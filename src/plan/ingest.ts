// Document ingestion for `qa plan`: resolves paths, globs and directories (with `~`), reads every supported format
// into markdown text, spreadsheet rows or a JSON tree, and records {path, sha256, kind} for traceability.
import { globSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { crc32, inflateRawSync } from 'node:zlib';
import ExcelJS from 'exceljs';
import mammoth from 'mammoth';
import { extractText, getDocumentProxy } from 'unpdf';
import { parse as parseYaml } from 'yaml';
import { expandHome, ROOT } from '../core/config.ts';
import { sha256 } from '../core/fsx.ts';
import { SourceLedger, textSourceLedger, unsupportedSourceLedger } from '../core/product.ts';
import { slugify } from './segment.ts';
import { jsonSourceLedger } from '../core/source-json.ts';

export type DocKind = 'md' | 'txt' | 'csv' | 'tsv' | 'json' | 'yaml' | 'xlsx' | 'docx' | 'pdf';

const KINDS: Record<string, DocKind> = {
  '.md': 'md',
  '.markdown': 'md',
  '.txt': 'txt',
  '.csv': 'csv',
  '.tsv': 'tsv',
  '.json': 'json',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.xlsx': 'xlsx',
  '.docx': 'docx',
  '.pdf': 'pdf',
};

export interface Sheet {
  name: string;
  /** `line` = 1-based spreadsheet row / CSV record start line. */
  rows: { line: number; cells: string[] }[];
}

export type DocBody =
  /** `lines` = line numbers refer to the source file (false for text converted from docx/pdf). */
  | { type: 'markdown'; text: string; lines: boolean }
  | { type: 'table'; sheets: Sheet[] }
  | { type: 'tree'; value: unknown };

export interface IngestedDoc {
  /** Display path recorded in plan.json: project-relative, `~/…`, absolute, or `inline.md`. */
  path: string;
  /** Absolute file path; null for inline text. */
  file: string | null;
  kind: DocKind;
  sha256: string;
  /** Requirement id prefix, unique within the plan. */
  slug: string;
  body: DocBody;
}

export const INLINE_DOC = 'inline.md';

export interface IngestOptions {
  /** Scenario typed in the UI / `--text`; becomes the virtual document `inline.md`. */
  text?: string;
  cwd?: string;
  /** Slugs already used by the existing plan (display path → slug): same path keeps its slug, others are avoided. */
  reservedSlugs?: ReadonlyMap<string, string>;
  /**
   * `sources` are the exact files a server plan job resolved and confined when it was queued: they are read as given
   * (no glob or folder expansion), and each file's realpath must still lie inside one of these realpaths when read.
   */
  confinedTo?: readonly string[];
}

export async function ingestDocuments(sources: readonly string[], opts: IngestOptions = {}): Promise<IngestedDoc[]> {
  const cwd = opts.cwd ?? process.cwd();
  const files = opts.confinedTo ? sources.map((source) => resolve(cwd, source)) : resolveDocPaths(sources, cwd);
  const reserved = opts.reservedSlugs ?? new Map<string, string>();
  const used = new Set<string>();
  const assignSlug = (path: string, name: string): string => {
    const kept = reserved.get(path);
    if (kept && !used.has(kept)) {
      used.add(kept);
      return kept;
    }
    const others = new Set([...reserved].filter(([p]) => p !== path).map(([, s]) => s));
    const base = slugify(name) || 'doc';
    let slug = base;
    for (let n = 2; used.has(slug) || others.has(slug); n++) slug = `${base}-${n}`;
    used.add(slug);
    return slug;
  };

  const docs: IngestedDoc[] = [];
  for (const file of files) {
    const kind = KINDS[extname(file).toLowerCase()];
    if (!kind) throw new Error(`지원하지 않는 문서 형식입니다 (${extname(file) || '확장자 없음'}): ${displayPath(file)}`);
    const bytes = readFileSync(opts.confinedTo ? confinedPath(file, opts.confinedTo) : file);
    const path = displayPath(file);
    let body: DocBody;
    try {
      body = await readBody(kind, bytes, basename(file));
    } catch (err) {
      throw new Error(`문서를 읽을 수 없습니다 (${kind}): ${path}: ${(err as Error).message}`);
    }
    docs.push({ path, file, kind, sha256: sha256(bytes), slug: assignSlug(path, basename(file, extname(file))), body });
  }
  if (opts.text !== undefined && opts.text.trim() !== '') {
    const text = opts.text.normalize('NFC');
    docs.push({ path: INLINE_DOC, file: null, kind: 'md', sha256: sha256(text), slug: assignSlug(INLINE_DOC, 'inline'), body: { type: 'markdown', text, lines: true } });
  }
  return docs;
}

/** Paths, globs (`*`, `?`, `[…]`, `{…}`) and directories → sorted, de-duplicated absolute files of supported kinds. */
function resolveDocPaths(sources: readonly string[], cwd: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    out.push(file);
  };
  for (const source of sources) {
    const pattern = expandHome(source.trim());
    if (/[*?[\]{}]/.test(pattern)) {
      const hits = globSync(pattern, { cwd })
        .map((p) => resolve(cwd, p))
        .filter((p) => KINDS[extname(p).toLowerCase()] && statSync(p).isFile())
        .sort();
      if (!hits.length) throw new Error(`글롭에 맞는 문서가 없습니다: ${source}`);
      hits.forEach(add);
      continue;
    }
    const abs = resolve(cwd, pattern);
    let stat;
    try {
      stat = statSync(abs);
    } catch {
      throw new Error(`문서를 찾을 수 없습니다: ${source}`);
    }
    if (stat.isDirectory()) {
      const hits = walk(abs);
      if (!hits.length) throw new Error(`폴더에 지원하는 문서가 없습니다: ${source}`);
      hits.forEach(add);
      continue;
    }
    if (!KINDS[extname(abs).toLowerCase()]) {
      throw new Error(`지원하지 않는 문서 형식입니다 (${extname(abs) || '확장자 없음'}): ${source} — 지원: ${Object.keys(KINDS).join(' ')}`);
    }
    add(abs);
  }
  return out;
}

/** Realpath of a queued document, refused when it no longer lies inside `roots` (e.g. swapped for a link leading out). */
function confinedPath(file: string, roots: readonly string[]): string {
  let real: string;
  try {
    real = realpathSync(file);
  } catch {
    throw new Error(`문서를 찾을 수 없습니다: ${displayPath(file)}`);
  }
  const inside = roots.some((root) => {
    const rel = relative(root, real);
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
  });
  if (!inside) throw new Error(`문서가 허용된 위치 밖을 가리킵니다 (작업을 등록한 뒤 링크로 바뀐 파일은 읽지 않습니다): ${displayPath(file)}`);
  return real;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else if (entry.isFile() && KINDS[extname(p).toLowerCase()]) out.push(p);
  }
  return out;
}

function displayPath(file: string): string {
  const inRoot = relative(ROOT, file);
  if (!inRoot.startsWith('..') && !inRoot.startsWith(sep) && inRoot !== '') return inRoot.split(sep).join('/');
  const home = homedir();
  return file.startsWith(home + sep) ? `~/${relative(home, file).split(sep).join('/')}` : file;
}

async function readBody(kind: DocKind, bytes: Buffer, name: string): Promise<DocBody> {
  switch (kind) {
    case 'md':
    case 'txt':
      return { type: 'markdown', text: utf8(bytes), lines: true };
    case 'csv':
    case 'tsv':
      return { type: 'table', sheets: [{ name, rows: parseDelimited(utf8(bytes), kind === 'tsv' ? '\t' : ',') }] };
    case 'json':
      return { type: 'tree', value: JSON.parse(utf8(bytes)) };
    case 'yaml':
      return { type: 'tree', value: parseYaml(utf8(bytes)) };
    case 'xlsx':
      return { type: 'table', sheets: await readWorkbook(bytes) };
    case 'docx': {
      const { value } = await mammoth.convertToHtml({ buffer: bytes });
      return { type: 'markdown', text: htmlToMarkdown(value), lines: false };
    }
    case 'pdf': {
      const pdf = await getDocumentProxy(new Uint8Array(bytes));
      const { text } = await extractText(pdf, { mergePages: false });
      const pages = text.map((t, i) => `# ${i + 1}쪽\n\n${t.normalize('NFC').trim()}`);
      return { type: 'markdown', text: pages.join('\n\n'), lines: false };
    }
  }
}

function utf8(bytes: Buffer): string {
  return bytes.toString('utf8').replace(/^\uFEFF/, '').normalize('NFC');
}

/** RFC 4180 records (quoted fields may contain delimiters, quotes and newlines). */
function parseDelimited(text: string, delimiter: string): Sheet['rows'] {
  const rows: Sheet['rows'] = [];
  let cells: string[] = [];
  let cell = '';
  let quoted = false;
  let line = 1;
  let recordLine = 1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else {
        if (ch === '\n') line++;
        if (ch !== '\r') cell += ch;
      }
      continue;
    }
    if (ch === '"' && cell === '') quoted = true;
    else if (ch === delimiter) {
      cells.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      cells.push(cell);
      rows.push({ line: recordLine, cells });
      cells = [];
      cell = '';
      line++;
      recordLine = line;
    } else cell += ch;
  }
  if (cell !== '' || cells.length) {
    cells.push(cell);
    rows.push({ line: recordLine, cells });
  }
  return rows;
}

class WorkbookBudgetError extends Error {}

const WORKBOOK_ENTRY_BYTES = 8 * 1024 * 1024;
const WORKBOOK_EXPANDED_BYTES = 32 * 1024 * 1024;
const WORKBOOK_STRUCTURE_LIMIT = 100_000;

function workbookXMLBudget(text: string, budget: { nodes: number; cells: number; rows: number; columns: number; merges: number; mergeCells: number; ranges: number; sheets: number }): void {
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new WorkbookBudgetError('XLSX XML declarations are outside the structural budget');
  let position = 0;
  let depth = 0;
  let maximumRow = 0;
  let rowCount = 0;
  const rowWidths = new Map<number, number>();
  const coordinate = (value: string): { row: number; column: number } => {
    const match = /^\$?([A-Z]{1,3})\$?([1-9]\d{0,5})$/.exec(value);
    if (!match) throw new WorkbookBudgetError('XLSX cell reference exceeds structural budget');
    let column = 0;
    for (const character of match[1]!) column = column * 26 + character.charCodeAt(0) - 64;
    const row = Number(match[2]);
    if (row > WORKBOOK_STRUCTURE_LIMIT || column > 16_384) throw new WorkbookBudgetError('XLSX cell reference exceeds structural budget');
    return { row, column };
  };
  const integer = (value: string, maximum = WORKBOOK_STRUCTURE_LIMIT): number => {
    if (!/^[0-9]{1,6}$/.test(value) || Number(value) > maximum) throw new WorkbookBudgetError('XLSX index exceeds structural budget');
    return Number(value);
  };
  while ((position = text.indexOf('<', position)) !== -1) {
    if (text.startsWith('<!--', position) || text.startsWith('<![CDATA[', position) || text.startsWith('<?', position)) {
      const terminator = text.startsWith('<!--', position) ? '-->' : text.startsWith('<![CDATA[', position) ? ']]>' : '?>';
      const end = text.indexOf(terminator, position + 2);
      if (end === -1) throw new Error('Invalid XLSX XML');
      position = end + terminator.length;
      continue;
    }
    let end = position + 1;
    let quote = '';
    for (; end < text.length; end++) {
      const character = text[end]!;
      if (quote) { if (character === quote) quote = ''; }
      else if (character === '"' || character === "'") quote = character;
      else if (character === '>') break;
      if (end - position > 1_000_000) throw new WorkbookBudgetError('XLSX XML token exceeds structural budget');
    }
    if (end === text.length) throw new Error('Invalid XLSX XML');
    const token = text.slice(position + 1, end);
    position = end + 1;
    if (token.startsWith('/')) { if (--depth < 0) throw new Error('Invalid XLSX XML'); continue; }
    const element = /^([A-Za-z_][\w.:-]*)/.exec(token);
    const tag = element?.[1]?.split(':').at(-1);
    if (!element || !tag) throw new Error('Invalid XLSX XML');
    if (++budget.nodes > 500_000 || (!token.endsWith('/') && ++depth > 128)) throw new WorkbookBudgetError('XLSX XML node or depth limit');
    const attributes = new Map<string, string>();
    const attribute = /\s+([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/y;
    let attributePosition = element[0].length;
    for (;;) {
      attribute.lastIndex = attributePosition;
      const match = attribute.exec(token);
      if (!match) break;
      if (attributes.has(match[1]!)) throw new Error('Duplicate XLSX XML attribute');
      attributes.set(match[1]!, match[2] ?? match[3]!);
      attributePosition = attribute.lastIndex;
    }
    const closing = token.slice(attributePosition).trim();
    if (closing !== '' && closing !== '/') throw new Error('Invalid XLSX XML attributes');
    for (const name of ['count', 'sheetId', 'fontId', 'fillId', 'borderId', 'xfId', 'numFmtId', 'dxfId', 's']) {
      const value = attributes.get(name);
      if (value !== undefined) integer(value);
    }
    if (tag === 'sheet' && ++budget.sheets > 100) throw new WorkbookBudgetError('XLSX worksheet limit');
    if (tag === 'row') {
      const value = attributes.get('r');
      if (value !== undefined) maximumRow = Math.max(maximumRow, integer(value));
      if (++rowCount > WORKBOOK_STRUCTURE_LIMIT) throw new WorkbookBudgetError('XLSX row limit');
    }
    if (tag === 'c') {
      if (++budget.cells > WORKBOOK_STRUCTURE_LIMIT) throw new WorkbookBudgetError('XLSX cell limit');
      const reference = attributes.get('r');
      if (reference !== undefined) {
        const { row, column } = coordinate(reference);
        maximumRow = Math.max(maximumRow, row);
        const width = rowWidths.get(row) ?? 0;
        budget.columns += Math.max(0, column - width);
        rowWidths.set(row, Math.max(width, column));
      } else budget.columns++;
    }
    if (tag === 'col' && (attributes.has('min') || attributes.has('max'))) {
      const minimum = integer(attributes.get('min') ?? '', 16_384);
      const maximum = integer(attributes.get('max') ?? '', 16_384);
      if (!minimum || maximum < minimum) throw new WorkbookBudgetError('XLSX column range limit');
      budget.columns += maximum - minimum + 1;
    }
    for (const name of ['ref', 'sqref']) {
      const reference = attributes.get(name);
      if (reference === undefined) continue;
      for (const range of reference.trim().split(/\s+/)) {
        const parts = range.split(':');
        if (parts.length > 2) throw new WorkbookBudgetError('XLSX range limit');
        const first = coordinate(parts[0]!);
        const last = parts[1] === undefined ? first : coordinate(parts[1]);
        const area = (Math.abs(last.row - first.row) + 1) * (Math.abs(last.column - first.column) + 1);
        budget.ranges += area;
        if (area > WORKBOOK_STRUCTURE_LIMIT || budget.ranges > 1_000_000) throw new WorkbookBudgetError('XLSX expanded range limit');
        if (tag === 'mergeCell') {
          budget.mergeCells += area;
          if (++budget.merges > 1000 || budget.mergeCells > WORKBOOK_STRUCTURE_LIMIT) throw new WorkbookBudgetError('XLSX merge expansion limit');
        }
      }
    }
    if (budget.columns > WORKBOOK_STRUCTURE_LIMIT) throw new WorkbookBudgetError('XLSX expanded cell storage limit');
  }
  if (depth !== 0) throw new Error('Invalid XLSX XML');
  budget.rows += Math.max(maximumRow, rowCount);
  if (budget.rows > WORKBOOK_STRUCTURE_LIMIT) throw new WorkbookBudgetError('XLSX sparse row storage limit');
}

function preflightWorkbook(bytes: Buffer): void {
  if (bytes.length > 50 * 1024 * 1024) throw new WorkbookBudgetError('XLSX compressed byte limit');
  let end = bytes.length - 22;
  for (; end >= Math.max(0, bytes.length - 65_557); end--) {
    if (bytes.readUInt32LE(end) === 0x06054b50 && end + 22 + bytes.readUInt16LE(end + 20) === bytes.length) break;
  }
  if (end < 0 || end < bytes.length - 65_557) throw new Error('Invalid XLSX ZIP directory');
  const entries = bytes.readUInt16LE(end + 10);
  const start = bytes.readUInt32LE(end + 16);
  if (bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6) || bytes.readUInt16LE(end + 8) !== entries
      || start + bytes.readUInt32LE(end + 12) !== end) throw new Error('Unsupported XLSX ZIP directory');
  if (entries > 2048) throw new WorkbookBudgetError('XLSX ZIP entry limit');
  const budget = { nodes: 0, cells: 0, rows: 0, columns: 0, merges: 0, mergeCells: 0, ranges: 0, sheets: 0 };
  const names = new Set<string>();
  const ranges: { start: number; end: number }[] = [];
  let expanded = 0;
  let position = start;
  for (let index = 0; index < entries; index++) {
    if (position + 46 > end || bytes.readUInt32LE(position) !== 0x02014b50) throw new Error('Invalid XLSX ZIP entry');
    const flags = bytes.readUInt16LE(position + 8);
    const method = bytes.readUInt16LE(position + 10);
    const checksum = bytes.readUInt32LE(position + 16);
    const compressedSize = bytes.readUInt32LE(position + 20);
    const size = bytes.readUInt32LE(position + 24);
    const nameLength = bytes.readUInt16LE(position + 28);
    const next = position + 46 + nameLength + bytes.readUInt16LE(position + 30) + bytes.readUInt16LE(position + 32);
    const local = bytes.readUInt32LE(position + 42);
    if (next > end || bytes.readUInt16LE(position + 34) || (flags & 1) || ![0, 8].includes(method)) throw new Error('Unsupported XLSX ZIP entry');
    if (size > WORKBOOK_ENTRY_BYTES || (expanded += size) > WORKBOOK_EXPANDED_BYTES) throw new WorkbookBudgetError('XLSX ZIP expansion byte limit');
    const nameBytes = bytes.subarray(position + 46, position + 46 + nameLength);
    const name = new TextDecoder('utf-8', { fatal: true }).decode(nameBytes);
    if (!name || name.includes('\\') || name.startsWith('/') || name.split('/').some(part => part === '.' || part === '..') || names.has(name)) throw new Error('Ambiguous XLSX ZIP entry');
    names.add(name);
    if (local + 30 > start || bytes.readUInt32LE(local) !== 0x04034b50
        || bytes.readUInt16LE(local + 6) !== flags || bytes.readUInt16LE(local + 8) !== method
        || bytes.readUInt16LE(local + 26) !== nameLength) throw new Error('Invalid XLSX ZIP local entry');
    const dataStart = local + 30 + nameLength + bytes.readUInt16LE(local + 28);
    if (dataStart + compressedSize > start || !bytes.subarray(local + 30, local + 30 + nameLength).equals(nameBytes)) throw new Error('Invalid XLSX ZIP entry bounds');
    for (const [extraStart, extraEnd] of [
      [position + 46 + nameLength, position + 46 + nameLength + bytes.readUInt16LE(position + 30)],
      [local + 30 + nameLength, dataStart],
    ]) {
      let extra = extraStart!;
      while (extra < extraEnd!) {
        if (extra + 4 > extraEnd!) throw new Error('Invalid XLSX ZIP metadata');
        const id = bytes.readUInt16LE(extra);
        const length = bytes.readUInt16LE(extra + 2);
        const finish = extra + 4 + length;
        if (finish > extraEnd!) throw new Error('Invalid XLSX ZIP metadata');
        if (id === 0x7075 && !(flags & 0x0800) && length >= 5 && bytes[extra + 4] === 1
            && bytes.readUInt32LE(extra + 5) === crc32(nameBytes)
            && new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(extra + 9, finish)) !== name) throw new Error('Ambiguous XLSX ZIP filename');
        extra = finish;
      }
    }
    if (!(flags & 8) && (bytes.readUInt32LE(local + 14) !== checksum || bytes.readUInt32LE(local + 18) !== compressedSize || bytes.readUInt32LE(local + 22) !== size)) throw new Error('Inconsistent XLSX ZIP sizes');
    ranges.push({ start: local, end: dataStart + compressedSize });
    const compressed = bytes.subarray(dataStart, dataStart + compressedSize);
    let content: Buffer;
    try { content = method === 0 ? compressed : inflateRawSync(compressed, { maxOutputLength: WORKBOOK_ENTRY_BYTES }); }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ERR_BUFFER_TOO_LARGE') throw new WorkbookBudgetError('XLSX actual ZIP expansion byte limit');
      throw error;
    }
    if (content.length !== size || crc32(content) !== checksum) throw new Error('Invalid XLSX ZIP expanded entry');
    // ExcelJS dispatches some XML entries with unanchored filename patterns.
    if (/\.(xml|rels|vml)$/i.test(name)
        || /xl\/(?:worksheets\/(?:_rels\/)?sheet\d+[.]xml|drawings\/(?:_rels\/)?[a-zA-Z0-9]+[.](?:xml|vml)|comments\d+[.]xml|tables\/table\d+[.]xml)/.test(name)) {
      workbookXMLBudget(new TextDecoder('utf-8', { fatal: true }).decode(content), budget);
    }
    position = next;
  }
  if (position !== end) throw new Error('Invalid XLSX ZIP directory length');
  ranges.sort((first, second) => first.start - second.start);
  for (let index = 1; index < ranges.length; index++) if (ranges[index]!.start < ranges[index - 1]!.end) throw new Error('Overlapping XLSX ZIP entries');
}

async function readWorkbook(bytes: Buffer): Promise<Sheet[]> {
  preflightWorkbook(bytes);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(bytes as unknown as Parameters<typeof wb.xlsx.load>[0]);
  const sheets: Sheet[] = [];
  wb.eachSheet((ws) => {
    const rows: Sheet['rows'] = [];
    ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      const cells: string[] = [];
      for (let c = 1; c <= row.cellCount; c++) cells.push((row.getCell(c).text ?? '').replace(/\r\n?/g, '\n').normalize('NFC'));
      rows.push({ line: rowNumber, cells });
    });
    sheets.push({ name: ws.name, rows });
  });
  return sheets;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/**
 * mammoth HTML → markdown the segmenter understands: headings, paragraphs, (nested) list items, bold (kept as `**`
 * so `**용어**: 정의` works) and tables as pipe tables. Everything else is reduced to text.
 */
function htmlToMarkdown(html: string): string {
  const out: string[] = [];
  let buf = '';
  let heading = 0;
  let listDepth = 0;
  let inCell = false;
  let row: string[] | null = null;
  let tableRows = 0;
  const flush = (prefix = '') => {
    const text = buf.replace(/\s+/g, ' ').trim();
    buf = '';
    if (text) out.push(prefix + text);
  };
  for (const m of html.matchAll(/<(\/?)([a-z0-9]+)[^>]*>|([^<]+)/gi)) {
    if (m[3] !== undefined) {
      buf += m[3].replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (ref, e: string) =>
        e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : (ENTITIES[e.toLowerCase()] ?? ref),
      );
      continue;
    }
    const closing = m[1] === '/';
    const tag = m[2]!.toLowerCase();
    if (/^h[1-6]$/.test(tag)) {
      if (closing) {
        flush(`${'#'.repeat(heading)} `);
        out.push('');
      } else {
        flush();
        heading = Number(tag[1]);
      }
    } else if (tag === 'strong' || tag === 'b') buf += '**';
    else if (tag === 'em' || tag === 'i') buf += '_';
    else if (tag === 'br') buf += ' ';
    else if (tag === 'ul' || tag === 'ol') {
      flush(`${'  '.repeat(Math.max(0, listDepth - 1))}- `);
      listDepth += closing ? -1 : 1;
      if (closing && listDepth === 0) out.push('');
    } else if (tag === 'li') flush(`${'  '.repeat(Math.max(0, listDepth - 1))}- `);
    else if (tag === 'table') {
      if (!closing) flush();
      tableRows = 0;
      if (closing) out.push('');
    } else if (tag === 'tr') {
      if (!closing) row = [];
      else if (row) {
        out.push(`| ${row.join(' | ')} |`);
        if (++tableRows === 1) out.push(`|${row.map(() => ' --- ').join('|')}|`);
        row = null;
      }
    } else if (tag === 'td' || tag === 'th') {
      inCell = !closing;
      if (closing && row) {
        row.push(buf.replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|'));
        buf = '';
      }
    } else if (tag === 'p' && closing && !inCell) {
      flush(listDepth ? `${'  '.repeat(listDepth - 1)}- ` : '');
      if (!listDepth) out.push('');
    } else if (tag === 'p' && closing && inCell) buf += ' ';
  }
  flush();
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Product source inventory never infers headers, assertions or a new run result from document contents. */
export async function ingestSourceLedger(bytes: Buffer, name: string): Promise<SourceLedger> {
  const kind = KINDS[extname(name).toLowerCase()];
  if (!kind) return unsupportedSourceLedger('지원하지 않는 문서 형식입니다. 원본 bytes와 파일 위치를 보존했습니다.');
  if (kind === 'json') return jsonSourceLedger(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes));
  if (['md', 'txt', 'yaml'].includes(kind)) {
    return textSourceLedger(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  }
  const ledger: SourceLedger = { segments: [], issues: [] };
  const add = (locator: string, text: string, kind: SourceLedger['segments'][number]['kind']) => {
    for (const [index, line] of text.split(/\r\n|\n|\r/).entries()) {
      if (!line.trim()) continue;
      const position = `${locator}/line:${index + 1}`;
      ledger.segments.push({ id: position, locator: position, text: line, kind });
      if (ledger.segments.length > 100_000) throw new Error('source segment limit');
    }
  };
  if (kind === 'csv' || kind === 'tsv') {
    const rows = parseDelimited(new TextDecoder('utf-8', { fatal: true }).decode(bytes), kind === 'tsv' ? '\t' : ',');
    for (const row of rows) row.cells.forEach((cell, index) => add(`record:${row.line}/column:${index + 1}`, cell, 'cell'));
  } else if (kind === 'xlsx') {
    try { preflightWorkbook(bytes); }
    catch (error) {
      return {
        segments: [{ id: 'file', locator: 'file', text: '', kind: 'unparsed' }],
        issues: [{ code: error instanceof WorkbookBudgetError ? 'source_xlsx_limit' : 'source_xlsx_unreadable', locator: 'file',
          message: 'XLSX 압축·확장·구조를 안전 한도 안에서 확인하지 못했습니다. 원본 bytes는 보존하며 일부 행을 전체 원문으로 표시하지 않습니다.' }],
      };
    }
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(bytes as unknown as Parameters<typeof workbook.xlsx.load>[0]);
    workbook.eachSheet(sheet => {
      ledger.segments.push({ id: `sheet:${sheet.id}`, locator: `sheet:${sheet.id}`, text: sheet.name, kind: 'metadata' });
      sheet.eachRow({ includeEmpty: false }, row => {
        row.eachCell({ includeEmpty: false }, cell => {
          if (cell.isMerged && cell.master.address !== cell.address) return;
          const merges = sheet.model.merges ?? [];
          const range = merges.find(merge => merge.split(':')[0] === cell.address);
          const locator = `sheet:${sheet.id}!${range ?? cell.address}`;
          add(locator, cell.text, 'cell');
          if (cell.type === ExcelJS.ValueType.Formula) {
            ledger.issues.push({ code: 'source_formula_unverified', locator, message: '수식과 계산 결과는 원본에 보존됩니다. 재계산/외부 참조 의미는 검증하지 않았습니다.' });
          }
          if (cell.note) add(`${locator}/note`, typeof cell.note === 'string' ? cell.note : JSON.stringify(cell.note), 'metadata');
        });
      });
      const addImage = (locator: string, imageId: string, range?: Partial<ExcelJS.ImageRange & ExcelJS.ImagePosition> & {
        editAs?: string; hyperlinks?: ExcelJS.ImageHyperlinkValue;
      }) => {
        const media = workbook.getImage(Number(imageId));
        const [tl, br] = [range?.tl, range?.br].map(anchor => anchor ? {
          col: anchor.col, row: anchor.row,
          nativeCol: anchor.nativeCol, nativeRow: anchor.nativeRow,
          nativeColOff: anchor.nativeColOff, nativeRowOff: anchor.nativeRowOff,
        } : null);
        const metadata = {
          imageId: String(imageId), extension: media?.extension ?? null,
          range: range ? {
            tl, br,
            ext: range.ext ? { width: range.ext.width, height: range.ext.height } : null,
            editAs: range.editAs ?? null,
            hyperlinks: range.hyperlinks ? { hyperlink: range.hyperlinks.hyperlink, tooltip: range.hyperlinks.tooltip } : null,
          } : null,
        };
        ledger.segments.push({ id: locator, locator, text: JSON.stringify(metadata), kind: 'image' });
        ledger.issues.push({ code: 'source_image_uninterpreted', locator, message: '원본 그림의 의미를 해석하지 않았습니다. 텍스트 기대값으로 대체하지 않습니다.' });
      };
      for (const [index, image] of sheet.getImages().entries()) {
        addImage(`sheet:${sheet.id}/image:${index + 1}`, image.imageId, image.range);
      }
      const backgroundId = sheet.getBackgroundImageId();
      if (backgroundId !== undefined) addImage(`sheet:${sheet.id}/background-image`, backgroundId);
    });
  } else {
    let body: DocBody;
    if (kind === 'docx') {
      let imageIndex = 0;
      const converted = await mammoth.convertToHtml({ buffer: bytes }, {
        externalFileAccess: false,
        convertImage: mammoth.images.imgElement(async image => {
          const locator = `extracted-image:${++imageIndex}`;
          ledger.segments.push({ id: locator, locator, text: image.contentType, kind: 'image' });
          ledger.issues.push({ code: 'source_image_uninterpreted', locator, message: '원본 그림의 의미는 해석되지 않았습니다. 원본 DOCX에서 확인하세요.' });
          return { src: `qautra-original:${locator}` };
        }),
      });
      body = { type: 'markdown', text: htmlToMarkdown(converted.value), lines: false };
      for (const message of converted.messages) ledger.issues.push({ code: 'source_parser_issue', locator: 'file', message: message.message });
    } else {
      body = await readBody(kind, bytes, name);
    }
    if (body.type === 'markdown') {
      for (const [index, paragraph] of body.text.split(/\n\s*\n/).entries()) add(`extracted-block:${index + 1}`, paragraph, 'paragraph');
    }
    ledger.issues.push({
      code: 'source_structure_unverified', locator: 'file',
      message: kind === 'pdf' ? 'PDF 텍스트 레이어만 추출했습니다. 원본 페이지/그림/표 전체의 의미는 확인되지 않아 실행 정의로 발행할 수 없습니다.'
        : 'DOCX 추출 텍스트를 보존했습니다. 원본 그림/표/문단 전체와의 대조가 확인되지 않아 실행 정의로 발행할 수 없습니다.',
    });
    ledger.segments.push({ id: 'original-structure', locator: 'file', text: '', kind: 'unparsed' });
  }
  if (!ledger.segments.length) ledger.issues.push({ code: 'source_empty', locator: 'file', message: '검토 가능한 원문 구간이 없습니다.' });
  return SourceLedger.parse(ledger);
}
