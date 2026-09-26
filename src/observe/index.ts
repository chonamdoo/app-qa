// Observation public API (architecture §2).
export { parseAndroidSource } from './android.ts';
export { parseIosSource } from './ios.ts';
export { buildScreenModel, MAX_CANDIDATES, type ScreenModelOptions } from './normalize.ts';
export { isUnoccludedAt, topmostAt } from './occlusion.ts';
export { refind } from './refind.ts';
export { candidateRow, candidateRows, renderCandidateTable } from './table.ts';
export { normLabel } from './text.ts';
export { buildOcrHelper, runOcr, type OcrLine } from '../ocr/ocr.ts';
