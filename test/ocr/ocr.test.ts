import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { PATHS } from '../../src/core/config.ts';
import { buildOcrHelper, parseOcrOutput, runOcr } from '../../src/ocr/ocr.ts';

const IOS_SCREEN = { x: 0, y: 0, width: 402, height: 874 };

describe('parseOcrOutput', () => {
  it('maps normalized boxes of an @3x screenshot to point tap coordinates', () => {
    const json = JSON.stringify({
      secs: 0.3,
      width: 1206,
      height: 2622,
      items: [{ text: '항공편 찾기'.normalize('NFD'), confidence: 1, box: [0.5, 0.5, 0.1, 0.02] }],
    });
    assert.deepEqual(parseOcrOutput(json, IOS_SCREEN), [
      { text: '항공편 찾기', confidence: 1, rect: { x: 201, y: 437, width: 40, height: 17 } },
    ]);
  });

  it('clamps boxes to the screen and skips empty text', () => {
    const json = JSON.stringify({
      width: 1080,
      height: 2400,
      items: [
        { text: 'edge', confidence: 0.5, box: [0.95, -0.01, 0.1, 0.05] },
        { text: '  ', confidence: 1, box: [0, 0, 0.1, 0.1] },
      ],
    });
    assert.deepEqual(parseOcrOutput(json, { x: 0, y: 0, width: 1080, height: 2400 }), [
      { text: 'edge', confidence: 0.5, rect: { x: 1026, y: 0, width: 54, height: 96 } },
    ]);
  });

  it('rejects a screenshot whose aspect ratio does not match the screen', () => {
    const json = JSON.stringify({ width: 2622, height: 1206, items: [] });
    assert.throws(() => parseOcrOutput(json, IOS_SCREEN), /비율/);
  });

  it('rejects malformed helper output', () => {
    assert.throws(() => parseOcrOutput(JSON.stringify({ width: 1206, height: 2622, items: [{ text: 1 }] }), IOS_SCREEN), /형식/);
    assert.throws(() => parseOcrOutput('{}', IOS_SCREEN), /형식/);
  });
});

const hasSwiftc = process.platform === 'darwin' && spawnSync('swiftc', ['--version']).status === 0;

describe('Vision OCR helper', { skip: hasSwiftc ? false : 'swiftc(macOS Xcode 명령줄 도구)가 없어 OCR 도우미를 빌드할 수 없음' }, () => {
  it('builds idempotently and reads the kroute launch screen in point coordinates', async () => {
    const helper = await buildOcrHelper();
    assert.equal(helper, join(PATHS.bin, 'qa-ocr'));
    assert.equal(await buildOcrHelper(), helper);
    const png = readFileSync(join(PATHS.fixtures, 'ios/kroute/launch.png'));
    const lines = await runOcr(png, IOS_SCREEN);
    assert.ok(lines.length > 0);
    for (const l of lines) {
      assert.ok(l.rect.x >= 0 && l.rect.y >= 0, JSON.stringify(l));
      assert.ok(l.rect.x + l.rect.width <= 402 && l.rect.y + l.rect.height <= 874, JSON.stringify(l));
    }
    // The tree's StaticText sits at 116,427 170×20 pt; the OCR line must land on it (pixel → point conversion).
    const smoke = lines.find((l) => l.text.includes('Local URI'));
    assert.ok(smoke, JSON.stringify(lines.map((l) => l.text)));
    const cx = smoke.rect.x + smoke.rect.width / 2;
    const cy = smoke.rect.y + smoke.rect.height / 2;
    assert.ok(cx >= 116 && cx <= 286 && cy >= 427 && cy <= 447, JSON.stringify(smoke.rect));
  });
});
