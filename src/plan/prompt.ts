// Generation prompt: rules, DSL reference, output JSON Schema (from zod), the app's real screen strings and the
// requirements of one batch. The model must copy UI strings verbatim from the inventory and never invent labels.
import { z } from 'zod';
import { profilePlatforms, TestSpec, type AppProfile, type Requirement } from '../spec/schema.ts';
import type { AppContext } from './context.ts';

/** What the model returns. `app`/`source` are filled in by the planner. */
export const LlmOutput = z.strictObject({
  tests: z.array(TestSpec.omit({ app: true, source: true })),
  untestable: z.array(z.strictObject({ requirement: z.string().min(1), reason: z.string().min(1) })),
});

export function outputJsonSchema(): object {
  return z.toJSONSchema(LlmOutput, { io: 'input', unrepresentable: 'any', reused: 'ref' });
}

const RULES = `You write end-to-end tests for a mobile app or a website in the app-qa DSL from requirement documents.

# OUTPUT
Return ONLY one JSON object, no prose and no code fences:
{"tests": [<test>, ...], "untestable": [{"requirement": "<requirement id>", "reason": "<Korean reason>"}, ...]}
<test> = {"id": "<ascii-kebab-case, unique, <=60 chars>", "name": "<Korean: what is verified>", "covers": ["<requirement id>", ...], "tags"?: [...], "platforms"?: [<platform listed under APP>, ...], "when"?: [...], "steps": [...]}
Do not set "app", "source", "reset", "start" or "budget".

# RULES
1. Coverage: every requirement id under REQUIREMENTS appears in some test's "covers" or in "untestable" with a reason. Use only those ids.
2. One test per coherent group of requirements verifiable in the same screen flow. Minimal steps; no step unrelated to the covered requirements.
3. UI strings: copy element labels and text lines VERBATIM (character for character, same spaces and punctuation) from APP SCREENS. Never invent a label, button name, tab name, placeholder or message, never take wording from the requirement document, never translate. If a requirement needs a screen or string that is not listed, put it in "untestable" (reason starts with "화면 인벤토리에 없음:").
4. Matching is literal: a plain-string target is matched against element labels by whole-string equality; "assertText"/"assertNoText"/{"text": ...} plain strings are substrings of one visible text line. Use {"regex": "..."} (JavaScript syntax, add ^ and $ yourself when you need a full match) only for values that change between runs (times, counts, minutes, numbers) or that are listed under VOLATILE.
   APP SCREENS were captured once: labels and lines that embed live data (clock times, minutes, counts, dates, flight numbers, a specific flight's status or destination, which item is recommended) WILL differ at run time. Never copy such a string literally as a target or assertion; use a regex selector such as {"see": {"text": {"regex": "^출국장 \\\\d, .*대기 \\\\d+분"}}} or a "checkEach" rule. Copy literally only stable UI strings: tab names, button labels, headings, fixed messages.
5. Prefer deterministic checks:
   - "assertText"/"assertNoText" for wording and terminology rules. A glossary term's "_Avoid_" words must not appear where the concept is shown: use "assertNoText" for each avoided word on a listed screen that shows the preferred term.
   - "checkEach" for data rules over repeated lines, e.g. {"checkEach": {"pattern": "^(?<min>\\\\d+)분$", "rule": {">=": [{"var": "min"}, 0]}, "min": 1}} (named groups; digit groups become numbers; JSONLogic "var" names = group names).
   - "see" for element presence; target = the exact label as a plain string, or {"intent": "<exact label>", "state": {"selected": true}} to check state.
   - "claim" only for semantic statements that text matching cannot express: one concrete, checkable fact about the current screen, in Korean.
6. Navigation: the app (a website: its start URL) is launched fresh before steps. Reach screens by tapping labels listed in APP SCREENS (tabs, buttons, links). Use {"wait": {"until": ...}} for content that loads.
7. Forbidden (validation rejects them): "allowRisky"; tap/longPress on destructive or external actions (삭제, 지우기, 제거, 결제, 구매, 주문, 탈퇴, 로그아웃, 초기화, 송금, 이체, 전송, 보내기, 공유, 신고, 차단, 구독, 해지, 전화, 권한 허용, delete, remove, erase, pay, purchase, buy, order, checkout, unsubscribe, sign out, log out, reset, send, transfer, share, report, block, call) or confirm buttons of such dialogs; steps "tapAt", "swipe", "use", "open", "location"; "submit": true on "type" and any "press" other than "back" (Enter can send or confirm a form — tap the labelled button instead); "launch" with "permissions" or reset clear/reinstall; selectors with "id". A requirement that needs any of these goes to "untestable" with reason "needs_approval: ...".
8. Requirements that depend on state you cannot set up or observe (a specific real flight, live airport data values, the current time, network failures, saved data that may not exist) go to "untestable" with the reason, unless a check holds for whatever data is shown (formats, terminology, presence of labels). Glossary definitions with no observable UI consequence go to "untestable" with reason "화면에서 관찰 불가: ...".
9. "\${NAME}" placeholders only for names listed under ENV VARIABLES or set earlier with "remember".
10. Write every "name", "note", "claim" and "reason" in Korean.
`;

const DSL = `# DSL REFERENCE (the JSON Schema below is authoritative for shapes)
Target = "<exact element label>" | {"intent"?: "<label>", "text"?: TextMatch, "desc"?: TextMatch, "state"?: {"enabled"?, "checked"?, "selected"?, "focused"?}}
TextMatch = "<literal>" | {"regex": "<JS regex>", "flags"?: "imsu"}
Each step is an object with exactly one kind key plus optional common fields: timeout (ms), optional, platforms, expect, expectNoChange, within, nth, near, note.
  {"tap": Target} | {"longPress": Target, "holdMs"?: 1000} | {"type": "<text>", "into": Target, "append"?: true} | {"clear": Target}
  {"press": "back"} | {"hideKeyboard": true} | {"back": true} | {"launch": true}
  {"see": Target} (element visible) | {"seeNot": "<label>"} (element absent)
  {"assertText": TextMatch} (a visible text line contains it) | {"assertNoText": TextMatch} (no visible line contains it)
  {"checkEach": {"pattern": "<regex with named groups>", "rule": <JSONLogic>, "min": 1}} (every matching visible line satisfies rule; at least min lines match)
  {"claim": "<Korean statement about the current screen>"}
  {"remember": {"name": "x", "from": Target | {"regex": "(?<value>...)"}}} then "\${x}" in later strings
  {"which": {"<screen state A>": [steps], "<screen state B>": [steps]}} (branch on which of ≥2 states is shown)
  {"repeat": {"times": 1-10, "steps": [...]}} | {"repeat": {"while": {"see": Target} | {"text": TextMatch} | {"noText": TextMatch}, "steps": [...]}}
  {"scroll": {"direction": "down"|"up"|"left"|"right", "until"?: Target | {"text": TextMatch}, "max"?: 5}}
  {"wait": <ms> | {"until": Target | {"text": TextMatch}}} | {"capture": "<name>"}
expect (any step, checked after it settles): {"see": Target} | {"text": TextMatch} | {"noText": TextMatch} | {"claim": "..."} | [ ... ]
when (test level, before each step): [{"see": Target, "do": [steps], "max"?: 3}] to dismiss a known interrupting popup.
`;

/** Only for website profiles: the run blocks or fails anything outside the allowed origins. */
const WEB_RULES = `# WEBSITE RULES (APP kind is website)
11. Stay on the allowed ORIGINS listed under APP: never tap a link or button that leaves them (external sites, social or single sign-on, app stores, payment or map pages, links that open a new tab). A requirement that needs another origin goes to "untestable" with reason "needs_approval: 허용 origin 밖 이동: <where>".
12. The page is shown in a browser: use the page's own buttons and links, never the browser's address bar, tabs or menus; {"back": true} is the browser's back button.
`;

/** The APP line: what runs, where, and on which platforms. */
function appLine(p: AppProfile): string {
  const head = `id: ${p.id} · name: ${p.name} · build: ${p.build}`;
  if (p.web) {
    const origins = p.web.origins ?? [new URL(p.web.url).origin];
    return `${head} · kind: website · url: ${p.web.url} · ORIGINS: ${origins.join(', ')} · platforms: ${profilePlatforms(p).join(', ')}`;
  }
  const platforms = [p.android ? `android (${p.android.package})` : null, p.ios ? `ios (${p.ios.bundleId})` : null].filter(Boolean).join(', ');
  return `${head} · kind: mobile app · platforms: ${platforms || '(none)'}`;
}

export function buildPrompt(ctx: AppContext, requirements: readonly Requirement[], schema: object): string {
  const p = ctx.profile;
  const parts = [
    RULES,
    ...(p.web ? [WEB_RULES] : []),
    DSL,
    '# JSON SCHEMA OF THE OUTPUT',
    JSON.stringify(schema),
    '',
    '# APP',
    appLine(p),
    `VOLATILE (regexes of texts that change between runs): ${p.volatile.length ? p.volatile.map((v) => JSON.stringify(v)).join(', ') : '(none)'}`,
    `ENV VARIABLES: ${ctx.envNames.size ? [...ctx.envNames].join(', ') : '(none)'}`,
    '',
    '# APP SCREENS (the only UI strings you may use; "elements" = actionable/labelled elements, "texts" = visible text lines)',
    ctx.screens.length ? ctx.screens.map(renderScreen).join('\n\n') : '(no screen inventory: every requirement that needs a UI string is untestable — "화면 인벤토리에 없음")',
    '',
    '# REQUIREMENTS',
    requirements.map((r) => `[${r.id}] (${r.section.join(' › ') || r.doc})\n${r.text}`).join('\n\n'),
  ];
  return parts.join('\n');
}

function renderScreen(s: AppContext['screens'][number]): string {
  const lines = [`## ${s.platform}/${s.name}`, 'elements (role | label | state):'];
  for (const c of s.candidates) if (c.role !== 'text') lines.push(`- ${c.role} | ${JSON.stringify(c.name)}${c.state.length ? ` | ${c.state.join(',')}` : ''}`);
  lines.push('texts:');
  for (const t of s.texts) lines.push(`- ${JSON.stringify(t)}`);
  return lines.join('\n');
}

export function buildRevisionPrompt(basePrompt: string, previousOutput: string, errors: readonly string[]): string {
  const previous = previousOutput.length > 60_000 ? `${previousOutput.slice(0, 60_000)}\n…(truncated)` : previousOutput;
  return [
    basePrompt,
    '',
    '# YOUR PREVIOUS OUTPUT',
    previous,
    '',
    '# VALIDATION ERRORS (deterministic checks; fix every one)',
    ...errors.map((e) => `- ${e}`),
    '',
    'Return the complete corrected JSON object (all tests and all untestable entries), not a diff. Keep tests that had no errors unchanged. If a test cannot be fixed within the rules, drop it and list its requirements in "untestable" with the reason.',
  ].join('\n');
}
