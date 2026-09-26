# ConvoyBridge research: Convoy + jev-ios-bridge (code-level)

> Sources were read through raw.githubusercontent.com at HEAD on 2026-09-26. There was no shell, so nothing was cloned. Every claim below comes from source I read unless it is marked [INFERENCE].

---

## gokulnair2001/Convoy

TypeScript, `convoy-e2e` v0.1.6, Node ≥20, Vitest runner. **License: MIT** (Copyright 2026 Gokul Nair). Five stars; the README calls M6 (threshold calibration on real screens) unfinished.

### 1. Observation

**Android** (`src/drivers/android.ts`):
- The primary dump is `adb [-s SERIAL] exec-out uiautomator dump /dev/tty`.
- The fallback is `adb shell uiautomator dump /sdcard/window_dump.xml` followed by `adb shell cat /sdcard/window_dump.xml`.
- The XML is parsed with a regex (`<node\b([^>]*)\/?>` and attributes `([:\w-]+)="([^"]*)"`), which also decodes XML entities. The trailing text "UI hierchary dumped to…" is ignored because only `<node` tags are matched.
- Screenshots use `adb exec-out screencap -p`. **Bug:** `util/exec.ts` decodes stdout with `d.toString('utf8')`, and the driver then calls `Buffer.from(stdout,'binary')`, so the PNG is corrupted. Errors fall back to a 1×1 PNG.

**iOS** (`src/drivers/ios.ts`, `idb-session.ts`, `idb-bridge.py`):
- `idb ui describe-all --nested` (60s timeout), then `JSON.parse`.
- Transport: the first time an op is needed, it spawns `python <idb-bridge.py> [udid]` with `IDB_UDID` in the environment. The Python binary comes from the `idb` shebang (`pythonForIdb`); otherwise `python3` is used.
- The helper uses `idb.grpc.management.ClientManager(companion_path=get_default_companion_path()).from_udid(udid)` and prints `{"ok":true,"ready":true}`. After that it speaks JSON lines: request `{id, op, …}` → reply `{id, ok, stdout|b64|error}`.
- Timeouts: ready 15s, per-call 30s, `describe-all` 60s.
- A transport error (timeout or process exit) triggers one reconnect. If that fails, gRPC is disabled for the driver and it falls back to the `idb` CLI (`idb <args> --udid X` with the `IDB_UDID` env var).
- Non-transport errors (`ok:false`) are thrown as-is.
- Ops: `describe-all` → `client.accessibility_info(target=None, options=AccessibilityInfoOptions(nested=True))`; `tap` → `client.tap(x,y)`; `text` → `client.text(s)`; `key` → `client.key` or `hid(key_press_with_modifiers_to_events(keycode, ['command']))`; `set-value` → `client.accessibility_set_value(AccessibilityPoint(x,y), value)`; `swipe`; `screenshot` (base64); `terminate`; `uninstall`; `launch`; `install`; `ping`.
- Companion warm-up: `idb connect <udid>` with a 10s timeout; failures are ignored.
- Simulator lifecycle: `xcrun simctl list devices -j` picks a booted iPhone, else the first available one. Then `xcrun simctl boot` ("already booted" is fine), `open -a Simulator` when headed, and `idb install`/`launch` or `simctl install`/`launch`.

**Settle / slow screens** (`src/core/settle.ts`):
- `signature(elements)` = `role:name:value:enabled` joined by `|`. Bounds are not included, so movement-only animations look stable.
- `waitUntilPresent(snapshot, attempt, isRetryable, {timeoutMs})` is the main path for tap/type/see/which. It takes a dump, computes the signature, and returns immediately if the attempt succeeds. After a retryable miss it keeps dumping and only calls the attempt (i.e. Jev) again when the signature changes. There is no sleep; the dump itself sets the pace. On timeout it throws the last error.
- `waitForSettle` (stable for 250ms, 100ms poll, 5s timeout) is used only by `t.score`.
- `actionTimeoutMs` defaults to 20,000 (`CONVOY_ACTION_TIMEOUT_MS`).
- Nothing waits for the screen to settle after an action. The next step polls. Risk: a label that exists on both the old and new screen can be acted on again before the transition finishes (tap has no exact-match or change check).
- Jev cost risk: a changing `value` (clock, progress %) changes the signature, so every dump triggers a Jev call for up to 20s.

### 2. Normalization (`src/core/normalize.ts`, `roles.ts`, `bounds.ts`, `element.ts`)

**Per-platform extraction:**
- **iOS:** `flatten(raw)` walks `children` and `child`. Frame comes from `node.frame {x,y,width,height}`, else the `AXFrame` string `{{x, y}, {w, h}}`. Role = `mapIosRole(type, role, role_description)`. Name = first of `AXLabel, label, title, placeholder, name`. Value = `AXValue ?? value`. Enabled = `node.enabled !== false`.
- **Android:** frame from `bounds "[l,t][r,b]"`. Role = `mapAndroidRole(class)`. Name = first of `content-desc, contentDesc, text, label, name`. Value = `text` but **only if it differs from the name**. Enabled = `enabled !== "false"`.

**Role tables:**
- The lookup lowercases, strips `[^a-z0-9.]`, and also strips an `ax` prefix.
- iOS: Button/Key→button; TextField/SecureTextField/SearchField/TextView→textfield; StaticText→text; Switch/Toggle/CheckBox→toggle; Cell→cell; Link; Image; Tab/TabBar/RadioButton→tab; Table/CollectionView→list.
- Android: the exact `android.widget.*` classes, then substring fallbacks for button, edit, text, switch|check, image, tab.
- **Pitfall:** `android.view.View`/`ViewGroup` (Compose, React Native, Flutter) do not map. They become role `text` with `actionable:false`. The `clickable`, `checkable`, `password`, `scrollable`, `resource-id` and `hint` attributes are all ignored.

**`finalize` pipeline:**
1. Drop zero-size nodes (`w≤0||h≤0`).
2. Drop nodes entirely outside the screen rect (`isOnScreen`). There is no occlusion or visible-to-user check.
3. Drop unlabeled nodes, except textfields, which are renamed `"text field"`.
4. Keep disabled nodes by default (`includeDisabled:true`; the comment says "over-filtering is the highest risk").
5. Sort by y, then x, then name.
6. Dedupe *adjacent* entries with the same role and name and |dx|,|dy| < 1.
7. Order actionable roles first (button, textfield, toggle, cell, link, tab), then the rest.
8. Cap at `MAX_CHOICE_OPTIONS = 250`, leaving room for `none` under Jev's 255-option Choice limit.
9. Assign ids `e1..eN` in that order, so the numbering is not a pure reading order.

The result also carries a `dropped` counter object {unlabeled, offscreen, zeroSize, capped}.

**Element shape:** `{id, role, name, value?, enabled, bounds:[x,y,w,h] in 0–1, ref:{platform, frame(px or pt), raw}}`. `ref` is never sent to Jev.

**Bug (screen size):** `AndroidDriver.snapshot()` calls `normalizeAndroid(xml, {screen: this.screen})` with `this.screen` initialized to 1080×2400. iOS does the same with 390×844. Because `opts.screen` is always set, `inferScreen` never runs. Consequences:
- Nodes beyond the default size are dropped as off-screen (Android beyond 1080 px wide or 2400 px tall; the iPhone Pro Max tab bar beyond y 844 pt).
- Normalized bounds are wrong. They feed the title heuristic, label order and nearest-field distance.
- Taps are unaffected, because they use the raw frame.

**ASCII-only labels:** `normalizeLabel = lower().replace(/[^a-z0-9]+/g,' ')`. Korean names normalize to `''`, so the exact-name fast path and the field-cluster tie-break never fire for Korean.

### 3. Jev usage (exact)

**Transport** (`src/jev/client.ts`):
- `POST ${baseUrl}/systemone`; baseUrl defaults to `https://api.typesafe.ai/v1` (`TYPESAFE_BASE_URL`); model defaults to `jev-latest` (`TYPESAFE_MODEL`).
- Headers: `Authorization: Bearer $TYPESAFE_API_KEY`, `Content-Type: application/json`.
- Body: `{model, state, questions}`; per-request timeout 15s (`AbortSignal.timeout`).
- Up to 4 attempts. HTTP 429 or 529 sleeps `2^attempt·250` ms. Errors matching `/timeout|fetch|network/i` are retried. Other non-OK statuses throw `ToolError(jevHttpReport)`.
- Quirk: that error's message includes a hint containing "network", so 5xx responses are also retried. After four 429s it throws a generic "Jev request failed".
- If `@typesafe-ai/sdk` can be imported (it is **not** in package.json), `SdkJevClient` uses `sdk.choice/noul/score` helpers with no Convoy-level retry.
- Modes: `live` / `heuristic` / `recorded`. **Silent fallback:** when no key is set and `CONVOY_JEV_MODE` is unset, the mode stays `heuristic`, a token-overlap stand-in.
- `RecordedJevClient` is constructed without a live client, so it never records; a cache miss throws.

**State** (`src/jev/state.ts`):
```json
{"screen": {"platform": "iOS · com.example.app", "title": "Sign in", "labels": ["Back","Sign in","Email","…≤40 unique names, top→bottom"]},
 "elements": [{"id":"e1","role":"button","name":"Continue"},{"id":"e2","role":"textfield","name":"Email","value":"a@b.c"}]}
```
- The title is the first `text` element with `bounds.y < 0.28` that is not chrome (back, close, cancel, done, more, menu); failing that, any non-tab element there.
- Values are included only for tap and type (`includeValues: action !== 'see'`). Oracle and which calls omit them.
- **`enabled` and bounds are never sent**, so Jev can pick a disabled control.

**Resolve questions** (`src/jev/resolver.ts`):
- Choice criteria: `{e<i>: '<role> "<name>"[ value="<json>"]', …, none: 'No unique control fulfills the intent'}`.
- The instruction is `${ask} ${rules}\nAction: ${action}\nIntent: ${intent}`.

| step | questions | ask | rules (verbatim) |
|---|---|---|---|
| tap | `target` Choice | "Which control in `elements` should be used to tap?" | "The author's phrase is an intent; the visible label may differ. If one control's visible name matches the phrase (ignore case and punctuation), pick that control. If none match, the unique primary forward CTA (continue, next, submit, log in, sign in, done, save) may match even when the label differs. Side actions (Forgot password, Continue as guest, Use SSO, Create account) only match when the phrase names them. If two controls fit equally, pick none." |
| type | `present` Noul + `target` Choice | present: "Does `elements` contain a unique field that fulfills this type?"; target: "Which field in `elements` should be used to type?" | "The author's phrase is an intent; the visible label may differ. If one field's visible name matches the phrase (ignore case and punctuation), pick that field. Prefer text fields. If a heading/label and a text field share the same visible name, pick the field. If two fields fit equally, pick none." |
| see | `target` Choice | "Which control in `elements` is this intent pointing at? Pick none if it is not on screen." | "The author's phrase is an intent; the visible label may differ. If one control's visible name matches the phrase (ignore case and punctuation), pick that control. Otherwise pick the unique control whose name means the same thing. Do not infer from the kind of screen. Do not pick a unique forward CTA (continue, next, log in) unless the phrase names that action or that label. If two controls fit equally, or none do, pick none." |

**Fast paths that skip Jev:**
- `type`: `elementsWithExactName` finds exactly one textfield cluster (`uniqueFieldForTyping`: a group sharing a normalized label containing exactly one textfield).
- `see`: exactly one exact-name match.
- More than one exact match returns ambiguous.
- `exactHit` writes a **synthetic** response (`probabilities {id:1, none:0}`) into the trace, so the trace looks like a Jev call that never happened.

**Oracle** (`src/jev/oracle.ts`):
- Score: `a<i>` → `{type:'score', instructions:'How completely does the current screen satisfy: <intent>?', criteria:['Not at all','Partially','Fully']}`, value = `answer.score/2`.
- Noul: `{type:'noul', instructions:'Does \`elements\` show: <intent>?'}`.
- `which` → `screen` Choice with instructions "Which option best describes the current screen? Use `screen.labels` (visible text) and `elements`. Pick none if the screen is still loading or does not match any option." and criteria `{s0:intent0,…, none:'Still loading, or a different screen that is not any of the other options'}`.
- `Steps` only calls `oracle.ask` for `score` and `classify` for `which`. The Noul `see` and `see.not` checks through `gateAssert` are not called by `Steps`.

**Response parsing** (`types.ts`): Noul reads `answer.noul ?? answer.probability ?? 0`; Choice reads `{choice ?? 'none', probabilities ?? {}, confidence}`; Score reads `answer.score ?? 0`. This is lenient: a missing field becomes 0 or none, which ends as not_found (fail-closed through the gate).

**Gate math** (`src/core/gate.ts`; defaults presence .90, none .10, target .75, gap .20, assertion .85; env `CONVOY_GATE_*`):
- **gateResolve (tap/type)**:
  - ranked = all probabilities including none, descending; `gap = top − second`, where second may be none.
  - `choiceClear = top≠none && noneP<.10 && (top≥.75 || gap≥.20)`.
  - If `noneP≥.10 || (!choiceClear && present<.90)` → not_found; if top is none → not_found; if top≥.75 → pass; if gap<.20 → ambiguous (top 3); otherwise pass.
  - tap and see send `present=1`, so the presence gate only affects `type`.
  - Unit-test fixtures show the calibration intent: present .71 with e3 .99 → pass; e2 .62 vs e3 .20 → pass on gap; e4 .48 vs e9 .44 → ambiguous; e4 .80 with none .20 → not_found.
- **strictTarget (see)**: not_found if top is none, noneP≥.10 or top<.75; ambiguous if a non-none second is within .20; otherwise pass. The "0.47 maybe login" test case is rejected.
- **gateWhich**: over non-none screens, not_found if `noneP ≥ top`; ambiguous if `second>noneP && top−second<.20`; pass if `top≥.75 || top−noneP≥.20`; otherwise not_found. A 0.7/0.2/0.1 split passes.
- **gateAssert**: see passes at ≥.85, fails at ≤.15, otherwise ambiguous. see.not is the mirror image. score passes at `≥ (min ?? .85)`.
- For `type`, an ambiguous result is re-checked with `uniqueFieldForTyping(competitors)` (label and field sharing a name).
- **Low confidence and errors:** only `NotFoundError` is retried (inside `waitUntilPresent`). `AmbiguousError`, `ToolError` (Jev or driver) and `AssertionFailedError` fail the test immediately, which is fail-closed. `mergeReport` relabels not_found/assert_failed as `timeout` once waited ≥500ms.

### 4. Actions

**Android:**
- Tap: `adb shell input tap <cx> <cy>` on the pixel center of the raw bounds (`Math.round`).
- Type:
  1. Tap the field.
  2. If `value` is non-blank: `adb shell input keyevent KEYCODE_MOVE_END KEYCODE_DEL×n`, with n = `value.trim().length`.
  3. `adb shell input text <text.replace(/ /g,'%s').replace(/['"]/g,'')>`.
  - **Quotes are silently removed and shell metacharacters (&;|$()<>*\\) are not escaped**; adb shell joins the arguments into one remote shell command.
  - Korean and other non-ASCII text is not supported by `input text` [INFERENCE: platform limitation, not exercised]. Convoy has no IME or clipboard path.
  - An EditText whose text *is* its name (no content-desc) has `value` undefined, so it is never cleared and the new text is appended.
- Back: `KEYCODE_BACK`.
- Launch: `adb shell monkey -p <pkg> -c android.intent.category.LAUNCHER 1`.
- Reset: `pm clear` / `am force-stop` plus launch, or uninstall and `install -r` (120s).

**iOS:**
- Tap: `idb ui tap <cx> <cy>`. The frame is already in **points**, so no scaling is needed.
- Type:
  1. Tap the field.
  2. If it has a value: `idb ui set-value --value "" x y`, falling back to `ui key --command 4` (Cmd+A) then `ui key 42` (Delete), then re-tap.
  3. `idb ui text <text>`, which goes through HID `text_to_events`. Confirmed in facebook/idb `idb/common/hid.py`: characters missing from KEY_MAP raise `Exception("No keycode found for …")`, so **Korean cannot be typed**.
- Back: `idb ui swipe 0 200 350 200`, a hard-coded left-edge swipe.
- Reset: `terminate`+`launch`; `clear`/`reinstall` do `uninstall`+`install`+`launch`.
- Screenshot: `idb screenshot <tmp>`, or base64 over gRPC.

No scroll or swipe step exists, so content below the fold is unreachable, and off-screen nodes are filtered out anyway.

### 5. Verification / failure handling
- **tap/type:** the step passes as soon as the driver command returns. There is no post-action assertion or change detection.
- **see:** resolve (exact-name or strict Choice) with retries until 20s.
- **see.not:** a single snapshot with no waiting. A resolver NotFound means pass; a hit or an ambiguous result fails.
- **which:** retries not_found until the timeout; ambiguous fails immediately.
- Loop limit: time only (`actionTimeoutMs`). There is no step or Jev-call budget.
- Per test: `resetBetweenTests` (default true) plus an optional `ready.see` (30s) before the body.

### 6. Specs, reporting, traces

**Specs** are YAML `*.e2e.yaml`/`*.e2e.yml` (strict keys) or TypeScript `*.e2e.ts` (`e2e(name, opts, t=>…)`, `e2e.serial`).

YAML steps:
- `tap: X`
- `type: ${ENV}` + `into: X` (unexpanded `${…}` is an error)
- `see: X`
- `see.not`/`seeNot`/`see_not`/`not:{see}`
- `back: true`
- `which: {intent: [steps]}` (at least 2 intents)

Other top-level keys are `platforms`, `tags`, `fixture` and `start: launch|attach`.

**Reporting:**
- Vitest runs with `--maxWorkers 1 --fileParallelism false` for ios/android; `--junit` writes `reports/junit.xml`; `--shard`.
- A human-readable failure report shows bars for the scores, the first 12 on-screen rows, hints, next steps and the traces path.

**Traces:**
- `.convoy/runs/<ISO-seconds>/step-NN/{elements.json, request.json, response.json, screen.png}` plus `summary.json {startedAt, platform, test, steps[{index,action,intent,outcome,ms,element,probability}], costs{inputTokens, requests}, outcome, error}`.
- `costs.inputTokens` is never filled in and is always 0.
- The directory name has one-second resolution, so a fast second test can collide.
- `elements.json` stores field values (PII).
- Debug output (`CONVOY_DEBUG_JEV=1`) omits values.
- `convoy inspect` prints the element table; `convoy capture` saves the raw dump, elements and a PNG.

### 7. Copy vs avoid

**Copy:**
- The element table plus a Choice with `none`, gated by none, target and gap.
- A separate strict `see` gate.
- A `which` screen classifier with a none option meaning loading.
- Retrying only on not_found and re-asking Jev only when the signature changes.
- Exact-name fast paths.
- Actionable-first capping at 250.
- Keeping unlabeled text fields.
- Label/field cluster resolution for typing.
- A long-lived idb gRPC helper with fallback to the CLI.
- Per-step request/response traces and the failure-report UX.
- Gates overridable per env.

**Avoid or fix:**
- The fixed screen size bug.
- Unescaped, ASCII-only Android text input and the silent quote stripping.
- ASCII-only label normalization.
- Android class-only role mapping (use `clickable`, `checkable`, `password`, `scrollable`, `resource-id`).
- Not sending `enabled` to Jev, and sending field values to Jev.
- No settle or verification after actions.
- The UTF-8-corrupted Android screenshot.
- The silent heuristic fallback without a key; recorded mode that never records.
- A signature that ignores bounds.
- The hard-coded iOS back swipe.
- No scrolling.
- iOS software keyboard `Key` nodes mapping to buttons, which floods the candidates with roughly 30 keys while the keyboard is up [INFERENCE from the role table].

---

## hugues-vnsgn/jev-ios-bridge

TypeScript, v0.1.0 experimental prerelease, Node ≥24. Pinned dependencies: `@typesafe-ai/sdk@0.6.0`, `mobilebuildmcp@2.7.1` (via npx), `zod@4.6.5`, `@modelcontextprotocol/server@2.1.0`. **License: none.** There is no LICENSE file (404) and package.json has `"private": true` with no license field, so the code is all-rights-reserved by default. Reuse the ideas only. The GitHub description ("Jev choosing each step") is out of date; ADR-0003 replaced that approach.

### Key empirical finding (ADR-0003, `spikes/`)

Three preregistered experiments with Jev choosing the next action failed their gates.

**v3** (Choice threshold 0.6): 17/20 top-1 acceptable (needed 18) and 10/20 accepted (needed 16), with 0 wrong accepts. Low-confidence cases:
- Duplicate list rows: 0.34.
- Swipe to an off-screen item: 0.33, and the choice was wrong.
- Multi-select: 0.36.
- No-results screen: 0.58.
- `stop-goal` chosen too early on unsaved forms (0.88/0.90). The goal Noul prevented these from being accepted.

The direction was then changed to **scripted actions with Jev judging assertions only**.

**Assertion evaluation** (24 screens, one true and one false claim each, fixed 0.9/0.1):
- 22/24 true and 23/24 false claims confidently correct.
- 0 false passes and 0 wrong decisive failures; 3/48 answers uncertain.
- 111,957 input tokens; about 470 ms mean latency (11,366 ms over 24 calls).
- Typical probabilities: true 0.94–0.99, false 0.01–0.07.
- Outliers: "new list blank" true = 0.80, "note empty" true = 0.78, unsaved-email false claim = 0.22.

Claims about absence or emptiness are weaker.

**Real runs:** 12 scripts matched their expected outcomes. They used 1.2k–6.2k input tokens per checkpoint and took 11–28 s each.

### 1. Observation (iOS only, simulator only)
- MobileBuildMCP CLI: `npx --yes mobilebuildmcp@2.7.1 ui-automation snapshot-ui --simulator-id <UUID> [--verbose] --output json`. Env `MOBILEBUILDMCP_SENTRY_DISABLED=true`; `maxBuffer` 8 MB; per UI command deadline 35 s (1–300 s).
- The backend is AXe, per the integration notes ("pinned AXe binary").
- Envelope: `{schema:'mobilebuildmcp.output.capture-result', schemaVersion:'2', didError?, data:{capture:{type:'runtime-snapshot', protocol:'rs/1'|'1', elements[]|targets[]/scroll[]/text[], seq, capturedAtMs, expiresAtMs, screenHash, count}, artifacts:{…}}}`. `artifacts` must be non-empty, which counts as the terminal acknowledgement.
- Full element: `{ref, role, label?, value?, identifier?, frame{x,y,width,height}, state{enabled, visible, focused?, selected?}, actions[]}`.
- A compact row is `"ref|actions|role|label|value|identifier"`, with actions `swipe`→`swipeWithin` and `type`→`typeText`. Compact mode is flagged `truncated` when targets≥64, scroll≥32 or text≥64.
- A ref expires after `expiresAtMs`, defaulting to capture + 60 s.
- Screenshot: `ui-automation screenshot --simulator-id X --return-format path`, kept local and never sent to Jev.
- The runtime and OS log tails (last 4096 bytes) come from the launch artifacts.
- Settle: there is no implicit settle. Authors write explicit `wait` steps that poll a guard every 250 ms (1–5000) up to `timeoutMs` ≤ 60,000, and the step's `guard` must still hold on each poll.
- Prepare: `simulator launch-app --simulator-id X --bundle-id Y`, which terminates any running process first. Scripts must therefore start from the observed post-launch screen.
- Close: `simulator stop …`.
- The UUID must match 8-4-4-4-12. The alias `booted` is rejected.
- Device lease: `${tmpdir}/jev-ios-bridge-device-locks/<UUID>.lock`, opened with `wx` and mode 0600, containing `{pid, token}`.

### 2. Normalization / selection (`src/scripted/select.ts`, `observe.ts`)

**Selectors** use exact equality on `identifier`, `role`, `label` and `value`. At least one of identifier/role/label is required, and value only filters. Captured refs and list indexes are rejected as selectors.

**Target resolution:**
- Match the selector.
- Keep elements with `state.visible===true`, a positive frame, `state.enabled===true` and the required action (`tap`, `typeText` or `swipeWithin`).
- Collapse aliases by (identifier, role, label, value) plus frame containment with 0.5 pt slack.
- For MobileBuildMCP 2.7.1 only: collapse identical-frame, unidentified button aliases for tap.
- Codes: 0 matches → `TARGET_MISSING`; matches exist but none usable → `TARGET_UNAVAILABLE`; more than one → `TARGET_AMBIGUOUS`; truncated snapshot → `SNAPSHOT_TRUNCATED`.

**Guards:** every `present` selector must match exactly one visible element (`GUARD_MISSING`/`GUARD_AMBIGUOUS`), and every `absent` selector must match none (`GUARD_FORBIDDEN`). This handles sheets whose background controls remain in the tree: forbid the sheet's anchors.

**Assertion projection** (`renderAssertionState`, rule `visible-full-text-v1`):
- Throws `TRUNCATED` for a truncated snapshot.
- Drops `state.visible===false`, zero frames, `/status.?bar/i` in role or identifier, and scroll-bar sliders (`/^(vertical|horizontal) scroll bar,?\s*\d+ pages?$/i`).
- Keeps an element if it has a label, value or identifier, has any action, or has role text|statictext|title|heading|alert.
- Output: `'Current iOS screen (full accessibility capture):\n' + JSON.stringify({role,label?,value?,identifier?,frame?,state?})` for each element, one per line.
- Errors: `EMPTY_SCREEN`; `STATE_BUDGET` above 24,000 bytes. Overflow stops the run instead of truncating.

### 3. Jev usage (`src/scripted/jev.ts`)
- The model is pinned: `jev-1.13.0` (not `jev-latest`). The client is `new TypeSafeClient({defaultModel, logLevel:'warn'})` with `TYPESAFE_API_KEY` from the environment; a missing key raises `AUTH` before any run.
- Request: `{model:'jev-1.13.0', state:<projection string>, questions:{'assertion:<encodeURIComponent(id)>': noul({question:'Does the visible evidence on this current screen support this specific claim?', claim:<claim>})}}`.
  - SDK 0.6.0 `NoulQuestion.instructions` accepts text **or a JSON object**, so the question and the claim are sent as structured instructions.
  - A checkpoint has 1–20 claims, each ≤1000 chars, with ids matching `/^[A-Za-z][A-Za-z0-9_-]{0,63}$/`.
  - There is no Choice, no completion question and no values dictionary, so typed values are never sent to Jev directly.
- Budget: `bytes(JSON(state)) + longest question ≤ 28,000` and the whole request ≤ 56,000; otherwise `REQUEST_BUDGET`.
- Response validation (strict): `raw.model === 'jev-1.13.0'`; `answers` is a record with exactly N keys; each answer has `type==='noul'` and a finite `noul` in [0,1]; `usage.input_tokens` and `output_tokens` are non-negative safe integers. Anything else is `MALFORMED_RESPONSE`, and response bodies are never echoed.
- Error mapping: `APIUserAbortError`→ABORTED, `APITimeoutError`→TIMEOUT, `APIConnectionError`→NETWORK, `APIError` 401/403→AUTH, 429→RATE_LIMIT, other→SERVICE, else UNKNOWN. The bridge adds no retries of its own.
- **Historical autonomous design** (`src/jev/index.ts`, `src/observation/index.ts`), kept for the record:
  - `next_action` Choice over options `tap:<ref>`, `type:<ref>:<valueKey>`, `swipe:<ref>:<dir>`, plus `wait`, `stop-goal`, `stop-blocked` and `none` (≤255 options; ≤64 candidates).
  - Plus a `goal_reached` Noul and assertion Nouls.
  - Gate: Choice confidence ≥0.7 (0.6 in v3); goal ≥0.9 yes, ≤0.1 no, otherwise uncertain and stop; `stop-goal` must agree with the goal Noul.
  - Choice probabilities had to sum to 1 ± 0.02.
  - Three wordings exist (DEFAULT, V2, V3); V3's nextAction reads "Which complete listed action most directly establishes the current checkpoint desired screen state…".

### 4. Actions (`src/device/index.ts`)
- Tap: `ui-automation tap --simulator-id X --element-ref REF --output json`.
- Type (full replacement): `ui-automation type-text --json '{"simulatorId","elementRef","text","replaceExisting":true}'`.
- Swipe: `ui-automation swipe --simulator-id X --within-element-ref REF --direction up|down|left|right`.
- Each action requires the terminal ack schema `mobilebuildmcp.output.ui-action-result` with non-empty `data.action` and `data.artifacts`. Otherwise the error is `TERMINAL_ACK_MISSING` and the command stays "unconfirmed", which keeps the device lock.
- Refs are addressed by element, never by coordinates, so there is no points/pixels arithmetic.
- Stale refs:
  - Proactive: if `now ≥ expiresAt − 5 s`, re-observe. If the screen is unchanged (screenHash, or element JSON without refs), rematch by identifier or by the unique (role,label) pair; otherwise throw `StaleSnapshotError`.
  - Reactive: on `SNAPSHOT_EXPIRED` or `ELEMENT_REF_NOT_FOUND`, re-observe, rematch and retry once.
  - In the runner, `StaleSnapshotError` triggers a re-capture. A changed screen gives `SCREEN_CHANGED` (inconclusive); otherwise it re-checks the guard, re-resolves and acts once more.
- Text input: `values` must be printable ASCII (`/^[\x20-\x7e]*$/`), ≤2048 chars, ≤32 entries, and cannot start with `-` (a vendor limitation). **Korean and unicode are explicitly unsupported.** The notes record a real simulator keyboard casing bug (lowercased text, failed replacement) that only a MobileBuildMCP reboot fixed. Authors are told to verify typed text with the next guard.
- There is no back action; navigation is through explicit tap targets.

### 5. Verdict / fail-closed rules (`src/scripted/run.ts`)

**Checkpoints:** `answers.some(p => p>0.1 && p<0.9)` → **inconclusive** (`ASSERTION_UNCERTAIN`); else `some(p ≤ 0.1)` → **failed** (`ASSERTION_FALSE`); else passed. The first non-pass checkpoint ends the run.

**Run passed** only when all of these hold:
- Every step ran.
- Every checkpoint passed.
- The reason is still `SCRIPT_INCOMPLETE`.
- Cleanup succeeded.
- Nothing was aborted.

**Inconclusive with a code otherwise:** any exception (guard or target codes, `WAIT_TIMEOUT`, `SCREEN_CHANGED`, `INVALID_JUDGMENT`, Jev codes, device codes). Cleanup failure also forces inconclusive, overriding even a failed verdict; so do `WALL_LIMIT` (default 300 s, ≤1 h), `STEP_LIMIT` (≤100) and `CANCELLED`.

**Structural rules:**
- The script must end with a checkpoint.
- `checkedJudgment` re-validates the model id, token counts and probability ranges.
- Cleanup waits for pending device operations. If any command is unconfirmed, the result is `UI_ACTION_UNCONFIRMED` and the lock is kept.
- A journal with no final verdict is inconclusive.
- CLI exit codes: 0 passed, 1 failed, 2 inconclusive or startup failure.
- Jev never generates input text or chooses actions. An uncertain answer never becomes a pass, and nothing silently falls back to host control.

### 6. Spec, reporting, evidence

**Spec** is JSON (zod strict):
```json
{"app":{"bundleId":"…"},"device":{"udid":"…"},"preconditions":["…"],"values":{"key":"…"},
 "steps":[{"id":"s1","kind":"action","guard":{"present":[{…}],"absent":[{…}]},"action":{"kind":"tap"|"replaceText"|"swipe","selector":{…},"valueKey"?,"direction"?}},
          {"id":"w","kind":"wait","guard":{…},"until":{…},"timeoutMs":≤60000},
          {"id":"c","kind":"checkpoint","guard":{…},"assertions":[{"id":"a","claim":"The selection summary reads Selected: Apple."}]}]}
```

**Entry points:** CLI `run scenario.json --max-steps --timeout-ms`, `report RUN_ID`, and an MCP server (`start_scenario`, `get_report` with waitMs ≤45000, `cancel_run`).

**Evidence:**
- Journal: `.jev-runs/<run-id>/run.jsonl` (`JEV_RUNS_DIR`); directories 0700, files 0600, created with exclusive `wx` (no resume), fsync on every append.
- Event shape: `{version:1, runId, sequence, at, type: started|prepared|step|judgment|action|checkpoint|error|verdict, data}`.
- Step events carry `observationSummary` (≤4000 chars with head and tail), the full `assertionObservation` at checkpoints, `screenshotPath` (copied into the run dir) and `logTails`.
- Judgment events carry probabilities, input tokens and latency. The verdict event carries phase timings and device metrics.
- Redaction: literal supplied values and the API key become `[REDACTED]`; keys named authorization|apiKey|api_key|password|token are redacted; secret-bearing dynamic keys become HMAC pseudonyms. Screenshots are not redacted.
- The watch page binds 127.0.0.1 and requires a token.

### 7. Copy vs avoid

**Copy:**
- The assertion-only Noul with a fixed instruction and a structured `{question, claim}`.
- The three-way verdict (passed / failed / inconclusive), where uncertain never passes.
- A pinned model id and a strict response schema.
- Byte budgets that stop instead of truncating.
- Guards with present/absent and exactly-one matching.
- Terminal acknowledgements plus a retained lock on unknown outcomes.
- Stale-ref rematch only when the screen is unchanged.
- An fsynced JSONL journal with redaction.
- Evaluating Jev on frozen screens against preregistered bars before trusting it.

**Avoid or treat as limits:**
- iOS simulator only; no Android.
- English and printable-ASCII input only.
- Authors must write accessibility-identifier selectors, which is costly and brittle for apps with poor accessibility.
- No settle other than explicit waits.
- Screen scope is the app capture only; system alerts are not handled [INFERENCE].
- `launch-app` kills the process, so no warm attach is possible.
- Compact capture truncation turns into inconclusive.
- No license.