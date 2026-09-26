// Shared contracts between observe / jev / drivers / runner / plan.
// Every module codes against these types; change them only through the integration owner.

export type Platform = 'android' | 'ios';

/** Device tap coordinate space: Android = physical px, iOS = points. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

// ───────────────────────── observation ─────────────────────────

export interface NodeFlags {
  clickable: boolean;
  longClickable: boolean;
  focusable: boolean;
  checkable: boolean;
  checked: boolean;
  enabled: boolean;
  selected: boolean;
  focused: boolean;
  scrollable: boolean;
  password: boolean;
  editable: boolean;
  heading: boolean;
}

/** One element parsed from a platform page source, before normalization. */
export interface RawNode {
  /** Path id within the snapshot, e.g. "0.3.1". Stable for a given source string. */
  id: string;
  parentId: string | null;
  childIds: string[];
  /** Global paint order: higher = drawn later (on top). Android: window order, then DFS with siblings sorted by drawing-order. iOS: DFS document order. */
  z: number;
  windowId: string | null;
  /** Android class name (android.widget.Button) or iOS element type without prefix (Button, StaticText…). */
  className: string;
  text: string | null;
  /** Android content-desc / iOS label. */
  desc: string | null;
  /** iOS name (accessibilityIdentifier) / Android resource-id. */
  resourceId: string | null;
  value: string | null;
  hint: string | null;
  rect: Rect;
  flags: NodeFlags;
}

export interface Snapshot {
  platform: Platform;
  takenAt: string; // ISO
  /** Screen size in tap coordinates (Android px from window rect, iOS pt). */
  screen: Rect;
  nodes: RawNode[];
  /** Exact page source as returned by the driver (kept for receipts / fixtures). */
  rawSource: string;
  /** PNG bytes when requested. Pixel space may differ from tap space (iOS @3x). */
  screenshotPng: Uint8Array | null;
  /** Foreground app id (Android package / iOS bundleId) when the driver can tell. */
  foregroundApp: string | null;
  keyboardShown: boolean;
  /** iOS: deepest element depth seen; `depthCapped` when it reached the snapshotMaxDepth setting (tree may be truncated). */
  maxDepth: number | null;
  depthCapped: boolean;
}

export type Role =
  | 'button'
  | 'link'
  | 'tab'
  | 'input'
  | 'secure-input'
  | 'switch'
  | 'checkbox'
  | 'heading'
  | 'text'
  | 'image'
  | 'list-item'
  | 'scroll'
  | 'other';

/** A target the runner may resolve an intent to. At most 254 per screen (Jev Choice limit 255 incl. `none`). */
export interface Candidate {
  /** Choice key sent to Jev: e1..eN. */
  key: string;
  nodeId: string;
  role: Role;
  /** Human-visible name (NFC). */
  name: string;
  /** Current value; secure fields are replaced by `•` × length. */
  value: string | null;
  /** e.g. ['disabled', 'checked', 'selected', 'focused']. */
  state: string[];
  rect: Rect;
  /** Center of the largest un-occluded region, in tap coordinates. */
  tapPoint: Point;
  actionable: boolean;
  region: 'top' | 'middle' | 'bottom';
  source: 'tree' | 'ocr';
}

export interface Fingerprints {
  /** Changes when the set of visible (role, name) changes; ignores geometry and volatile text (clock, battery). */
  identity: string;
  /** Changes when visible geometry changes; ignores values. */
  layout: string;
}

export interface ScreenModel {
  snapshot: Snapshot;
  candidates: Candidate[];
  /** Visible, un-occluded text lines (NFC) used by deterministic text assertions. Includes OCR lines when OCR ran. */
  texts: string[];
  occludedNodeIds: string[];
  fingerprints: Fingerprints;
  /** True when the tree has too little labelled content to act on (OCR fallback trigger). */
  sparse: boolean;
  /** True when candidates exceeded 254 and the screen cannot be offered to Jev without truncation. */
  overflow: boolean;
}

// ───────────────────────── actions ─────────────────────────

/** completed = driver confirmed; uncertain = outcome unknown (timeout/transport) → never auto-retried; rejected = refused before dispatch. */
export type ActionStatus = 'completed' | 'uncertain' | 'rejected';

export interface ActionOutcome {
  status: ActionStatus;
  ms: number;
  error?: string;
}

export interface TypeOutcome extends ActionOutcome {
  /** Value read back from the field after typing (secure fields: length only). */
  readBack: string | null;
  path: 'setValue' | 'keys' | 'clipboard';
}

export interface AppTarget {
  platform: Platform;
  /** Android package / iOS bundle id. */
  appId: string;
  /** Optional Android launch activity. */
  activity?: string;
  /** Optional binary for install/reinstall (APK or simulator .app). */
  binaryPath?: string;
}

export type ResetMode = 'none' | 'relaunch' | 'clear' | 'reinstall';

export interface DeviceInfo {
  platform: Platform;
  id: string; // adb serial / simulator UDID
  name: string;
  osVersion: string;
  state: 'booted' | 'shutdown' | 'offline';
  kind: 'emulator' | 'simulator' | 'device';
}

export interface Driver {
  readonly platform: Platform;
  readonly deviceId: string;
  /** Opens the automation session (does not launch the app unless asked). */
  open(app: AppTarget): Promise<void>;
  close(): Promise<void>;
  snapshot(opts?: { screenshot?: boolean }): Promise<Snapshot>;
  screenshot(): Promise<Uint8Array>;
  tap(p: Point): Promise<ActionOutcome>;
  /** Focus `at`, clear (unless append), enter text, optionally press return; read back. Fallback path only when the value did not change at all. */
  typeText(at: Point, text: string, opts?: { secure?: boolean; append?: boolean; submit?: boolean }): Promise<TypeOutcome>;
  /** Clears the field focused by tapping `at`; verifies the value became empty (or equals the hint). */
  clearText(at: Point): Promise<TypeOutcome>;
  longPress(p: Point, holdMs: number): Promise<ActionOutcome>;
  swipe(from: Point, to: Point, durationMs: number): Promise<ActionOutcome>;
  back(): Promise<ActionOutcome>;
  press(key: 'enter' | 'back' | 'tab' | 'escape' | 'delete'): Promise<ActionOutcome>;
  /** Dismisses the soft keyboard only if shown (never an unconditional BACK); `rejected` if it stays shown. */
  hideKeyboard(): Promise<ActionOutcome>;
  launch(app: AppTarget, opts?: { permissions?: Record<string, 'allow' | 'deny' | 'unset'>; arguments?: string[] }): Promise<ActionOutcome>;
  terminate(app: AppTarget): Promise<ActionOutcome>;
  /** clear on iOS also runs `simctl keychain <udid> reset` (device-wide). */
  reset(app: AppTarget, mode: ResetMode): Promise<ActionOutcome>;
  openUrl(app: AppTarget, url: string): Promise<ActionOutcome>;
  setLocation(lat: number, lon: number): Promise<ActionOutcome>;
  foregroundApp(): Promise<string | null>;
  /** iOS: WDA `hittable` of the element at/around a point; Android: undefined (geometry test is authoritative). */
  isHittable?(p: Point): Promise<boolean | undefined>;
  /**
   * Start collecting device logs for the app; slice returns text between two ISO timestamps. Every line passes
   * `sanitize` before it touches disk (the runner's evidence sanitizer) — raw device output is never stored.
   */
  startLogs(app: AppTarget, sanitize: (line: string) => string): Promise<void>;
  logSlice(fromIso: string, toIso: string): Promise<string>;
  /** Crash evidence since `sinceIso`: Android logcat crash buffer / ANR traces, iOS DiagnosticReports *.ips for the app. */
  crashArtifacts(app: AppTarget, sinceIso: string): Promise<{ name: string; content: string }[]>;
}

// ───────────────────────── Jev decisions ─────────────────────────

export type GroundingVerdict = 'pass' | 'ambiguous' | 'not_found' | 'error';
export type ClaimVerdict = 'pass' | 'fail' | 'inconclusive' | 'error';

export interface JevReceipt {
  questionVersion: string;
  model: string | null; // model id returned by the API
  requestId: string | null; // x-typesafe-request-id
  stateDigest: string; // sha256 of the serialized, redacted state
  latencyMs: number;
  inputTokens: number | null;
  /** Question ids → raw answer objects exactly as returned. */
  answers: Record<string, unknown> | null;
  error: string | null;
}

export interface GroundingDecision {
  verdict: GroundingVerdict;
  candidate: Candidate | null;
  /** candidate key (or 'none') → probability, when Jev was consulted. */
  probabilities: Record<string, number> | null;
  decisionSource: 'fast_path' | 'selector' | 'jev' | 'none';
  receipt: JevReceipt | null;
  reason: string;
}

export interface ClaimDecision {
  verdict: ClaimVerdict;
  pYes: number | null;
  decisionSource: 'jev';
  receipt: JevReceipt | null;
  reason: string;
}

export interface WhichDecision {
  verdict: 'pass' | 'none' | 'ambiguous' | 'error';
  option: string | null;
  probabilities: Record<string, number> | null;
  receipt: JevReceipt | null;
  reason: string;
}

// ───────────────────────── results ─────────────────────────

/** Final status of a step or test. INCONCLUSIVE never counts as pass. */
export type Verdict = 'PASS' | 'FAIL' | 'INCONCLUSIVE' | 'ERROR' | 'SKIPPED';

export interface HealthFinding {
  kind:
    | 'app_not_foreground'
    | 'crash_dialog'
    | 'anr_dialog'
    | 'rn_redbox'
    | 'rn_logbox_error'
    | 'rn_logbox_warning'
    | 'flutter_error'
    | 'blank_screen';
  severity: 'fail' | 'warn';
  evidence: string;
}
