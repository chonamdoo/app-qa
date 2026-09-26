// Deterministic requirement segmentation. Same document bytes → same Requirement ids, texts and digests.
//   Markdown: heading path + paragraph / top-level list item / bold-term definition / table row units.
//   Spreadsheets (xlsx/csv/tsv, arrays of objects in json/yaml): one row = one test case, columns mapped by header heuristics.
// Ids: `<doc-slug>#<section-slug>` for the first unit of a section, `.2`, `.3`, … for later ones (slugs never contain '.').
import { stringify as stringifyYaml } from 'yaml';
import { sha256 } from '../core/fsx.ts';
import type { Requirement } from '../spec/schema.ts';
import type { IngestedDoc, Sheet } from './ingest.ts';
import { isPlainObject } from './json.ts';

/** Korean-safe slug: NFC, lower case, every run of non letter/mark/digit characters → '-'. */
export function slugify(s: string, max = 60): string {
  const cleaned = s
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  return Array.from(cleaned).slice(0, max).join('').replace(/-+$/, '');
}

export function segmentRequirements(docs: readonly IngestedDoc[]): Requirement[] {
  const out: Requirement[] = [];
  for (const doc of docs) {
    const body = doc.body;
    let units: Unit[];
    if (body.type === 'markdown') units = markdownUnits(body.text);
    else if (body.type === 'table') units = body.sheets.flatMap((sheet) => sheetUnits(sheet, body.sheets.length > 1 ? [sheet.name] : [], true));
    else units = treeUnits(body.value, [], 0);
    const lineMapped = body.type !== 'markdown' || body.lines;
    const seen = new Map<string, number>();
    for (const unit of units) {
      const text = unit.text.trim();
      if (!text) continue;
      const base = unit.key ?? (slugify(unit.section.at(-1) ?? '') || 'body');
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      out.push({
        id: `${doc.slug}#${n === 1 ? base : `${base}.${n}`}`,
        doc: doc.path,
        section: unit.section,
        lines: lineMapped && unit.lines ? unit.lines : null,
        text,
        digest: sha256(text),
      });
    }
  }
  return out;
}

interface Unit {
  section: string[];
  lines: [number, number] | null;
  text: string;
  /** Explicit id base (spreadsheet ID column / row number); default = slug of the last section element. */
  key?: string;
}

// ───────────────────────── markdown ─────────────────────────

const HEADING = /^ {0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const HR = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const LIST_ITEM = /^(\s*)(?:[-*+•▪◦○●■□▶►]|\d{1,3}[.)]|[①-⑳])\s+\S/;
/** `**term**: definition` / `**term:** definition`, optionally as a list item. */
const BOLD_TERM = /^\s*(?:[-*+]\s+)?\*\*([^*]+?)\*\*\s*[:：]\s*(.*)$|^\s*(?:[-*+]\s+)?\*\*([^*]+?)[:：]\*\*\s*(.*)$/;
/** Glossary follow-up lines (`_Avoid_: …`) belong to the term above them, even across a blank line. */
const TERM_NOTE = /^\s*[_*]{1,2}(?:avoid|피할 말|금지어|쓰지 말 것)[_*]{1,2}\s*[:：]/i;
const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;

function markdownUnits(source: string): Unit[] {
  const lines = source.replace(/^\uFEFF/, '').split(/\r?\n/);
  const units: Unit[] = [];
  const headings: { level: number; text: string }[] = [];
  const section = () => headings.map((h) => h.text);
  const blank = (i: number) => i >= lines.length || lines[i]!.trim() === '';
  const unit = (sec: string[], from: number, to: number) => {
    units.push({ section: sec, lines: [from + 1, to + 1], text: lines.slice(from, to + 1).map((l) => l.trimEnd()).join('\n') });
  };
  const isTableStart = (i: number) => (lines[i] ?? '').includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]!) && lines[i + 1]!.includes('-');
  const startsBlock = (i: number) => {
    const l = lines[i]!;
    return HEADING.test(l) || FENCE.test(l) || HR.test(l) || BOLD_TERM.test(l) || LIST_ITEM.test(l) || isTableStart(i) || l.trimStart().startsWith('<!--');
  };

  let i = 0;
  if (lines[0]?.trim() === '---') {
    const close = lines.findIndex((l, k) => k > 0 && l.trim() === '---');
    if (close > 0) i = close + 1;
  }
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === '' || HR.test(line)) {
      i++;
      continue;
    }
    if (line.trimStart().startsWith('<!--')) {
      while (i < lines.length && !lines[i]!.includes('-->')) i++;
      i++;
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      const level = h[1]!.length;
      while (headings.length && headings.at(-1)!.level >= level) headings.pop();
      headings.push({ level, text: inlineText(h[2]!) });
      i++;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1]!;
      let j = i + 1;
      while (j < lines.length && !lines[j]!.trimStart().startsWith(marker)) j++;
      unit(section(), i, Math.min(j, lines.length - 1));
      i = j + 1;
      continue;
    }
    if (isTableStart(i)) {
      const header = tableCells(line);
      let j = i + 2;
      while (j < lines.length && lines[j]!.includes('|') && lines[j]!.trim() !== '') {
        const cells = tableCells(lines[j]!);
        const text = cells
          .map((c, k) => (c ? `${header[k] || `열${k + 1}`}: ${c}` : ''))
          .filter(Boolean)
          .join('\n');
        units.push({ section: section(), lines: [j + 1, j + 1], text });
        j++;
      }
      i = j;
      continue;
    }
    const term = BOLD_TERM.exec(line);
    if (term) {
      let j = i + 1;
      while (!blank(j) && !startsBlock(j)) j++;
      // Attach `_Avoid_:` style notes that follow after blank lines.
      let k = j;
      while (blank(k) && k < lines.length) k++;
      while (k < lines.length && TERM_NOTE.test(lines[k]!)) {
        j = k + 1;
        while (!blank(j) && !startsBlock(j)) j++;
        k = j;
        while (blank(k) && k < lines.length) k++;
      }
      unit([...section(), inlineText(term[1] ?? term[3]!)], i, j - 1);
      i = j;
      continue;
    }
    if (LIST_ITEM.test(line)) {
      const end = listItemEnd(lines, i);
      unit(section(), i, end);
      i = end + 1;
      continue;
    }
    // Paragraph (block quotes included).
    let j = i + 1;
    while (!blank(j) && !startsBlock(j)) j++;
    let end = j - 1;
    if (/[:：]\s*$/.test(lines[end]!)) {
      // A lead-in ("다음을 만족해야 한다:") owns the list that follows it.
      let k = j;
      while (blank(k) && k < lines.length) k++;
      if (k < lines.length && LIST_ITEM.test(lines[k]!) && !BOLD_TERM.test(lines[k]!)) {
        end = k;
        while (k < lines.length && LIST_ITEM.test(lines[k]!)) {
          end = listItemEnd(lines, k);
          k = end + 1;
          while (blank(k) && k < lines.length) k++;
        }
      }
    }
    unit(section(), i, end);
    i = end + 1;
  }
  return units;
}

/** Last line of the list item starting at `start`: nested items and indented continuations stay with it. */
function listItemEnd(lines: readonly string[], start: number): number {
  const indent = /^(\s*)/.exec(lines[start]!)![1]!.length;
  let end = start;
  let j = start + 1;
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.trim() === '') {
      const next = lines.slice(j + 1).findIndex((x) => x.trim() !== '');
      if (next < 0) break;
      const nl = lines[j + 1 + next]!;
      if (/^(\s*)/.exec(nl)![1]!.length > indent) {
        j = j + 1 + next;
        end = j;
        j++;
        continue;
      }
      break;
    }
    const lead = /^(\s*)/.exec(l)![1]!.length;
    if (lead <= indent && (LIST_ITEM.test(l) || HEADING.test(l) || FENCE.test(l) || HR.test(l) || l.includes('|'))) break;
    end = j;
    j++;
  }
  return end;
}

function tableCells(line: string): string[] {
  const inner = line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '');
  return inner.split(/(?<!\\)\|/).map((c) => inlineText(c.replace(/\\\|/g, '|')));
}

/** Heading/cell text without inline markup: bold/italic markers, code ticks, link targets. */
function inlineText(s: string): string {
  return s
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|`)/g, '')
    .replace(/(^|\s)[*_]([^*_]+)[*_](?=\s|$)/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim();
}

// ───────────────────────── spreadsheets ─────────────────────────

export type CaseField = 'id' | 'area' | 'title' | 'precondition' | 'steps' | 'expected' | 'ignore';

/** Checked in this order; the first column that matches a field owns it. `ignore` = execution bookkeeping columns. */
const FIELD_PATTERNS: [CaseField, RegExp][] = [
  ['ignore', /실제\s*결과|actual|판정|pass\s*\/\s*fail|^결과$|테스트\s*결과|수행\s*결과|^status$|담당|tester|수행자|작성자|날짜|일자|^date$/i],
  ['id', /^(?:#|no\.?|id|번호|순번|tc|tc\s*(?:id|no\.?)|test\s*(?:case\s*)?id|케이스\s*(?:id|번호)|테스트\s*케이스\s*(?:id|번호)|시나리오\s*(?:id|번호))$/i],
  ['expected', /기대|예상\s*결과|expected/i],
  ['precondition', /사전\s*조건|전제\s*조건|pre-?\s*conditions?/i],
  ['steps', /절차|단계|스텝|수행\s*방법|테스트\s*방법|재현|^steps?$|test\s*steps|procedure|^actions?$/i],
  ['title', /시나리오|제목|테스트\s*케이스|케이스\s*명|^title$|scenario|summary|^name$|^설명$|^내용$|description/i],
  ['area', /항목|기능|화면|메뉴|구분|카테고리|feature|screen|^area$|module|category/i],
];

/** Header cell → field; unmatched headers are `null` (kept as plain context columns). */
export function mapHeader(header: readonly string[]): (CaseField | null)[] {
  const out: (CaseField | null)[] = header.map(() => null);
  const taken = new Set<CaseField>();
  for (const [field, re] of FIELD_PATTERNS) {
    header.forEach((h, k) => {
      if (out[k] !== null || !h.trim() || !re.test(h.trim())) return;
      if (field !== 'ignore' && taken.has(field)) return;
      out[k] = field;
      taken.add(field);
    });
  }
  return out;
}

function sheetUnits(sheet: Sheet, sectionPrefix: string[], lineMapped: boolean): Unit[] {
  const rows = sheet.rows.filter((r) => r.cells.some((c) => c.trim() !== ''));
  if (!rows.length) return [];
  const probe = rows.slice(0, 10);
  const headerIdx = Math.max(
    0,
    probe.findIndex((r) => mapHeader(r.cells).filter((f) => f !== null && f !== 'ignore').length >= 2),
  );
  const header = rows[headerIdx]!.cells.map((c) => c.trim());
  const fields = mapHeader(header);
  const col = (f: CaseField) => fields.indexOf(f);
  const sheetKey = sectionPrefix.length ? slugify(sheet.name) || 'sheet' : 'row';
  const units: Unit[] = [];
  for (const row of rows.slice(headerIdx + 1)) {
    const cell = (k: number) => (k >= 0 ? (row.cells[k] ?? '').trim() : '');
    const width = Math.max(header.length, row.cells.length);
    const parts: string[] = [];
    for (let k = 0; k < width; k++) {
      const v = cell(k);
      if (!v || fields[k] === 'ignore') continue;
      parts.push(`${header[k] || `열${k + 1}`}: ${v}`);
    }
    if (!parts.length) continue;
    const id = cell(col('id'));
    const section = [...sectionPrefix, cell(col('area')), [id, cell(col('title'))].filter(Boolean).join(' ')].filter(Boolean);
    units.push({
      section,
      lines: lineMapped ? [row.line, row.line] : null,
      text: parts.join('\n'),
      key: (id && slugify(id)) || `${sheetKey}.${row.line}`,
    });
  }
  return units;
}

// ───────────────────────── json / yaml trees ─────────────────────────

const scalarText = (v: unknown) => (typeof v === 'string' ? v : v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));

function treeUnits(value: unknown, section: string[], depth: number): Unit[] {
  if (Array.isArray(value)) {
    if (value.length && value.every(isPlainObject)) {
      const header: string[] = [];
      for (const item of value) for (const key of Object.keys(item)) if (!header.includes(key)) header.push(key);
      const sheet: Sheet = {
        name: section.at(-1) ?? 'items',
        rows: [{ line: 0, cells: header }, ...value.map((item, k) => ({ line: k + 1, cells: header.map((h) => scalarText(item[h])) }))],
      };
      return sheetUnits(sheet, section, false).map((u) => ({ ...u, section: u.section.length ? u.section : section }));
    }
    return value.flatMap((item) => (isPlainObject(item) || Array.isArray(item) ? treeUnits(item, section, depth + 1) : [{ section, lines: null, text: scalarText(item) }]));
  }
  if (isPlainObject(value)) {
    const fields = mapHeader(Object.keys(value)).filter((f) => f !== null && f !== 'ignore');
    if (fields.length >= 2 || depth >= 4) return [{ section, lines: null, text: stringifyYaml(value).trim() }];
    return Object.entries(value).flatMap(([key, v]) => treeUnits(v, [...section, key], depth + 1));
  }
  return [{ section, lines: null, text: scalarText(value) }];
}
