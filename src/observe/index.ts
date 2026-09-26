// Observation public API (architecture §2).
import type { Platform, RawNode, Rect } from '../core/types.ts';
import { parseAndroidSource } from './android.ts';
import { parseIosSource } from './ios.ts';
import { parseWebSource } from './web.ts';

export { parseAndroidSource, parseIosSource, parseWebSource };
export { WEB_EXTRACT_SCRIPT, webSourceFromExtract } from './web.ts';
export { buildScreenModel, MAX_CANDIDATES, type ScreenModelOptions } from './normalize.ts';
export { isUnoccludedAt, topmostAt } from './occlusion.ts';
export { refind } from './refind.ts';
export { candidateRow, candidateRows, renderCandidateTable } from './table.ts';
export { normLabel } from './text.ts';
export { buildOcrHelper, runOcr, type OcrLine } from '../ocr/ocr.ts';

/** Page-source parser per platform (stored `rawSource` / fixtures → RawNode[]). Desktop sources are canonical web XML. */
export const SOURCE_PARSERS: Record<Platform, (xml: string, screen: Rect) => RawNode[]> = {
  android: parseAndroidSource,
  ios: parseIosSource,
  'desktop-chrome': parseWebSource,
  'desktop-safari': parseWebSource,
};
