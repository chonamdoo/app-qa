# Maestro code review: comparison with app-qa

Source: `mobile-dev-inc/maestro` at `main` (fetched 2026-09-26), plus tag `cli-1.39.0` for the older AI prompts and the old web Studio. "Ours" means `skills/architecture/references/design.md` and `src/spec/schema.ts`. **[INFERENCE]** marks conclusions I drew from reading code but did not run.

---
## 1. Flow YAML DSL and command model

### 1.1 Files
- Command models: `maestro-orchestra-models/src/main/java/maestro/orchestra/{Commands.kt, ElementSelector.kt, Condition.kt, MaestroConfig.kt, ElementTrait.kt, MaestroCommand.kt, WorkspaceConfig.kt, ArtifactManifest.kt}`
- YAML layer: `maestro-orchestra/src/main/java/maestro/orchestra/yaml/`
  - `YamlFluentCommand.kt` holds every YAML key and its `_toCommands` mapping.
  - Also `YamlElementSelector.kt`, `YamlCondition.kt`, `YamlConfig.kt`, `YamlScrollUntilVisible.kt`, `YamlExtendedWaitUntil.kt`, `YamlRepeatCommand.kt`, `YamlRetry.kt`, `YamlAssertWithAI.kt`, …

### 1.2 Full YAML command list (fields of `YamlFluentCommand`)

| Group | Commands |
|---|---|
| Tap | `tapOn`, `doubleTapOn` (TapRepeat(2, delay=100 ms)), `longPressOn` |
| Assert | `assertVisible`, `assertNotVisible`, `assertTrue`, `assertScreenshot`, `assertWithAI`, `assertNoDefectsWithAI`, `assertDarkMode`, `assertLightMode` |
| AI extract | `extractTextWithAI` |
| Input | `inputText`, `inputRandomText`, `inputRandomNumber`, `inputRandomEmail`, `inputRandomPersonName`, `inputRandomCityName`, `inputRandomCountryName`, `inputRandomColorName` (Datafaker), `eraseText`, `pasteText`, `copyTextFrom`, `setClipboard`, `pressKey`, `hideKeyboard` |
| Navigation | `back`, `scroll`, `scrollUntilVisible`, `swipe`, `openLink`, `action: back / hideKeyboard / scroll / clearKeychain` (string form) |
| App lifecycle | `launchApp`, `stopApp`, `killApp`, `clearState`, `clearKeychain`, `setPermissions` |
| Device | `setLocation`, `travel`, `setOrientation`, `setAirplaneMode`, `toggleAirplaneMode`, `setDarkMode`, `toggleDarkMode`, `addMedia` |
| Waits | `extendedWaitUntil`, `waitForAnimationToEnd` |
| Control flow | `runFlow`, `repeat`, `retry` |
| Scripting | `runScript`, `evalScript` |
| Artifacts | `takeScreenshot`, `startRecording`, `stopRecording` |

Flow header (`YamlConfig`):
- `appId` or `url` (web); one of them is required, otherwise `ConfigParseError("missing_app_target")`.
- `name`, `tags`, `env`, `onFlowStart`, `onFlowComplete`, `properties`.
- Unknown keys go to `ext`, for example `jsEngine` (rhino is now rejected) and `androidWebViewHierarchy: devtools`.

Workspace `config.yaml` (`WorkspaceConfig`):
- `flows`, `includeTags`, `excludeTags`, `executionOrder.{flowsOrder, continueOnFailure}`.
- `platform.android.disableAnimations`, `platform.ios.{disableAnimations, snapshotKeyHonorModalViews}`, `testOutputDir`.

### 1.3 Selector model
`YamlElementSelector` → `ElementSelector`, built into filters by `Orchestra.buildFilter`.
- **Keys:** `text`, `id`, `width`/`height`/`tolerance` (size), `below`, `above`, `leftOf`, `rightOf`, `containsChild`, `containsDescendants[]`, `childOf`, `traits` (`text`, `square`, `long-text`), `index`, `enabled`, `selected`, `checked`, `focused`, `css` (web). Tap-specific keys also live here: `optional` (deprecated), `retryTapIfNoChange`, `waitUntilVisible`, `point`, `repeat`, `delay`, `waitToSettleTimeoutMs`, `label`.
- **`text` is a regex.** It is compiled with `REGEX_OPTIONS = {IGNORE_CASE, DOT_MATCHES_ALL, MULTILINE}` via `toRegexSafe`, which escapes the string as a literal if it is not a valid regex.
  - `Filters.textMatches` accepts a node if any of `text`, `hintText`, `accessibilityText` (Android content-desc, iOS label) or `error` (Android only, non-empty) satisfies one of: `regex.matches(value)` (a full match, not a substring), `regex.pattern == value` (literal equality, so metacharacters still work when the string is identical), or the same two checks after replacing `\n` with a space.
  - Consequence: multiline text matches either through DOT_MATCHES_ALL or through the newline→space replacement. Partial strings never match; the MCP `inspect_screen` description warns about exactly this.
- **`id`:** full regex match on `resource-id`, or on the part after the last `/` (so `com.pkg:id/foo` matches `foo`). On iOS, `resource-id` = accessibilityIdentifier.
- **State:** `Filters.enabled/selected/checked/focused` compare TreeNode booleans. On iOS, `checked` = element type in (checkbox, switch, toggle) and `value == "1"`.
- **Relative:** `below` = `it.bounds.y > other.bounds.y` (top edges only; there is no horizontal overlap test). `above`, `leftOf`, `rightOf` are the analogous comparisons. `relativeTo` sorts candidates by centre distance, but see §3.4 for why that order is probably lost.
  - `containsChild` = a direct child matches.
  - `containsDescendants` = every sub-filter matches some descendant.
  - `childOf` = resolve the parent (first match, recursively), then search only in its subtree. Failures produce `childOfDebugMessage`, which reports whether the parent matched and how many times the target matched elsewhere.
- **`index`:** after filtering, sort by `INDEX_COMPARATOR` (bounds.y, then bounds.x). Negative indices count from the end. Without `index`, `Filters.clickableFirst()` stable-sorts clickable nodes to the front and the first result wins.

### 1.4 `optional`, `when`, runFlow, repeat, retry
- **optional:** on a command (or the deprecated selector field). A `MaestroException` becomes `CommandWarned` (a warning insight) and the flow continues. Non-Maestro exceptions still fail.
- **Conditions** (`when` on `runFlow` / `runScript`; `while` on `repeat`) are evaluated by `Orchestra.evaluateCondition`. All present clauses must hold (AND):
  - `platform`: equals the device platform.
  - `true:`: a script result string. It is false if blank, `false`, `undefined`, `null` or numeric 0.
  - `visible`: `findElement` within `adjustedToLatestInteraction(timeout ?: optionalLookupTimeoutMs = 7000)`.
  - `notVisible`: inside the same adjusted deadline, repeatedly call `findElement(timeout=500)`. It is true as soon as one 500 ms lookup finds nothing, i.e. the element is absent for about 500 ms.
- **runFlow:** takes `file` or inline `commands` (exactly one), plus `env`, `when`, `label`, `optional`. A false condition → `CommandSkipped`. `runSubFlow` pushes an env scope and runs the subflow's own onFlowStart/onFlowComplete.
- **repeat:** `times` (default unlimited) and/or `while`. Subcommands are reset each iteration. Zero iterations → Skipped.
- **retry:** `maxRetries` (default 1, capped at `MAX_RETRIES_ALLOWED = 3`). It retries only on `MaestroException`, i.e. element-not-found or assertion failures, including after mutating steps have already run.

### 1.5 Waiting and assertions
- `assertVisible` / `assertNotVisible` → `AssertConditionCommand`. Timeout = the `timeout` field or `lookupTimeoutMs = 17000`, adjusted to the last interaction.
- `extendedWaitUntil {visible | notVisible, timeout}` is the same command with an explicit timeout.
- `scrollUntilVisible` (see §2.4). Defaults: direction DOWN, `timeout` 20000, `speed` 40 → duration `(1000*(100-speed)/100)+1` = 601 ms, `visibilityPercentage` 100, `centerElement` false.
- `waitForAnimationToEnd`: `ScreenshotUtils.waitUntilScreenIsStatic(timeout ?: 15000, 0.005)`.

### 1.6 Variables, scripts, hooks
- `env` in the header, `-e KEY=VAL` on the CLI, and `runFlow.env`. `${...}` in any string field is evaluated as JS by `evaluateScripts` before each command runs.
- **JS engine:** GraalJS (`maestro-client/.../js/GraalJsEngine.kt`).
  - One shared context, strict mode. Each script runs inside `(function(){ return eval(`…`) })()`.
  - Bindings: `output` (persists), `maestro.{copiedText, platform}`, `http`, `faker`, `json()`, `relativePoint()`.
  - A Proxy on `globalThis` makes undeclared variables evaluate to `undefined`, enabling `${VAR || 'default'}`.
  - Env scopes are a stack (`enterEnvScope` / `leaveEnvScope`).
- **copyTextFrom:** takes text → hintText → accessibilityText → error from the element and stores it in `maestro.copiedText`. `pasteText` = `inputText(copiedText)`. `setClipboard` only sets that variable. None of these touch the device clipboard.
- **Hooks:** `onFlowStart` runs first; if it fails, the body is skipped. `onFlowComplete` runs in `finally` (unless cancelled); if it fails, the flow fails, but a body failure takes precedence.

### 1.7 AI commands
Models: `AssertWithAICommand`, `AssertNoDefectsWithAICommand`, `ExtractTextWithAICommand`. **All default to `optional = true`**, including the YAML shorthand `YamlAssertWithAI.parse`.

- **Transport:** `maestro-ai/.../cloud/ApiClient.kt`, base URL `MAESTRO_CLOUD_API_URL` or `https://api.copilot.mobile.dev`, header `Authorization: Bearer <MAESTRO_CLOUD_API_KEY>`, timeouts 10 s connect / 60 s socket / 60 s request.
  - `assertNoDefectsWithAI` → `POST /v2/find-defects {screen}` → `defects[]`. **FAIL if the list is non-empty**; the reasoning is stored in `CommandMetadata.aiReasoning`.
  - `assertWithAI` → `POST /v2/find-defects {assertion, screen}` → `defects.firstOrNull()`. **PASS iff it is null.**
  - `extractTextWithAI` → `POST /v2/extract-text {query, screen}` → `text`, stored as env `outputVariable`.
  - The screenshot is an uncompressed PNG from `maestro.takeScreenshot(…, compressed=false)`.
- **Prompts and model are no longer in the repo; they live on the server.** The older in-repo version (`cli-1.39.0/maestro-ai/.../Prediction.kt`):
  - Opening: "You are a QA engineer performing quality assurance for a mobile application. Identify any defects in the provided screenshot."
  - Categories: `localization` (mixed languages), `layout` (overlap / cropping), plus `assertion`.
  - Anti-false-positive rules and a JSON `{defects:[{category, reasoning}]}` format. OpenAI used Structured Outputs with `askForDefects_schema.json`; Claude used prompt-only JSON.
  - Assertion prompt: "identify if the following assertion is true: \"…\"". **It contains an inverted rule:** "If the assertion is false, the list in the JSON output MUST be empty", immediately followed by "If assertion is false … include a single defect".
  - `maxTokens` 4096, `imageDetail` high. The eval harness `DemoApp.kt` defaults to `gpt-4o`, temperature 0.2, with files named `{app}_{n}_{good|bad}.png` (+ `.txt` prompt).
  - There is no confidence value, no calibration, and a missing defect list means PASS.
- **Ours:** `claim` = Jev Noul, gated by calibrated thresholds, fail-closed. This is strictly safer. Do not import `assertWithAI` semantics.

---
## 2. Orchestra execution semantics

### 2.1 Lookup timeouts and polling
- `Orchestra(lookupTimeoutMs = 17000, optionalLookupTimeoutMs = 7000)`.
- `findElement` uses the explicit timeout, or `adjustedToLatestInteraction(optional ? 7000 : 17000)` = `max(0, t − (now − timeMsOfLastInteraction))`. `timeMsOfLastInteraction` is updated whenever `executeCommand` returns `mutating = true`.
- **Polling:** `MaestroTimer.withTimeoutSuspend` is a tight do/while with no sleep. Each iteration fetches the full hierarchy (`ViewHierarchy.from(driver)`), applies the filter and takes `firstOrNull()`.

### 2.2 Settle (`Driver.waitForAppToSettle`)
- **Hierarchy-based** (`ScreenshotUtils.waitForAppToSettle`): fetch the hierarchy repeatedly. Stable = two consecutive `ViewHierarchy` values structurally equal (Kotlin data-class equality over all attributes including bounds) and root `is-loading` not true. Without a timeout: `repeat(10)` with 200 ms sleeps, about 2 s plus fetch time. With `waitToSettleTimeoutMs`: tight loop until the deadline.
- **Android with appId:** `waitForWindowToSettle` loops **until a fixed 750 ms deadline** (`WINDOW_UPDATE_TIMEOUT_MS`) calling gRPC `isWindowUpdating` (`uiDevice.waitForWindowUpdate(appId, 500)`). It runs the hierarchy settle if the window is updating and never exits early.
- **iOS:** `IOSDriver.waitForAppToSettle` → `waitUntilScreenIsStatic(3000)`, i.e. repeated `/isScreenStatic` calls, which compare the SHA-256 of two consecutive `XCUIScreen.main.screenshot()` PNGs. Static → returns `null`. Not static within 3 s → falls back to the hierarchy settle.
- **`waitForAnimationToEnd`:** host-side screenshot pairs compared with `romankh3 ImageComparison`, static if `differencePercent ≤ 0.005` (0.5%), 15 s timeout.

### 2.3 Tapping (`Maestro.tap` / `performTap`)
1. `waitForAppToSettle(initialHierarchy, appId, waitToSettleTimeoutMs)`.
2. **Stabilise after a scroll.** `recentScroll` is set by swipe/scroll/hideKeyboard and cleared by tap/launch. If the settle returned null and `recentScroll` is set, `refreshElementUntilStable`:
   - fetch a fresh hierarchy every 100 ms;
   - `refreshElement` finds the node whose attributes minus bounds equal the original, and requires exactly one such node;
   - succeed when its bounds are equal in two consecutive fresh fetches;
   - give up after 3000 ms (`ELEMENT_STABILITY_TIMEOUT_MS`) and use the last known position (ticket MA-4124).
   - Otherwise the settled (or initial) hierarchy is used with `refreshElement`.
3. **Tap point = `bounds.center()`** of the refreshed element, or `relativePoint` ("x%,y%" or pixels inside the element) via `calculateElementRelativePoint`. **There is no occlusion or hit-test check.**
4. **`hierarchyBasedTap`** (Android, `Capability.FAST_HIERARCHY`): tap, then settle; stop as soon as the hierarchy after differs from before (or the settle returned null). With `retryTapIfNoChange`, retries = 2, so a second physical tap follows if nothing changed. Default is false.
5. **`screenshotBasedTap`** (iOS, no capabilities): same, but if the hierarchy is unchanged it also compares screenshots before and after; `differencePercent > 0.005` counts as changed.
6. **`waitUntilVisible`:** if the hierarchy is unchanged and `!isVisible(node)`, poll up to 10 × 1 s until `getElementAt(center) == node`, then tap again.
7. **Repeat taps:** `TapRepeat(repeat, delay)` subtracts the time the tap itself took from the delay. Long press: Android `input swipe x y x y 3000`, iOS 3000 ms.

### 2.4 Scrolling
- **`scrollUntilVisible`:** loop until deadline:
  - `findElement(selector, timeout=500)`;
  - `visibility = getVisiblePercentage(screen)`;
  - with `centerElement`, `visibility > 0.1` and fewer than 4 re-centre attempts, succeed when `isElementNearScreenCenter` (margin = screen/5 along the scroll axis);
  - otherwise succeed if `visibility ≥ visibilityPercentageNormalized`;
  - if not found or not visible enough, `swipeFromCenter(direction, duration, waitToSettle)`.
  - **Bug:** `visibilityPercentageNormalized = (visibilityPercentage / 100).toDouble()` is integer division, so 1–99 → 0.0. Any found element passes regardless of the percentage.
- **Android swipe coordinates:** UP 50%→10% height, DOWN 20%→90%, LEFT 90%→10% width, RIGHT 10%→90%, all through `adb shell input swipe … <ms>`. `scroll` = swipe UP, 400 ms.
- **iOS:** `scrollVertical` 50%→10%, 333 ms. Every `IOSDriver.swipe` first calls `waitForAppToSettle` (up to 3 s) and then `/swipeV2` (private event synthesis via EventRecord.addSwipeEvent).

### 2.5 Text input, erase, keyboard
- `inputText` → `driver.inputText` → settle. See §4 for the per-platform behaviour.
- `eraseText` defaults to **50** characters (`MAX_ERASE_CHARACTERS`).
  - Android: `uiDevice.pressDelete()` × N.
  - iOS: types `XCUIKeyboardKey.delete` × N through the same text-input path.
- `hideKeyboard`: `driver.hideKeyboard()`, then if `isKeyboardVisible()` is still true, `HideKeyboardFailure` (with advice to tap a static text instead).
  - Android: **always `input keyevent 4` (BACK)** plus 300 ms.
  - iOS: dismiss the "Speed up your typing…" intro if present, then a 50%→47% vertical drag, then a horizontal one. "Hidden" = no element with id `delete` within 2 s.

---
## 3. Hierarchy filtering and matching

### 3.1 Pre-filter
`ViewHierarchy.from`:
- `filterOutOfBounds` drops a node if it is less than 10% inside the screen and has no kept children. Toasts are exempt via `ignoreBoundsFiltering`.
- Android keyboard exclusion (`excludeKeyboardElements`) removes only nodes whose resource-id starts with `com.google.android.inputmethod.latin:id/` (Gboard).
- `isKeyboardVisible` = the serialized hierarchy JSON contains `com.google.android.inputmethod.latin:id`. Other keyboards are invisible to both checks.

### 3.2 Deepest match, no clickable-ancestor promotion
- Basic filters (text, id, size, traits, state) are intersected and wrapped in `Filters.deepestMatchingElement`: for each node, if any descendant matches, return the deepest matching descendants, otherwise the node itself; then `distinct()`.
- So `tapOn: "Login"` targets the **TextView/label node**, not its clickable parent. It relies on the platform routing a centre tap to the ancestor.
- `clickableFirst` only reorders among multiple matches. On iOS there is no `clickable` attribute, so it has no effect.

### 3.3 Visibility and occlusion
- **findElement has none.** Android dumps **all window roots** (reflection on `UiDevice.getWindowRoots`, falling back to `rootInActiveWindow`). It skips children that are not `isVisibleToUser`, which ignores overlap between views, and clips bounds to the display.
- So text behind an in-window bottom sheet or scrim is matched, and its centre is tapped, which lands on the sheet.
- `ViewHierarchy.isVisible` / `getElementAt` (topmost node by reverse child order, any node) is used only by `waitUntilVisible`.
- iOS relies on accessibility's own modality: `snapshotKeyHonorModalViews` can be disabled via workspace config to expose elements behind modals.
- Our model (occluders limited to touchable nodes, un-occluded tap point, `my-flight-sheet` ground truth) is more correct than Maestro's. Keep it.

### 3.4 Ordering
- `Filters.intersect` does `map { it(nodes).toSet() }.reduce { a, b -> a.intersect(b) }`. Kotlin's `Iterable.intersect` keeps the **receiver's** order, and the receiver is the basic filter output in document order (or all nodes when there is no basic filter).
- **[INFERENCE]** Therefore the distance ordering built in `relativeTo` is discarded: `below: X` picks the first clickable match in document order, not the nearest.
- `index` re-sorts explicitly by (y, x). There is no deduplication of repeated rows beyond `distinct()` of identical TreeNode objects.
- `refreshElement` requires a unique match on all attributes except bounds. For identical repeated rows it returns null and the pre-settle bounds are used.

---
## 4. Drivers

### 4.1 Android (`maestro-android`, `maestro-client/.../drivers/AndroidDriver.kt`)
- **Startup:** installs `maestro-app.apk` (`dev.mobile.maestro`) and `maestro-server.apk` (`dev.mobile.maestro.test`), then `am instrument -w [-m] -e class 'dev.mobile.maestro.MaestroDriverService#grpcServer' -e port <p> …AndroidJUnitRunner`.
  - Startup timeout 15000 ms (`MAESTRO_DRIVER_STARTUP_TIMEOUT` env overrides).
  - Server: Netty gRPC. `Configurator` sets action-acknowledgment, waitForIdle and waitForSelector timeouts to **0**.
- **Hierarchy** (`androidTest/.../ViewHierarchy.kt`, adapted from AccessibilityNodeInfoDumper):
  - `refreshAccessibilityCache` = `uiDevice.waitForIdle(500)` + `uiAutomation.serviceInfo = null`.
  - Attributes: index, `hintText`, `text` (empty when `isShowingHintText`, so a hint is never reported as text), resource-id, class, package, content-desc, checkable, checked, clickable, enabled, focusable, focused, scrollable, long-clickable, password, selected, visible-to-user, important-for-accessibility, `error`, bounds (visible bounds ∩ display), NAF.
  - Invalid XML characters are replaced with `.`.
  - **No drawing-order or window-id is emitted**, so the host cannot compute z-order.
  - `ToastAccessibilityListener` appends the latest Toast as a node.
- **Tap:** `uiDevice.clickExt(x, y)`. Swipe, long press, back and keys go through the adb shell (`input swipe`, `input keyevent N` + 300 ms).
- **Input:**
  - **ASCII:** gRPC `inputText` → each character goes through `setText`, a keycode table (0–9, a–z, A–Z with meta, punctuation, shifted symbols), with `Thread.sleep(75)` per character. **Characters not in the table are silently dropped** (e.g. `\n`, `\t`), and nothing verifies the result.
  - **Non-ASCII (Korean):** `inputUnicodeText`:
    - save the current IME (`settings get secure default_input_method`);
    - `ime enable` + `ime set dev.mobile.maestro/.input.MaestroInputMethodService`;
    - poll the status broadcast until `result=0` (at most 5000 ms, every 300 ms);
    - for each chunk of at most 1000 UTF-16 code units (never splitting a surrogate pair), base64url the UTF-8 and send `am broadcast -a dev.mobile.maestro.ime.commitText -n …/.receivers.UnicodeInputReceiver --es textBase64 …`; the IME does `beginBatchEdit / commitText(text, 1) / finishComposingText / endBatchEdit`;
    - sleep 250 ms, then restore the original IME (best effort).
  - Korean is therefore committed as finished syllables, not composed with jamo.
- **eraseText:** `pressDelete` × N. **Clipboard:** not used (the clipboard is an internal variable, see §1.6).
- **Lifecycle:** launch = `getLaunchIntentForPackage` + `startActivity` from the instrumentation context (extras from `launchArguments`). stop = `am force-stop`; kill = `am kill` (simulates process death); clear = `pm clear`; clearKeychain is a no-op.
- **Other:** screenshot = `uiAutomation.takeScreenshot` → PNG with retry. Recording = `screenrecord --bit-rate 100000` (180 s cap below API 34), `killall -INT`, sleep 3 s, pull.

### 4.2 iOS (`maestro-ios-xctest-runner`, `maestro-ios-driver`, `IOSDriver.kt`)
- **Runner:** an XCTest UI-test bundle running a FlyingFox HTTP server (`XCTestHTTPServer`). It is launched with `xcrun simctl launch --console --terminate-running-process <udid> dev.mobile.maestro-driver-iosUITests.xctrunner` and `SIMCTL_CHILD_PORT` (plus `SIMCTL_CHILD_snapshotKeyHonorModalViews`).
- **Routes** (`RouteHandlerFactory.swift`): runningApp, swipe, swipeV2, inputText, touch, screenshot, isScreenStatic, pressKey, pressButton, eraseText, deviceInfo, setOrientation, setAppearance, appearance, setPermissions, viewHierarchy, status, keyboard, terminateApp, launchApp.
- **XCTest swizzles:**
  - `XCUIApplication.doesNotHandleUIInterruptions` → YES (no XCTest interruption monitors).
  - Quiescence waits bypassed unless `waitForIdleTimeout` is set (`XCUIApplicationProcess+FBQuiescence.m`).
  - Snapshot request parameters (`XCAXClient_iOS+FBSnapshotReqParams.m`, WebDriverAgent-derived) for `maxDepth` and `snapshotKeyHonorModalViews`.
- **viewHierarchy** (`ViewHierarchyHandler.swift`):
  - Foreground app comes from the AX active-applications list; springboard is used if there is none, and also when iOS 26 iPad reports `DockFolderViewService`.
  - It walks the `XCUIElementSnapshot` tree, not `dictionaryRepresentation`, which it notes is O(subtree) per call.
  - **`snapshotMaxDepth = 60`:** if depth ≥ 60, re-snapshot each child via `descendants(matching:.other).element(boundBy:i)`.
  - On `kAXErrorIllegalArgument` or `kAXErrorInvalidUIElement`, it forces maxDepth 60, starts again from the first window child with more than one child, and separately fetches keyboard, alerts and custom window elements.
  - Adds springboard status bars and, on iOS 26+, the `SafariViewService` web-view tree. Applies offsets for cross-process windows (windowContextID + isRemote + visibleFrame) and window-vs-device offsets (with a landscape guard).
  - Auto-taps the notification permission alert on springboard when a `permissions.notifications` value was set.
  - Host side: `WARNING_MAX_DEPTH = 61` → an insight telling React Native users to move to the new architecture.
  - Mapping: text = title or value; accessibilityText = label; hintText = placeholderValue; resource-id = identifier; checked as in §1.3.
- **Touch:** `RunnerDaemonProxy().synthesize(EventRecord.addPointerTouchEvent)`, a private event path with orientation-aware points.
- **inputText** (`TextInputHelper`): wait up to 1 s for `keyboards.firstMatch.exists` (200 ms poll); type the first character at typingSpeed 1; **sleep 500 ms**; type the rest at speed 30 via `PointerEventPath.pathForTextInput().type(text:)`. No verification.
  - [INFERENCE] Unicode works because XCTest's type path accepts arbitrary strings. Our own measurements already confirm WDA Korean input.
- **pressKey:** `delete` / `return` typed via the same path; `home` / `lock` via pressButton.
- **backPress: `override fun backPress() {}`, a silent no-op on iOS.**
- **Lifecycle** (`LocalSimulatorUtils.kt`):
  - launch: `XCUIApplication(bundleId).activate()` (runner) or `simctl launch`;
  - clearAppState: `simctl terminate`, then `ensureStopped` (poll `simctl spawn launchctl list`, 10 s), copy the `.app` from `get_app_container`, `simctl uninstall`, `simctl install`;
  - clearKeychain: `xcrun simctl keychain <udid> reset`, which is device-wide;
  - permissions: pinned `~/.maestro/deps/applesimutils --byId … --bundle …`, falling back to PATH applesimutils, and `simctl privacy grant|revoke|reset location[-always]`;
  - killApp = stopApp (no process death on iOS); openLink = `simctl openurl`; setLocation = `simctl location set`.
- **launchApp** (Orchestra): optional clearKeychain → optional clearState → **`setPermissions(permissions ?: {all: allow})`** → stop → launch.

---
## 5. Tooling

### 5.1 Maestro Studio
- Now a **closed-source desktop app**. The README says so, and `StudioCommand` only prints a download URL.
- Last open-source web Studio (`cli-1.39.0/maestro-studio/{server,web}`):
  - Ktor server with `POST /api/run-command {yaml, dryRun}` (parse with `YamlFluentCommand`, run through Orchestra), `POST /api/format-flow`, `GET /api/device-screen/sse`, `GET /api/last-view-hierarchy`, and `/screenshot/*` static files.
  - The SSE stream loops forever over hierarchy + screenshot, keeps the last 10 PNGs, and synthesises element ids from `resource-id[-idIndex]-text[-textIndex]` or bounds.
  - React front end with components `device-and-device-elements`, `interact`, `commands`, `design-system`.
  - [INFERENCE] The UI was a live screenshot with element-box overlays; clicking an element produced suggested `tapOn` / `assertVisible` selectors (text/id/index); commands were run REPL-style and exported as a flow.

### 5.2 MCP server
- `maestro mcp` (`maestro-cli/.../mcp/McpServer.kt`) uses stdio and a forked MCP Kotlin SDK.
- Tools: `list_devices`, `take_screenshot`, `run` (exactly one of `yaml` / `files` / `dir` + tags + env; validates syntax), `inspect_screen`, `cheat_sheet`, `open_maestro_viewer`, `list_cloud_devices`, `run_on_cloud`, `get_cloud_run_status`, `describe_cloud_run`.
- `inspect_screen` returns compact JSON (`ui_schema` abbreviations + defaults, `elements` tree with `b`, `txt`, `rid`, `a11y`, `hint`, `cls`, `val`, `c`). Its instructions: copy `txt` verbatim; never author selector strings from a screenshot; remember `text:` is a full-string regex.
- **Maestro Viewer:** a React/Vite/Tailwind v4 app inlined into one HTML file. `POST /api/events` and `GET /api/events/stream` (SSE).

### 5.3 Recording
`maestro record <flow> [out] [--local]` runs the flow under a screen recording, then renders a video with a command-list overlay: locally with `SkiaFrameRenderer` at 1920×1080 / 25 fps, or remotely. `startRecording` / `stopRecording` commands pad recordings to at least 3 s.

### 5.4 Test output
- `--format JUNIT|HTML|HTML-DETAILED`, `--output`, `--test-suite-name`.
- Debug output: `$XDG_STATE_HOME/tests/<yyyy-MM-dd_HHmmss>/`, or `--debug-output` / `--flatten-debug-output` / `--test-output-dir`. Contents: `maestro.log`, per-flow folders (sanitised name, `-shard-N`, `-N` on collision), `manifest.json`, `commands.json` (per command: evaluatedCommand, logMessages, insight, aiReasoning, numberOfRuns), `logs/`, `takeScreenshot/`, `startRecording/`, and `ai-(flow).json` + an AI HTML report. Old runs are purged after 14 days.
- Per-step screenshots are taken only for the failed step unless `captureFullArtifacts` is on.
- `ArtifactManifest`: `ArtifactKind` = SCREENSHOT, TAKE_SCREENSHOT, SCREEN_RECORDING, START_SCREEN_RECORDING, SCREEN_HIERARCHY, COMMAND_METADATA, MAESTRO_LOG, DEVICE_LOG, CRASH_REPORT, ANR_REPORT, AI_ANALYSIS. Each entry has relativePath, count, sizeBytes, metadata, and `$schema` points to a versioned `v1.schema.json`.
- Crash data: `Driver.collectCrashArtifacts(appId, sinceEpochMs)` (Android `LogcatCrashReport`; iOS `IOSCrashFileFinder` + `IPSParser`).

### 5.5 Sharding and CI
- `--shard-split N` splits flows evenly across N devices; `--shard-all N` runs all flows on each of N devices; `--device a,b`.
- `executionOrder.flowsOrder` runs sequentially first and stops on failure unless `continueOnFailure`.
- `--reinstall-driver` (default true) reinstalls the driver apps or runner each run. `CiUtils` detects the CI provider.

---
## 6. Verdict

### 6.1 ADOPT (ranked)
1. **Clear the iOS keychain during reset.** Maestro: `LocalSimulatorUtils.clearKeychain` = `xcrun simctl keychain <udid> reset`.
   - Why: the iOS keychain survives `uninstall + install`. Expo SecureStore and other auth tokens live there, so our iOS `reset: clear` today may **not** log the user out ([INFERENCE] for 떠남; verify whether it uses SecureStore).
   - Changes: `src/drivers/*` (reset). Schema request: document that `clear` implies a keychain reset on iOS, or add an explicit `launch.clearKeychain` flag. The reset is device-wide, which is fine under `acquireDeviceLock`.
2. **Raise iOS snapshot depth and warn when it is hit.** Appium XCUITest's `snapshotMaxDepth` defaults to **50**; Maestro uses 60 plus a per-child fallback and warns at 61.
   - Changes: set `snapshotMaxDepth` (for example 62–75) in the iOS session settings next to `pageSourceExcludedAttributes`; have observe record max depth and flag `depth >= cap` in the snapshot receipt.
   - [INFERENCE] Re-check whether our sparse iOS fixtures (`ios/kroute`, `ios/granite`) are truncated trees rather than genuinely sparse ones.
   - Modules: drivers caps, observe meta.
3. **Stabilise the target's position after scroll or swipe before tapping** (`Maestro.refreshElementUntilStable`: 100 ms poll, bounds equal in 2 consecutive fresh fetches, 3000 ms cap, `recentScroll` flag). Our freshness step re-observes once. Add "target rect identical in two consecutive observations" when the previous step was scroll/swipe/back-gesture. Module: `src/runner` (freshness).
4. **Count timeouts from the last mutating action** (`adjustedToLatestInteraction`). The deadline of `see` / `expect` / `wait.until` after an action becomes `timeout − (now − lastActionAt)`, so chained checks do not each wait the full budget, and the verdict stays tied to the action's timing. Do not copy Maestro's 17 s default. Module: runner.
5. **Explicit launch permissions instead of silently allowing everything.** Maestro grants all permissions by default; we should not. Schema request: `launch: { reset, permissions?: Record<service, 'allow'|'deny'|'unset'> }`. Android: `pm grant/revoke`, plus `appops` for location. iOS: `simctl privacy <udid> grant|revoke|reset <service> <bundleId>` (notifications need applesimutils, or leave them unsupported). Modules: drivers + schema.
6. **Deep-link step.** Schema request `open: <url>`: Android `am start -a android.intent.action.VIEW -d <url> [<pkg>]`, iOS `simctl openurl`. Expo apps have a scheme, which lets tests jump straight to screens. The risk policy treats the URL as a labelled action. Modules: drivers + runner + schema.
7. **Key press / submit.** Schema request `press: enter|back|tab|escape` or `type.submit: true`. Maestro: Android keyevent 66/4/61/111; iOS `return` / `delete` via the typing path. Search forms depend on it. Modules: drivers + schema.
8. **Deterministic state predicates.** Schema request `Selector.state?: {enabled?, checked?, selected?, focused?}`, usable in `see` / `expect`. Our `NodeFlags` already carry these. This covers "버튼 비활성" and toggle states without Jev. Modules: schema + runner resolve.
9. **Observation fidelity.** Include Android `error` text (EditText.setError / Compose error) in `texts`. Treat `text == hint` on empty editable fields as an empty value, as Maestro does with `isShowingHintText`, so `assertText` and typeText verification are not fooled by placeholders. Capture Toast text (Maestro: `ToastAccessibilityListener`). [INFERENCE] Check whether UIA2 `/source` exposes `error` / showing-hint / toasts; otherwise add a UIA2 toast query. Module: observe (+ drivers).
10. **Crash and ANR artifacts.** Android logcat crash/ANR parsing; iOS `.ips` files from DiagnosticReports since the test start (Maestro `IOSCrashFileFinder` / `IPSParser`). Attach on `app_not_foreground` or a crash-dialog FAIL. Modules: drivers (`logSlice`) + runner health.
11. **Run artifact manifest.** `.qa/runs/<runId>/manifest.json` with kind / format / relativePath / count / sizeBytes and a versioned `$schema`, so `qa serve` and the UI list evidence without scanning directories. Enum values should be fixed up front, since Maestro's own comment warns that adding enum values is a breaking change. Modules: report/runner (+ an events contract note).
12. **Diagnostic text for not_found.** Port `childOfDebugMessage`: say whether the `within` container matched, and how many matches exist elsewhere on the screen. Modules: runner receipts + `report.html`.
13. **Planner prompt hygiene from `inspect_screen`.** "Copy strings verbatim from the hierarchy/inventory; never from screenshots"; say explicitly that matching is whole-string. Module: `src/plan`.
14. **Reusable subflows and hooks.** `runFlow` + `onFlowStart` / `onFlowComplete` are heavily used by Maestro users (login, onboarding). Schema request: `use: <path>` step and test-level `setup` / `teardown`. Nesting is budgeted, and there are no conditions beyond `when` / `which`. Modules: schema + `spec/load` + runner.
15. **Nice to have:** `--shard-split` style device fan-out (later), and a Studio/Viewer-style SSE live screen, which we already plan with `Last-Event-ID` replay.

### 6.2 AVOID (bugs and pitfalls seen in the code)
- **No occlusion model** (§3.3): matching and tapping behind sheets and modals. Keep our touchable-occluder rule and un-occluded tap point.
- **Retrying taps when nothing changed** (`retryTapIfNoChange`, 2 physical taps) and **`retry` blocks re-running mutating steps**: these can double-submit. Our rule stands: `uncertain` / `no_effect` → INCONCLUSIVE or ERROR, never an automatic re-act.
- **iOS `back` is a no-op** (`IOSDriver.backPress() {}`): a silent pass. Our back must verify a screen change.
- **Android `hideKeyboard` = unconditional BACK**, which navigates away if the IME has already closed. Keyboard detection is Gboard-only (`com.google.android.inputmethod.latin:id`). Instead, detect the keyboard from the IME window or `mobile: isKeyboardShown` and dismiss only if it is shown.
- **ASCII typing drops unmapped characters** (`setText` keycode table, no `\n` / `\t`) and nothing verifies the result. **iOS typing uses a timing hack** (first char, 500 ms sleep, speed 30) with no verification either. Keep our verify-after-type and `INPUT_UNVERIFIED`.
- **IME switching for Unicode** (`ime set` to the Maestro IME, then restore) can change keyboard layout and height mid-step and needs `ime enable` rights. Prefer Appium setValue plus our clipboard fallback, already verified for Korean on 떠남. If we ever need an IME route, restore the IME in `finally` and re-observe afterwards.
- **iOS "static" = identical screenshot SHA-256**: any caret blink, spinner, Lottie animation or clock prevents settling, which costs 3 s per action before the fallback. Keep our dHash thresholds (same ≤4 / different ≥7) and tree fingerprints.
- **Android window-settle loop spins to its 750 ms deadline** even when idle, and hierarchy polling uses tight loops with no sleep. Keep our 150 ms poll.
- **`scrollUntilVisible.visibilityPercentage` integer-division bug** (every value under 100 → 0). **Relative-selector ordering lost in `Filters.intersect`** [INFERENCE]. Our `near` must actually sort by distance and be tested.
- **Full-string regex as the default text matcher**: literal strings with regex metacharacters work only through a pattern == value fallback, and partial strings never match. Keep our exact (NFC) match plus an explicit `regex`.
- **`refreshElement` identity = all attributes except bounds, unique match required**: for repeated list rows it returns null and stale bounds are tapped. Our `refind` (role + name + value, nearest to the previous position) is better. Keep it and fail with `stale_target`.
- **`launchApp` grants all permissions by default**, which hides permission-UX regressions. Android `clearState` then resets permissions to `unset`, so the two platforms behave differently.
- **AI assertions:** optional by default (a failure is only a warning), no confidence value, and PASS = empty defect list. The older prompt contained a contradictory instruction. Never make LLM or vision verdicts non-blocking by default, and never treat "no answer" as PASS.
- **Internal "clipboard"** (`copyTextFrom` / `pasteText` / `setClipboard`) never exercises the device clipboard. If we add value capture, call it a variable, not a clipboard.
- **Device-wide keychain reset** and **iOS `killApp` = stop**. Document these scopes honestly rather than pretending they are per-app or a real process death.
- **Long press = `input swipe x y x y 3000`** (a fixed 3 s long press through adb). Use a W3C pointer with a configurable hold instead.

### 6.3 DSL gaps: what Maestro users rely on that we lack

| Maestro feature (commonly used) | Ours | Recommendation |
|---|---|---|
| `longPressOn`, `doubleTapOn` (repeat/delay) | only `tap` | Add `longPress: Target` (+ `holdMs`), optionally `tap.count` |
| `pressKey` (Enter / Back / Tab …) | none | Add `press:` or `type.submit` (§6.1 #7) |
| `hideKeyboard` | none (we only strip keyboard nodes) | Add `hideKeyboard: true` with a verified dismiss |
| `eraseText` / `inputText` without a target (append) | `type` always clears | Add `clear: Target` and `type.append: true` |
| `openLink` (deep links) | none | Add `open: url` (§6.1 #6) |
| `runFlow` (file / inline), `onFlowStart` / `onFlowComplete`, `env` params | none (`${ENV}` only in `type`) | Add `use:`, `setup` / `teardown`, and `${ENV}` in all strings |
| `when: {platform}` on steps | test-level `platforms` only | Add per-step `platforms` |
| `repeat {times, while}` | none | Add a bounded `repeat` (max ≤ 10, budgeted), non-mutating by default |
| `retry` | intentionally none | Keep none (§6.2) |
| selector `enabled/checked/selected/focused` | none | Add `state` (§6.1 #8) |
| selector `text` / `id` regex, `index` | exact match, `nth` | Add `regex` on Selector, reusing the TextMatch shape |
| `below/above/leftOf/rightOf`, `childOf`, `containsChild` | `near`, `within` | Enough for v1; add `below` / `above` only if generated tests need them |
| `copyTextFrom` + `${maestro.copiedText}` | none | Add `remember: {name, from: Target \| {regex}}` and `${name}` for later assertions (booking numbers etc.) |
| `launchApp {clearState, clearKeychain, permissions, arguments, stopApp:false}` | `launch.reset` | Add `permissions`, `arguments`, and the keychain behaviour (§6.1 #1, #5) |
| `setLocation` / `travel` | none | Worth adding for an airport app [INFERENCE] (`simctl location set` / Appium geo) |
| `takeScreenshot`, `assertScreenshot` (threshold %, cropOn) | `capture` | Visual diff is optional; per-step screenshots already exist |
| `runScript` / `evalScript` (`http`, `faker`) for backend setup | none (JSONLogic `checkEach` only) | Keep scripting out of v1; add an explicit `http` setup hook only if needed |
| `assertWithAI` / `extractTextWithAI` | `claim` (Jev), `which` | Ours is safer; no change |

### 6.4 License
- Maestro is **Apache-2.0** (`LICENSE`; file headers say "Copyright (c) 2022 mobile.dev inc."). Porting ideas or algorithms into TypeScript is permitted. If we translate substantial logic (e.g. `refreshElementUntilStable`, `childOfDebugMessage`), keep an attribution comment and a NOTICE entry.
- The iOS runner's ObjC categories (e.g. `XCAXClient_iOS+FBSnapshotReqParams.m`) keep **Facebook WebDriverAgent BSD** headers; attribution applies if reused.
- **Not open:** Maestro Studio Desktop (freeware), Maestro Cloud, and the AI endpoints (`api.copilot.mobile.dev`, which needs `MAESTRO_CLOUD_API_KEY`). Their prompts and models are server-side and cannot be audited.