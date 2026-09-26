# IOSAgents.md — iOS execution layer research (read from source, 2026-09-26)

> Method: I had no shell or write tool, so I could not clone. I read every file below from `raw.githubusercontent.com` / GitHub pages. `[INFERENCE]` marks a claim I did not observe in code or in a primary source.
> Target context: Xcode 27 / iOS 27 simulator on Apple Silicon, project-local tooling only.

---

## szupzj18/flick (MIT, Python ~700 LOC, deps: `httpx[http2]`)

**1. Observation**
- `flick/device.py` `describe_all_raw()` runs `idb ui describe-all --json --api axbridge` with env `IDB_UDID=<udid>`. The comment says `--udid` is only defined on leaf parsers.
- axbridge is required: on the iOS 26 Settings root the legacy `ax` backend returns 15 elements and axbridge returns 132.
- Measured cost is about 0.2 s per read, of which about 150 ms is CLI process overhead.
- Errors containing `guest`, `not booted` or `closed by peer`, and non-JSON output, raise `TransientTreeError`.
- iOS support is simulator only: axbridge relies on the private Simulator bridge.
- Settle logic, `observer.py` `observe_stable(stable_reads=2, timeout_s=12, settle_delay=0.25)`:
  - It re-reads until two consecutive cleaned-tree fingerprints are equal.
  - It retries transient errors.
  - If the timeout expires it returns the last read anyway (not fail-closed).
  - design.md reports that app launch goes through three phases (guest error, element-count drift, stable after about 2.7 s).
- Hit test before a tap: `idb ui describe-point X Y --json --api axbridge`.
- Screenshot: `xcrun simctl io <udid> screenshot <path>`. The code comment says idb screenshot is broken on this companion/iOS pair.

**2. Normalization** (`observer.py clean()`)
- Type blacklist (substring match): ScrollIndicator, Separator, Decoration, CellHostingView, CellContentView, InheritedView, SystemBackground, PopoverDimmingView, TransitionView, Background, TouchPassThroughView, DebugView, IconImageView, IconLayerView, Legibility.
- A node is interactive if `type` is in INTERACTIVE_TYPES (Button, Cell, Link, Icon, Switch, TextField, TextView, SearchField, Slider, SegmentedControl, …) or its traits include one of Button, Link, SearchField, Switch, Adjustable, KeyboardKey, ….
- Label fallback order: `AXLabel` → `title` → `placeholder` → `help` → `role_description`.
- An unlabelled interactive node is kept only if it has `AXUniqueId`.
- On-screen check: 8-point tolerance, width and height ≥ 4.
- Known issue: the screen size is hardcoded to `{402, 874}` (iPhone 17 Pro, in points). `clean()` is never given the real screen size.
- Dedupe key: (label, round(x/4), round(y/4), round(w/4), round(h/4)). When several nodes share a key, the rank decides: Button/Cell/Link/Switch/Icon = 3, other interactive = 2, other = 1.
- IDs are 1-based strings in (y, x) reading order.
- `page_text` = on-screen StaticText joined with newlines. It is capped at 6000 characters in `as_state`.
- `to_choice()` truncates label and value to 120 characters.
- Modal detection: role ending in `Alert`, or type Alert, Sheet or ActionSheet; otherwise a `PopoverDimmingView`.
- Fingerprint: `sha256(json{pid, modal, elements[r,l,v,f,t]})[:16]`.
- The frontmost pid is the most frequent `pid` in the tree.
- Per-element fields: `index, role, label, value, frame, center, traits, uid, enabled, operations[TAP|TYPE_TEXT|ADJUST]`.
- Measured element counts: Settings 165 → 13, SpringBoard 278 → 13, Reminders 81 → 15.

**3. Jev usage** (`model.py`)
- `POST https://api.typesafe.ai/v1/systemone`, sent through an `httpx.Client(http2=True, timeout=30)`.
- Model: `TYPESAFE_MODEL` or `jev-latest`.
- Request body: `{model, state:{front_app, modal, elements[{index,role,label,value,operations}], page_text, recent_actions[-10:]}, questions}`.
- Questions:
  - `operation`: choice over TAP, TYPE_TEXT, SCROLL_UP, SCROLL_DOWN, WAIT, DONE, BLOCKED, plus DISMISS_MODAL when a modal is present. Criteria map each operation to a description. `instructions` is the object `{goal, rules: NEXT_ACTION}`.
  - `tap_target` / `type_target`: choice whose `criteria` map `index → {role, label, current_value, operations}`. These heads are speculative.
  - `goal_satisfied`: noul with `instructions {goal, success_condition, rules}`.
- Response parsing: `answers.<id>.{choice, confidence, probabilities}` for choices, `answers.goal_satisfied.noul` for the noul, plus `usage`.
- `validate_choice` requires: choice ∈ options, probability keys equal the options, each value finite and in [0,1], |sum − 1| < 0.02, and the choice is the argmax.
- Transport retries: 3 attempts on 429/529/503 or transport error, with backoff 0.5 s × 2^n. Anything else raises. The executor turns an exception into `status:"error"` and takes no action.
- Gate (`executor.py`): `operation_confidence < 0.6` → `escalate`.
  - Target confidence is not gated, although design.md says it should be.
  - The label is matched against SENSITIVE_TERMS, which holds Chinese and English words (buy, pay, delete, erase, 支付, 删除 …) → `escalate`. There are no Korean terms.
  - DONE or BLOCKED → `stopped`. Known issue: `goal_satisfied_p ≥ 0.8` (design.md §4.2) is not enforced in code.
- Measured: Jev takes 430–500 ms per decision; the full cycle takes 593.8 ms on average.

**4. Action execution**
- Tap: `idb ui tap X Y --api hid [--reason ...]`, at the frame centre, in points.
- Scroll: `idb ui swipe 200 700 200 200 --duration 0.4`. Coordinates are hardcoded, which is a problem on other screen sizes.
- Home: `idb ui button HOME`.
- Launch: `idb launch --foreground <bundle>`. design.md notes that this does not reset the navigation stack.
- Text:
  - `idb ui text` supports ASCII only. Non-ASCII fails with "No keycode found", and a space becomes U+2006.
  - flick therefore always pastes: `xcrun simctl pbcopy <udid>` (text on stdin), then `idb ui key 25 --command` (HID V = 0x19).
  - Measured elsewhere (sim-mirror #27/#30): on iOS 27 this paste is refused silently, and on iOS 26 it shows an "Allow Paste" prompt. flick's text path is therefore broken on iOS 27.
- Before a TAP or TYPE:
  1. Run `observe_stable` again.
  2. `relocalize` the target: exact label, else substring match, else the candidate with the largest frame overlap.
  3. Run `describe-point` at the centre and compare labels in both directions (substring).
  - Bug: when the element at the point has no label (`hit_label == ""`), the check passes, because `"" in anything` is true. An unlabelled overlay therefore passes.
- DISMISS_MODAL with no target taps the centre of the modal frame blind. That tap can hit a button in an alert.

**5. Verification / failure handling**
- After typing: read the target's AXValue and check that it contains the text. A mismatch only appends a warning, and the status stays `success` (not fail-closed).
- `page_changed` = fingerprint before ≠ fingerprint after.
- There is no loop: `flick run` performs one step. `history` is never passed, so `recent_actions` is always empty.
- Budgets and stuck limits exist only in design.md: 60 actions, 120 Jev calls, 3 unchanged screens → BLOCKED.

**6. Spec / report format**
- CLI: `flick run "<goal>" --completion "<observable>" [--text]`.
- Output is JSON: `{status: success|escalate|stopped|blocked|error, action_taken, page_changed, goal_satisfied_probability, current_screen}`.
- Offline evaluation: `scripts/eval.py` with `tests/eval_dataset.json`. Fixtures are raw axbridge dumps.

**7. Strengths**
- One HTTP request answers the operation head plus speculative target heads.
- An element is offered only for the operations it supports.
- Fingerprint-based settle.
- `describe-point` hit test before a tap.
- Measured argument for axbridge over the legacy backend.

**Pitfalls:** the hit-check bug above; DONE does not check goal_satisfied; a failed read-back is only a warning; hardcoded screen size and scroll coordinates; paste is broken on iOS 27; no Korean sensitive terms; the doc says a sum tolerance of 0.2 while the code uses 0.02 (the code is right).

**8. License:** MIT.

---

## gpazo/jev-vphone-cli (MIT, Swift; fork of Lakr233/vphone-cli)

The repo has two targets:
- **VM path**: a virtual iPhone via Virtualization.framework and the PCC research VM. It needs SIP/AMFI relaxed (`csrutil disable`, `amfi_get_out_of_my_way=1`) and about 40 GB of disk. The guest accessibility probe was never run. This path does not fit our constraints.
- **Simulator path**: works and is measured. The rest of this section describes it.

**1. Observation**
- Setup: `make setup_jev` → `scripts/setup_jev.sh` puts everything in `.tools/axe`:
  - Downloads `https://github.com/cameroncooke/AXe/releases/download/v1.8.0/AXe-macOS-v1.8.0-universal.tar.gz` and checks sha256 `7b76340b72e90d0f211bc7c4636f15009076eff07acef2f2b632b175debd8834`. AXe's frameworks must stay beside the binary.
  - Downloads idb `v1.6.1/idb-companion.macos-arm64.tar.gz` (sha256 `f59cadedbb05fe21c11522ee297cd8827b758136e27837a647267682cb2c80bb`) and extracts only `./Resources/SimulatorFrameworkBridge-iOS`.
  - Compiles its own guest helper: `xcrun --sdk iphonesimulator clang -fobjc-arc -O2 -arch $(uname -m) -mios-simulator-version-min=15.0 -framework Foundation SimulatorPreferences.m SimulatorActions.m SimulatorTargets.m -o .tools/axe/JevSimulatorPreferences`.
- Tree reader (`VPhoneJevAccessibilityBridge.swift`):
  - Starts `xcrun simctl spawn <udid> <.tools/axe/SimulatorFrameworkBridge-iOS> accessibility serve /tmp/jev-ax-<uuid>.sock --idle-timeout 120 --exit-on-disconnect true`.
  - Connects with AF_UNIX, a 15 s send/receive timeout and SO_NOSIGPIPE.
  - Framing: 4-byte big-endian length, then UTF-8 JSON. Responses are limited to 16 MB.
  - Wire format per the code comment: facebook/idb v1.6.1 `SimulatorFrameworkBridge/AccessibilityServiceServer.m`.
  - Tree request: `{"verb":"describe","method":"window-server","x":midX,"y":midY,"snapshotTree":true,"automationMode":true,"attributes":["XC_kAXXCAttributeElementType","…ElementBaseType","…Label","…Value","…Identifier","…Frame","…AutomationType","…Children","…PlaceholderValue","…DatePickerPossibleValues"],"maxNodes":20000}`.
  - Response: `{ok, tree, pid, truncated, error, error_kind}`. `truncated:true` is refused, and `error_kind == "assertion_failed"` becomes a stale-target error.
  - Foreground-only query: same request with `maxDepth:0` and only the Label and Frame attributes.
  - Hit test: `{"verb":"hittest","x","y","attributes":[Label,Value,AutomationType,PlaceholderValue]}`.
  - Measured: warm reads 33–35 ms, first request 508 ms. Before that, AXe `describe-ui` took 1.65 s cold and 0.286–0.296 s warm including process start (Xcode 26.6, iOS 18.5).
- Why not AXe for reads: AXe's host translator reports a UIDatePicker as a `Slider` with indices 5000/4980. The guest reader returns the readable values "9 o’clock", "00 minutes", "AM".
- Settle:
  - Policy: `settleMilliseconds 400`, then re-observe every `settlePollMilliseconds 250` up to `settleTimeoutMilliseconds 2500` while the screen looks unchanged.
  - Torn observation (a snapshot has tappable elements but none passes the hit test, for example during a keyboard transition): retry with `freshTraversal`, backing off 50 ms × 2^attempt, at most 4 attempts (≤ 750 ms). After that it fails closed.
  - A childless `AXRemoteElement` stub inside the visible bounds sets `completenessIssue`, which blocks a completion claim.

**2. Normalization** (`JevSimulatorObserver.normalize/decode`)
- AutomationType → role map: 9, 10, 20, 44 → Button; 33 Slider; 39 Picker; 40 Switch; 42 Link; 43 Image; 45 SearchField; 48 and 51 StaticText; 49 and 50 TextField; 52 TextArea; 75 Cell; 19 Keyboard (context label).
- An empty label on a text field falls back to its placeholder. An unlabelled picker gets the label `Picker wheel`.
- A web container with AutomationType 0 becomes static text.
- Nodes that are hidden, have no or empty frame, or have an empty label are dropped.
- An enclosing Group is dropped when a child control has the same label, and a nested Link is dropped.
- Switch values are normalized to on/off. A disabled element becomes `statictext`.
- Dedupe key: `role|label|value|midX|midY`.
- IDs are `e1..eN`.
- Context: up to the last 2 ancestor labels, and "After row: <prev>" for an unnamed inline editor.
- Off-viewport controls (within one screen height, at most 24) become read-only `nearbyElements` marked "above/below viewport; not actionable".
- Every tappable element is hit-tested live before it is offered. Covered ones become "unreachable: covered or clipped; not actionable" context (at most 48).
- When a text field is present, single-character keyboard keys are removed.
- Coordinates are device points, and they are never sent to Jev.
- Operation targets are capped at 250.

**3. Jev usage** (`VPhoneJevClient.swift`, `VPhoneJevQuestions.swift`, `docs/jev.md`)
- Model `jev-latest`, 30 s timeout. `prepareConnection()` sends a HEAD request to warm DNS/TLS.
- State (`JevState`): `{goal, device{kind,screen,constraints}, foregroundApp, observationSource, elements[], history[{action, changedScreen, fromDocument, toDocument}], verifiedFacts[], documentTitle, observedProgress, nearbyElements, inputRejection}`.
- Questions, all in one batch:
  - `action`: choice over the available JevAction values `tap, scroll_down, scroll_up, drag_up, drag_down, set_picker_value, type_text, press_home, open_app, wait, finish, stop_unable`. Actions that cannot run are not offered.
  - `tap_target`, `app` (≤150 options), `type_text_target` (pairs of field and literal from the goal: Jev never generates text), `set_picker_value_target`, `drag_*_target`.
  - Nouls: `done`, `blocked`, `risky`.
- Response: `{model, answers{id:{type, noul|choice|score, probabilities, confidence}}, usage{input_tokens, output_tokens}}`, validated as in flick (±0.02).
- `JEV_TRACE_DIR` saves the request and response JSON, without headers.
- Gates (`Policy`):
  - done ≥ 0.8 → success; or Finish chosen and done ≥ 0.5.
  - blocked ≥ 0.45 → hand back. Real permission dialogs scored 0.54–0.59.
  - risky ≥ 0.5 → confirm, unless `--yes`.
  - confidence = min(operation confidence, target confidence). Below 0.5 with risky ≥ 0.15 → stop. Below 0.85 with risky ≥ 0.15 → confirm.
  - 3 identical screens → stuck. The same 2–4-action cycle twice → stop. 6 consecutive scrolls → lost. 25 steps → budget. At most 4 interstitials.
  - An invalid answer ends the run.
- Measured: Jev takes 152–362 ms per call (median 209 ms). A step uses 1,200–1,500 input tokens, which costs about $0.00005.
- Ablation against a no-model baseline: Jev refused "delete all photos" (blocked 0.84); the baseline tapped it.

**4. Actions**
- Tap: `.tools/axe/axe tap -x X -y Y --tap-style physical --udid <udid>`.
- Drag: `axe drag --start-x --start-y --end-x --end-y --duration 0.6`, over 3.5 % of the screen height. `swipe` does not move picker wheels.
- Type: `axe type --file <tmp>`. It supports printable ASCII 32–126 only and rejects anything else.
- Home: `axe button home`.
- Native press, increment, decrement, page scroll, custom actions and launch go through the guest helper (`SimulatorActions.m`), which reads JSON lines on stdin:
  - It dlopens AXRuntime, AccessibilityPlatformTranslation and `/Developer/Library/PrivateFrameworks/XCTAutomationSupport`.
  - `AXUIElementCopyElementAtPosition(systemWide, x, y)`.
  - It checks the expected Label, Value, AutomationType and PlaceholderValue, then runs `AXPTranslator processActionRequest` (`AXPActionPress`, `AXPActionScrollDownByPage`, …).
- `replace-text`: `AXUIElementSetAttributeValue(hit, XCAXAccessibilityAttributesForStringAttributes(["XC_kAXXCAttributeValue"]), text)`, then reads back the same element. This is Unicode-safe, so Korean should work [INFERENCE: not tested with Korean], but it bypasses keyboard and IME events.
- Launch: `LSApplicationWorkspace openApplicationWithBundleID:`. Installed apps: `xcrun simctl listapps <udid>`.

**5. Verification**
- Before input: re-resolve the target by signature (role + label + value); values stay in the check so that a flipped switch reads as stale. A target that only moved is tapped at its new position. A changed or vanished target voids the decision.
- Completion needs a fresh read.
- Independent device facts come from cfprefsd domains (`com.apple.Accessibility`, `com.apple.Preferences`, `NSGlobalDomain`) read through the warm helper, with a fallback to `simctl spawn <udid> defaults read`.
- Guard tests: `make jev_guards` runs the fake phone with mutations.

**6. Format:** natural-language goal (`make jev SIM=<udid> PROMPT=...`). `--verbose` prints state and probabilities; `--profile` prints stage timings. Artifacts go to `research/artifacts/...`.

**7. Strengths:** fastest measured tree read; hit-test filtering of offered elements; fail-closed behaviour (no OCR fallback, truncated trees refused); pinned and hash-checked project-local install; risk-aware gates; ablation discipline.

**Pitfalls:**
- Relies heavily on private APIs (the guest ObjC helper, XCTAutomationSupport, AXPTranslator), which can break with each iOS release.
- `automationMode:true` sets `AutomationEnabled` for the whole simulator and leaves it on.
- Measured on iOS 18.5 / 26.x simulators only. No iOS 27 simulator measurements.
- Picker handling is experimental; the Calendar and Safari flows are flaky.
- The socket lives in /tmp.

**8. License:** MIT.

---

## unblocklabs-ai/openclaw-iphone-ops (license "UNLICENSED" in package.json: do not copy code; Python)

**1. Observation**
- Physical iPhone over USB through CoreDevice: `xcrun devicectl … --json-output <file>` handles discovery, lock state, launch and apps.
- WDA runs on the phone: `xcodebuild test -project|-workspace <WDA> -scheme WebDriverAgentRunner -configuration Debug -destination id=<udid> -destination-timeout 30 [-allowProvisioningUpdates DEVELOPMENT_TEAM=… PRODUCT_BUNDLE_IDENTIFIER=…]`, supervised by a LaunchAgent. Port 8100, reached over the CoreDevice tunnel URL.
- Tree: `GET /source`, which returns XCUIElementType XML inside `{value}`. The compact form `?format=xml&excluded_attributes=accessible,nativeAccessibilityElement,index,placeholderValue,traits,nativeFrame,minValue,maxValue,customActions,type` is also used.
- Measured:
  - Settings `/source` took **9.6–10.8 s**; Calculator about 1.2 s.
  - App-only waits skip `/source`: settled Settings wait 10.2 s → 0.57 s.
  - Read timeout is 12 s.
- Settle: the session sets `POST /session/:id/appium/settings {waitForIdleTimeout:0, animationCoolOffTimeout:0}`, because the XCTest idle wait adds about 10 s per click in animated apps. Readiness is established only by predicate polling.

**2. Normalization** (`observations.py parse_observation`)
- Rejects: over 2 MB, a DOCTYPE or ENTITY, depth over 60, or 2000 or more nodes. Nothing is truncated.
- Each element keeps `role (XCUIElementType*), name, label, value, visible, enabled, focused, bounds (x,y,w,h), ancestors, path, xpath`. IDs are `<uuid4>:<n>`, local to one snapshot.
- A SecureTextField anywhere sets `secure=True`. Its values are dropped and no actions are offered.
- Locator choice: class chain with named ancestors, else a predicate string, else XPath.
- The planner view has at most 80 relevant elements and no values. Labels are opt-in, and only labels on the `cloud_labels` allowlist are ever sent to Jev.

**3. Jev** (`jev.py`)
- `MODEL = "jev-1.13.0"` is pinned, and the code checks that `payload.model == MODEL`. This breaks when the model is upgraded.
- Request: `{model, state:view, questions:{action:{type:"choice", instructions:{task, rules[...], output}, criteria:options}}}`. Choice keys are opaque. Criteria are objects `{control, role, ancestors, bounds}` plus an `escalate` option.
- Limits: request ≤ 16,384 bytes, 1–255 options, response ≤ 256 KB. Duplicate JSON keys and NaN are rejected. |sum − 1| ≤ 0.01.
- No retries. HTTP or transport errors → `DecisionUnavailable` (`model_unavailable`). Confidence below `min_confidence` (0.7) → `LowConfidenceDecision` (`low_confidence`). Neither dispatches an action.
- Cost estimate: input tokens × $0.042 per 1M.

**4. Actions** (`wda.py`)
- Tap: `POST /session/:id/actions` with a W3C pointer sequence: pointerMove (duration 0) → pointerDown → pause 100 → pointerUp. Coordinates are in points.
- Keypad: one request with a separate touch source per key, 125 ms apart, each held 50 ms.
- Drag: W3C pointer with a hold pause and at least 100 ms of movement.
- Text:
  - `/session/:id/wda/keys {value:[text]}`: bulk, inserted at the caret. Unicode goes through XCTest typeText, which inserts the text directly instead of typing it (Appium Unicode doc).
  - Per-character W3C `key` actions. Batched key events lost every character after the first, so each key is sent as its own request.
  - `element/:id/value` and `/clear`.
- Scroll: `/wda/element/:id/swipe` with the direction inverted.
- Back: `/wda/back`, then `/session/:id/back`.
- Buttons: `/wda/pressButton`. Apps: `/wda/apps/activate|terminate|state`. Other: `/wda/activeAppInfo`, `/wda/locked`, `/wda/unlock`, `/screenshot`.

**5. Verification and failure**
- A read error is `WDAUnavailable`. A write error is `WDAOutcomeUnknown`, which is never replayed automatically.
- A stale element ref may only be re-read.
- Lock state is checked at every write.
- Grants each have a single use; offers are consumed once per snapshot; each action has explicit after/success predicates; one task-wide monotonic budget.

**6. Format:** a task JSON `{version, objective, grants[{operation, app, description, selector|destination, after[]}], success[], limits{seconds, max_steps, max_decisions}}`. Planner sessions use JSON lines. Metrics are content-free.

**7. Strengths:** the strictest separation of read and write errors; no replay; privacy-positive cloud projection; the `waitForIdleTimeout=0` lesson.

**Pitfalls:** proprietary license; physical device only; very slow `/source`; WDA runner start can fail with "Timed out while enabling automation mode"; signing and provisioning are required.

**8. License:** UNLICENSED (proprietary). Use as a reference only.

---

## 207studio/jev-codex-tools (MIT, Node ≥ 24) — how it reads the simulator AX tree

**1. Observation, exactly** (`integration/ios-controller.mjs`)
- It needs an already running **serve-sim 0.1.46**. The code checks that `realpath(serveSim)` ends in `dist/serve-sim.js` and that the `package.json` has name `serve-sim`, version `0.1.46`.
- `observe()` runs this sequence:
  1. `node <serve-sim.js> --list <UDID>` → registry `{running, device, pid, url, streamUrl, wsUrl}`, validated against `url` (localhost only).
  2. `xcrun simctl list devices available --json` → the device must be `Booted`.
  3. HTTP `GET <url><prefix>/foreground?device=<UDID>` → `{bundleId, pid}`, which must be on the bundle allowlist.
  4. `GET …/config?device=<UDID>` → `{width, height, orientation}`.
  5. **`GET …/ax?device=<UDID>`** → the AX tree. Each fetch has a 3 s timeout, redirects are an error, and the body is limited to 2 MB.
  6. `config` and `foreground` again, then the registry again. Any difference → `observation_changed`.
- What `/ax` is: serve-sim's per-device Swift helper, which is "axe-compatible". fbidb.io says "serve-sim ported the framework's host-side accessibility reading into its own server". So this is host-side AXPTranslator over SimDevice XPC, the equivalent of idb `--api ax` and AXe `describe-ui`, not a guest reader.
- Tree shape: `[ {frame{x,y,width,height}, type, AXLabel, AXUniqueId, enabled, hidden, visible, children[...]} ]`, with exactly one root.
- The root frame must be (0,0), and its aspect ratio must be within 1 % of the config.

**2. Normalization**
- DFS over at most 10,000 nodes. `blocked` is inherited from ancestors that are disabled, hidden or not visible.
- A candidate needs all of: `AXLabel` in the `--element` allowlist, type in {Button, CheckBox, RadioButton, PopUpButton, MenuButton, Link, Tab}, enabled, a unique non-empty `AXUniqueId`, and a frame fully on screen.
- Duplicate labels → `ambiguous_allowed_element`.
- IDs are `E1..En`, sorted by AXUniqueId.
- Fingerprint: sha256 of the stable JSON of `{registry, config, foreground, ax}`. The full tree stays local.

**3. Jev** (`choice.mjs`)
- `{model:'jev-latest', state: JSON string {intent, candidates[{choice, name}], completedActions}, questions:{decision:{type:'choice', instructions, criteria:{NONE:…, E1:'Tap the allowed control named "…"'}}}}`.
- Timeout ≤ 2500 ms, 0 retries, body ≤ 64 KB.
- Validation: model matches `/^jev[-\w.]*$/i`, sum within ±0.02, argmax.
- Any failure → `null` → `stopped`.
- Gate: confidence < 0.8 → `unknown_or_low_confidence`. `NONE` → `no_selection`.
- `chooseMany`: ≤ 24 questions, ≤ 60 KB.

**4. Action**
- Observe again. The fingerprint and the selected candidate must be identical.
- Tap point = frame centre divided by the screen width/height, so **normalized 0..1**.
- `node serve-sim.js tap <x> <y> -d <UDID>`. Exit 0 proves only that the tap was sent. Any error → `tap_outcome_unknown` (exit code 3), never retried.
- No text input.

**5. Verification:** observe after every tap. An exact `--done-label` seen on screen → done. The same fingerprint as before → `unchanged_state` stop. At most 8 steps (`control_loop` flag), 20 s budget. Everything is off by default (`jev-features`).

**6. Format:** CLI flags only (`--udid --url --bundle --element --intent [--execute --max-steps --done-label]`). Output is a single line of JSON.

**7. Strengths:** the most paranoid identity bracketing around a read; normalized coordinates remove any points-vs-pixels bugs.

**Pitfalls:** needs label allowlists and unique AXUniqueIds (many third-party apps have none); taps only; exact serve-sim version pin; host-side (composite) tree.

**8. License:** MIT.

---

## BennyKok/omg.dev (MIT) — embedded mobile E2E (`mobile/`)

**1. Observation**
- One `maestro mcp` process per run (JSON-RPC 2.0 over stdio, through ssh to the Mac): `initialize` (protocol `2024-11-05`), then `tools/call inspect_screen {device_id}`.
- The returned JSON has keys `a11y, txt, val, hint, rid, b:"[x1,y1][x2,y2]", enabled, focused, selected, checked, c[children]`.
- Maestro reads the tree through its own on-device XCTest driver.
- Settle: there are no fixed waits. The runner looks again until `done` holds or the step timeout (default 60 s) expires.
- UDID resolution: `xcrun simctl list devices booted | grep -F '<name> ('`, never `booted`.
- Device lock: atomic `mkdir ~/.omg-sim-locks/<udid>`, broken after 1 h.

**2. Normalization** (`e2e-jev.ts candidates()`)
- Keyboard nodes are skipped (`rid` matches keyboard or inputView).
- label = `a11y || txt || hint`.
- A node is listed the first time its label appears on the way down. Descendants with the same label are folded into it.
- Key `label|rid` is deduplicated. Centre comes from the bounds. Disabled nodes are skipped.
- `text[]` collects every txt, a11y, val and hint string for the expect/forbid checks.
- IDs are integer indices.

**3. Jev** (`scripts/jev.ts`)
- `{state, model:'jev-latest', questions}`, 20 s timeout.
- Key from `TYPESAFE_API_KEY` or `~/.config/typesafe/env`.
- State: `{goal, done_when, screen[{i, label, id, focused, selected}], already_typed}`.
- Questions:
  - `done`: noul with `criteria {true, false}`.
  - `blocked`: noul (error, challenge, rate limit, dev menu).
  - `tap`: choice over the indices plus `none`.
- Answers are **not** validated. An HTTP error throws, which fails the run.
- Thresholds:
  - Pass when every expect string is present and no forbid string is present (and `selected` if set). The facts override Jev. With no expect list, `done ≥ 0.7`.
  - `blocked ≥ 0.85` on two looks in a row → fail.
  - `done ≥ 0.7` while the facts fail, three times → fail with the missing string named.
  - Tap only when `confidence ≥ 0.4`, which is low.
  - Tapping the same element twice in a row → sleep 1 s instead.
- Latency is about 0.5 s per look.

**4. Actions:** inline Maestro YAML through `run`:
- `tapOn: point: "x,y"`, `longPressOn`, `eraseText`, `inputText: "…"`, `hideKeyboard`, `openLink`, `launchApp: clearState`.
- `typeVerified`: erase, type, read back, retry up to 3 times. Maestro iOS sometimes doubles a character.
- Maestro needs Java 17+. They use a self-contained Temurin 21 JDK in `~/.local/jdk` with `JAVA_HOME`.

**5. Verification:** deterministic expect/forbid/selected checks; per-step timeout; one reconnect when inspect fails.

**6. Format:** `e2e/<name>.plan.json` = `{appId, launch{clearState}, steps[{name, goal, done, expect[], forbid[], selected, type, focused, echo, otp, longPress, timeoutMs, open, tapAt}]}`. `--record` combines `simctl` video with an ffmpeg side panel listing the steps, into `e2e/<name>.mp4`.

**7. Strengths:** the right split, where exact strings are the proof and Jev only drives navigation; the plan format; UDID pinning plus a device lock; one persistent driver process.

**Pitfalls:** no answer validation; low tap threshold; Maestro and the JVM live in the home directory (`~/.maestro`), not the project; not tested on iOS 27 here.

**8. License:** MIT.

---

## Jev wire contract, common to all repos (verified in 5 code bases)

```json
// POST https://api.typesafe.ai/v1/systemone   Authorization: Bearer $TYPESAFE_API_KEY
{"model":"jev-latest","state":{...}|"text",
 "questions":{
   "op":{"type":"choice","instructions":"…"|{...},"criteria":{"A":"desc"|{...}|null}},
   "ok":{"type":"noul","instructions":"…","criteria":{"true":"…","false":"…"}},
   "lvl":{"type":"score","instructions":"…","criteria":["lowest","…","highest"]}}}
// 200 →
{"model":"jev-…","answers":{"op":{"type":"choice","choice":"A","confidence":0.93,"probabilities":{"A":0.95,"B":0.05}},
  "ok":{"type":"noul","noul":0.12}},"usage":{"input_tokens":1234,"output_tokens":210}}
```

- Choice options: at most 255.
- A noul has no `confidence`; its probability is the answer.
- Validate before acting: offered choice, key set equals the options, values finite and in [0,1], |Σ − 1| ≤ 0.02, choice is the argmax.
- Measured latency: 152–500 ms per call.

---

## iOS execution layer options — comparison (Xcode 27 / iOS 27 simulator, project-local)

| Option | Tree read mechanism | Tree fidelity | Tree-dump speed (source) | Input | Korean text | Xcode 27 / iOS 27 status | Project-local install | Maintenance 2026 | License |
|---|---|---|---|---|---|---|---|---|---|
| **idb** (`idb_companion` + `fb-idb` client), `--api axbridge` | Guest `SimulatorFrameworkBridge` in serve mode, reached by the companion over a private Unix socket. Reads the whole tree in one call per process. Tree bounds: depth 50, 3000 nodes; `--format complete` reports `truncated`, `modal`, `screen`, `profile`. | Full XCUITest-level tree, including out-of-process web views | ~30 ms guest-side for 167 elements (fbidb.io); ~190–200 ms per CLI call including process start (flick) | HID: `ui tap/swipe/key/key-sequence/button/pinch`. AX: `ui tap <marker> [--expected-value]`, `ui scroll`, `ui set-value`. Settle: **`ui quiet [timeout] --json`** (run loop idle, no animations, 250 ms quiet window) | `ui text` is ASCII only. **`ui set-value --value '한글'` sets the AX value (Unicode, no keyboard or IME events)** [INFERENCE: Korean not tested] | Xcode 27 broke HID (`SimulatorKit` moved to `Contents/SharedFrameworks`). Fixed upstream in `981101298cf5` (June 2026). v1.6.2 released 2026-09-23, assumed to contain the fix [INFERENCE] → **pin ≥ v1.6.2**. AX reads were never affected. | Download the GitHub release tarball (`idb-companion.macos-arm64.tar.gz`) into `.tools/idb/`, keeping the `Resources/` sibling layout (`SimulatorFrameworkBridge-iOS`). `pip install fb-idb` into the project `.venv` (Python ≥ 3.10). Avoid `brew`. | Active (8,839 commits; releases v1.6.1 → v1.6.2; Swift companion) | MIT |
| **idb guest reader, direct** (jev-vphone pattern) | `xcrun simctl spawn <udid> SimulatorFrameworkBridge-iOS accessibility serve <sock> …`, length-prefixed JSON (`describe`, `hittest`) | Same as axbridge, plus `DatePickerPossibleValues` | **33–35 ms warm**, 508 ms first request (jev-vphone, iOS 18.5) | Reader only (hit test). Needs AXe or idb for HID, or your own guest helper for AX actions and value set | Through your own guest helper: `AXUIElementSetAttributeValue(XC_kAXXCAttributeValue)` with read-back (Unicode) | Wire format is private to idb and can change between versions. Re-verify on iOS 27. | Extract one file from the idb tarball, pinned by sha256 (`setup_jev.sh`) | Coupled to idb releases | MIT (idb); helper code in jev-vphone is MIT |
| **AXe** 1.8.0 (cameroncooke) | `axe describe-ui --udid` (host-side translator, built on idb frameworks); `--point x,y` | Host view: composite nodes, picker indices instead of values | 0.286–0.296 s warm including process start; 1.65 s cold (jev-vphone, Xcode 26.6) | `tap -x -y` or `--id/--label/--value [--wait-timeout] [--tap-style physical]`; `swipe`, `drag`, `touch`, `gesture` presets, `button`, `key`, `key-sequence`, **`key-combo`**, `slider`, `batch` (one HID session), `screenshot`, `record-video` | `type` is **US keyboard only**; non-ASCII fails. The Cmd+V paste path (`key-combo --modifiers 227 --key 25`) is refused silently on iOS 27 | **Officially supports Xcode 26 and 27; iOS 27 through Device Hub; Simulator.app not required** (validated with Xcode 27 b3 / iOS 27) | `curl` `AXe-macOS-v1.8.0-universal.tar.gz` into `.tools/axe/` with sha256 `7b76340b…`; frameworks stay beside the binary. Brew tap also exists. | Active (v1.5 → v1.8 in 2026; 2.2k stars) | MIT |
| **Appium WebDriverAgent** (`appium-webdriveragent` 16.12.10) | XCTest runner app with an HTTP server on :8100. `GET /source` (XML, or `?format=json`), `/session/:id/elements`, `/element/:id/attribute/*` | XCUITest tree (`XCUIElementType*`, visible, enabled, focused, value) | **Slow**: 9.6–10.8 s for Settings `/source` on a physical iPhone, ~1.2 s for Calculator (openclaw). Simulator not measured. | W3C `/session/:id/actions` (pointer and key), `/wda/keys`, `element/:id/{click,value,clear}`, `/wda/element/:id/swipe`, `/wda/pressButton`, `/wda/apps/{activate,terminate,state}`, `/wda/activeAppInfo`. Set `appium/settings {waitForIdleTimeout:0, animationCoolOffTimeout:0}` | **XCUITest typeText / `/wda/keys` accepts Unicode** by inserting directly, not through the keyboard (Appium Unicode doc) → Korean OK, with no IME events | Needs `IPHONEOS_DEPLOYMENT_TARGET 15` (WDA#1152) to build with Xcode 27. Preinstalled WDA on devices dies after ~20 s with Xcode 27 (xcuitest-driver#2978, #2985). No Simulator.app on 27, so run headless. | `npm i appium-webdriveragent` into project `node_modules`, then `xcodebuild build-for-testing/test -project node_modules/appium-webdriveragent/WebDriverAgent.xcodeproj -scheme WebDriverAgentRunner -destination id=<udid> -derivedDataPath .tools/wda`. Alternative: the release `WebDriverAgentRunner-Runner-sim-<ver>.zip`, `simctl install`, then `simctl launch --terminate-running-process <udid> com.facebook.WebDriverAgentRunner.xctrunner` (iOS ≥ 17) | Active (Appium; Xcode 27 CI green 2026-09-19) | BSD (repo) / Apache-2.0 (npm) |
| **Maestro** (`maestro mcp`) | Own XCTest iOS driver; `inspect_screen` returns compact JSON (`a11y, txt, val, hint, rid, b, c`) | XCUITest-level | Not measured; the omg.dev loop runs about 0.5 s per Jev look on top | Flow YAML: `tapOn point`, `longPressOn`, `inputText`, `eraseText`, `hideKeyboard`, `openLink`, `launchApp` | `inputText`: the docs name a non-ASCII limitation on Android only; iOS is undocumented [INFERENCE: likely XCTest typeText, so Unicode]. Occasionally doubles characters, so read back | Not checked on 27 | Installer puts files in `~/.maestro`; needs a local JDK 17+ tarball (`~/.local/jdk`). Not fully project-local [INFERENCE: may be relocatable] | Active (mobile.dev) | Apache-2.0 [INFERENCE] |
| **serve-sim** (npm `serve-sim` / `@expo/serve-sim`) | Swift helper `GET /ax`, a port of idb's host-side AX reading (`ax`-equivalent); `/foreground`, `/config` | Host (composite) view | Not measured | `serve-sim tap x y` (**normalized 0..1**), `gesture` JSON, `button`, binary WebSocket | `type` is US keyboard only | arm64 only | `npm i serve-sim` into the project | Active (Expo fork) | Apache-2.0 |
| **`xcrun simctl` alone** | none | – | – | `launch`, `terminate`, `openurl`, `io screenshot/recordVideo`, `pbcopy`, `privacy`, `spawn defaults` | `pbcopy` + Cmd+V: iOS 26 shows an **Allow Paste** prompt; iOS 27 **refuses silently** (sim-mirror #27/#30). `simctl privacy` has no pasteboard permission. | Built in | – | Apple | – |

### Korean / Unicode text on iOS simulator — decision matrix

1. **HID keycodes** (`idb ui text`, `axe type`, `serve-sim type`): US-ASCII only. Hangul is impossible unless you add a Korean keyboard to the simulator and send 2-set (dubeolsik) jamo keycodes [INFERENCE: not tested anywhere]. sim-mirror measured on iOS 27: keys held 0 ms lost 40 of 164 characters; held 10–20 ms, all arrived.
2. **Pasteboard** (`simctl pbcopy` + Cmd+V): **not usable on iOS 27** (silent refusal). On iOS 26 it needs a manual "Allow Paste" tap.
3. **AX value set** (`idb ui set-value`, jev-vphone guest `replace-text`): Unicode; the read-back can be checked on the same element. It skips keyboard and IME events, so onChange handlers in React Native, Flutter or web views may not fire. Verify per framework.
4. **XCUITest typeText** (WDA `/wda/keys`, `element/:id/value`, Maestro `inputText` [INFERENCE]): Unicode, direct insertion. Heavier runtime (xcodebuild runner).
→ Recommended [INFERENCE]: use (3) as the default Unicode path with a value read-back. Use (1) for ASCII when real keyboard events matter. Use (4) as the fallback. Never (2) on iOS 27.

### Recommended simulator stack for our platform [INFERENCE, derived from the above]

- **Observe**:
  - Default: idb ≥ v1.6.2 `axbridge` full tree through the CLI, `--format complete` (gives `truncated`, `modal`, `screen`).
  - Fast path: keep the guest reader warm with a direct socket (jev-vphone), about 35 ms per read.
  - Settle: `idb ui quiet <timeout> --json`, plus two equal fingerprints.
- **Hit test**: `idb ui describe-point X Y --api axbridge`, or the guest `hittest`, just before input. Reject an empty or mismatched label. Do not repeat flick's empty-label bug.
- **Act**: HID tap/swipe in points (idb `--api hid`, or AXe 1.8.0 with explicit Xcode 27 support). Accessibility press or scroll through `idb ui tap <marker> --expected-value` or `idb ui scroll`. Text: `idb ui set-value` with a read-back for Unicode, or AXe `type` for ASCII with real key events.
- **Install**: pinned tarballs with sha256 into `.tools/` (see `setup_jev.sh`) and the `fb-idb` client in `.venv`. No brew.
- **Physical devices / cross-check**: WDA through `node_modules/appium-webdriveragent` with `waitForIdleTimeout=0`. Expect `/source` to take seconds.
- **Caveats**: axbridge turns on `AutomationEnabled` for the whole simulator. Flutter (without semantics), Unity and Metal apps expose no tree, so an OCR or vision fallback would be needed; none of these repos implement one.

### Coordinate notes

- All simulator AX frames and HID taps are in **points**. iPhone 17 Pro is 402×874 points; its screenshot is 1206×2622 pixels (3×). jev-vphone's VM path uses pixels.
- serve-sim uses normalized 0..1 coordinates.
- WDA W3C actions use points.
- AXe corrects for landscape and letterboxed orientation automatically (v1.7.0).

### Sources beyond the repos

fbidb.io/docs/idb/{accessibility,ui,installation}; github.com/facebook/idb (releases, commit 981101298cf5); github.com/cameroncooke/AXe (README, CHANGELOG) and axe-cli.com/docs/command-reference; registry.npmjs.org/appium-webdriveragent (16.12.10); appium/appium#22368 and xcuitest-driver #2978/#2985; AndrewKochulab/sim-mirror #27/#30; quern-dev/quern #222; EvanBacon/serve-sim skills (SKILL.md, references/endpoints.md); Appium Unicode doc.