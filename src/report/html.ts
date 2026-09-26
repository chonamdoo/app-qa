// Single-file Korean HTML report: run header, test × platform grid, requirement traceability matrix, and per-test step
// tables with thumbnails (linked relatively inside the run dir), decision sources, health findings and log excerpts.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PLATFORMS } from '../core/platform.ts';
import type { Platform, Verdict } from '../core/types.ts';
import { platformLabel, QA_STATUSES, type QaStatus } from './status.ts';
import type { Traceability } from './trace.ts';
import type { DecisionSummary, RunSummary, StepResult, TestResult } from './types.ts';
import { WEB_QA_DIR } from './webqa.ts';

const VERDICT_KO: Record<Verdict, string> = { PASS: '통과', FAIL: '실패', INCONCLUSIVE: '판정 불가', ERROR: '오류', SKIPPED: '건너뜀' };
const SOURCE_KO: Record<DecisionSummary['source'], string> = { selector: '셀렉터', fast_path: '라벨 일치', jev: 'Jev', deterministic: '결정적', none: '없음' };
const DOC_STATE_KO: Record<'same' | 'changed' | 'missing', string> = { same: '', changed: '문서 변경됨', missing: '문서 없음' };
const PHASE_KO: Record<StepResult['phase'], string> = { setup: '준비', main: '', teardown: '정리', interrupt: '인터럽트' };
const EXCERPT_LINES = 40;

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function badge(v: Verdict): string {
  return `<span class="v v-${v}">${VERDICT_KO[v]}</span>`;
}

/** web-qa status (PASS / FAIL / BLOCKED / NOT_RUN …) next to the verdict. */
function qaTag(s: QaStatus): string {
  return `<span class="qa qa-${s}">${s}</span>`;
}

function statusBadge(status: TestResult['status']): string {
  if (status === 'draft') return ' <span class="tag draft">초안(draft)</span>';
  if (status === 'rejected') return ' <span class="tag rejected">반려</span>';
  return '';
}

function thumb(path: string | null, alt: string): string {
  if (!path) return '';
  return `<a href="${esc(path)}" target="_blank"><img loading="lazy" src="${esc(path)}" alt="${esc(alt)}"></a>`;
}

function decisionCell(decisions: readonly DecisionSummary[]): string {
  return decisions
    .map((d) => {
      const top = d.top?.length
        ? `<ul class="probs">${d.top.map((t) => `<li><span class="bar" style="width:${Math.round(t.p * 100)}%"></span><span>${esc(t.label)} ${t.p.toFixed(2)}</span></li>`).join('')}</ul>`
        : '';
      const ref = d.reference ? ' <span class="tag">참고용</span>' : '';
      return `<div class="dec"><b>${esc(SOURCE_KO[d.source])}</b> · ${esc(d.kind)} · ${esc(d.verdict)}${ref}<div class="muted">${esc(d.reason)}</div>${top}</div>`;
    })
    .join('');
}

function excerpt(runDir: string, rel: string): string {
  const file = join(runDir, rel);
  if (!existsSync(file)) return '';
  const lines = readFileSync(file, 'utf8').split('\n');
  const shown = lines.slice(-EXCERPT_LINES).join('\n');
  return `<details><summary>${esc(rel)} (${lines.length}줄, 마지막 ${Math.min(lines.length, EXCERPT_LINES)}줄)</summary><pre>${esc(shown)}</pre><a href="${esc(rel)}">전체 보기</a></details>`;
}

function testSection(t: TestResult, runDir: string): string {
  const steps = t.steps
    .map((s) => {
      const phase = PHASE_KO[s.phase] ? `<span class="tag">${PHASE_KO[s.phase]}</span> ` : '';
      const health = s.health.length ? `<div class="health">${s.health.map((h) => `${h.severity === 'fail' ? '⛔' : '⚠️'} ${esc(h.kind)}: ${esc(h.evidence)}`).join('<br>')}</div>` : '';
      const settle = s.settle ? `<div class="muted">변화 ${s.settle.changed ? '있음' : '없음'} · 안정 ${s.settle.settled ? '예' : '아니오'} · ${s.settle.ms}ms</div>` : '';
      return `<tr class="row-${s.verdict}"><td>${s.seq}</td><td>${phase}${esc(s.label)}${s.optional ? ' <span class="tag">선택</span>' : ''}</td><td>${badge(s.verdict)}${s.code ? `<div class="muted">${esc(s.code)}</div>` : ''}</td><td>${esc(s.reason)}${settle}${health}</td><td>${decisionCell(s.decisions)}</td><td class="shots">${thumb(s.before, '이전')}${thumb(s.after, '이후')}</td></tr>`;
    })
    .join('\n');
  const warnings = t.warnings.length ? `<div class="warn"><b>경고 (판정 불변)</b><ul>${t.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>` : '';
  const health = t.health.length
    ? `<div class="health"><b>상태 점검</b><ul>${t.health.map((h) => `<li>${h.severity === 'fail' ? '⛔ 실패' : '⚠️ 경고'} ${esc(h.kind)} — ${esc(h.evidence)}</li>`).join('')}</ul></div>`
    : '';
  const logs = [t.logs, ...t.crash].filter((p): p is string => p !== null).map((p) => excerpt(runDir, p)).join('');
  return `<section class="test" id="${esc(`${t.id}-${t.platform}`)}">
<h3>${badge(t.verdict)} ${qaTag(t.qaStatus)} ${esc(t.name)} <span class="muted">${esc(t.id)} · ${esc(platformLabel(t.platform, t.surface ?? 'app'))}${t.deviceName ? ` · ${esc(t.deviceName)}` : ''} · ${(t.durationMs / 1000).toFixed(1)}초</span>${statusBadge(t.status)}</h3>
<p>${esc(t.reason)}${t.file ? ` <span class="muted">(${esc(t.file)})</span>` : ''}</p>
${t.covers.length ? `<p class="muted">요구사항: ${t.covers.map(esc).join(', ')}</p>` : ''}
${warnings}${health}${logs ? `<div class="logs"><b>로그·크래시</b>${logs}</div>` : ''}
<table class="steps"><thead><tr><th>#</th><th>스텝</th><th>판정</th><th>이유</th><th>판단 근거</th><th>화면</th></tr></thead><tbody>
${steps}
</tbody></table></section>`;
}

/** `heads`: the platform column headers, one per `platforms` entry. */
function matrix(trace: Traceability, platforms: readonly Platform[], heads: string): string {
  if (trace.error) return `<section><h3>요구사항 추적 매트릭스 — ${esc(trace.app)}</h3><p class="warn">${esc(trace.error)}</p></section>`;
  const docs = trace.docs
    .map((d) => `<li>${esc(d.path)}${d.state !== 'same' ? ` <span class="tag ${d.state}">${DOC_STATE_KO[d.state]}</span>` : ''}</li>`)
    .join('');
  const rows = trace.rows
    .map((r) => {
      const stale = r.docState !== 'same' ? ` <span class="tag ${r.docState}">${DOC_STATE_KO[r.docState]}</span>` : '';
      const req = `<td><b>${esc(r.requirement.id)}</b>${stale}<div class="muted">${esc(r.requirement.section.join(' › '))}</div><div class="req">${esc(r.requirement.text.slice(0, 240))}</div></td>`;
      if (!r.tests.length) return `<tr>${req}<td colspan="${platforms.length + 1}" class="muted">연결된 테스트 없음</td></tr>`;
      return r.tests
        .map((t, i) => {
          const cells = platforms.map((p) => `<td>${t.verdicts[p] ? `<a href="#${esc(`${t.id}-${p}`)}">${badge(t.verdicts[p]!)}</a>` : '<span class="muted">실행 안 함</span>'}</td>`).join('');
          return `<tr>${i === 0 ? req.replace('<td>', `<td rowspan="${r.tests.length}">`) : ''}<td>${esc(t.name)}${statusBadge(t.status)}<div class="muted">${esc(t.file ?? t.id)}</div></td>${cells}</tr>`;
        })
        .join('\n');
    })
    .join('\n');
  const untestable = trace.untestable.length
    ? `<h4>테스트 불가 요구사항</h4><table><thead><tr><th>요구사항</th><th>사유</th></tr></thead><tbody>${trace.untestable
        .map((u) => `<tr><td><b>${esc(u.requirement)}</b>${u.text ? `<div class="req">${esc(u.text.slice(0, 240))}</div>` : ''}</td><td>${esc(u.reason)}</td></tr>`)
        .join('')}</tbody></table>`
    : '';
  return `<section class="trace"><h3>요구사항 추적 매트릭스 — ${esc(trace.app)}</h3>
<p class="muted">계획: ${esc(trace.plan)} · 생성 ${esc(trace.createdAt)}</p><ul class="docs">${docs}</ul>
<table><thead><tr><th>요구사항</th><th>테스트</th>${heads}</tr></thead><tbody>
${rows}
</tbody></table>${untestable}</section>`;
}

const STYLE = `
body{font:14px/1.5 -apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Noto Sans KR",sans-serif;margin:24px;color:#1d1d1f;background:#fafafa}
h1{font-size:22px;margin:0 0 4px}h2{font-size:18px;margin:28px 0 8px}h3{font-size:16px;margin:0 0 6px}
table{border-collapse:collapse;width:100%;background:#fff;margin:8px 0}th,td{border:1px solid #e0e0e0;padding:6px 8px;text-align:left;vertical-align:top}
th{background:#f2f2f5;font-weight:600}.muted{color:#6e6e73;font-size:12px}.req{font-size:12px;max-width:520px}
.v{display:inline-block;padding:1px 8px;border-radius:10px;font-size:12px;font-weight:600;color:#fff}
.v-PASS{background:#1a7f37}.v-FAIL{background:#cf222e}.v-ERROR{background:#6e2fb5}.v-INCONCLUSIVE{background:#bf8700}.v-SKIPPED{background:#8c959f}
.tag{display:inline-block;padding:0 6px;border-radius:4px;font-size:11px;background:#e8e8ed;color:#333}.tag.draft{background:#fff3cd;color:#7a5b00}
.tag.changed,.tag.missing{background:#ffe1e1;color:#9a1c1c}.tag.rejected{background:#ffe1e1}
.test{background:#fff;border:1px solid #e0e0e0;border-radius:8px;padding:12px 16px;margin:16px 0}
.shots{white-space:nowrap}.shots img{width:64px;margin-right:4px;border:1px solid #ddd;border-radius:4px;vertical-align:top}
.probs{list-style:none;padding:0;margin:4px 0 0}.probs li{position:relative;font-size:11px;padding:1px 4px;min-width:160px}
.probs .bar{position:absolute;left:0;top:0;bottom:0;background:#dbe9ff;z-index:0}.probs li span:last-child{position:relative}
.dec{margin-bottom:6px}.warn{background:#fff8e1;border:1px solid #f0d58c;padding:6px 10px;border-radius:6px;margin:6px 0}
.health{color:#9a1c1c;font-size:12px}pre{background:#f6f8fa;padding:8px;overflow:auto;max-height:320px;font-size:12px}
.counts span{margin-right:10px}.row-FAIL td,.row-ERROR td{background:#fff5f5}.row-INCONCLUSIVE td{background:#fffbea}
.qa{display:inline-block;padding:0 6px;border-radius:4px;font-size:11px;font-weight:600;border:1px solid #c9c9d1;color:#333;background:#fff}
.qa-PASS{border-color:#1a7f37;color:#1a7f37}.qa-FAIL{border-color:#cf222e;color:#cf222e}.qa-BLOCKED{border-color:#6e2fb5;color:#6e2fb5}
`;

export function renderHtml(summary: RunSummary, traces: readonly Traceability[], runDir: string): string {
  const platforms = PLATFORMS.filter((p) => summary.tests.some((t) => t.platform === p));
  // A column holds every result of one platform: `Android`, `Android Chrome`, or both when a run mixes apps and sites.
  const heads = platforms
    .map((p) => `<th>${esc([...new Set(summary.tests.filter((t) => t.platform === p).map((t) => platformLabel(p, t.surface ?? 'app')))].join(' / '))}</th>`)
    .join('');
  const counts = (Object.keys(VERDICT_KO) as Verdict[]).map((v) => `<span>${badge(v)} ${summary.counts[v]}</span>`).join('');
  const qaCounts = QA_STATUSES.filter((s) => summary.qaCounts[s] > 0)
    .map((s) => `<span>${qaTag(s)} ${summary.qaCounts[s]}</span>`)
    .join('');
  const webQa = summary.tests.some((t) => t.surface === 'web')
    ? `<p class="muted">web-qa 기록(check-run v1): <a href="${WEB_QA_DIR}/plan.json">${WEB_QA_DIR}/plan.json</a> · <a href="${WEB_QA_DIR}/result.json">${WEB_QA_DIR}/result.json</a> (증거 루트: 실행 디렉터리)</p>`
    : '';
  const devices = summary.devices.map((d) => `${esc(d.platform)}: ${esc(d.name)} (${esc(d.id)})`).join(' · ') || '없음';
  const ids = [...new Set(summary.tests.map((t) => t.id))];
  const grid = ids
    .map((id) => {
      const rows = summary.tests.filter((t) => t.id === id);
      const first = rows[0]!;
      const cells = platforms
        .map((p) => {
          const r = rows.find((x) => x.platform === p);
          return `<td>${r ? `<a href="#${esc(`${id}-${p}`)}">${badge(r.verdict)}</a> ${qaTag(r.qaStatus)}<div class="muted">${esc(r.reason.slice(0, 120))}</div>` : '<span class="muted">—</span>'}</td>`;
        })
        .join('');
      return `<tr><td>${esc(first.name)}${statusBadge(first.status)}<div class="muted">${esc(id)}</div></td>${cells}</tr>`;
    })
    .join('\n');
  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>app-qa ${summary.kind === 'smoke' ? '스모크' : '실행'} 리포트 ${esc(summary.runId)}</title><style>${STYLE}</style></head>
<body>
<header><h1>app-qa ${summary.kind === 'smoke' ? '스모크' : '테스트 실행'} 리포트</h1>
<p class="muted">실행 ID ${esc(summary.runId)} · 시작 ${esc(summary.startedAt)} · ${(summary.durationMs / 1000).toFixed(1)}초 · 플랫폼 ${esc(summary.platform)} · 기기 ${devices}</p>
<p class="counts">${counts}</p>
<p class="counts">QA 상태: ${qaCounts || '없음'}</p>
<p class="muted">판정 규칙: 오류 &gt; 실패 &gt; 판정 불가 &gt; 통과. 판정 불가는 통과가 아닙니다. QA 상태: 오류는 BLOCKED(원래 코드 유지), 명세 오류·취소는 NOT_RUN.</p>${webQa}</header>
<h2>테스트 × 플랫폼</h2>
<table><thead><tr><th>테스트</th>${heads}</tr></thead><tbody>
${grid}
</tbody></table>
${traces.length ? `<h2>요구사항 추적</h2>${traces.map((t) => matrix(t, platforms, heads)).join('\n')}` : ''}
<h2>상세</h2>
${summary.tests.map((t) => testSection(t, runDir)).join('\n')}
</body></html>
`;
}
