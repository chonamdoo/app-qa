# google/artemis

**Source read:** HEAD `371aa6df56880643da57b30da936e9812fb0ec66` (2026-09), fetched through raw.githubusercontent.com and the jsDelivr flat file list pinned to that SHA. Warning: jsDelivr `@main` returned a stale tree without `packages/artemis-accessibility-helper`, `runtime/helper_manager.py` or `cli/commands/helper.py`; pin by SHA.
**License:** Apache-2.0. Some files, e.g. `clients/ui_automator_client.py` and `controllers/unified_controller.py`, are marked "derived from mobile-use, Copyright Minitap, Inc., Apache-2.0", so keep NOTICE attribution if copying.
**Scope:** Android only. `drivers/factory.py` builds only `AndroidAdbDriver` or `MockDeviceDriver` (plus a cloud path whose code is not in the repo). `drivers/types.py` has `platform: Literal["android","ios",...]`, but there is no iOS driver, no WDA, idb or simctl code. iOS is only a README roadmap item. There is **no TypeSafe/Jev usage**; all judgment runs through LangChain chat models, Gemini by default.

---

## 1. Observation (device layer)

### 1.1 Backends (`artemis/clients/screen_client_factory.py`)
- `ARTEMIS_HIERARCHY_BACKEND` = `auto` (default) | `helper` | `uiautomator`.
- `FallbackScreenClient`: try the helper first. On `RuntimeError/OSError/ValueError/SubprocessError`, check `adb -s <serial> get-state`; if it is not `device`, raise `DeviceOfflineError` and do not fall back. Otherwise serve from UIAutomator2 for `retry_after=30.0` s, then stop the u2 server (`device.stop_uiautomator()`) before retrying the helper, because a live UiAutomation connection makes Android unbind every accessibility service. Every backend switch is recorded in `backend_history` and reported ("UI hierarchy source: … switched to UIAutomator2 at T+.. because …").

### 1.2 Artemis Accessibility Helper (on-device APK, `packages/artemis-accessibility-helper/`)
- **Package and service:** `com.artemis.helper/.ArtemisAccessibilityService`. The bundled APK is `ArtemisAccessibilityHelper.apk` (~37 KB), Java source included.
- **Provisioning** (`artemis/runtime/helper_manager.py`):
  - `adb install -r -g <apk>`
  - `settings put secure enabled_accessibility_services <existing>:com.artemis.helper/.ArtemisAccessibilityService`
  - `settings put secure accessibility_enabled 1`
  - Re-read after a settle delay, because AccessibilityManager may prune the entry right after install.
  - Revive a dead service by removing it from the enabled list, waiting, and re-adding it.
  - Auto-install is on by default (`ARTEMIS_HELPER_AUTO_INSTALL`).
  - A cross-process file mutex serializes installs per serial.
- **Tunnel:** `adb -s S forward --no-rebind tcp:0 tcp:18888`. The host port is allocated by adb and existing forwards for the same serial are reused. The `transport_id` from `adb devices -l` is tracked so a replug rebuilds the tunnel.
- **Auth:** a per-host token (`secrets.token_hex(24)`, file mode 0600 in the temp dir) delivered by `am broadcast -n com.artemis.helper/.TokenReceiver -a com.artemis.helper.SET_TOKEN --es token <t>`. The receiver requires `WRITE_SECURE_SETTINGS`, so only the adb shell user can send it. Every endpoint except `/ping` requires the `X-Artemis-Token` header (or a `token` query parameter or JSON field). On HTTP 401 the host pushes the token again and retries once.
- **Endpoints** (`CommandServer.java`, bound to 127.0.0.1:18888, HTTP or line-delimited JSON-RPC, body limit 4 MB, UTF-8 read as bytes):
  - `/ping`: version_code, protocol_version (the host needs ≥2), token_set, and package/activity when authenticated.
  - `/snapshot?fields=xml[,elements,tree]&include_invisible=1`
  - `/dump`, `/dump_xml`
  - `/action` with `{cmd: tap|double_tap|long_press|swipe|type|clear|clipboard|global, ...}`
- **HierarchyDumper.java:**
  - Root discovery in three tiers:
    1. `getWindows()` sorted by layer, highest first, deduped by root hash; covers app, dialog, IME, system and split-screen windows.
    2. `getRootInActiveWindow()` if no app window was found.
    3. Walk up from the focused input or accessibility node to its root.
  - Retry backoff `[40,80,120,160,220,300]` ms when no windows are found (cold start or transition).
  - Uses `FLAG_PREFETCH_DESCENDANTS_HYBRID` on API 33+.
  - Children with `isVisibleToUser()==false` are skipped (roots are kept). Bounds are intersected with display ∩ window ∩ scrollable-ancestor bounds, matching UIAutomator's `trimScrollableParent`.
  - Extra semantics: `editable`, `errorText` (getError), `hint` (and `text=""` when `isShowingHintText`), `drawingOrder`, `isHeading`, `paneTitle`, `tooltip`, `screenReaderFocusable`, `stateDescription` (API 30+, Compose).
  - Limits: `MAX_NODES=8000`, `MAX_DEPTH=75`; `truncated` is reported.
  - Output is XML in UIAutomator format with strict XML 1.0 character sanitizing.
  - **Atomic snapshot:** on API 30+, `takeScreenshot(DEFAULT_DISPLAY)` runs in parallel with the dump. Rate-limit error code 3 triggers one retry after 350 ms, with a 2500 ms latch. The result is JPEG q80 base64, and `width/height` are the bitmap's own dimensions. Below Android 11, `has_screenshot=false` and the host adds `adb exec-out screencap -p`.
- **Why:** the helper never takes the single UiAutomation connection, so it can run alongside Appium, Espresso and Mobly and has no `waitForIdle` hangs.

### 1.3 UIAutomator2 fallback (`clients/ui_automator_client.py`)
- `u2.connect(serial)` with 3 attempts and 1 s×n backoff. **Side effect:** first uninstalls Maestro (`pm uninstall --user 0 dev.mobile.maestro`) if it is present.
- `device.dump_hierarchy(compressed=True)`; screenshot via `adb exec-out screencap -p`, falling back to `u2.screenshot()`; images sent as JPEG q80.
- Flat element parse (`_parse_hierarchy_xml_to_elements`): keeps every attribute, adds `parsed_bounds {left,top,right,bottom}`, and copies `content-desc` into `accessibilityText`. **The list is flat; there is no `children` key.**

### 1.4 Driver (`drivers/android/adb_driver.py:get_screen_data`)
- `await asyncio.sleep(0.3)` unless `skip_settling`, then the screen client's `get_screen_data()`, then `filter_ui_hierarchy(...)`.
- **Pitfall:** if both screenshot paths fail, it returns a hard-coded **1×1 transparent PNG** with default 1080×2400 dimensions instead of raising ("fallback for headless testing"). This fails open.

### 1.5 Settle and idle handling
- Only fixed sleeps: 0.3 s (driver), `observe(settle_ms=400)` (`mcp/observation.py`), 0.4 s in `graph/perception.py`. Settling is skipped after `wait_for_delay`.
- Nothing checks for idle or animation. The prompts tell the model to call `wait_for_delay` for spinners and transitions.
- `wait_for_text` (in `mcp/actuators/adb.py`: poll the tree every 0.5 s, default 5 s timeout, substring match against `str(tree)`) exists but `action_manifest.py` says it has **never had a tool declaration**, so no model can call it.
- `config/artemis.jsonc` notes a dHash "similarity hint" calibrated on 460 device steps: **same screen ≤4, different screens ≥7**, `similarity_max_distance: 5`. These numbers can be reused for our settle detector.

### 1.6 OCR (`utils/ocr_api.py`, `utils/ocr_xml_fusion.py`)
- Google Cloud Vision `images:annotate` `TEXT_DETECTION` with an API key (`OCR_API_KEY`/`VISION_API_KEY`); optional.
- The status bar is cropped first (height taken from the tree or 4% of the screen) and coordinates are mapped back.
- Fusion: an OCR word box attaches to the smallest tree node that contains it (overlap relative to the OCR box ≥0.9 is band 1, ≥0.7 band 2). Non-text containers over 10% of the screen are excluded. OCR boxes whose text is >0.8 similar to the node text are dropped.

### 1.7 Video, live mirror and logcat
- **Recording** (`utils/video.py`, `controllers/unified_controller.py`): `scrcpy -s S --no-window --record out.mkv --record-format mkv --video-bit-rate <br>`. It is stopped with SIGINT (CTRL_BREAK on Windows) so the recorder flushes, then `ffmpeg -y -i mkv -c copy -movflags +faststart mp4`. `DEFAULT_MAX_DURATION_SECONDS=900`, segments of 1800 s. A `video_analyzer` sub-agent answers questions about time ranges on the session clock (`T+mm:ss`).
- **Live console view** (`apps/admin_console/services/device_stream_service.py`): **not scrcpy**; it polls `adb exec-out screencap -p` about every 80 ms and serves PNG frames as multipart MJPEG at `/api/stream/device-live`. **Bug:** it streams the first `device` line from `adb devices`, not the device the task is using.
- **Logcat** (`tools/mobile/log_utils.py`): on demand only, `logcat -v threadtime -t "MM-DD HH:MM:SS.ms"` or `-t <lines>` (default 200 in the tool). Output is filtered by parsing the first 18 characters as a timestamp. Relative seconds are converted using the session start. Tools: `read_logs`, `search_logs`, and a `log_analyzer` agent that can use search grounding.

### 1.8 Keeping the device awake (`runtime/awake_service.py`)
`pkill -f screenrecord`; `am broadcast -a android.intent.action.CLOSE_SYSTEM_DIALOGS`; `svc power stayon usb`; `input keyevent KEYCODE_WAKEUP`; `wm dismiss-keyguard`; verified with `settings get global stay_on_while_plugged_in` and `dumpsys power`. Heartbeat fallback: `input keyevent KEYCODE_UNKNOWN` sent periodically.

---

## 2. Normalization (raw tree → candidates)

### 2.1 `utils/ui_filter.py:filter_ui_hierarchy`
- **Bounds:** parses the `[x1,y1][x2,y2]` string, `{left,top,right,bottom}`, `{x,y,width,height}`, or a cached `parsed_bounds`.
- **Clipping:** clips to ancestor bounds (the screen for a flat list). Fully clipped nodes become a point with `is_clipped=True` and are kept.
- **Minimum size:** `max(5, 0.5% of the short side)`; width and height must both exceed it.
- **Dropping empty nodes:** a node is empty if it has no text, no content description, is neither clickable nor focusable, and its class does not contain image/icon/photo. Default mode `hoist` drops the node and promotes its children.
- **Fixed system bars** (`_detect_fixed_system_bars`):
  - Spans ≥95% of the width, touches top or bottom, with no scrollable node inside it or above it.
  - Identified either by id or class keywords (`bottom_navigation`, `navigation_bar`, `bottom_bar`, `tab_layout`, `action_bar`), by package `com.android.systemui`, or by height (bottom bar 25 px to 15% of height; top bar 15 px to 12%).
  - Other nodes are clamped vertically against these bars; leftover slivers ≤ max(min_size, 20) px are dropped.
- **Code-reading finding:** strategy 2 (`_merge_complementary_children`, which merges an icon and text under a clickable parent with an "[Icon]" label) and strategy 3 (`_prune_parent_child_redundancy`) only run on nodes that have `children`. The Android path always passes a **flat** list (see 1.3; `normalize_helper_elements` also removes `children`), so these strategies never run there.

### 2.2 Element list shown to the model (`utils/visualization.py:format_minimal_list_with_elements`)
- Iterates the fused list in document order. For each node, every attached OCR box becomes `[i] OCR Text: '…' | Bounds: [l,t][r,b]`. Otherwise, if the node has `text`, `content-desc` or `hint`, it becomes `[i] Text|Hint: '…' | Bounds: …`, with `| Error: '…'` when the helper reported an error.
- Bounds are normalized to **0–1000** per axis using the screenshot's width and height.
- **Dedup:** same text with centers within 8 px.
- **Overlap warning:** pairs with intersection ≥50% of either box, excluding concentric parent/child pairs (one box inside the other, the outer ≥2× the area, centers within 20% of the largest dimension), get `(WARNING: may overlap with [j] and [k], possible occlusion)`.
- The returned element records are `{index, center:[cx,cy] px, text, bounds:[l,t,r,b] px, class, resource_id, is_ocr, is_hint?, error?}`.
- **Important limitation:** nodes with no label (icon-only `ImageButton` without a content description, custom-drawn Canvas/Flutter content) get **no index at all**. The agent must use `ask_explorer` (visual grounding) or raw coordinates.

### 2.3 Explorer index (`agents/explorer/screen_index.py`)
- `ScreenElement(text, bounds, source xml|ocr, class, resource_id, interactive)`. Interactive means any of clickable, scrollable, long-clickable, checkable, focusable, editable or selected.
- Dedup key is (normalized text, bounds); unlabeled nodes are skipped.
- `search_text`: `SequenceMatcher` ratio, with substring matches scored at least 0.85 when the query has ≥3 characters; threshold 0.6, limit 8.
- `exact_matches` prefers the tree source and collapses matches overlapping ≥0.5.
- `elements_at(x,y)`: innermost tree node first, stopping at the first interactive one (at most 2), then OCR boxes.

### 2.4 Visual fallback (Explorer tiers, `agents/explorer/tiers.py`)
- `flash`: one-shot `object_detector`. `pro`: 3-turn loop with `ask_perception_tool`. `ultra`: 8-turn loop with detect_objects, get_ocr_list, inspect_region and ask_image_processor, plus Gemini context caching.
- The object detector (`agents/object_detector/object_detector.json`) **requires a Gemini Robotics-ER model** (`gemini-robotics-er-2-preview`). Its output is `[{"point": [y, x] (0–1000), "label": …}]`. Note the **[y, x]** order.
- Candidates it finds are appended to `state.indexed_elements`, so they can then be addressed by index.

---

## 3. Judgment layer (the part Jev would fill)

Artemis does not call Jev. Mapping each LLM decision to our design:

| Artemis decision | Where | Output shape | Gate |
|---|---|---|---|
| Next action | FlashRunner / Operator tool calls | tool name plus args (`target` = index or `[x,y]` 0–1000 plus `target_description`) | none (tool-call validity only) |
| Pixel pre-action check | `agents/validator/pixel_safety_net.md` | `{"reasoning","is_present":bool,"confidence":float}` | block only if `!is_present && confidence>=0.7`; **otherwise let the action through (fail-open)** |
| Checkpoint/final verdict | `agents/checker/checker.py` `CheckReport` | `verdicts:[{item_text, kind: verify|assert, status: passed|failed|inconclusive, evidence, suggestion}], unmet_subgoals:[]` | computed in code: release if every `verify` is passed or inconclusive; failed asserts never block release |
| Plan-change review | planner validation | status/feedback | advisory only (never rolled back) |

A Jev translation would be: pixel check → Choice {present, absent, uncertain} with a probability gate. Checker → Choice {passed, failed} plus Noul for the "inconclusive/evidence missing" case, with **fail-closed** thresholds instead of Artemis's fail-open ones.

### 3.1 Model providers (`llm/router.py`, `services/llm.py`, `config/artemis.jsonc`)
- `ModelProvider`: google (gemini), vertexai, openai, anthropic, openrouter, xai, ollama, vllm, custom.
- One model per agent role (planner, operator, validator, validator_pixel_safety_net, checker, explorer, object_detector, hopper, summarizer, outputter, log_analyzer, diagnoser_expert, video_analyzer, …), each with an optional `fallback`.
- Defaults: `gemini-3.8-flash` with thinking_level medium, fallback `gemini-3.7-flash`. Step summarizer and pixel check use `gemini-3.5-flash-lite`. Object detector uses `gemini-robotics-er-2-preview`.
- `with_fallback()` switches to the fallback model only for failure types where another endpoint could help (not for bad requests) and logs an `llm_fallback` event. A shared circuit breaker is keyed by provider:model. When retries run out and no fallback exists, the task **pauses** (bounded by `LLM_PAUSE_TIMEOUT_SECONDS`).
- `invoke_llm_with_timeout_message` shows a soft countdown at 10 s and enforces a **hard 180 s timeout**. Default request timeout is 60 s and temperature 0.0.
- Structured output: `acomplete_structured` handles code fences and JSON repair and re-asks once on unparseable JSON. Failed parses are stored in the `failed_outputs` table.
- If the model returns no native tool call but a ```json block, FlashRunner parses `{name, args}` from the text.

### 3.2 How prompts are built
- **Flash** (`agents/flash/flash_runner.md`, Jinja): role and objective; reasoning protocol (one prose paragraph per turn; milestones on turn 1); time awareness (3–7 s turn latency; short-lived UI → `click_sequence` with 50 ms gaps); history reading (`# CURRENT OBSERVATION [T+mm:ss]`, `--- Historical Visual Transition ---`, `[Era N | Steps a–b | …]`); loop prevention (the same action twice with no change means stop and rethink); action rules (1. prefer the index, 2. otherwise 0–1000 coordinates plus `target_description`, 3. never guess coordinates → `ask_explorer`, 4. `manage_app` to launch); stop rule (`report_task_status(completed)` only after visually confirming; `failed` with the exact blocking reason).
- **Each turn's observation tail:** header, `--- Current Screenshot ---` plus an image block (JPEG data URL), then `--- Visible UI Elements ---` plus the element list, then one-turn notices.
- **Operator** (`agents/operator/operator.json`): explained in the Pro section below. Key rules: the screenshot is the source of truth and the element list is only a lookup table; tools are split into pre-decision tools and turn-ending actions (at most one vetted action or a burst of 2–`max_burst_actions` (4)); `OPERATOR_MAX_TOOL_ITERATIONS=20` tool calls per turn; plan-ledger rules (bounce the action once if the ledger has no change for `plan_ledger_stale_turns`=4 turns).

---

## 4. Action execution

### 4.1 Coordinates
- The model always works in **0–1000 normalized** coordinates. Index targets resolve to the element's pixel center, then back to 0–1000 (`mcp/action_executor.py:_resolve_index`).
- On the wire (`mcp/actuators/adb.py:_to_px`): `x = clamp(int(nx*width/1000), 0, width-1)`, where the dimensions come from the latest screenshot (`ctx.device.device_width/height`).
- **Per-turn index snapshot:** all indices in one turn resolve against the list the model saw, even after earlier actions in that turn change the screen (`FlashRunner._turn_index_snapshot`).
- `click_sequence` accepts only coordinate pairs, never indices, and needs one `target_descriptions` entry per point.
- **Pitfall:** `utils/visualization.py:_resolve_coordinates` guesses the coordinate space: 0–1 means fractions; ≤1000 on a device larger than 1000 px means normalized; anything else means pixels. A pixel point ≤1000 would be misread as normalized. Keep an explicit coordinate-space marker, as the action records do (`COORDINATE_SPACE_KEY`).

### 4.2 Commands (`drivers/android/adb_driver.py`, all through adbutils `device.shell`)
- **Tap:** `input tap X Y`. Repeated taps: `input tap X Y && sleep 0.100 && input tap X Y`. **Long press:** `input swipe X Y X Y <ms>` (when ≥500 ms). The helper's `dispatchGesture` tap exists but the driver does not use it.
- **Swipe:** `input swipe x1 y1 x2 y2 <ms>` (default 800 ms). Directional swipes use x = 60% of width (avoids edge gestures and alphabet side bars): up is y 0.7→0.3 (about 50–60% overlap; 800 ms avoids a fling), down is 0.3→0.7, left/right is 0.75↔0.25 of width at mid-height.
- **Keys:** `input keyevent N` (home 3, back 4, enter 66, delete 67, power 26, app_switch 187, volume 24/25). The helper maps back/home/recents/notifications/quick_settings to `performGlobalAction`.
- **Launch:** `monkey -p <pkg> -c android.intent.category.LAUNCHER 1`. `launch_app_with_retries` makes 3 attempts: force-stop, launch, sleep 1 s, then poll up to 15 s until the focused window's package is the target, or `dumpsys activity activities` shows the resumed task's affinity belongs to the target (so the app's own permission or account-picker screens still count as foreground).
- **Stop:** `am force-stop`. **Open link:** `am start -a android.intent.action.VIEW -d '<url>'`.
- **Current package:** adbutils `current_app`, else `dumpsys window displays | grep -E 'mCurrentFocus|mFocusedApp'`.

### 4.3 Text input, including Korean/Unicode
Order in `AndroidAdbDriver.input_text`:
1. **Clear:** `input keyevent 123` (MOVE_END) && `input keyevent --meta 1 122` (shift+MOVE_HOME selects) && `input keyevent 67` && 20× `67`. `UnifiedMobileController.erase_text` instead uses `input keycombination 113 29` (Ctrl+A) and falls back to 30 DELs only on a Python exception. [INFERENCE] `input keycombination` does not exist on older Android versions, and a shell error does not raise, so the fallback may never run.
2. **Step 1 (all scripts, multiline): clipboard plus paste.** `screen_client.set_clipboard(text)`: via the helper (`ClipboardManager.setPrimaryClip(ClipData.newPlainText("artemis", text))` on the main thread; clipboard writes are allowed from any app on every API level) or via u2 `device.set_clipboard`. Then `input keyevent 279` (KEYCODE_PASTE). **This is how Korean text goes in.** Literal `\n` sequences are first turned into real newlines.
3. **Step 2:** if `settings get secure default_input_method` contains `adbkeyboard`: `am broadcast -a ADB_INPUT_B64 --es msg '<base64 utf-8>'`.
4. **Step 3:** per line, `input text <escaped>` (escapes `\ " ' \` $ & | ; < > ( ) * ? ~` and turns spaces into `%s`), with `input keyevent 66` between lines. ASCII only.
- Other paths: the helper's `type` command uses `ACTION_SET_TEXT` on the focused or first editable node (append mode keeps existing text unless the hint is showing). The older `drivers/android/input_ime.py` uses u2 FastInputIME `send_keys` for non-ASCII.
- **Weakness:** success is reported as soon as the paste keyevent is dispatched. Nothing checks that the field now contains the text. The user's clipboard is overwritten. [INFERENCE] Paste may be blocked in password or secure fields.
- `input_text` with a target first taps it (unless the smallest focusable/clickable/EditText at that point is already `focused=="true"`) and then **sleeps 1.0 s** for the keyboard.

---

## 5. Agent loop: Flash vs Pro

### 5.1 Flash (`agents/flash/runner.py`)
- One model, observe → think → act. Tools: the validator action set (without note readers), `click_sequence`, `ask_explorer`, history tools (`search_history`, `replay_steps`, `get_step_screenshot`), `video_analyzer` (when recording is on), and `report_task_status`.
- `max_turns` comes from `agent.flash.max_turns` = **0 (unlimited)**. With a bound, the last turn only offers `report_task_status`. A turn with no tool call adds a one-turn notice (`_NO_TOOL_CALL_NOTICE`). No response at all ends the loop as failed.
- Tool calls execute one after another. After each action an observation is taken (`observe`), and a step is written to SQLite with before/after screenshots.
- **Background step summarizer** (`agents/flash/summarizer.py`, `flash_summarizer*.md`, gemini-3.5-flash-lite, concurrency 2, 3 retries, 30 s flush). It writes an objective first-person paragraph of 60–100 words; words like "successfully/completed/failed/navigated to…" are banned so the history does not claim success.
- **Transcript ledger** (`memory/transcript.py`, shared with Pro):
  - The system prefix stays byte-stable for prompt caching.
  - Element lists are removed from older turns once a newer observation exists (`xml_scrub_depth=1`), so an old index can never be used as a target.
  - Screenshots are replaced by their summary after 3 turns (6 while context use is below `start_ratio=0.35`).
  - `context_budget_tokens=80000` with ratios 0.35/0.7/0.9.
  - Older steps are compressed into chunks (`memory/chunking.py`: max 12 steps, min 3, 2000 source tokens, max 8 chunks) and folded into "eras" that can be recalled with `search_history` and `replay_steps`.
- **Pass/fail:** the model's own `report_task_status(status=completed|failed, …)`. No deterministic post-condition. The SDK client counts `status in {completed, success}` as success (`packages/artemis-client/.../models.py`).

### 5.2 Pro (`graph/graph.py`, LangGraph)
- **Nodes:** `planner` → `convergence` (deferred) → gate: `continue` goes to `perception` → `operator` → `execution_check` → (`execute_decisions`) `validator` → `summarizer` → `convergence`; `exit_settlement` → `END`, or back into the loop.
- **Budget:** graph `recursion_limit` = `RECURSION_LIMIT=30000` (in effect unbounded). Termination is decided from the plan (`convergence_gate`): all top-level items `[x]` ends the run unless a `[Loop:continuous]` item exists without an explicit `release_loop` signal; an `assert_halt` latch sends it to settlement.
- **Planner** writes `notes/task_plan.md`. Grammar (`utils/plan_grammar.py`):
  - Status markers: `- [ ]` pending, `[/]` active, `[x]` done, `[!]` blocked.
  - Nested items (2/4 spaces) are the Operator's working ledger.
  - Check lines: `- verify: <criterion>`, `- assert: <expectation>`, `- assert@end: <expectation>`.
  - Loop tags: `[Loop] <Goal> into note <N> (Exit: …; Interval: …)`, `[Loop:continuous] …`.
  - `- finding:` lines are written by the system only.
  - Code only ever branches on this checkbox syntax, never on the free text.
- **Checking targets before individual actions** (`agents/validator/execution_loop.py`):
  - *One turn-ending action, vetted:* first the tree check (`precondition_xml.py`: fetch the live tree with a 1.0 s timeout, bypassing to the pixel check on timeout or empty tree; up to 3 tries 0.4 s apart), then the pixel check if the tree check fails or is bypassed (`precondition_pixel.py`). The action then runs with **2 local tries** (1 for launch_app), 0.5 s apart.
  - *Burst (2–4 actions):* no checks, one try each, stops at the first failure; the Operator takes the risk.
  - **Tree scoring:** weights `W_ID=0.5, W_TEXT=0.4, W_BOUNDS=0.3 (IoU), W_COORD=0.3 (the original point lies inside)`. A mismatched resource id scores −0.5×W_ID; a missing id +0.3×W_ID. Text similarity: exact 1.0, substring 0.8, else SequenceMatcher. A size ratio >2.5 in either axis flags a size mismatch. `scale = diag(screen)/diag(1080×2400)`. Pass at `score ≥ 0.55` if distance ≤150·scale, else ≥0.75. The coordinates are corrected to the new center if distance ≤200·scale. An identity match needs identity ≥0.85, or ≥0.5 with an id match (distance allowance 300·scale for id matches). Failures are classified as `TARGET_SHIFTED`, `TARGET_OCCUPIED` (something else is at the point) or `TARGET_DISAPPEARED`.
  - **Pixel check:** before and after screenshots, each marked with a red dot of radius 15, sent to a small model with the rules in `pixel_safety_net.md`: specific control vs described target vs coordinates only vs surface; for surfaces, ignore natural frame changes.
- **Blocked actions and recovery** (`agents/validator/incidents.py`): a blocked or failed action opens an `ExecutionIncident{kind: safety_net|exec_error, category, reason, action, action_description, action_index, burst_size, step_number, consecutive_failures, evidence}`. It is shown as `--- Execution Incident (OPEN) ---` until a later action goes through without error. There is no separate repair agent; the Operator decides, and a verbatim retry is discouraged unless the target is visibly still there.
- **Checker** (read-only; tools are history replay, screenshots and probes):
  - `verification_level` presets (`config/agent.py`): `off`; `final` (default: exit review only); `checkpoints` (midway plus final); `strict` (assert failure halts, `checkpoint_max_repairs=4`, `final_check_max_attempts=5`, `max_iterations=30`).
  - Defaults: `max_iterations=20`, `final_check_max_attempts=3`, `checkpoint_max_repairs=2`, `max_concurrent_checkpoints=3`, `checkpoint_timeout=180 s`, `settlement_timeout=120 s`.
  - A failed `verify` reopens its milestone (up to the repair budget). A failed `assert` is recorded as a device defect and never repaired.
- **Outputter** (optional): writes `notes/output.md` when `expected_output_desc` is given.
- **Timing** (README and `rules.md`): Flash about 3–5 s per step; Pro about 15–40 s per turn.

---

## 6. Verification, outcomes and failure handling
- **Verdict rules** (`checker.json`): quote each item verbatim; every verdict needs concrete evidence; `failed` without evidence is **downgraded to inconclusive** (`_normalize_report`); items without a verdict become `inconclusive`. **Before failing an assert, confirm from history that the triggering action really ran**; otherwise `inconclusive` ("do not blame the device for an execution problem"). Transient expectations (toasts) must be judged from recorded history near the anchor step, not the live screen. `@end` items use the final state. `on_complete` items use the ledger (an assert that ever failed stays failed).
- **Read-only probes** (`checker.py:PROBES`), built as argv lists, never shell strings:
  - `alarms` → `dumpsys alarm`; `battery` → `dumpsys battery`; `foreground` → `dumpsys activity activities`; `notifications` → `dumpsys notification`; `packages` → `pm list packages`
  - `setting` → `settings get <system|secure|global> <key ^[A-Za-z0-9._-]+$>`
  - `content` → `content query --uri <^content://[A-Za-z0-9./_-]+$>`
  - `prop` → `getprop <key>`
  - Output is truncated at `_PROBE_OUTPUT_LIMIT`.
- **Outcome files** (`graph/checkpoints.py`): `check_ledger.jsonl` (one record per attempt) and `run_outcome.json` = `{task_status: completed|partial|blocked, tests: {passed, failed, inconclusive, unchecked, retired, failed_items:[{item_text, kind, evidence}]}}`. Assert failures never change `task_status`.
- **What fails open (avoid):**
  - Pixel check bypasses on errors, prompt or model setup failure, or `confidence<0.7`.
  - The release decision is "fail-open on errors" by design (checker.json).
  - Driver returns a fake 1×1 screenshot; screen size defaults to 1080×2400.
  - `wait_for_text` matches substrings of `str(tree)`, so it can match attribute values, not just visible text.
- **Retries and loop limits:** tree check 3 tries; pixel check `_MAX_ATTEMPTS` with a delay; action 2 tries; app launch 3×15 s; UIAutomator2 connect 3 tries; helper request one repair; LLM retries per failure type, then the fallback model or a pause. Loops are otherwise only limited by prompt rules (a third identical action → `ask_diagnoser`) and by user injection or stop.
- **Batch** (`interfaces/cli/commands/batch.py`): the local path marks a goal `SUCCESS` unless `agent.run_task` throws. [INFERENCE] It may report SUCCESS for runs where the agent reported failed. The daemon path does check `status in (completed, success)`.

---

## 7. Test/spec format, traces, reports
- **Spec:** a natural-language goal (`artemis run "…" --profile flash|pro`; `artemis batch -f goals.txt|goals.json` with one goal per line or a JSON array). Pro verify/assert lines are generated by the Planner from the goal; there is no user YAML DSL. The SDK: `ArtemisClient(url, device_serial, default_profile).run(goal)` returns `TaskResult{task_id, status, goal, profile, device_serial, output, error, turns}`.
- **Traces:** `traces/data_engine.db` (SQLite, WAL mode, `data_engine/storage.py`):
  - `sessions(session_id PK, initial_goal, start_time, end_time, status, device_info JSON, video_filepath)`
  - `images(image_name PK = sha256(screenshot), timestamp, ocr_result, ui_tree, extra_metadata)`
  - `steps(step_id PK, session_id, step_number, timestamp, pre_image_name, post_image_name, summary, action_taken JSON, operator_raw_thinking, operator_native_thinking, last_execution_result JSON, extra_metadata JSON)`
  - `traces(trace_id PK, session_id, step_id, parent_trace_id, type [agent|llm_call|action|…], name, timestamp, duration, status, payload JSON)`
  - `failed_outputs(id, session_id, trace_id, model_name, prompt, raw_output, error_message, timestamp)`
  - `background_tasks(task_id, session_id, summary, status, start/end, trace_id, logs)`
  - `history_chunks(chunk_id, session_id, start/end step ids and numbers, source_step_ids, subgoal_hash, version, status, band1..3, rendered_text, created_at)`
  - `video_recordings(video_id, session_id, device_id, start/end, local_video_path, status, error)`
  - plus `video_analysis_*` tables
- **Action record** (in Flash): `{action, coordinates, coordinate_space: normalized, args, normalized_coordinates, normalized_start/end_coordinates, target_text/target_bounds/target_resource_id (index targets) | target_description (coordinate targets)}`. `last_execution_result = {status: dispatched|failed, result, error?}`. "Dispatched" means only that the device accepted the command.
- **Per-trace directory** (`runtime/trace_store.py`): `traces/<trace_id>/status.json` `{trace_id, task_desc, model, conversation_id, status: running|completed|failed|cancelled, device_serial, start_time, end_time, error, result, pid}` written atomically (temp file, fsync, replace, with a cross-process lock), plus `stdout.log`, `stderr.log`, `notes/` (task_plan.md, output.md), `injected_instruction.json` (mid-run guidance, read and deleted each turn).
- **Action overlay screenshots:** before-screenshot with a red circle for taps (`mobile_inspect_trace view_step_screenshots`).

---

## 8. MCP tool surface (`mcp_server/`, FastMCP, stdio or sse; `python -m mcp_server`)
- `mobile_run_task(task_desc: str, conversation_id: str|None, model: "Flash"|"Pro"="Flash", locked_app_package: str|None, app_path: str|None, expected_output_desc: str|None (Pro), device_serial: str|None, verification_level: off|final|checkpoints|strict|None (Pro), explorer_mode: flash|pro|ultra|None (Pro))` returns immediately with `{trace_id, status: running|failed|unknown, message, notes_dir, stdout_log, stderr_log}`. The device serial must be attached and authorized. The job goes to the background service (FastAPI :8000) unless `ARTEMIS_STANDALONE=1`. When the service is running, it refuses to start a standalone runner (avoids two runners on one device). If enqueueing is unconfirmed it returns `unknown` rather than risk a duplicate submit. The docstring requires the calling IDE agent to poll at least every 1 min.
- `mobile_manage_task(action: "status"|"inject_instruction"|"stop", trace_id, instruction: str|None, release_loop: bool=False)`. Status returns `{trace_id, status, device_serial, task_desc, model, elapsed_seconds, test_summary, progress}`. Only `release_loop=True` ends a continuous loop; wording like "please stop" does not.
- `mobile_get_device_state(view_type: "screenshot"|"hierarchy", device_serial)` returns a `file://…/live_screenshot_<serial>.jpg` or the exact element list the agent sees.
- `mobile_inspect_trace(action: view_summary|search|view_step_screenshots|view_step_details, trace_id, step_number, query, step_range: [start,end], max_results=5)` reads from SQLite.
- `mobile_diagnose(attempt_fix=False, device_serial, launch_avd, verify_credentials=False (~12 s), probe_device=False (~20 s))` returns `{verdict: ready|degraded|blocked, summary, next_steps (`Run:` / `Guidance:` / `Docs:` lines in dependency order), checks, credentials, device_probe, tasks{active, queued}, logs.last_failed_task{trace_id, stderr_log, recent_errors}}`. Diagnosis has a 40 s timeout. `attempt_fix` regenerates corrupt ADB RSA keys, restarts the ADB server when safe, and clears stale locks and queue tickets.
- **Notifiers** (`mcp_server/notifiers/`): Antigravity AgentAPI wake-up, desktop toast (osascript, notify-send, powershell), webhook (`ARTEMIS_WEBHOOK_URL`…), script hook (`ARTEMIS_NOTIFY_CMD`), `notifications.jsonl`.

## 9. Admin console (FastAPI, `apps/admin_console/server.py`, default :8000, same-origin middleware against DNS rebinding, lifecycle token)
- **tasks.py:** `GET /api/tasks/presets`, `GET /api/tasks/catalog`, `POST /api/run`, `GET /api/run/defaults`, `GET /api/devices`, `POST /api/stop`, `POST /api/resume`, `GET /api/status`, `GET /api/stream[/{session_id}]` (SSE event stream).
- **sessions.py:** `GET /api/sessions`, `GET /api/sessions/{id}`, `/usage`, `/tree`, `/background_tasks`, `/startup_progress`, `POST /api/cleanup`, `POST /api/sessions/{id}/delete`.
- **steps.py:** `GET /api/sessions/{id}/steps`, `GET /api/steps/{step_id}/traces`, `GET /api/traces/{trace_id}[/download]`.
- **replay.py** (re-runs an `ask_explorer` step in a sandbox): `GET /api/replay/tools`, `/api/replay/config`, `/api/sessions/{id}/replay_steps`, `POST /api/sessions/{id}/steps/{n}/replay`, `GET …/replay_traces`.
- **stream.py:** `GET /api/stream/device-live` (MJPEG), `/api/stream/device-state`.
- **system.py:** `/readiness`, `/devices/select`, `/adb/restart`, `/adb/heal-keys`, `/adb/connect` (Wi-Fi), `/adb/server*`, `/emulator/launch|status|stop|dismiss`, `/credentials[/test]`, `/model-config-env`, `/server-status`, `/restart`, `/shutdown`.
- **Task queue:** `services/task_queue_service.py` (70 KB) spawns worker processes; device selection comes from `runtime/device_pool.py`. `runtime/device_lock.py`:
  - Per-device lock file `artemis-device-<serial>.lock` created with `O_CREAT|O_EXCL`; FIFO tickets `<time_ns>-<token>.wait` in `artemis-global-device.queue/`.
  - Owner records hold the PID and process creation time, so reused PIDs cannot keep a stale lock alive.
  - Concurrency mode: 0 = per device, 1 = global serial, N = global cap.
  - Tickets for "any device" are parked on a single idle device rather than blocking every device's queue.

---

## 10. rules.md, "Mobile Testing Mindset (ARTEMIS Integration)" (`mcp_server/rules.md`)
1. **Runnable Code Principle and exploration:** explore the live app through ARTEMIS before writing tests; deliver runnable tests with explicit waits. Timing: explore with the AI, then hard-code deterministic waits. Compensate for model latency: Flash is about 5 s per step (for a 30 s wait, ask for about 25 s); Pro is about 30 s per turn, which often covers the wait by itself. Judge pragmatically whether exact durations matter.
2. **Flash vs Pro routing:** Flash for simple deterministic flows (no step cap). Pro when you need a persistent plan, verified checkpoints, notes or a report, ADB or log diagnosis, polling loops, or multi-branch exploration. Covers the Planner, Operator (explorer tiers flash 1-shot, pro 3-turn, ultra deep zoom), safety net and incidents, bursts, Checker levels, Outputter.
3. **Devices:** ask the user when more than one device is attached; use `adb devices -l`; one task per device (FIFO); pull artifacts with `adb pull`.
4. **"Dynamic-First, Coordinate-Fallback" test code:** find out what locators the framework supports. Try ids, text or OCR first; catch failures and fall back to the absolute coordinates verified during exploration. Parameterize coordinates when the framework only supports coordinates.
5. **Self-diagnosis:** call `mobile_diagnose` first on any error; follow `next_steps` in order; `Run:` lines may be executed locally, `Guidance:` lines are relayed to the user; use `attempt_fix=true` before any manual ADB work; `launch_avd` rather than running `emulator -avd` in the shell (it hangs); never pass API keys through the chat; restart the MCP server after config changes; read `last_failed_task.recent_errors` before rerunning; repeat until `ready` or `degraded`.

---

## 11. Worth copying vs overkill

**Copy (high value for our fail-closed Jev platform):**
1. **The accessibility helper as our Android observer:** one-call snapshot of XML plus screenshot on API 30+, multi-window capture, clipping to what is really visible, hint/error/stateDescription, token-protected loopback port reached through `adb forward tcp:0`. It removes the uiautomator `waitForIdle` stalls that hurt `adb exec-out uiautomator dump`. Apache-2.0, so fork with NOTICE.
2. **Text input:** clipboard, then `KEYCODE_PASTE` (279) for Korean and Unicode; ADBKeyboard B64 as second choice. **Add** a read-back check of the field's `text` after typing, which Artemis lacks.
3. **Candidate list format:** index, text or hint, 0–1000 bounds, error, overlap warning. Adapt it as our Jev `state` candidates. **Extend it** with unlabeled clickable nodes (label built from class, resource-id and position) so custom and icon-only UIs still get candidates.
4. **Index discipline:** resolve indices against the snapshot the model saw; require `target_description` for raw coordinates; keep an explicit coordinate-space marker in records.
5. **Deterministic pre-action check:** tree scoring, shifted/covered/gone labels and drift correction as a gate before every allowlisted action. Replace the fail-open pixel fallback with a Jev Choice (present/absent) that **stops or sends to review** when uncertain.
6. **Verdict semantics** for Jev: verify vs assert; evidence required; `inconclusive` is a separate outcome, never a pass; confirm the trigger ran before failing an assert; the release decision computed in code; `run_outcome.json` separating task status from test counts.
7. **Fixed read-only probes** built as argv lists with regex-checked parameters, as deterministic assertions (settings, content providers, dumpsys, getprop).
8. **Trace schema:** images named by SHA-256, steps with before/after screenshots, parent–child traces, a `failed_outputs` table for model parse failures, atomic status.json.
9. **Operations:** FIFO device lock with dead-owner detection; the `mobile_diagnose` verdict and next_steps pattern; foreground verification via task affinity; the keep-awake sequence; scrcpy MKV→MP4 remux; logcat `-v threadtime -t <time>` time windows.
10. **Numbers worth reusing:** dHash same-screen ≤4 / different ≥7 (for settle and "screen changed?" checks); swipe geometry (x=0.6W, 0.7↔0.3H, 800 ms); min element size max(5, 0.5% of short side); system-bar rules.

**Overkill for our scope:** the LangGraph Planner/Operator/Checker graph with plan grammar, advisory planner validation, committee debate, video-analyzer sub-agents, transcript ledger with eras and chunks (only needed for 100+ step exploratory runs), log analyzer and diagnoser with search grounding, the Angular showcase UI, IDE notifiers, cloud mode, and a Gemini Robotics-ER dependency for grounding.

**Pitfalls and bugs seen in the code:**
- **Fail-open:** pixel check (errors or confidence <0.7 let the action through); fake 1×1 screenshot plus default 1080×2400 dimensions; release decision fail-open by design.
- **Completion by self-report:** Flash PASS is the model's `report_task_status`; `wait_for_text` is not reachable by any model.
- **Settling:** fixed 0.3–0.4 s sleeps; no idle or animation detection.
- **Unlabeled interactive nodes get no index**, so custom UIs depend on a VLM.
- **Unused normalization:** ui_filter's merge and redundancy strategies never run on the flat Android list.
- **Order and space confusion:** the object detector returns [y, x]; `_resolve_coordinates` guesses the coordinate space.
- **Device side effects:** u2 connect uninstalls Maestro; the helper auto-installs and changes secure accessibility settings; the clipboard is overwritten.
- **Clear-text:** `input keycombination` does not exist on older Android versions and the fallback is not triggered by a shell error.
- **Wrong device:** the console live stream picks the first adb device.
- **Batch:** the local path may report SUCCESS for runs the agent reported as failed.
- **Unbounded runs:** Flash `max_turns=0` and Pro recursion_limit 30000 mean effectively unbounded cost.
- **Latency:** taps go through `adb shell input tap` (about 100–300 ms per call [INFERENCE]) although the helper can dispatch gestures.
- **No iOS at all:** nothing on iOS points vs pixels, WDA or idb to learn from here.

Note: this subagent had no file-write tool, so this report was not written to `local://research/Artemis.md`; save this text there.