// JUnit XML for CI: one testsuite per platform, one testcase per test. INCONCLUSIVE is a failure (never a pass).
import type { Platform } from '../core/types.ts';
import type { RunSummary, TestResult } from './types.ts';

function xmlEscape(s: string): string {
  return s.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
}

function testcase(t: TestResult): string {
  const attrs = `name="${xmlEscape(t.name)}" classname="${xmlEscape(`${t.app}.${t.id}`)}" time="${(t.durationMs / 1000).toFixed(3)}"`;
  const steps = t.steps.map((s) => `${s.verdict.padEnd(12)} ${s.label} — ${s.reason}`).join('\n');
  const out = `<system-out>${xmlEscape(steps)}</system-out>`;
  const msg = xmlEscape(t.reason);
  switch (t.verdict) {
    case 'PASS':
      return `    <testcase ${attrs}>${out}</testcase>`;
    case 'SKIPPED':
      return `    <testcase ${attrs}><skipped message="${msg}"/>${out}</testcase>`;
    case 'ERROR':
      return `    <testcase ${attrs}><error type="${xmlEscape(t.code ?? 'ERROR')}" message="${msg}"/>${out}</testcase>`;
    default:
      return `    <testcase ${attrs}><failure type="${t.verdict}${t.code ? `:${xmlEscape(t.code)}` : ''}" message="${msg}"/>${out}</testcase>`;
  }
}

export function renderJunit(summary: RunSummary): string {
  const platforms = [...new Set(summary.tests.map((t) => t.platform))] as Platform[];
  const suites = platforms.map((p) => {
    const tests = summary.tests.filter((t) => t.platform === p);
    const n = (v: TestResult['verdict']) => tests.filter((t) => t.verdict === v).length;
    const time = tests.reduce((sum, t) => sum + t.durationMs, 0) / 1000;
    return [
      `  <testsuite name="app-qa ${p}" tests="${tests.length}" failures="${n('FAIL') + n('INCONCLUSIVE')}" errors="${n('ERROR')}" skipped="${n('SKIPPED')}" time="${time.toFixed(3)}" timestamp="${summary.startedAt}">`,
      ...tests.map(testcase),
      '  </testsuite>',
    ].join('\n');
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="app-qa ${xmlEscape(summary.runId)}">\n${suites.join('\n')}\n</testsuites>\n`;
}
