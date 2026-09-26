// Text normalization and a minimal XML scanner for Appium page sources (UiAutomator2 / XCUITest).

const ZERO_WIDTH = /[\u200B-\u200D\u2060]/gu;

/** NFC, zero-width characters removed, every whitespace run (incl. NBSP, newlines) collapsed to one space, trimmed. Keeps all scripts. */
export function cleanText(s: string): string {
  return s.normalize('NFC').replace(ZERO_WIDTH, '').replace(/\s+/gu, ' ').trim();
}

/** Matching key for labels: NFC + lower case + whitespace collapsed. Korean and other non-ASCII text is preserved as-is. */
export function normLabel(s: string): string {
  return cleanText(s).toLowerCase();
}

const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntities(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g, (_, e: string) =>
    e.startsWith('#x')
      ? String.fromCodePoint(Number.parseInt(e.slice(2), 16))
      : e.startsWith('#')
        ? String.fromCodePoint(Number.parseInt(e.slice(1), 10))
        : NAMED_ENTITIES[e]!,
  );
}

export interface XmlHandler {
  open(tag: string, attrs: Record<string, string>): void;
  close(tag: string): void;
}

function isSpace(c: number): boolean {
  return c === 32 || c === 9 || c === 10 || c === 13;
}

/**
 * Streams element open/close events. Handles quoted attributes (which may contain `>`), self-closing tags,
 * the XML declaration, comments and CDATA. Text content is ignored (Appium sources carry everything in attributes).
 * Throws on truncated or unbalanced markup so a corrupt source never yields a partial screen.
 */
export function scanXml(xml: string, handler: XmlHandler): void {
  const n = xml.length;
  const stack: string[] = [];
  let i = 0;
  for (;;) {
    const lt = xml.indexOf('<', i);
    if (lt < 0) break;
    const c = xml.charCodeAt(lt + 1);
    if (c === 63 /* ? */) {
      const end = xml.indexOf('?>', lt + 2);
      if (end < 0) throw new Error('XML: unterminated declaration');
      i = end + 2;
      continue;
    }
    if (c === 33 /* ! */) {
      const close = xml.startsWith('<!--', lt) ? '-->' : xml.startsWith('<![CDATA[', lt) ? ']]>' : '>';
      const end = xml.indexOf(close, lt + 2);
      if (end < 0) throw new Error('XML: unterminated comment/CDATA/doctype');
      i = end + close.length;
      continue;
    }
    if (c === 47 /* / */) {
      const end = xml.indexOf('>', lt);
      if (end < 0) throw new Error('XML: unterminated closing tag');
      const tag = xml.slice(lt + 2, end).trim();
      if (stack.pop() !== tag) throw new Error(`XML: unexpected </${tag}>`);
      handler.close(tag);
      i = end + 1;
      continue;
    }
    let j = lt + 1;
    while (j < n) {
      const ch = xml.charCodeAt(j);
      if (isSpace(ch) || ch === 47 || ch === 62) break;
      j++;
    }
    const tag = xml.slice(lt + 1, j);
    if (!tag) throw new Error('XML: empty tag name');
    const attrs: Record<string, string> = Object.create(null) as Record<string, string>;
    let selfClosing = false;
    for (;;) {
      while (j < n && isSpace(xml.charCodeAt(j))) j++;
      if (j >= n) throw new Error(`XML: unterminated <${tag}>`);
      const ch = xml.charCodeAt(j);
      if (ch === 62 /* > */) {
        j++;
        break;
      }
      if (ch === 47 /* / */) {
        if (xml.charCodeAt(j + 1) !== 62) throw new Error(`XML: malformed <${tag}>`);
        selfClosing = true;
        j += 2;
        break;
      }
      const eq = xml.indexOf('=', j);
      if (eq < 0) throw new Error(`XML: malformed attribute in <${tag}>`);
      const name = xml.slice(j, eq).trim();
      let q = eq + 1;
      while (q < n && isSpace(xml.charCodeAt(q))) q++;
      const quote = xml[q];
      if (quote !== '"' && quote !== "'") throw new Error(`XML: unquoted attribute ${name} in <${tag}>`);
      const end = xml.indexOf(quote, q + 1);
      if (end < 0) throw new Error(`XML: unterminated attribute ${name} in <${tag}>`);
      attrs[name] = decodeEntities(xml.slice(q + 1, end));
      j = end + 1;
    }
    handler.open(tag, attrs);
    if (selfClosing) handler.close(tag);
    else stack.push(tag);
    i = j;
  }
  if (stack.length) throw new Error(`XML: unclosed <${stack[stack.length - 1]}>`);
}
