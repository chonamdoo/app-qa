// Health rules checked after every settle (architecture §5): foreground app, crash/ANR dialogs, RN RedBox/LogBox,
// Flutter errors and blank screens. Deterministic only; a FAIL finding fails the step and attaches logs.
import type { HealthFinding, ScreenModel } from '../core/types.ts';
import { colorStats, type Raster } from './image.ts';

interface Rule {
  kind: HealthFinding['kind'];
  severity: HealthFinding['severity'];
  re: RegExp;
}

const TEXT_RULES: readonly Rule[] = [
  { kind: 'crash_dialog', severity: 'fail', re: /계속 중지됨|keeps stopping|has stopped|이\(가\) 중지되었습니다/i },
  { kind: 'anr_dialog', severity: 'fail', re: /응답하지 않음|응답하지 않습니다|isn't responding|is not responding/i },
  { kind: 'rn_redbox', severity: 'fail', re: /^DISMISS \(ESC\)$|^RELOAD \(R, R\)$|Unable to resolve module|UnableToResolveError/ },
  { kind: 'rn_logbox_error', severity: 'fail', re: /^(Render Error|Uncaught Error|Syntax Error)$/ },
  { kind: 'flutter_error', severity: 'fail', re: /RenderFlex overflowed|Another exception was thrown/ },
  { kind: 'rn_logbox_warning', severity: 'warn', re: /Open debugger to view (warnings|errors)/i },
];

const LOGBOX_PAGER = /^Log \d+ of \d+$/;
/** Share of one colour bucket above which an empty tree counts as a blank screen. */
const BLANK_SHARE = 0.98;
/** Share of saturated red pixels that marks a full-screen RedBox even without its buttons in the tree. */
const REDBOX_SHARE = 0.5;

/**
 * Text lines the health rules scan: visible texts plus candidate names (RN folds button text into the label) and
 * resource ids (RedBox views are named `rn_redbox_*`).
 */
function healthLines(model: ScreenModel): string[] {
  const lines = new Set<string>(model.texts);
  for (const c of model.candidates) lines.add(c.name);
  return [...lines];
}

export function checkHealth(model: ScreenModel, screenshot: Raster | null, appId: string): HealthFinding[] {
  const findings: HealthFinding[] = [];
  const fg = model.snapshot.foregroundApp;
  if (fg && fg !== appId) findings.push({ kind: 'app_not_foreground', severity: 'fail', evidence: `포그라운드 앱 ${fg} ≠ ${appId}` });
  const lines = healthLines(model);
  const seen = new Set<string>();
  for (const rule of TEXT_RULES) {
    const hit = lines.find((l) => rule.re.test(l));
    if (hit && !seen.has(rule.kind)) {
      seen.add(rule.kind);
      findings.push({ kind: rule.kind, severity: rule.severity, evidence: hit.slice(0, 200) });
    }
  }
  if (!seen.has('rn_redbox') && model.snapshot.nodes.some((n) => n.resourceId?.includes('rn_redbox'))) {
    seen.add('rn_redbox');
    findings.push({ kind: 'rn_redbox', severity: 'fail', evidence: 'rn_redbox 뷰가 화면에 있음' });
  }
  if (!seen.has('rn_logbox_error') && lines.some((l) => LOGBOX_PAGER.test(l)) && lines.includes('Dismiss') && lines.includes('Minimize')) {
    seen.add('rn_logbox_error');
    findings.push({ kind: 'rn_logbox_error', severity: 'fail', evidence: lines.find((l) => LOGBOX_PAGER.test(l))! });
  }
  if (screenshot) {
    const stats = colorStats(screenshot);
    if (!seen.has('rn_redbox') && stats.redShare >= REDBOX_SHARE) {
      findings.push({ kind: 'rn_redbox', severity: 'fail', evidence: `빨간 전체 화면 (${Math.round(stats.redShare * 100)}%)` });
    }
    if (model.candidates.length === 0 && model.texts.length === 0 && stats.dominantShare >= BLANK_SHARE) {
      findings.push({ kind: 'blank_screen', severity: 'fail', evidence: `트리·OCR 비어 있고 단색 ${Math.round(stats.dominantShare * 100)}%` });
    }
  }
  return findings;
}
