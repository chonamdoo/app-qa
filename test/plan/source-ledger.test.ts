import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Worker } from 'node:worker_threads';
import ExcelJS from 'exceljs';
import { ingestSourceLedger } from '../../src/plan/ingest.ts';
import { docxBytes, pdfBytes } from './helpers.ts';

test('headerless CSV retains the first record, multiline expectations and historical results', async () => {
  const bytes = Buffer.from('TC-7,共通条件,"期待A\n期待B",FAIL\r\nTC-8,別条件,期待C,PASS\r\n');
  const ledger = await ingestSourceLedger(bytes, 'arbitrary.csv');
  assert.deepEqual(ledger.issues, []);
  assert.deepEqual(ledger.segments.map(segment => segment.text), ['TC-7', '共通条件', '期待A', '期待B', 'FAIL', 'TC-8', '別条件', '期待C', 'PASS']);
  assert.equal(ledger.segments[0]!.locator, 'record:1/column:1/line:1');
  assert.equal(ledger.segments[3]!.locator, 'record:1/column:3/line:2');
  assert.equal(ledger.segments[5]!.locator, 'record:3/column:1/line:1');
});

test('XLSX inventories every sheet, first row, merged common condition, note and expected value without column assumptions', async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('독자 양식');
  sheet.mergeCells('A1:C1'); sheet.getCell('A1').value = '모든 TC의 공통 로그인 전제';
  sheet.addRow(['원 TC-01', '행동', '기대A\n기대B', 'FAIL']);
  sheet.getCell('B2').note = '상세 근거';
  const hidden = workbook.addWorksheet('추가 조건', { state: 'hidden' });
  hidden.addRow(['숨겨진 원문도 보존']);
  const bytes = Buffer.from(await workbook.xlsx.writeBuffer());
  const ledger = await ingestSourceLedger(bytes, 'not-a-template.xlsx');
  assert.deepEqual(ledger.issues, []);
  assert.ok(ledger.segments.some(segment => segment.locator === `sheet:${sheet.id}!A1:C1/line:1` && segment.text === '모든 TC의 공통 로그인 전제'));
  assert.equal(ledger.segments.filter(segment => segment.text === '모든 TC의 공통 로그인 전제').length, 1);
  for (const text of ['원 TC-01', '기대A', '기대B', 'FAIL', '상세 근거', '숨겨진 원문도 보존']) assert.ok(ledger.segments.some(segment => segment.text === text), text);
});

test('spreadsheet images and formulas remain explicitly unqualified rather than sample expectations', async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('그림과 수식');
  sheet.getCell('A1').value = { formula: '1+1', result: 2 };
  sheet.getCell('A2').value = { formula: 'SUM(10,20)' };
  sheet.getCell('B1').value = '원문 기대값';
  const id = workbook.addImage({ base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lKcAAAAASUVORK5CYII=', extension: 'png' });
  sheet.addImage(id, 'B2:C3');
  const hidden = workbook.addWorksheet('숨겨진 그림', { state: 'hidden' });
  hidden.addImage(id, {
    tl: { col: 1.5, row: 2.25 }, ext: { width: 32, height: 24 },
    hyperlinks: { hyperlink: 'https://example.test/source', tooltip: '원문 링크' },
  });
  const background = workbook.addWorksheet('배경만 있는 시트');
  background.addBackgroundImage(id);
  const bytes = Buffer.from(await workbook.xlsx.writeBuffer());
  const original = Buffer.from(bytes);
  const ledger = await ingestSourceLedger(bytes, 'source.xlsx');
  assert.deepEqual(bytes, original);
  assert.deepEqual(ledger.segments.filter(segment => segment.kind === 'metadata').map(segment => segment.text),
    [sheet.name, hidden.name, background.name]);
  assert.deepEqual(ledger.segments.filter(segment => segment.kind === 'cell').map(segment => segment.text), ['2', '원문 기대값']);
  assert.deepEqual(ledger.issues.filter(issue => issue.code === 'source_formula_unverified').map(issue => issue.locator),
    [`sheet:${sheet.id}!A1`, `sheet:${sheet.id}!A2`]);
  const images = ledger.segments.filter(segment => segment.kind === 'image');
  assert.deepEqual(images.map(image => image.locator),
    [`sheet:${sheet.id}/image:1`, `sheet:${hidden.id}/image:1`, `sheet:${background.id}/background-image`]);
  assert.deepEqual(ledger.issues.filter(issue => issue.code === 'source_image_uninterpreted').map(issue => issue.locator),
    images.map(image => image.locator));
  assert.equal(new Set(images.map(image => image.id)).size, images.length);
  const [cellRange, positioned, backgroundImage] = images.map(image => JSON.parse(image.text));
  assert.equal(cellRange.imageId, positioned.imageId);
  assert.equal(cellRange.imageId, backgroundImage.imageId);
  for (const image of [cellRange, positioned, backgroundImage]) assert.equal(image.extension, 'png');
  assert.deepEqual(cellRange.range.tl, { col: 1, row: 1, nativeCol: 1, nativeRow: 1, nativeColOff: 0, nativeRowOff: 0 });
  assert.deepEqual(cellRange.range.br, { col: 3, row: 3, nativeCol: 3, nativeRow: 3, nativeColOff: 0, nativeRowOff: 0 });
  assert.equal(cellRange.range.ext, null);
  assert.equal(positioned.range.tl.col, 1.5);
  assert.equal(positioned.range.tl.row, 2.25);
  assert.equal(positioned.range.br, null);
  assert.deepEqual(positioned.range.ext, { width: 32, height: 24 });
  assert.deepEqual(positioned.range.hyperlinks, { hyperlink: 'https://example.test/source', tooltip: '원문 링크' });
  assert.equal(backgroundImage.range, null);
});

test('plain manual text retains original Unicode and exact line locators', async () => {
  const text = 'e\u0301 원 TC\r\n선행조건\r\n기대값 하나\n기대값 둘';
  const ledger = await ingestSourceLedger(Buffer.from(text), 'manual.txt');
  assert.deepEqual(ledger.segments.map(segment => segment.text), ['e\u0301 원 TC', '선행조건', '기대값 하나', '기대값 둘']);
  assert.deepEqual(ledger.segments.map(segment => segment.id), ['line:1', 'line:2', 'line:3', 'line:4']);
});

test('DOCX paragraphs/tables and PDF text never imply complete visual source interpretation', async () => {
  const docx = await ingestSourceLedger(docxBytes('<w:p><w:r><w:t>첫 문단 원문</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>원 결과 FAIL</w:t></w:r></w:p></w:tc></w:tr></w:tbl>'), 'source.docx');
  assert.ok(docx.segments.some(segment => segment.text.includes('첫 문단 원문')));
  assert.ok(docx.segments.some(segment => segment.text.includes('원 결과 FAIL')));
  assert.ok(docx.issues.some(issue => issue.code === 'source_structure_unverified'));
  const pdf = await ingestSourceLedger(pdfBytes(['Original PDF requirement']), 'source.pdf');
  assert.ok(pdf.issues.some(issue => issue.code === 'source_structure_unverified'));
  assert.ok(pdf.segments.some(segment => segment.kind === 'unparsed'));
});

test('unsupported images expose unresolved source location, never invented text', async () => {
  const ledger = await ingestSourceLedger(Buffer.from([137, 80, 78, 71]), 'source.png');
  assert.equal(ledger.segments[0]!.kind, 'unparsed');
  assert.equal(ledger.segments[0]!.text, '');
  assert.equal(ledger.segments[0]!.locator, 'file');
  assert.ok(ledger.issues.some(issue => issue.code === 'source_parser_unavailable'));
});

test('nested JSON preserves independent expectations, unknown fields, empty history and original numeric tokens', async () => {
  const raw = String.raw`[{"case":"FO-001","checks":["- 첫 기대값","","- 두 번째 기대값"],"result":{},"observed":{"PC":"FAIL"},"extra":{"a/b~c":9007199254740993,"__proto__":[null,false,-0,1e400],"empty":[],"escaped":"\u0061\n"}},{"case":"FO-001","checks":["- 다른 TC 기대값"]}]`;
  const bytes = Buffer.from(raw);
  const ledger = await ingestSourceLedger(bytes, 'not-an-excel-template.json');
  assert.deepEqual(ledger.issues, []);
  const actual = Object.fromEntries(ledger.segments.map(segment => [segment.id, segment.text]));
  assert.equal(actual['json:""'], '[');
  assert.equal(actual['json:"/0"'], '{');
  assert.equal(actual['json:"/1"'], '{');
  assert.equal(actual['json:"/0/checks/0"'], '"- 첫 기대값"');
  assert.equal(actual['json:"/0/checks/1"'], '""');
  assert.equal(actual['json:"/0/checks/2"'], '"- 두 번째 기대값"');
  assert.equal(actual['json:"/1/checks/0"'], '"- 다른 TC 기대값"');
  assert.equal(actual['json:"/0/result"'], '{}');
  assert.equal(actual['json:"/0/observed/PC"'], '"FAIL"');
  assert.equal(actual['json:"/0/extra/a~1b~0c"'], '9007199254740993');
  assert.equal(actual['json:"/0/extra/__proto__/0"'], 'null');
  assert.equal(actual['json:"/0/extra/__proto__/1"'], 'false');
  assert.equal(actual['json:"/0/extra/__proto__/2"'], '-0');
  assert.equal(actual['json:"/0/extra/__proto__/3"'], '1e400');
  assert.equal(actual['json:"/0/extra/empty"'], '[]');
  assert.equal(actual['json:"/0/extra/escaped"'], String.raw`"\u0061\n"`);
  assert.equal(actual['json:"/0/case"'], '"FO-001"');
  assert.equal(actual['json:"/1/case"'], '"FO-001"');
  assert.equal(bytes.toString('utf8'), raw);
});

test('JSON field locations do not depend on pretty printing or required TC field names', async () => {
  const input = { arbitrary: [{ '다른 형식': ['기대A', '기대B'], extra: { '': null, '\0': '\ud800' } }] };
  const compact = await ingestSourceLedger(Buffer.from(JSON.stringify(input)), 'compact.json');
  const pretty = await ingestSourceLedger(Buffer.from(JSON.stringify(input, null, 2)), 'pretty.json');
  assert.deepEqual(compact, pretty);
  assert.ok(compact.segments.some(segment => segment.id === 'json:"/arbitrary/0/extra/\\u0000"' && segment.text === '"\\ud800"'));
});

for (const [label, input, code] of [
  ['truncated row', '[{"tc_id":"FO-159","expected":["first"', 'source_json_invalid'],
  ['trailing comma', '[{"expected":["A",]}]', 'source_json_invalid'],
  ['comment', '{"expected":/* comment */"A"}', 'source_json_invalid'],
  ['unquoted key', '{expected:"A"}', 'source_json_invalid'],
  ['duplicate field', '{"expected":"A","expected":"B"}', 'source_json_duplicate_key'],
  ['escaped duplicate field', String.raw`{"expected":"A","\u0065xpected":"B"}`, 'source_json_duplicate_key'],
] as const) test(`JSON ${label} stays unresolved rather than importing partial or overwritten expectations`, async () => {
  const bytes = Buffer.from(input);
  const ledger = await ingestSourceLedger(bytes, 'source.json');
  assert.deepEqual(ledger.segments, [{ id: 'file', locator: 'file', text: '', kind: 'unparsed' }]);
  assert.equal(ledger.issues[0]!.code, code);
  assert.equal(bytes.toString('utf8'), input);
});

test('JSON structural limits do not publish a normal-looking prefix', async () => {
  for (const text of [JSON.stringify({ ['a'.repeat(1001)]: 'unread remainder' }), JSON.stringify(Array(100_001).fill('requirement'))]) {
    const ledger = await ingestSourceLedger(Buffer.from(text), 'large.json');
    assert.equal(ledger.issues[0]!.code, 'source_json_limit');
    assert.deepEqual(ledger.segments, [{ id: 'file', locator: 'file', text: '', kind: 'unparsed' }]);
  }
});

test('JSON node exhaustion is refused inside a bounded parser heap', { timeout: 15_000 }, async t => {
  const moduleURL = new URL('../../src/core/source-json.ts', import.meta.url).href;
  const worker = new Worker(`const { parentPort } = require('node:worker_threads');
    import(${JSON.stringify(moduleURL)}).then(({ jsonSourceLedger }) => {
      parentPort.postMessage(jsonSourceLedger('[' + '0,'.repeat(400_000) + '0]'));
    });`, { eval: true, resourceLimits: { maxOldGenerationSizeMb: 128 } });
  t.after(async () => { await worker.terminate(); });
  const result = await new Promise<{ segments: { kind: string }[]; issues: { code: string }[] }>((resolve, reject) => {
    let received = false;
    worker.once('message', value => { received = true; resolve(value); });
    worker.once('error', reject);
    worker.once('exit', code => { if (!received) reject(new Error(`Parser exited without a bounded result: ${code}`)); });
  });
  assert.deepEqual(result.issues.map(issue => issue.code), ['source_json_limit']);
  assert.deepEqual(result.segments.map(segment => segment.kind), ['unparsed']);
});
