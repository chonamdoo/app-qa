// Document ingestion for `qa plan`: resolves paths, globs and directories (with `~`), reads every supported format
// into markdown text, spreadsheet rows or a JSON tree, and records {path, sha256, kind} for traceability.
import { globSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import ExcelJS from 'exceljs';
import mammoth from 'mammoth';
import { extractText, getDocumentProxy } from 'unpdf';
import { parse as parseYaml } from 'yaml';
import { expandHome, ROOT } from '../core/config.ts';
import { sha256 } from '../core/fsx.ts';
import { slugify } from './segment.ts';

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

async function readWorkbook(bytes: Buffer): Promise<Sheet[]> {
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
