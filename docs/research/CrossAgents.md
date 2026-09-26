# CrossAgents — how 7 Jev-based mobile agents are built (source review, 2026-09-26)

Method: files read from `raw.githubusercontent.com` (default-branch HEAD), GitHub tree pages and unpkg. This subagent has no shell, so nothing was cloned or run; `api.github.com` returned 403. Every claim cites a file. Anything marked [INFERENCE] was not observed directly.

---
## Cross-cutting takeaways

| Concern | Best pattern found | Where |
|---|---|---|
| iOS sim tree | sim-use (idb FBSimulatorControl + Apple AX APIs + HID, per-UDID daemon, no runner in app) or agent-device (local accessibility bridge for sim snapshots, XCTest for interactions) | lycorp-jp/sim-use README; callstack/agent-device README |
| Android tree | `adb shell uiautomator dump /data/local/tmp/<f>.xml` + `adb exec-out cat`, retry 3×/400ms when no `<node` | @phone-use/sdk `src/backends/android.ts` |
| Settle | overlapped confirmation read + identity/layout fingerprints + read-until-changed (≤2s) | jev-sim-use `AgentLoop.swift`, `AgentLoop+Step.swift`, `UISnapshot+Identity.swift` |
| Request shape | one request: `operation` choice + `<op>_target` choices + done noul | jev-phone `policy.ts`; jev-sim-use `JevStepPlanner.swift`; jevium `policy.go` |
| Response validation | offered label, keys==options, [0,1], sum≈1, choice==argmax; fail → no action | jev-phone `jev.ts` `parseAnswers`; jevium `ValidateChoice`; jevis `jevis_policy.dart` |
| Gate | risk tiers: harmless 0.5 / reversible 0.55 / irreversible 0.6 / leaves-app ~0.85; support=min(factors) | jev-sim-use `ActionPolicy.swift` |
| DONE | never trusted alone: noul check + veto / deterministic text check / external verify | jev-phone `agent.ts`; jevium `agent.go GoalVisible`; jevis `verify:` |
| Text | Jev never generates text; names or registered values only; Unicode via paste (iOS) / ADBKeyBoard (Android) | jev-sim-use `-t`; jevis `enterText(values)`; phone-use `typeUnicode` |

TypeSafe wire facts collected:
- Native: `POST https://api.typesafe.ai/v1/systemone`, `Authorization: Bearer`, body `{model, state, questions}`. Response `{model, answers:{<qid>:{type:'choice', choice, confidence, probabilities:{label:p}} | {type:'noul', noul:p}}, usage}`. jev-sim-use reads `usage.estimatedCostUSD` via swift-jev.
- Vercel gateway: `POST https://ai-gateway.vercel.sh/v4/ai/evaluation-model`, headers `ai-gateway-protocol-version: 0.0.1`, `ai-evaluation-model-specification-version: 4`, `ai-model-id: typesafe-ai/jev`. `noul` is called `boolean` (answer field `probability`). Confidence comes back out-of-band in `providerMetadata.typesafe.confidence.<qid>`. Probabilities are rounded to 0.01 (jev-phone `jev.ts`).
- Limits:
  - a choice needs ≥2 options (jev-phone, jev-sim)
  - at most 255 options (jev-sim `typesafe.py`; jev-sim-use `ActionCatalog.maximumOptions`); jevis uses 254 + `__stop__`
  - state ~32k tokens (jev-sim-use `PlanningState.swift` comment)
- Models seen: `jev-latest`; `jev-1.13.0` (pinned default in jev-sim-use); `typesafe-ai/jev` (gateway).

---
## 1. Rajmeet/jev-phone (TS/Bun, uses @phone-use/sdk 0.5.1)

**Observation**
- **iOS Simulator:**
  - `ios.connect(udid?)` or `ios.launch()`, then `createAgentDeviceBackend`, which calls callstack's `agent-device` client `client.capture.snapshot({udid, interactiveOnly:true})` (unpkg `src/backends/agent-device.ts`).
  - The agent-device README says: "local accessibility bridge for iOS Simulator snapshots and XCTest for iOS interactions".
  - Simulator lifecycle uses `xcrun simctl create|boot|bootstatus <udid> -b|shutdown|delete|list devices [booted] -j`. Exit 149 is tolerated (already in that state). Simulators are named `phone-use-<hex>` so orphans can be reaped; the daemon session is `phone-use-<udid>` (`src/backends/ios.ts`).
  - `apps.ts` filters out `-Runner (`/`xctrunner)` apps, which suggests an XCTest runner is installed on the simulator.
- **Android** (`src/backends/android.ts`):
  - `uiautomator dump /data/local/tmp/phone-use-dump.xml`, then `adb exec-out cat`. Retries 3× with a 400 ms sleep; a dump with no nodes is treated as an error (dumps fail mid-animation).
  - Screen size from `wm size`; `Override size` wins over `Physical size`.
  - Foreground app from `dumpsys activity activities | grep -m1 ResumedActivity`, regex `\su0\s+([\w.]+)\/`.
  - Adds a synthetic `Application` root node at the real screen size. Without it the SDK assumes a 1000 px viewport and treats everything below y≈1000 as off-screen.
  - Screenshots via `adb exec-out screencap -p`.
- **Cloud:** `createCloudSandboxBackend()`, wrapped by `resilient()` (`src/device.ts`).
  - SESSION_NOT_FOUND: re-open the last app, wait 1500 ms, retry once.
  - Read-only calls (snapshot/screenshot/listApps) are retried once after 3000 ms. Actions are never retried.
- **Settle:**
  - The cached tree is reused if younger than 1500 ms (`readScreen`).
  - `press`/`fill` diff the tree themselves: signature before, act, one re-snapshot, signature after. The signature is `${nodes.length}#` plus the first 16 `ref:label` pairs.
  - After an app launch, `settleAfterLaunch` polls every 500 ms for up to 12 s until the app has changed and there are ≥5 controls or the count is stable.
  - There is no general "animations finished" check.
  - README timings: a tree read takes ~0.7 s on the iOS sim and ~2 s on Android; a Jev decision takes 250–650 ms.

**Normalization** (`src/screen.ts`)
- `onScreen`: the element's centre must be strictly inside the viewport on both axes (width taken from the `Application` root), and the element must be enabled and not blocked.
- Elements are split into buckets:
  - `controls`: interactive, not Switch, excluding launcher app icons and anything on the `avoid` list
  - `switches`
  - `fields`: iOS `inputFields(true)`; on Android, EditText / AutoCompleteTextView / MultiAutoCompleteTextView / SearchView
  - `apps`
  - Each bucket is capped at 60. `visibleText` is the distinct labels in tree order, capped at 3000 chars.
- Title: the first StaticText of ≤40 chars with 44≤y<180, skipping the clock (`^\d{1,2}:\d{2}`). Falls back to the nav bar title, which on iOS is often the back button's text.
- IDs are `1..N` per bucket, and code maps them back. Elements are remembered by `role|label` and by `role@round(x/10),round(y/10)`.
- Android hierarchy (`android-hierarchy.ts`):
  - Android classes are mapped to iOS-style types:
    - EditText family → TextField, or SecureTextField if `password=true`
    - Switch / SwitchCompat / CheckBox / ToggleButton / RadioButton → Switch
    - SeekBar → Slider
    - ImageButton, and anything `clickable=true` → Button
  - label = `text || content-desc`
  - `absorbRowLabels`: an unlabelled clickable container (height ≤25% of the screen) takes the first plain label inside its bounds.
  - An unlabelled Switch takes the leftmost label to its left that overlaps its row by ≥50%.
  - Refs are `@aN`.

**Jev** (`src/policy.ts`, `src/jev.ts`)
- `state`: `{goal, screen:{app,title,visible_text,controls:[{index,label,role,value?}],switches,text_fields}, apps:[names], recent_actions:[{operation,outcome,target?,text?}] (last 8)}`.
- `questions`:
  - `operation`: a choice. Instructions `{goal, rules: RULES}`. Criteria are only the operations this screen supports and that aren't vetoed: TAP/TOGGLE/TYPE/SCROLL_DOWN/SCROLL_UP/BACK/OPEN_APP/WAIT/DONE/BLOCKED, each with a description.
  - `goal_done`: a noul (`DONE_CHECK`).
  - Speculative targets `tap_target|toggle_target|type_target|app_target`, only when there are ≥2 items (criteria `"1".."N"` → `{label,role,value}`). Only the target question for the chosen operation is read.
- confidence = min(operation, target).
- Validation: must be an offered label; probability keys == labels; each in [0,1]; sum within ±0.03; the choice must be ≥ max−0.011. Otherwise the step fails; answers are never repaired.
- Retries on 408/429/500/502/503/504/529 and network errors, up to 4, backoff min(1000·2^(n−1), 8000) ms, 10 s timeout per attempt. If Jev is unavailable the run ends `stopped` (fail-closed).
- Gates:
  - `minConfidence` defaults to 0, i.e. it acts on whatever scored highest.
  - `doneThreshold` 0.6.
  - DONE veto: the first unverified DONE is removed from the next menu and the last tapped element is withheld for 2 decisions. A second DONE is accepted if P(done) ≥ 0.2, otherwise the run ends `blocked`.
  - 3 WAITs in a row: WAIT is withheld for the next step.
  - BLOCKED: stop.

**Actions** (`agent.ts execute` + SDK)
- Before acting: take a fresh `observe()` and re-find the element by role + label + value, nearest to its old centre. If it's gone or the app changed, mark stale and decide again; 3 stale in a row stops the run.
- TAP: `core.press(ref)`. On Android that's `input tap cx cy`.
- TOGGLE: `pressAt(x+w−24, y+h/2)` on the knob, then observe and read the value back.
- TYPE on Android: tap the centre, wait 120 ms, then clear with `input keycombination 113 29` (Ctrl+A), DEL, MOVE_END and 8×DEL (67). Then:
  - ASCII: `input text` in chunks of 400, shell-quoted
  - non-ASCII: `pm list packages com.android.adbkeyboard` → `ime enable/set com.android.adbkeyboard/.AdbIME` → `am broadcast -a ADB_INPUT_B64 --es msg <base64>` → restore the previous IME
  - If the IME is missing or `WRITE_SECURE_SETTINGS` is denied, it throws an explicit error rather than dropping the text.
  - `\n` becomes KEYCODE 66 and `\b` becomes 67.
- TYPE on iOS: agent-device `interactions.fill`. It's inside agent-device; [INFERENCE] XCTest typeText.
- SCROLL on Android: `input swipe` from the centre ±35% of height, 450 ms, then a 350 ms sleep so the list doesn't keep flinging.
  - If `dumpsys input_method` contains `mInputShown=true`, the swipe moves to y=30% ±15% so Gboard doesn't read it as glide typing.
  - The finger moves opposite to the content you want to see.
- BACK: Android `input keyevent 4`; iOS agent-device `command.back`.
- OPEN_APP: `openApp(bundleId)` then settle.
- HOME is not offered.
- Destructive taps are refused unless `allowDestructive` is set: regex `/\b(delete|remove|erase|pay|purchase|buy|send|transfer|confirm order|place order|sign out|log out|unsubscribe|cancel subscription|reset|format)\b/i`.
- Every adb shell argument goes through `shellQuote`, because `adb shell` joins its arguments unescaped.

**Verification and failure**
- Each action's outcome is "screen changed" or "no visible change".
- The same action failing or changing nothing twice in a row: `blocked`.
- A failed TAP withholds that element for 2 decisions.
- Budget: `maxSteps` 25.
- Statuses: done / blocked / stopped / budget.
- Independent checks live in the examples:
  - `examples/bold-text.ts` relaunches Settings with plain SDK calls and reads the switch value, which must be `'1'`.
  - `examples/new-contact.ts` searches for a unique last name.
  - Both exit 0 or 2 and print a JSON record.

**Spec / reports:** a goal string. `run()` is an async generator that emits an `AgentEvent` per decision: screen summary, offered operations, decision, all answers with probabilities, jevMs, textMs, action outcome, status. `screenshotDir` saves one frame per step; Jev never sees them.

**Text helper** (`src/text.ts`): an OpenAI-compatible chat model, default `meta/llama-4-scout` on the gateway, `max_tokens` 300, `response_format json_object`. It must return exactly `{"text": string≤2000|null}`; `null` means nothing is typed and the run ends blocked.

**Strengths:** one request per step; operations offered only when the screen supports them; strict validation; re-find before acting; DONE veto; destructive denylist; explicit Unicode failures; careful Android gestures.

**Weaknesses:**
- No confidence gate by default.
- A repeated DONE is accepted at P ≥ 0.2.
- Text is generated by an LLM, so it isn't deterministic.
- No handling of alerts or permission prompts (README).
- The 60-control and 3000-char caps can hide targets on long screens.
- The phone-use README says there is no Android engine, but the 0.5.1 source has a working one — the docs are out of date.

**License:** MIT (@phone-use/sdk is Apache-2.0).

---
## 2. Ryu0118/jev-sim-use (Swift 6.2, macOS 15, drives the sim-use CLI, uses swift-jev)

**How sim-use reads the iOS simulator tree** (lycorp-jp/sim-use README)
- iOS Simulator: Meta idb's XCFrameworks (FBSimulatorControl), statically linked, plus Apple Accessibility APIs and the simulator HID pipeline. It is a fork of cameroncooke/AXe. A per-UDID daemon starts automatically and exits after 600 s idle; a round trip is ~300 ms; `SIM_USE_NO_DAEMON=1` runs a call in-process.
- Android: a bridge APK (installed with `sim-use android init --device <serial>`) exposes the AccessibilityService tree and input injection over HTTP through `adb forward`.
- Physical iOS: FBDeviceControl lockdown plus DTX to the accessibility audit daemon. Only apps built with `get-task-allow=true` (development-signed); there are no frames, so no coordinate taps.
- Output of `sim-use ui --json [--no-raw]`: `{ok, data:{platform, outline, entries:[{aliases:{at,list}, role, label, value, frame{x,y,width,height}, region{kind,label}, states[], uniqueId, depth, hint}], lists, screen, appLabel, appPackage}, process:{disappearedBundleIDs}}`.
  - The outline has bands `[Top y<120] / [Content] / [Bottom]`.
  - Aliases: `@N`, `#N` (list cells), `#<AXUniqueId>`.
  - Coordinates are iOS points in device-native portrait.
- jev-sim-use keeps the raw tree (`SimUseClient.observe`) because only it carries iOS accessibility hints; this grows the payload from ~5 KB to ~16 KB.

**Settle** (`AgentLoop.swift`, `AgentLoop+Step.swift`)
- **Overlapped confirmation:** a second `ui` read (B) runs while Jev plans on read A.
  - Same outline: act.
  - If the last action hadn't shown any effect yet: plan again on B.
  - Same `layout`: act.
  - Otherwise: re-aim the action from A to B (`retargeted`).
  - After `disagreementLimit` = 2, fall back to `observeSettled`: read until two consecutive outlines match, at most 2 extra reads.
- After an action, an unchanged `identity` is re-read back-to-back (~0.4 s each) until it changes or 2 s pass (`unchangedWait`).
- DONE or hand-over on a screen that hasn't settled is deferred. `reading(changedFrom:)` keeps reading for up to 5 s (`handOverWait`), replanning at most 2 times (`staleReplanLimit`).
- Fingerprints (`UISnapshot+Identity.swift`):
  - `identity` = appLabel + role|label|value|uniqueId|states — no frames, so a bouncing scroll doesn't count as a change
  - `layout` = role|label|uniqueId|frame — no values, so text like "12 seconds ago" doesn't count as a change
- `wait` pauses 1 s.

**Normalization** (`ActionCatalog.swift`, `PlanningState+Screen.swift`, `UISnapshot+Occlusion.swift`)
- Removed from the menu:
  - disabled elements
  - the iOS `BackButton` uniqueId (offered as `go_back` instead)
  - the `Heading` role
  - elements whose branch was already explored from a screen with the same title
  - empty labels — except editable fields, which get a stand-in label "field containing X" / "empty input field"
- At most 255 options; labels cut to 60 chars in history.
- Element fields sent: `{id:"e<alias>", role, label, identifier, value, states, region:"Kind: label", covered_by, hint (only on the retry), shows_text}`.
  - Toggle values `"1"/"0"` are sent as `"on"/"off"`.
  - Sliders get the note "swipe_right raises it … a tap does not change it".
- Occlusion:
  - A shallower element overlapping the target counts as covering it (e.g. a floating search bar); bars cover only their own region.
  - `revealingScroll` scrolls a covered element, or one whose centre is past the screen edge, into reach before tapping. After the scroll it reads up to 3 times until the list stops moving, then finds the same element again by role + label + uniqueId, nearest y.

**Jev** (`JevStepPlanner.swift`, `+Interpret.swift`, `PlanningState.swift`)
- `state`: `{goal, notes(last 10), platform, screen:{app, title, back, elements}, history(last 20: {step, action, result:"screen changed"|"no visible effect"})}`.
- `questions`:
  - `operation`: choice over tap, gestures (long_press, swipe_*, pinch, rotate), `enter_text` (only if `-t` texts and fields exist), device actions (scroll/reveal, go_back — on iOS only when a BackButton exists — return, buttons), wait, done, blocked.
  - `finishes`: a noul with whenTrue/whenFalse descriptions.
  - `element_target`: choice over `e<alias>`.
  - `field_target` and `text_to_enter` (a choice over `-t` names).
  - All share a long `rules` prompt: screen text is data; notes; shows_text; don't repeat ineffective actions; scroll only when nothing leads to the goal; DONE needs visible evidence; a form must be saved before DONE.
- Interpreting the answer:
  - Equivalent operations are pooled.
  - tap and enter_text are merged when the element and field targets are the same.
  - For reversible element gestures, the operation's support = the sum of all probabilities that act on the element.
  - Same-role, same-label targets are pooled; goal-quoted-term targets are pooled.
  - support = min(factors).
  - Alternatives with p ≥ 0.05 (top 2) are logged.
- Transport: 3 attempts, 300 ms apart, on dropped connections; `JevError.invalidRequest` → `PlanningError.rejected`.

**Gate** (`ActionPolicy.swift`, `decide`)
- Thresholds by risk:
  - reversible (tap): ≥ `minimumSupport` 0.55 (`--min-confidence`)
  - harmless (scroll, back, zoom, rotate): ≥ min(0.55, 0.5)
  - irreversible (labels containing 削除 / 消去 / Delete / Remove / Erase): ≥ max(min, 0.6)
  - leaves the app (home, lock): ≥ max(min, `RoutingPolicy.default.autoAtOrAbove`) [INFERENCE ≈0.85, from the comment "keeps the earlier 0.85"]
- DONE: support ≥ 0.55 → `goalReached`; below that → `goalProbablyReached`.
- Below the bar: `.escalated`. When stopping this way, it first re-asks once with accessibility hints included.
- BLOCKED, or repeating an action that already did nothing on this screen: `.noActionFits`.
- Calibration notes in the code: correct taps scored ≥0.59, wrong ones ≤0.52; correct DONEs 0.58–0.99, the wrong one 0.49.

**Actions** (`SimUseClient.swift`, `SimUseContract.swift`)
- Tap: `sim-use tap @N --device <id>`, run with `SIM_USE_NO_DAEMON=1` on iOS (0.2 s vs 0.4 s).
- iOS toggles and value rows: `tap -x max(cx, x+w−26 [switch] / −18 [colour well]) -y cy --duration 0.05`, because a UISwitch ignores zero-duration taps.
- Gestures:
  - `long-press`
  - `swipe --from x,y --to x,y`
  - `gesture scroll-up|down|left|right` — named by finger direction, so `scroll-up` pages down; vertical 1.5 s, sideways 0.3 s
  - `pinch-in|out` and `rotate-cw|ccw` with `--center-x/--center-y`
- iOS back: tap the BackButton if present, otherwise `swipe-from-left-edge`.
- Return: iOS `sim-use ios key 40`; Android `type "\n"`.
- Text entry:
  - tap the field, then `sim-use paste -- <text>` (`simctl pbcopy` + Cmd+V, which handles Unicode/CJK)
  - on iOS, if `keyboard-state` reports the soft keyboard visible, it refuses with `hardwareKeyboardRequired`: Cmd+V is dropped when no hardware keyboard is connected, yet sim-use reports success
  - `--` stops text starting with `-` being read as a flag
  - text values are never sent to Jev

**Verification and failure** (`AgentProgress.swift`)
- Stalled: the screen is revisited `stallLimit` 3 times.
- Crashes: `process.disappearedBundleIDs` or a crash dialog in the tree → `appCrashed`.
- Budget: `maxSteps` 15.
- Each screen identity remembers which actions did nothing there; branches already explored are skipped. `ScanFirst` scrolls down once to scan a screen first.
- Stopped runs become sessions: `session show | tell -n | forget | resume`, expiring after a week.
- `FailureCategory`: setup vs runtime.
- Contract tests check every CLI string against `sim-use --help`.

**Weaknesses:**
- Can't launch apps (sim-use has no launch verb).
- No physical iPhones.
- iOS paste needs a connected hardware keyboard.
- The destructive word list has no Korean (e.g. 삭제).
- No deterministic assertions.

**License:** MIT.

---
## 3. Aben25/jev-sim (Python, sim-use adapter)

- **Observation:** `sim-use ui --no-raw --json [--device $UDID]` via subprocess, 60 s timeout. `SIM_USE_BIN` and `JEV_SIM_DEVICE` are honoured, and a `{ok,data}` envelope is accepted (`sim_use.py`). The fixture `tests/fixtures/ui_settings.json` shows the sim-use JSON shape.
- **Normalization** (`candidates.py`):
  - Skips StaticText/TextView/Image/ImageView/Group/Other/GenericElement/Window/Application/ScrollView/ScrollArea unless the element has a uniqueId or resource_id, or its states mention link/button.
  - Skips states disabled / not-enabled / unavailable.
  - id `@<aliases.at>`; label = label or role, plus ` #uniqueId`, cut to 120 chars; de-duplicated by id; `max_taps` 80.
  - Always adds `done`, `scroll-up`, `scroll-down`, `wait`.
  - The outline sent is cut to 8000 chars.
- **Jev** (`typesafe.py`):
  - `POST https://api.typesafe.ai/v1/systemone`; `TYPESAFE_BASE_URL` and `TYPESAFE_MODEL` override.
  - Body: `{model:'jev-latest', state:{task:'mobile simulator computer-use', goal, screen_outline, candidate_ids}, questions:{action:{type:'choice', instructions, criteria:{id:"kind: label [selector]"}}}}`.
  - Options: 2..255.
  - Parses `answers.action.{choice, confidence, probabilities}`, `model`, `usage`.
  - HTTP ≥400 raises and the loop dies.
  - **No confidence gate and no probability validation.**
  - The API key is also read from a hard-coded `/home/box/.config/typesafe/api_key`.
- **Actions:** `sim-use tap @N`; `sim-use gesture scroll-up|scroll-down`; wait sleeps 0.5 s; `done` stops. No text input.
- **Verification:** none. The loop runs until `done` or `max_steps` 20, with no check that the screen is fresh and no DONE verification. Logs `choice/conf/observe/decide/exec ms`.
- **Pitfall:** the meta-action description "scroll-up: Scroll content up (page down)" mixes finger direction with content direction.
- **License:** MIT.

---
## 4. NIHAD779/jev-test (Node, Appium XCUITest + UiAutomator2, Jev plus a Gemini fallback)

- **Service:** `POST /tasks` → 202 `{taskId}`; `GET /tasks/:id` → `{status, failReason, history}`. Tasks are held in memory; LangSmith tracing is optional.
- **Sessions:** Android uses webdriverio `remote()` with `automationName UiAutomator2` and `newCommandTimeout 300`. iOS uses a raw REST session, then `POST /appium/device/activate_app {bundleId}` and `POST /orientation {PORTRAIT}`. Every Appium call goes through `makeAppiumRequest`: 3 retries on timeout, network or 5xx errors, delay 1000·attempt ms.
- **Observation:** every step waits a fixed `pause(5000)`, then `GET {APPIUM_URL}/wd/hub/session/{id}/source`. There is no settle logic.
- **Normalization** (`perception/parsePageSource.js`):
  - Android elements kept: clickable, long-clickable, scrollable, or class containing EditText.
  - iOS elements kept: types Button/Cell/TextField/SecureTextField/SearchField/Switch/Link/Tab/MenuItem/SegmentedControl/Slider/PickerWheel/Key with `visible != "false"`.
  - label: the element's own (Android `text||content-desc`; iOS `label||name||value`), otherwise its descendants' labels joined.
  - rect `[x1,y1,x2,y2]`: pixels on Android, points on iOS.
  - An absolute xpath is built from tag and sibling index.
  - No off-screen filtering, no de-duplication, no cap.
  - Sent to the model as `{index,type,label,editable,bounds}`.
- **Jev** (`agents/jevAgent.js`):
  - AI SDK `experimental_evaluate({model:'typesafe-ai/jev', state:{userInstruction, elements, history}, questions})`.
  - `action`: a choice over click/input/swipe_up/swipe_down/wait/handoff_vlm/done/fail.
  - `elementIndex`: a choice over `"i"` → `"[type] label (editable)"`.
  - confidence = `providerMetadata.typesafe.confidence.action ?? answers.action.probabilities[action]`.
  - Hands the step to the vision model when the action is `input` or `handoff_vlm`, or confidence < `JEV_CONFIDENCE_THRESHOLD` (0.6).
- **Vision fallback:** Gemini (`gemini-3.8-flash`) via LangChain with structured output. It gets a screenshot with numbered red boxes drawn by sharp; box coordinates are scaled by screenshotWidth / windowWidth to convert iOS points to pixels.
- **Actions** (`executor.js`, `appium/*`):
  - Element lookup tries, in order:
    - Android: xpath → `id` resourceId → customxpath → `//*[@text='..']` → accessibility id → `//*[@bounds='..']`
    - iOS: xpath → accessibility id name → `@label` → `@value` → `@name`
  - click: `POST /element/{id}/click`.
  - input: `/element/{id}/clear`, then `/element/{id}/value {text, value:[chars]}`, then presses keycode 66 (an Android-only endpoint; errors are swallowed).
  - swipe: W3C `/actions` pointer from the centre ±25% of height over 500 ms.
  - wait: 5 s.
- **Verification:** none. Done/fail are the agent's own claims. A failed action is recorded and the loop continues. `MAX_STEPS` 30; statuses done/failed/max_steps_reached/error; the session is always deleted.
- **Pitfalls:**
  - Uncertainty goes to a generative model instead of stopping.
  - The element choice's confidence is never gated.
  - `escapeQuotes` uses `\'`, which XPath 1.0 doesn't support, so labels containing apostrophes break.
  - Locators take the first match, which is wrong when labels repeat.
  - Enter after typing can submit a form.
  - The fixed 5 s pause is slow.
  - History fields can be `undefined`; the code comment says Jev rejects that [INFERENCE: whether it actually fails depends on the SDK's serialization].
- **License:** no LICENSE file.

---
## 5. aldouus/jevium (Go 1.27; Appium iOS XCUITest and Chrome; optional macOS Vision OCR)

- **Session** (`internal/appium/device.go`):
  - Capabilities: `platformName iOS, automationName XCUITest, udid (APPIUM_UDID required), wdaLocalPort 8101, mjpegServerPort 9101, wdaLaunchTimeout 180000, newCommandTimeout 3600, noReset true, xcodeSigningId "Apple Development"`.
  - Then `POST /appium/settings {settings:{includeHittableInPageSource:true}}`.
- **Observation:**
  - `GET /session/{id}/source`; screenshots are optional and never sent to Jev.
  - `--visual-ocr` adds macOS Vision OCR: `VNRecognizeTextRequest` (.accurate, no language correction, keeps results with confidence ≥0.8), run via `xcrun swift -e <embedded ocr.swift>` with the PNG on stdin and a 60 s timeout.
  - Regions are normalised with y flipped. Validation: at most 250 regions, all inside [0,1]; the window rect must be at 0,0 and match the page W×H, aspect within 0.01.
  - OCR text whose centre falls inside an existing click target is dropped. The rest become `visual_<i>` click targets labelled "visual text (clickability unknown)".
  - Before acting on OCR targets, the native fingerprint and the screenshot's sha256 must both be unchanged.
- **Settle / freshness:**
  - No settle logic. Before every action, `Fresh()` fetches the source again, rebuilds the snapshot and compares the sha256 fingerprint (controls + text + actions, including rects) and the target's kind + label + rect.
  - If anything differs: stale, observe again.
  - The model-call budget is 2×`MaxSteps` = 120.
- **Normalization** (`internal/appium/snapshot.go`):
  - Clickable types: Button/Icon/Cell/Link/Tab/Image/Key/MenuItem/CollectionViewCell/Slider, plus `Other` with accessible=true.
  - Fillable: SecureTextField/TextField/SearchField/TextView. Picker: PickerWheel. Toggle: Switch/CheckBox.
  - An element must be visible, enabled and hittable, with its centre inside the clip area (the Window intersected with ScrollView/WebView/Table/CollectionView containers).
  - label = `label||name||value||type`.
  - StaticText/TextView content becomes page text. Secure field values are blanked.
  - Sliders are expanded into 0/25/50/75/100% targets.
  - Each visible container gets a scroll action. Elements inside a WebView are scoped `web`.
  - Limits: 250 actions, 6000 chars of text.
- **Jev** (`internal/policy/policy.go`, `questions.go`):
  - Model `TYPESAFE_MODEL||jev-latest`.
  - `state`: `{page:{url,title,text}, elements:[{index,label,role,value,checked,selected,expanded,operations[]}], recent_actions(last 10)}`.
  - `operation`: a choice over CLICK, TYPE_TEXT, TYPE_SECRET, SCROLL_UP/DOWN, LONG_PRESS, DOUBLE_TAP, SWIPE_*, DRAG, PINCH_*, SET_SLIDER, PICKER_*, SELECT_ALL, CLEAR_TEXT, BACKSPACE, CURSOR_*, RETURN, SELECT, device controls (HOME, ACCEPT_ALERT, DISMISS_ALERT…), DONE, BLOCKED. Instructions `{goal, rules: NextAction}`.
  - Plus `<op>_target` for each operation, criteria `{scope, element:"[i] label", current_value, role, checked, selected, expanded}`.
  - `ValidateChoice`: choice offered; key counts equal; each in [0,1]; |sum−1| < 0.02; choice is the highest (1e-6 tolerance).
  - Retries: 3 attempts. 429/503/529 back off 500·2^n ms; network errors 400·2^n ms; any other ≥400 fails with "no action executed".
  - **No confidence threshold.**
- **Text:**
  - `FieldText` uses the first quoted literal in the goal, or the first URL.
  - Otherwise it asks an OpenAI-compatible LLM (default `deepseek-chat` at `https://api.deepseek.com/v1`) with a strict `{"text":...}` contract. The result is cached only while the helper's input is identical.
  - Secrets: `APPIUM_SECRET_FIELDS` maps field label → env var. `secure_fill` checks that the focused element is the resolved one, that its type is SecureTextField and its label matches, then clears it and checks focus again before typing; nothing is retried.
- **Actions** (iOS points taken from the page source):
  - tap: `POST /execute/sync {script:"mobile: tap", args:[{x,y}]}` at the rect centre.
  - scroll: `mobile: dragFromToForDuration` from 75% to 25% of the container height over 0.1 s.
  - typing: W3C key actions, keyDown/keyUp per rune. Before typing, `requireActive` checks that `GET /element/active` returns the resolved element.
  - keys: `mobile: keys` (Cmd+A = `a` with modifierFlags 1<<4).
  - alerts: `/alert/accept|dismiss`. HOME activates `com.apple.springboard`. Picker: `mobile: selectPickerWheelValue`. Apps are activated or terminated only if allow-listed.
- **Verification:**
  - DONE counts only if `GoalVisible` passes: the goal must contain "Stop when X [is visible|are visible|appears|is shown|.]" and the page text or title must contain X (case-insensitive). Otherwise `failedDone++`, and 3 failures end the run `blocked`.
  - `GoalVisible` is also checked after every action.
  - Stuck: the last 3 actions didn't change the page (except action kinds whose progress may be invisible), or `RepeatedCycle` → `blocked`.
  - Budget: `MaxSteps` 60.
  - History records before/after fingerprints, outcome, probabilities, latency and usage.
  - Outputs: `--coverage` JSON, `--record` directory of JPGs, a Bubble Tea TUI.
- **Pitfalls:**
  - No confidence gate.
  - `LiteralQuote` types the goal's first quoted string into every field.
  - DONE can never succeed unless the goal uses the "Stop when" wording.
  - The fingerprint covers all page text, so a changing clock or spinner makes every decision stale and burns the budget.
  - The 0.1 s drag makes lists fling.
  - `recognitionLanguages` is not set [INFERENCE: Vision defaults to English, so Korean isn't recognised].
  - `swift -e` compiles the script on every call.
  - iOS only in appium mode.
- **License:** no LICENSE file.

---
## 6. jaewgwon/jevis (Dart, Flutter integration_test; only registered actions)

- **Observation** (`lib/src/ui_observer.dart`, `flutter_agent.dart`):
  - Reads the in-process widget tree: `find.byElementPredicate(_role != null)`. An element counts as visible if it is mounted and `hitTestable()` finds it.
  - Roles by widget type:
    - TextField / EditableText → input
    - Checkbox / Switch (and their ListTile forms) → toggle
    - Slider → slider
    - DropdownButton → dropdown; DropdownMenuItem → menuOption
    - Draggable → draggable; Dismissible → dismissible
    - InkWell / GestureDetector with handlers → gesture
    - Button widgets, IconButton, FloatingActionButton, tappable ListTile → button
    - Scrollable → scrollable
  - Nested duplicates are suppressed.
  - `visibleText` = the first 100 hit-testable `Text` widgets.
  - Scrollables report pixels, min/max extent, viewport size and canScrollForward/Backward.
- **Identity:**
  - The id comes from ValueKeys (String/int) along the ancestor path; without keys it is `ephemeral:<n>`.
  - A duplicate identity throws `Ambiguous UI identity … Use unique scoped ValueKeys`.
  - Up to 500 keyed controls are remembered, and newlyObserved/updated diffs are sent.
- **Candidates:**
  - Only abilities the test registers: `JevisActions.tap/enterText(values)/scroll/back/focus/clearText/keyboardAction/longPress/doubleTap/drag/dragTo/selectOption/adjustSlider/wait/waitUntil`, plus custom actions.
  - Ids are `ui_<verb>_<n>`; each description embeds the target as compact JSON.
  - `enterText` offers one candidate per registered value, skipping values the field already holds.
  - Scroll moves 70% of the viewport.
  - Back = `NavigatorState.maybePop()` if `canPop()`.
  - At most 254 candidates. Just before executing, each candidate's validator re-checks the target (mounted, visible, same identity and description).
- **Settle:** after each action, `tester.pumpAndSettle(100ms, EnginePhase.sendSemanticsUpdate, settleTimeout=5s)`, or a custom `waitUntil` condition. A Flutter exception (`tester.takeException()`) fails the run.
- **Jev** (`jevis_policy.dart`): two requests in sequence to `https://api.typesafe.ai/v1/systemone`, `jev-latest`, sharing a 30 s budget.
  1. `goal_reached` noul (instructions + `criteria:{true,false}`) with state `{goal, screen}`. If P ≥ `goalThreshold` (0.6, must be >0.5): success.
  2. Otherwise `next_action`, a choice over candidate ids + `__stop__`, with state `{actionInstruction, previousActions, screen}`.
  - Validation: sum within 0.01, keys == offered set, choice is the highest.
- **Gates** (`core.dart`):
  - `actionThreshold` 0.2 → `lowConfidence`.
  - `__stop__` triggers one more noul check with no actions allowed. If it doesn't reach 0.6 the run ends `stopped`.
  - The same (state, actions, choice) seen more than `maxRepeatedAction` 2 times → `repeatedAction`.
  - Other limits: `attempts` budget, `historyLimit` 8, `decisionTimeout` 30 s.
  - An optional deterministic `verify:` callback runs after success (`verificationFailed`).
  - A failed run throws `JevisTestFailure`, which fails the Flutter test.
  - `onRequest`/`onResponse` hooks expose raw bodies; the report's trace records each observation, evaluation and executed action.
- **Text:** `tester.enterText(finder, value)` sets the field value directly [INFERENCE: this bypasses the IME, so Korean works]. Values must be pre-registered.
- **Pitfalls:**
  - Only works inside Flutter test builds (needs `--dart-define-from-file=jev.local.json`).
  - `pumpAndSettle` [INFERENCE] throws on endless animations such as spinners, so the run errors.
  - Two API calls per step.
  - Custom-drawn controls without the recognised widget types are invisible to it.
  - Needs unique ValueKeys.
- **License:** Apache-2.0.

---
## 7. MobAI-App/mobai-ci (GitHub Action + closed binary)

- The repo holds only `action.yml`, `install.sh`, examples and docs. The `mobai-ci` binary is closed-source, and `LICENSE-BINARY.md` forbids reverse engineering. **The Jev step-classification code is not available**; below is documented behaviour only.
- `.mobflow`: one plain-language step per line.
  - Jev decides whether each step is an action, a check or a sign-in; the prefixes `assert:` and `login:` force the type.
  - A check is judged from the screen and never acted on, so a failing check fails the run.
  - Each step gets 8 moves (`--jev-step-budget`).
  - Key: `MOBAI_TYPESAFE_KEY` / `--jev-key`; model: `--jev-model`.
  - Sign-in credentials come from `MOBAI_SECRET_<NAME>`, chosen by name and field label, and are scrubbed from logs, reports and UI trees (a screenshot can still show them).
  - Local devices only.
- `.mob` DSL:
  - `app "id" fresh`
  - `assert_exists ~"text" timeout:MS` (polls until present), `assert_not_exists`
  - `tap`, `type`, `swipe up|down|left|right`, `back`, `wait MS`, `screenshot`
  - Selectors: `~"fuzzy"`, `"exact a11y id"`, `@"resource id"`
  - Maestro YAML flows are mapped onto these; `${param}` placeholders; `mobai-ci validate`.
- CI (`action.yml`):
  - `mobai-ci sim boot --cache <dir> --device-type "iPhone 16 Pro" --runtime latest [--slim-only widgets | --slim profile.json]`. Cache key: `mobai-sim-${ImageOS}-${ImageVersion}-${VER}-${slug}-${extra}`.
  - `mobai-ci emu boot --api 35`, with a KVM udev rule on Linux.
  - `--wait-device 4m`; `--startup-timeout` defaults to 8m.
  - The iOS on-device runner bundle id is `run.mobai.MobAI.xctrunner` [INFERENCE: an XCTest runner].
- Reports:
  - always `<out>/junit.xml`
  - `screenshot` steps → `<case>/step-N.png`
  - failed steps → automatic `step-N.png` + `step-N-uitree.txt`
  - `--allure`; `--report-bundle` (`run.json` + `artifacts/` with every step's screenshot and UI tree)
  - `--shard i/N`
  - Exit codes: 0 all passed / 1 a test failed / 2 setup error.
- **License:** repo files MIT; the binary is proprietary but free to use.

---
## Korean / Unicode input summary
- **Android over adb:** `input text` accepts ASCII only. Use the ADBKeyBoard IME broadcast `ADB_INPUT_B64` (base64 UTF-8), switching IME with `ime set` and restoring it afterwards; fail loudly if that isn't possible (phone-use `android.ts`). sim-use's Android bridge APK also offers `type`/`paste`.
- **iOS Simulator:** `sim-use paste` (simctl pbcopy + Cmd+V) handles CJK but needs a connected hardware keyboard. `--via-menu` is an alternative, but jev-sim-use found the Paste menu item never appeared. iOS 16+ also asks "Allow Paste" once per app session. jevium's W3C per-rune key actions and agent-device's fill are unverified for Hangul [INFERENCE].
- **Flutter:** `tester.enterText` sets the value directly.

## iOS points vs pixels
- Appium, WDA page source and `mobile: tap` all use points (jevium taps the rect centre directly).
- Screenshots are in pixels: jev-test scales by screenshotWidth / window rect width.
- sim-use frames are device-native portrait points; `--coordinate-space ui` switches to the rotated coordinates `ui` prints.
- jevium OCR regions are normalised 0..1 and multiplied by the page W/H (points), after checking the aspect ratio matches.