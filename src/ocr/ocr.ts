// Apple Vision OCR through the prebuilt `.tools/bin/qa-ocr` helper; boxes are converted to tap coordinates.
import { execFile } from 'node:child_process';
import { mkdtemp, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { PATHS } from '../core/config.ts';
import { ensureDir } from '../core/fsx.ts';
import type { Rect } from '../core/types.ts';

const run = promisify(execFile);

export interface OcrLine {
  text: string;
  /** Vision confidence 0…1. */
  confidence: number;
  /** Tap coordinates (Android px / iOS pt), clamped to the screen. */
  rect: Rect;
}

export const OCR_HELPER = join(PATHS.bin, 'qa-ocr');
const SOURCE = fileURLToPath(new URL('./ocr.swift', import.meta.url));

let building: Promise<string> | null = null;

/**
 * Compiles `src/ocr/ocr.swift` with `swiftc -O` into `.tools/bin/qa-ocr` (atomic rename) unless the binary is newer
 * than the source. Idempotent; returns the binary path. Throws when not on macOS, swiftc is missing or compile fails.
 */
export function buildOcrHelper(): Promise<string> {
  building ??= (async () => {
    if (process.platform !== 'darwin') throw new Error('OCR 도우미는 macOS(Apple Vision)에서만 빌드할 수 있습니다.');
    const [src, bin] = await Promise.all([stat(SOURCE), stat(OCR_HELPER).catch(() => null)]);
    if (bin && bin.mtimeMs >= src.mtimeMs) return OCR_HELPER;
    ensureDir(PATHS.bin);
    const tmp = `${OCR_HELPER}.${process.pid}.tmp`;
    try {
      await run('swiftc', ['-O', SOURCE, '-o', tmp], { timeout: 600_000, maxBuffer: 16 << 20 });
    } catch (e) {
      await rm(tmp, { force: true });
      const err = e as NodeJS.ErrnoException & { stderr?: string };
      if (err.code === 'ENOENT') throw new Error('swiftc를 찾을 수 없습니다. Xcode 명령줄 도구를 설치하세요: xcode-select --install');
      throw new Error(`OCR 도우미 빌드 실패: ${(err.stderr || err.message).trim()}`);
    }
    await rename(tmp, OCR_HELPER);
    return OCR_HELPER;
  })().finally(() => {
    building = null;
  });
  return building;
}

function isNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Converts qa-ocr JSON to lines in tap coordinates. Boxes are normalized to the image, so scaling by the screen size
 * maps screenshot pixels to taps (iOS @3x 1206×2622 px → 402×874 pt). Rejects screenshots whose aspect ratio does
 * not match the screen (rotated / cropped capture) instead of returning wrong coordinates.
 */
export function parseOcrOutput(json: string, screen: Rect): OcrLine[] {
  const out = JSON.parse(json) as { width?: unknown; height?: unknown; items?: unknown };
  if (!isNumber(out.width) || !isNumber(out.height) || out.width <= 0 || out.height <= 0 || !Array.isArray(out.items)) {
    throw new Error('OCR 결과 형식이 올바르지 않습니다.');
  }
  const ratio = out.width / out.height / (screen.width / screen.height);
  if (Math.abs(ratio - 1) > 0.02) {
    throw new Error(`스크린샷 비율(${out.width}×${out.height})이 화면(${screen.width}×${screen.height})과 다릅니다.`);
  }
  const lines: OcrLine[] = [];
  for (const item of out.items as { text?: unknown; confidence?: unknown; box?: unknown }[]) {
    const box = item.box;
    if (typeof item.text !== 'string' || !isNumber(item.confidence) || !Array.isArray(box) || box.length !== 4 || !box.every(isNumber)) {
      throw new Error('OCR 결과 항목 형식이 올바르지 않습니다.');
    }
    const text = item.text.normalize('NFC').trim();
    if (!text) continue;
    const [bx, by, bw, bh] = box as [number, number, number, number];
    const x1 = Math.max(0, Math.min(1, bx));
    const y1 = Math.max(0, Math.min(1, by));
    const x2 = Math.max(x1, Math.min(1, bx + bw));
    const y2 = Math.max(y1, Math.min(1, by + bh));
    const x = Math.round(screen.x + x1 * screen.width);
    const y = Math.round(screen.y + y1 * screen.height);
    lines.push({
      text,
      confidence: item.confidence,
      rect: {
        x,
        y,
        width: Math.round(screen.x + x2 * screen.width) - x,
        height: Math.round(screen.y + y2 * screen.height) - y,
      },
    });
  }
  return lines;
}

/** Runs Vision OCR on a PNG screenshot of `screen` (builds the helper first if needed). */
export async function runOcr(png: Uint8Array, screen: Rect): Promise<OcrLine[]> {
  const helper = await buildOcrHelper();
  const dir = await mkdtemp(join(tmpdir(), 'qa-ocr-'));
  const file = join(dir, 'screen.png');
  try {
    await writeFile(file, png, { mode: 0o600 });
    const { stdout } = await run(helper, [file], { timeout: 30_000, maxBuffer: 32 << 20 });
    return parseOcrOutput(stdout, screen);
  } catch (e) {
    const err = e as Error & { stderr?: string };
    throw new Error(`OCR 실행 실패: ${(err.stderr || err.message).trim()}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
