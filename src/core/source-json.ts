import { isMap, isScalar, isSeq, parseDocument } from 'yaml';
export interface JSONSourceLedger {
  segments: { id: string; locator: string; text: string; kind: 'text' | 'metadata' | 'unparsed' }[];
  issues: { code: string; locator: string; message: string }[];
  jsonRows?: { index: number; startByte: number; endByte: number }[];
}

function withinStructureBudget(text: string): boolean {
  const separators = ' \t\r\n{}[]:,';
  let index = 0, values = 0, depth = 0, rootObjects = 0;
  let rootArray = false, onlyRootObjects = true;
  const value = (kind: string): boolean => {
    if (++values > 100_000) return false;
    if (values === 1) rootArray = kind === '[';
    else if (rootArray && depth === 1) {
      if (kind === '{') rootObjects++;
      else onlyRootObjects = false;
    }
    return true;
  };
  while (index < text.length) {
    const start = index, kind = text[index]!;
    if (kind === '"') {
      index++;
      while (index < text.length) {
        if (text[index] === '\\') index += 2;
        else if (text[index++] === '"') break;
      }
      if (index - start > 1_000_000) return false;
      let next = index;
      while (next < text.length && ' \t\r\n'.includes(text[next]!)) next++;
      if (text[next] !== ':' && !value(kind)) return false;
    } else if (kind === '[' || kind === '{') {
      if (!value(kind)) return false;
      depth++; index++;
    } else if (kind === ']' || kind === '}') {
      depth--; index++;
    } else if (separators.includes(kind)) index++;
    else {
      while (index < text.length && !separators.includes(text[index]!) && text[index] !== '"') index++;
      if (index - start > 1_000_000 || !value(kind)) return false;
    }
  }
  return !rootArray || !onlyRootObjects || rootObjects <= 5000;
}

export function jsonSourceLedger(text: string): JSONSourceLedger {
  const unresolved = (code: string, locator: string, message: string): JSONSourceLedger => ({
    segments: [{ id: 'file', locator: 'file', text: '', kind: 'unparsed' }],
    issues: [{ code, locator, message }],
  });
  const limit = () => unresolved('source_json_limit', 'file', 'JSON 구조 분석 한도를 초과했습니다. 원본은 보존하며 일부 구간을 전체로 표시하지 않습니다.');
  if (text.length > 8_000_000 || !withinStructureBudget(text)) return limit();
  try { JSON.parse(text); }
  catch (error) {
    const position = error instanceof Error ? /position (\d+)/.exec(error.message)?.[1] : undefined;
    return unresolved('source_json_invalid', position ? `utf16:${position}` : 'file', 'JSON 문법 또는 중간 절단을 확인하세요. 누락된 내용을 자동 생성하거나 일부 TC만 정상 입력으로 간주하지 않습니다.');
  }
  // JSON.parse checks grammar; the YAML AST supplies only lossless token ranges.
  let document: ReturnType<typeof parseDocument>;
  try { document = parseDocument(text, { schema: 'json', uniqueKeys: false, prettyErrors: false }); }
  catch { return unresolved('source_json_structure_unverified', 'file', 'JSON 원문 구조를 읽지 못했습니다. 원본을 직접 확인하세요.'); }
  if (document.errors.length || document.warnings.length) {
    return unresolved('source_json_structure_unverified', 'file', 'JSON 원문 구조를 손실 없이 읽지 못했습니다. 원본을 직접 확인하세요.');
  }
  const ledger: JSONSourceLedger = { segments: [], issues: [] };
  const stack: { node: unknown; pointer: string }[] = [{ node: document.contents, pointer: '' }];
  let queued = 1;
  while (stack.length) {
    const { node, pointer } = stack.pop()!;
    const id = `json:${JSON.stringify(pointer)}`;
    if (id.length > 1000) return limit();
    if (!isScalar(node) && !isMap(node) && !isSeq(node) || !node.range) {
      return unresolved('source_json_structure_unverified', id, 'JSON 구간의 정확한 원문 위치를 확인하지 못했습니다.');
    }
    const container = isMap(node) || isSeq(node);
    const token = text.slice(node.range[0], container && node.items.length ? node.range[0] + 1 : node.range[1]);
    if (token.length > 1_000_000) return limit();
    ledger.segments.push({ id, locator: id, text: token, kind: container ? 'metadata' : 'text' });
    if (isMap(node)) {
      const keys = new Set<string>();
      const children: { node: unknown; pointer: string }[] = [];
      for (const pair of node.items) {
        if (!isScalar(pair.key) || !pair.key.range) {
          return unresolved('source_json_structure_unverified', id, 'JSON 필드의 식별값을 확인하지 못했습니다.');
        }
        let key: unknown;
        try { key = JSON.parse(text.slice(pair.key.range[0], pair.key.range[1])); }
        catch { return unresolved('source_json_structure_unverified', id, 'JSON 필드의 정확한 원문을 확인하지 못했습니다.'); }
        if (typeof key !== 'string') return unresolved('source_json_structure_unverified', id, 'JSON 필드의 식별값을 확인하지 못했습니다.');
        if (keys.has(key)) return unresolved('source_json_duplicate_key', `utf16:${pair.key.range?.[0] ?? node.range[0]}`, '같은 객체에 중복 필드가 있습니다. 앞선 값을 덮어쓰지 않으며 원본의 어느 값이 기준인지 확인해야 합니다.');
        keys.add(key);
        if (++queued > 100_000) return limit();
        children.push({ node: pair.value, pointer: `${pointer}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}` });
      }
      for (let index = children.length - 1; index >= 0; index--) stack.push(children[index]!);
    } else if (isSeq(node)) {
      if ((queued += node.items.length) > 100_000) return limit();
      for (let index = node.items.length - 1; index >= 0; index--) stack.push({ node: node.items[index], pointer: `${pointer}/${index}` });
    }
  }
  const root = document.contents;
  if (isSeq(root) && root.items.length && root.items.every(isMap)) {
    if (root.items.length > 5000) return limit();
    let character = 0;
    let byte = 0;
    ledger.jsonRows = root.items.map((item, index) => {
      const [start, end] = item.range!;
      byte += Buffer.byteLength(text.slice(character, start), 'utf8');
      const startByte = byte;
      byte += Buffer.byteLength(text.slice(start, end), 'utf8');
      character = end;
      return { index, startByte, endByte: byte };
    });
  }
  return ledger;
}
