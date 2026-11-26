import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import { describe, test } from 'node:test';
import ExcelJS from 'exceljs';
import { sha256 } from '../../src/core/fsx.ts';
import { ingestDocuments, mapHeader, segmentRequirements } from '../../src/plan/index.ts';
import { ingestSourceLedger } from '../../src/plan/ingest.ts';
import { docxBytes, pdfBytes, tempDir, zipStore } from './helpers.ts';

describe('spreadsheets: one row = one test case', () => {
  test('header heuristics map Korean and English column names', () => {
    assert.deepEqual(mapHeader(['TC ID', '화면', '시나리오', '사전조건', '절차', '기대결과', '실제결과', '비고']), [
      'id',
      'area',
      'title',
      'precondition',
      'steps',
      'expected',
      'ignore',
      null,
    ]);
    assert.deepEqual(mapHeader(['No.', 'Feature', 'Title', 'Preconditions', 'Steps', 'Expected Result', 'Status']), [
      'id',
      'area',
      'title',
      'precondition',
      'steps',
      'expected',
      'ignore',
    ]);
    assert.deepEqual(mapHeader(['번호', '기능', '제목', '단계', 'Expected']), ['id', 'area', 'title', 'steps', 'expected']);
  });

  test('csv with quoted multi-line cells', async () => {
    const dir = tempDir();
    const file = join(dir, 'cases.csv');
    const csv = '번호,기능,제목,단계,Expected,결과\r\n1,검색,편명 검색,"1. 검색 탭\r\n2. ""KE123"" 입력",결과 목록이 보인다,PASS\r\n\r\n2,출국장,대기시간,출국장 탭,분 단위로 보인다,\r\n';
    writeFileSync(file, csv);
    const docs = await ingestDocuments([file]);
    assert.equal(docs[0]!.kind, 'csv');
    assert.equal(docs[0]!.sha256, sha256(csv));
    const reqs = segmentRequirements(docs);
    assert.deepEqual(
      reqs.map((r) => [r.id, r.section, r.lines]),
      [
        ['cases#1', ['검색', '1 편명 검색'], [2, 2]],
        ['cases#2', ['출국장', '2 대기시간'], [5, 5]],
      ],
    );
    assert.equal(reqs[0]!.text, '번호: 1\n기능: 검색\n제목: 편명 검색\n단계: 1. 검색 탭\n2. "KE123" 입력\nExpected: 결과 목록이 보인다');
  });

  test('xlsx: title row above the header, execution columns dropped, sheet names in the section', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('로그인');
    ws.addRow(['떠남 QA 시나리오 v1']);
    ws.addRow(['TC ID', '화면', '시나리오', '사전조건', '절차', '기대결과', '실제결과']);
    ws.addRow(['TC-001', '홈', '내 항공편 카드', '저장된 항공편 있음', '1. 앱 실행\n2. 홈 확인', '편명과 출발 시각이 보인다', 'FAIL']);
    ws.addRow([]);
    ws.addRow(['TC-002', '출국장', '혼잡 단계', '', '출국장 탭', '원활/보통/혼잡/매우 혼잡 중 하나', '']);
    const other = wb.addWorksheet('주차');
    other.addRow(['항목', '기대 결과']);
    other.addRow(['빈자리', '숫자로 보인다']);
    const dir = tempDir();
    const file = join(dir, 'QA 시나리오.xlsx');
    await wb.xlsx.writeFile(file);

    const docs = await ingestDocuments([file]);
    assert.equal(docs[0]!.kind, 'xlsx');
    assert.equal(docs[0]!.slug, 'qa-시나리오');
    const reqs = segmentRequirements(docs);
    assert.deepEqual(
      reqs.map((r) => [r.id, r.section, r.lines]),
      [
        ['qa-시나리오#tc-001', ['로그인', '홈', 'TC-001 내 항공편 카드'], [3, 3]],
        ['qa-시나리오#tc-002', ['로그인', '출국장', 'TC-002 혼잡 단계'], [5, 5]],
        ['qa-시나리오#주차.2', ['주차', '빈자리'], [2, 2]],
      ],
    );
    assert.equal(reqs[0]!.text, 'TC ID: TC-001\n화면: 홈\n시나리오: 내 항공편 카드\n사전조건: 저장된 항공편 있음\n절차: 1. 앱 실행\n2. 홈 확인\n기대결과: 편명과 출발 시각이 보인다');
  });

  test('json array of objects and yaml trees', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'cases.json'), JSON.stringify([{ id: 'S1', title: '검색', steps: '편명 입력', expected: '결과' }]));
    writeFileSync(join(dir, 'spec.yaml'), '홈:\n  - 내 항공편 카드가 보인다\n  - 설정 버튼이 있다\n주차:\n  요금: 미리 보기만 한다\n');
    const reqs = segmentRequirements(await ingestDocuments([join(dir, 'cases.json'), join(dir, 'spec.yaml')]));
    assert.deepEqual(
      reqs.map((r) => [r.id, r.section, r.text]),
      [
        ['cases#s1', ['S1 검색'], 'id: S1\ntitle: 검색\nsteps: 편명 입력\nexpected: 결과'],
        ['spec#홈', ['홈'], '내 항공편 카드가 보인다'],
        ['spec#홈.2', ['홈'], '설정 버튼이 있다'],
        ['spec#요금', ['주차', '요금'], '미리 보기만 한다'],
      ],
    );
    assert.ok(reqs.every((r) => r.lines === null));
  });
});

describe('docx and pdf', () => {
  test('docx headings, bold-term definitions, paragraphs and tables (mammoth)', async () => {
    const dir = tempDir();
    const file = join(dir, '기획서.docx');
    writeFileSync(
      file,
      docxBytes(
        [
          '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>검색</w:t></w:r></w:p>',
          '<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>편명 검색</w:t></w:r><w:r><w:t xml:space="preserve">: 편명을 입력하면 결과 목록이 보인다.</w:t></w:r></w:p>',
          '<w:p><w:r><w:t>검색어가 비면 안내 문구를 보여 준다 &amp; 닫기 버튼이 있다.</w:t></w:r></w:p>',
          '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>화면</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>기대결과</w:t></w:r></w:p></w:tc></w:tr>',
          '<w:tr><w:tc><w:p><w:r><w:t>출국장</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>대기시간이 분 단위로 보인다</w:t></w:r></w:p></w:tc></w:tr></w:tbl>',
        ].join(''),
      ),
    );
    const docs = await ingestDocuments([file]);
    assert.equal(docs[0]!.kind, 'docx');
    const reqs = segmentRequirements(docs);
    assert.deepEqual(
      reqs.map((r) => [r.id, r.section, r.text, r.lines]),
      [
        ['기획서#편명-검색', ['검색', '편명 검색'], '**편명 검색**: 편명을 입력하면 결과 목록이 보인다.', null],
        ['기획서#검색', ['검색'], '검색어가 비면 안내 문구를 보여 준다 & 닫기 버튼이 있다.', null],
        ['기획서#검색.2', ['검색'], '화면: 출국장\n기대결과: 대기시간이 분 단위로 보인다', null],
      ],
    );
  });

  test('pdf text layer (unpdf), one section per page', async () => {
    const dir = tempDir();
    const file = join(dir, 'spec.pdf');
    writeFileSync(file, pdfBytes(['Search shows matching flights.', 'Parking tab lists free spaces.']));
    const docs = await ingestDocuments([file]);
    assert.equal(docs[0]!.kind, 'pdf');
    const reqs = segmentRequirements(docs);
    assert.equal(reqs.length, 1);
    assert.equal(reqs[0]!.id, 'spec#1쪽');
    assert.deepEqual(reqs[0]!.section, ['1쪽']);
    assert.match(reqs[0]!.text, /Search shows matching flights\./);
    assert.match(reqs[0]!.text, /Parking tab lists free spaces\./);
    assert.equal(reqs[0]!.lines, null);
  });
});

describe('sources', () => {
  test('globs and directories expand to sorted supported files; inline text is inline.md', async () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'b.md'), '# B\n\nb\n');
    writeFileSync(join(dir, 'a.txt'), 'a\n');
    writeFileSync(join(dir, 'notes.bin'), 'x');
    writeFileSync(join(dir, 'sub', 'c.md'), 'c\n');
    const viaGlob = await ingestDocuments(['*.{md,txt}'], { cwd: dir });
    assert.deepEqual(
      viaGlob.map((d) => [d.slug, d.kind]),
      [
        ['a', 'txt'],
        ['b', 'md'],
      ],
    );
    const viaDir = await ingestDocuments([dir], { text: '시나리오' });
    assert.deepEqual(
      viaDir.map((d) => d.slug),
      ['a', 'b', 'c', 'inline'],
    );
    assert.equal(viaDir.at(-1)!.path, 'inline.md');
    assert.equal(viaDir.at(-1)!.file, null);
  });

  test('missing, unmatched and unsupported sources are errors', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'x.bin'), 'x');
    await assert.rejects(ingestDocuments([join(dir, 'nope.md')]), /문서를 찾을 수 없습니다/);
    await assert.rejects(ingestDocuments(['*.md'], { cwd: dir }), /글롭에 맞는 문서가 없습니다/);
    await assert.rejects(ingestDocuments([join(dir, 'x.bin')]), /지원하지 않는 문서 형식/);
  });

  test('a path that the previous plan knew keeps its slug; others avoid it', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'spec.md'), 'x\n');
    const reserved = new Map([['somewhere/else/spec.md', 'spec']]);
    const [doc] = await ingestDocuments([join(dir, 'spec.md')], { reservedSlugs: reserved });
    assert.equal(doc!.slug, 'spec-2');
    const [same] = await ingestDocuments([join(dir, 'spec.md')], { reservedSlugs: new Map([[doc!.path, 'spec-7']]) });
    assert.equal(same!.slug, 'spec-7');
  });
});

function compressedZip(files: Record<string, string>, declaredSize?: number, unicodePath?: string): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text);
    const compressed = deflateRawSync(data);
    const nameBytes = Buffer.from(name);
    const checksum = crc32(data);
    const alternate = unicodePath === undefined ? Buffer.alloc(0) : Buffer.alloc(9 + Buffer.byteLength(unicodePath));
    if (unicodePath !== undefined) {
      alternate.writeUInt16LE(0x7075);
      alternate.writeUInt16LE(alternate.length - 4, 2);
      alternate[4] = 1;
      alternate.writeUInt32LE(crc32(nameBytes), 5);
      alternate.write(unicodePath, 9);
    }
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(unicodePath === undefined ? 0x0800 : 0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(declaredSize ?? data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(alternate.length, 28);
    parts.push(local, nameBytes, alternate, compressed);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(unicodePath === undefined ? 0x0800 : 0, 8);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt32LE(checksum, 16);
    entry.writeUInt32LE(compressed.length, 20);
    entry.writeUInt32LE(declaredSize ?? data.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt16LE(alternate.length, 30);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBytes, alternate);
    offset += local.length + nameBytes.length + alternate.length + compressed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}

describe('XLSX pre-parse budgets', () => {
  for (const [label, declaredSize] of [['declared expansion', undefined], ['dishonest expansion', 1]] as const) {
    test(`${label} produces one unresolved source rather than attempting a workbook parse`, async () => {
      const bytes = compressedZip({ 'xl/sharedStrings.xml': 'x'.repeat(8 * 1024 * 1024 + 1) }, declaredSize);
      assert.ok(bytes.length < 100_000);
      const ledger = await ingestSourceLedger(bytes, 'compressed.xlsx');
      assert.deepEqual(ledger.segments, [{ id: 'file', locator: 'file', text: '', kind: 'unparsed' }]);
      assert.equal(ledger.issues[0]!.code, 'source_xlsx_limit');
    });
  }

  test('aggregate expansion is bounded across individually allowed entries', async () => {
    const bytes = compressedZip(Object.fromEntries(Array.from({ length: 5 }, (_, index) => [`xl/media/${index}.bin`, 'x'.repeat(7 * 1024 * 1024)])));
    const ledger = await ingestSourceLedger(bytes, 'aggregate.xlsx');
    assert.deepEqual(ledger.segments, [{ id: 'file', locator: 'file', text: '', kind: 'unparsed' }]);
    assert.equal(ledger.issues[0]!.code, 'source_xlsx_limit');
  });

  for (const name of ['xl/worksheets/sheet1.xml.backup', 'xl/drawings/vmlDrawing1.vml']) {
    test(`${name} cannot bypass structural preflight through parser filename dispatch`, async () => {
      const bytes = zipStore({ [name]: '<worksheet>' + '<node>'.repeat(129) + '</node>'.repeat(129) + '</worksheet>' });
      const ledger = await ingestSourceLedger(bytes, 'alternate-extension.xlsx');
      assert.deepEqual(ledger.segments, [{ id: 'file', locator: 'file', text: '', kind: 'unparsed' }]);
      assert.equal(ledger.issues[0]!.code, 'source_xlsx_limit');
    });
  }

  test('a ZIP Unicode filename override cannot change which entry receives structural preflight', async () => {
    const bytes = compressedZip({ 'opaque.bin': '<worksheet><row r="100001"/></worksheet>' }, undefined, 'xl/worksheets/sheet1.xml');
    const ledger = await ingestSourceLedger(bytes, 'unicode-path.xlsx');
    assert.deepEqual(ledger.segments, [{ id: 'file', locator: 'file', text: '', kind: 'unparsed' }]);
    assert.equal(ledger.issues[0]!.code, 'source_xlsx_unreadable');
  });

  for (const [label, structure] of [
    ['sparse rows', '<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Readable prefix</t></is></c></row><row r="100001"><c r="A100001" t="inlineStr"><is><t>Last row</t></is></c></row></sheetData>'],
    ['merge expansion', '<mergeCells count="1"><mergeCell ref="A1:XFD1000"/></mergeCells>'],
    ['column expansion', '<cols><col min="1" max="100000"/></cols>'],
    ['XML depth', '<wrapper>'.repeat(129) + '</wrapper>'.repeat(129)],
    ['XML node count', '<metadata/>'.repeat(500_001)],
  ]) test(`${label} keeps the entire source unresolved, never just readable leading rows`, async () => {
    const bytes = zipStore({ 'xl/worksheets/sheet1.xml': `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${structure}</worksheet>` });
    const ledger = await ingestSourceLedger(bytes, 'structure.xlsx');
    assert.deepEqual(ledger.segments, [{ id: 'file', locator: 'file', text: '', kind: 'unparsed' }]);
    assert.equal(ledger.issues[0]!.code, 'source_xlsx_limit');
    const dir = tempDir();
    const path = join(dir, 'structure.xlsx');
    writeFileSync(path, bytes);
    await assert.rejects(ingestDocuments([path]), /XLSX.*(budget|limit)/);
  });
});
