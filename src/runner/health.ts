// Health rules checked after every settle (architecture §5): foreground app, crash/ANR dialogs, RN RedBox/LogBox,
// Flutter errors and blank screens; on websites also browser error pages and navigation outside the allowed origins.
// Deterministic only; a FAIL finding fails the step and attaches logs.
import { PLATFORM_INFO } from '../core/platform.ts';
import type { AppTarget, HealthFinding, ScreenModel, Surface, WebTarget } from '../core/types.ts';
import { colorStats, type Raster } from './image.ts';

interface Rule {
  kind: HealthFinding['kind'];
  severity: HealthFinding['severity'];
  re: RegExp;
  /** Surfaces the rule applies to: RN/Flutter overlays exist only in apps, browser error pages only on websites. */
  on: readonly Surface[];
}

const ANY: readonly Surface[] = ['app', 'web'];
const APP: readonly Surface[] = ['app'];
const WEB: readonly Surface[] = ['web'];

const TEXT_RULES: readonly Rule[] = [
  { kind: 'crash_dialog', severity: 'fail', re: /계속 중지됨|keeps stopping|has stopped|이\(가\) 중지되었습니다/i, on: ANY },
  { kind: 'anr_dialog', severity: 'fail', re: /응답하지 않음|응답하지 않습니다|isn't responding|is not responding/i, on: ANY },
  { kind: 'rn_redbox', severity: 'fail', re: /^DISMISS \(ESC\)$|^RELOAD \(R, R\)$|Unable to resolve module|UnableToResolveError/, on: APP },
  { kind: 'rn_logbox_error', severity: 'fail', re: /^(Render Error|Uncaught Error|Syntax Error)$/, on: APP },
  { kind: 'flutter_error', severity: 'fail', re: /RenderFlex overflowed|Another exception was thrown/, on: APP },
  { kind: 'rn_logbox_warning', severity: 'warn', re: /Open debugger to view (warnings|errors)/i, on: APP },
  // Chrome (net error code and title) and Safari error pages, Korean and English.
  {
    kind: 'page_load_error',
    severity: 'fail',
    re: /\bERR_[A-Z_]+\b|사이트에 연결할 수 없음|This site can[’']t be reached|Safari에서 페이지를 열 수 없습니다|Safari Can[’']t Open the Page|서버에 연결할 수 없음/,
    on: WEB,
  },
];

const LOGBOX_PAGER = /^Log \d+ of \d+$/;
/** Share of one colour bucket above which an empty tree counts as a blank screen. */
const BLANK_SHARE = 0.98;
/** Share of saturated red pixels that marks a full-screen RedBox even without its buttons in the tree. */
const REDBOX_SHARE = 0.5;
/** Invisible direction marks Safari wraps the address-bar host in (`\u200Elocalhost`). */
const BIDI_MARKS = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
const HAS_SCHEME = /^[a-z][a-z\d+.-]*:\/\//i;
/** Browsers show `www.example.com` as `example.com`. */
const WWW = /^www\./;

/**
 * Text lines the health rules scan: visible texts plus candidate names (RN folds button text into the label) and
 * resource ids (RedBox views are named `rn_redbox_*`).
 */
function healthLines(model: ScreenModel): string[] {
  const lines = new Set<string>(model.texts);
  for (const c of model.candidates) lines.add(c.name);
  return [...lines];
}

/**
 * Why the page the browser shows is outside the target's origins, or null (inside, or the browser does not tell).
 * Desktop reports the full `location.href`; a mobile address bar shows `host[:port]` (Safari omits the port, both may
 * drop `www.`) or, while focused, the full URL. Text that is not an address (a hint, a search term) tells nothing.
 */
function originProblem(pageUrl: string, target: WebTarget): string | null {
  const allowed = target.origins.join(', ');
  if (PLATFORM_INFO[target.platform].host === 'desktop') {
    let origin = 'null';
    try {
      origin = new URL(pageUrl).origin;
    } catch {
      // Unparseable href: origin stays 'null', which no allowed origin equals.
    }
    return target.origins.includes(origin) ? null : `페이지 ${origin} — 허용 origin(${allowed}) 밖`;
  }
  const shown = pageUrl.replace(BIDI_MARKS, '').trim();
  if (!shown || /\s/.test(shown)) return null;
  const full = HAS_SCHEME.test(shown);
  let url: URL;
  try {
    url = new URL(full ? shown : `http://${shown}`);
  } catch {
    return null;
  }
  const inside = target.origins.some((o) => {
    const origin = new URL(o);
    if (full) return origin.origin === url.origin;
    // Safari shows no port: compare host names then; a shown port must match the origin's.
    return url.port ? origin.host.replace(WWW, '') === url.host.replace(WWW, '') : origin.hostname.replace(WWW, '') === url.hostname.replace(WWW, '');
  });
  return inside ? null : `주소창 ${shown} — 허용 origin(${allowed}) 밖`;
}

export function checkHealth(model: ScreenModel, screenshot: Raster | null, target: AppTarget): HealthFinding[] {
  const findings: HealthFinding[] = [];
  const fg = model.snapshot.foregroundApp;
  if (fg && fg !== target.appId) findings.push({ kind: 'app_not_foreground', severity: 'fail', evidence: `포그라운드 앱 ${fg} ≠ ${target.appId}` });
  const lines = healthLines(model);
  const seen = new Set<string>();
  for (const rule of TEXT_RULES) {
    if (!rule.on.includes(target.kind)) continue;
    const hit = lines.find((l) => rule.re.test(l));
    if (hit && !seen.has(rule.kind)) {
      seen.add(rule.kind);
      findings.push({ kind: rule.kind, severity: rule.severity, evidence: hit.slice(0, 200) });
    }
  }
  if (target.kind === 'web') {
    const pageUrl = model.snapshot.pageUrl;
    const problem = pageUrl === null ? null : originProblem(pageUrl, target);
    if (problem) findings.push({ kind: 'origin_mismatch', severity: 'fail', evidence: problem });
  } else {
    if (!seen.has('rn_redbox') && model.snapshot.nodes.some((n) => n.resourceId?.includes('rn_redbox'))) {
      seen.add('rn_redbox');
      findings.push({ kind: 'rn_redbox', severity: 'fail', evidence: 'rn_redbox 뷰가 화면에 있음' });
    }
    if (!seen.has('rn_logbox_error') && lines.some((l) => LOGBOX_PAGER.test(l)) && lines.includes('Dismiss') && lines.includes('Minimize')) {
      seen.add('rn_logbox_error');
      findings.push({ kind: 'rn_logbox_error', severity: 'fail', evidence: lines.find((l) => LOGBOX_PAGER.test(l))! });
    }
  }
  if (screenshot) {
    const stats = colorStats(screenshot);
    // A red page is a design choice on the web; the RedBox is a React Native overlay.
    if (target.kind === 'app' && !seen.has('rn_redbox') && stats.redShare >= REDBOX_SHARE) {
      findings.push({ kind: 'rn_redbox', severity: 'fail', evidence: `빨간 전체 화면 (${Math.round(stats.redShare * 100)}%)` });
    }
    if (model.candidates.length === 0 && model.texts.length === 0 && stats.dominantShare >= BLANK_SHARE) {
      findings.push({ kind: 'blank_screen', severity: 'fail', evidence: `트리·OCR 비어 있고 단색 ${Math.round(stats.dominantShare * 100)}%` });
    }
  }
  return findings;
}
