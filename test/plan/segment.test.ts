import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { sha256 } from '../../src/core/fsx.ts';
import { ingestDocuments, segmentRequirements, slugify } from '../../src/plan/index.ts';
import { tempDir } from './helpers.ts';

const CONTEXT = join(import.meta.dirname, '..', 'fixtures', 'docs', 'tteonam-context.md');

async function segmentText(text: string) {
  return segmentRequirements(await ingestDocuments([], { text }));
}

describe('markdown segmentation (떠남 CONTEXT.md)', () => {
  test('bold-term definitions become units under their heading path, _Avoid_ kept with the term', async () => {
    const reqs = segmentRequirements(await ingestDocuments([CONTEXT]));
    const congestion = reqs.find((r) => r.id === 'tteonam-context#혼잡-단계');
    assert.ok(congestion);
    assert.deepEqual(congestion.section, ['떠남', '터미널과 출국장', '혼잡 단계']);
    assert.match(congestion.text, /원활\(20분 미만\)/);
    assert.equal(congestion.digest, sha256(congestion.text));

    const gate = reqs.find((r) => r.id === 'tteonam-context#게이트')!;
    assert.equal(gate.text, '**게이트**:\n비행기에 타는 탑승구. 번호로 불러요.\n_Avoid_: 탑승 게이트, 출국 게이트, 출국장');
    assert.deepEqual(gate.lines, [26, 28]);
    // `_Avoid_` lines never become requirements of their own.
    assert.ok(reqs.every((r) => !r.text.startsWith('_Avoid_')));
    // The intro paragraph belongs to the H1.
    assert.deepEqual(reqs[0]!.section, ['떠남']);
    assert.equal(reqs[0]!.id, 'tteonam-context#떠남');
    assert.equal(reqs.length, 26); // intro + 25 glossary terms
  });

  test('ids, texts and digests are identical across runs', async () => {
    const a = segmentRequirements(await ingestDocuments([CONTEXT]));
    const b = segmentRequirements(await ingestDocuments([CONTEXT]));
    assert.deepEqual(a, b);
    assert.equal(new Set(a.map((r) => r.id)).size, a.length, 'ids are unique');
  });

  test('an _Avoid_ line separated by a blank line still attaches to its term', async () => {
    const reqs = await segmentText('## 용어\n\n**탑승 시작**:\n출발 40분 전.\n\n_Avoid_: 보딩\n\n다음 문단.\n');
    assert.equal(reqs.length, 2);
    assert.equal(reqs[0]!.text, '**탑승 시작**:\n출발 40분 전.\n\n_Avoid_: 보딩');
    assert.deepEqual(reqs[0]!.section, ['용어', '탑승 시작']);
    assert.equal(reqs[1]!.id, 'inline#용어');
  });
});

describe('markdown units', () => {
  test('list items, lead-in lists, tables and repeated sections', async () => {
    const md = [
      '# 검색',
      '',
      '- 편명으로 찾는다',
      '  - 대소문자 무시',
      '- 도시로 찾는다',
      '',
      '결과는 다음을 보여 준다:',
      '- 출발 시각',
      '- 게이트',
      '',
      '| 화면 | 기대 결과 |',
      '|---|---|',
      '| 출국장 | 대기시간이 분으로 보인다 |',
      '| 주차 \\| 요금 | 빈자리가 보인다 |',
      '',
      '## 검색',
      '',
      '두 번째 검색 절.',
    ].join('\n');
    const reqs = await segmentText(md);
    assert.deepEqual(
      reqs.map((r) => [r.id, r.lines]),
      [
        ['inline#검색', [3, 4]],
        ['inline#검색.2', [5, 5]],
        ['inline#검색.3', [7, 9]],
        ['inline#검색.4', [13, 13]],
        ['inline#검색.5', [14, 14]],
        ['inline#검색.6', [18, 18]],
      ],
    );
    assert.equal(reqs[0]!.text, '- 편명으로 찾는다\n  - 대소문자 무시');
    assert.equal(reqs[3]!.text, '화면: 출국장\n기대 결과: 대기시간이 분으로 보인다');
    assert.equal(reqs[4]!.text, '화면: 주차 | 요금\n기대 결과: 빈자리가 보인다');
    assert.deepEqual(reqs[5]!.section, ['검색', '검색']);
  });

  test('text without headings, front matter and comments', async () => {
    const reqs = await segmentText('---\ntitle: x\n---\n<!-- 메모 -->\n첫 문단\n이어짐\n\n둘째 문단\n');
    assert.deepEqual(
      reqs.map((r) => [r.id, r.text]),
      [
        ['inline#body', '첫 문단\n이어짐'],
        ['inline#body.2', '둘째 문단'],
      ],
    );
  });

  test('document slugs are Korean-safe and unique per plan', async () => {
    assert.equal(slugify('출국장 동편 / 서편'), '출국장-동편-서편');
    assert.equal(slugify('**CONTEXT**.md'), 'context-md');
    const dir = tempDir();
    writeFileSync(join(dir, '기획서.md'), '# 홈\n\n본문\n');
    const other = tempDir();
    writeFileSync(join(other, '기획서.md'), '# 홈\n\n다른 본문\n');
    const docs = await ingestDocuments([join(dir, '기획서.md'), join(other, '기획서.md')]);
    assert.deepEqual(
      docs.map((d) => d.slug),
      ['기획서', '기획서-2'],
    );
    assert.deepEqual(
      segmentRequirements(docs).map((r) => r.id),
      ['기획서#홈', '기획서-2#홈'],
    );
  });
});
