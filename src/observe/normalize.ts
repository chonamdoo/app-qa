// Snapshot → ScreenModel: filtering, occlusion, roles, labels, dedupe, reading-order keys, texts, fingerprints.
import { sha256 } from '../core/fsx.ts';
import { PLATFORM_INFO } from '../core/platform.ts';
import type { Candidate, NodeFlags, Platform, RawNode, Rect, Role, ScreenModel, Snapshot } from '../core/types.ts';
import type { OcrLine } from '../ocr/ocr.ts';
import type { AndroidExtras } from './android.ts';
import { iosKeyboardHosts, isIosBackdrop } from './ios.ts';
import { containsPoint, intersect, iou, isScrollContainer, isTouchable, visibleRegion } from './occlusion.ts';
import type { VisibleRegion } from './occlusion.ts';
import { cleanText, normLabel } from './text.ts';
import type { WebExtras, WebKind } from './web.ts';

export interface ScreenModelOptions {
  /** App-profile volatile patterns (regex sources or RegExps), added to the built-in clock / status-bar patterns. */
  volatile?: readonly (string | RegExp)[];
  /** OCR lines in tap coordinates (runOcr). Added as `source:'ocr'` text candidates and appended to `texts`. */
  ocr?: readonly OcrLine[] | null;
}

/** Jev Choice accepts 255 options including `none`. */
export const MAX_CANDIDATES = 254;
const SYNTH_MAX = 80;
/** Unlabelled touchables covering at least this share of the screen are scrims/backdrops, never targets. */
const SCRIM_SHARE = 0.5;
/** A top-anchored browser-UI strip shorter than this share of the screen is the status-bar / safe-area backdrop. */
const TOP_STRIP_SHARE = 0.15;
const DEDUPE_IOU = 0.9;
const LAYOUT_GRID = 8;

const DEFAULT_VOLATILE: readonly RegExp[] = [
  /^\d{1,2}:\d{2}$/,
  /^(오전|오후|AM|PM)\s?\d{1,2}:\d{2}$/i,
  /^\d{1,2}:\d{2}\s?(AM|PM|오전|오후)$/i,
  /^\d{1,3}\s?%$/,
  /^(배터리|battery)[\s:,]*(\d{1,3}\s?(%|퍼센트|percent)|.*충전|.*charging)/i,
  /^(wi-?fi|셀룰러|cellular|phone|signal|신호|모바일 데이터|mobile data)[\s:,].*(\d|막대|bars?|full|strength|강도)/i,
];

const SCROLL_BAR = /scroll bar|스크롤 ?(막대|바)/i;
const SYSTEM_PACKAGE = /^com\.android\.systemui$|inputmethod/;
const ANDROID_TAB_CLASS = /TabView|TabWidget\$|BottomNavigationItemView|NavigationBarItemView|NavigationRailItemView/;
const ANDROID_TAB_PARENT = /TabWidget|TabLayout|BottomNavigationMenuView|NavigationBarMenuView/;

const IOS_ROLES: Record<string, Role> = {
  SecureTextField: 'secure-input',
  TextField: 'input',
  SearchField: 'input',
  TextView: 'input',
  Switch: 'switch',
  Toggle: 'switch',
  CheckBox: 'checkbox',
  RadioButton: 'checkbox',
  Link: 'link',
  Tab: 'tab',
  Cell: 'list-item',
  Button: 'button',
  MenuItem: 'button',
  MenuButton: 'button',
  PopUpButton: 'button',
  ComboBox: 'button',
  Stepper: 'button',
  Incrementor: 'button',
  Icon: 'button',
  DisclosureTriangle: 'button',
  PageIndicator: 'button',
  PickerWheel: 'button',
  Image: 'image',
  StaticText: 'text',
  ScrollView: 'scroll',
  Table: 'scroll',
  CollectionView: 'scroll',
  WebView: 'scroll',
};
const ACTIONABLE_ROLES: Record<Role, boolean> = {
  button: true,
  link: true,
  tab: true,
  input: true,
  'secure-input': true,
  switch: true,
  checkbox: true,
  'list-item': true,
  heading: false,
  text: false,
  image: false,
  scroll: false,
  other: false,
};
/** Touch-intercepting iOS types that are containers or modal surfaces, not targets themselves. */
const NON_TARGET_TOUCHABLES: Record<string, true> = {
  Alert: true,
  Keyboard: true,
  Key: true,
  SegmentedControl: true,
  Picker: true,
  DatePicker: true,
  TabBar: true,
  NavigationBar: true,
  Toolbar: true,
};

const WEB_ROLES: Record<WebKind, Role> = {
  document: 'other',
  button: 'button',
  link: 'link',
  input: 'input',
  select: 'input',
  password: 'secure-input',
  checkbox: 'checkbox',
  radio: 'checkbox',
  switch: 'switch',
  tab: 'tab',
  heading: 'heading',
  image: 'image',
  listitem: 'list-item',
  option: 'list-item',
  scroll: 'scroll',
  text: 'text',
  dialog: 'other',
  overlay: 'other',
  generic: 'other',
};
/** Web kinds without an interactive role that become buttons when the page makes them clickable (onclick / pointer cursor). */
const WEB_CLICK_PROMOTES: Partial<Record<WebKind, true>> = { generic: true, text: true, image: true };
/** Screen roots (the app / the page itself): never candidates or text lines. */
const ROOT_CLASSES: Record<string, true> = { Application: true, 'web:document': true };
/** Element that hosts page content in the device browser; everything outside it is browser UI on a web surface. */
const WEB_CONTENT_CLASS: Record<'android' | 'ios', string> = { android: 'android.webkit.WebView', ios: 'WebView' };

function iosRole(n: RawNode): Role {
  const f = n.flags;
  const role = IOS_ROLES[n.className] ?? (f.clickable && NON_TARGET_TOUCHABLES[n.className] !== true ? 'button' : 'other');
  return f.heading && (role === 'text' || role === 'other') ? 'heading' : role;
}

function androidRole(n: RawNode): Role {
  const f = n.flags;
  const cls = n.className;
  if (f.password) return 'secure-input';
  if (f.editable) return 'input';
  if (/Switch|ToggleButton/.test(cls)) return 'switch';
  if (/CheckBox|RadioButton|CheckedTextView/.test(cls) || f.checkable) return 'checkbox';
  if (f.clickable || f.longClickable) return ANDROID_TAB_CLASS.test(cls) ? 'tab' : 'button';
  if (f.heading) return 'heading';
  if (/ImageView|ImageButton|Image$/.test(cls)) return 'image';
  if (isScrollContainer(n)) return 'scroll';
  if (n.text !== null || /TextView|Text$/.test(cls)) return 'text';
  return 'other';
}

/** Desktop DOM nodes (`web:<kind>`, observe/web.ts). Occluders are covering layers, never buttons. */
function webRole(n: RawNode): Role {
  const kind = (n.className.startsWith('web:') ? n.className.slice(4) : '') as WebKind;
  const role = WEB_ROLES[kind] ?? 'other';
  const occluder = (n as RawNode & Partial<WebExtras>).occluder === true;
  return n.flags.clickable && !occluder && WEB_CLICK_PROMOTES[kind] === true ? 'button' : role;
}

export function roleOf(n: RawNode, platform: Platform): Role {
  switch (platform) {
    case 'android':
      return androidRole(n);
    case 'ios':
      return iosRole(n);
    case 'desktop-chrome':
    case 'desktop-safari':
      return webRole(n);
  }
}

export function isActionable(n: RawNode, role: Role): boolean {
  const f: NodeFlags = n.flags;
  // Web `clickable` also marks covering layers (occluders) and dialogs; only the role vocabulary makes a web target.
  // A plain <li> is structure, not a control: list items (and options) act only when the page makes them clickable.
  if (n.className.startsWith('web:')) return (role === 'list-item' ? f.clickable : ACTIONABLE_ROLES[role]) || f.editable || f.checkable;
  return (
    ACTIONABLE_ROLES[role] ||
    f.longClickable ||
    f.checkable ||
    f.editable ||
    (f.clickable && NON_TARGET_TOUCHABLES[n.className] !== true)
  );
}

/** desc (content-desc / label) → text → hint, NFC and whitespace-collapsed; null when none is non-empty. */
export function ownLabel(n: RawNode): string | null {
  for (const s of [n.desc, n.text, n.hint]) {
    const t = s ? cleanText(s) : '';
    if (t) return t;
  }
  return null;
}

function compileVolatile(extra: readonly (string | RegExp)[] | undefined): RegExp[] {
  const out = [...DEFAULT_VOLATILE];
  for (const p of extra ?? []) {
    if (p instanceof RegExp) {
      out.push(new RegExp(p.source, p.flags.replace(/[gy]/g, '')));
      continue;
    }
    try {
      out.push(new RegExp(p));
    } catch (e) {
      throw new Error(`volatile 정규식이 올바르지 않습니다: ${p} (${(e as Error).message})`);
    }
  }
  return out;
}

function lowerBound(sorted: readonly number[], value: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid]! < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function truncate(s: string, max: number): string {
  const cps = [...s];
  return cps.length <= max ? s : `${cps.slice(0, max - 1).join('')}…`;
}

function fingerprint(entries: string[]): string {
  return sha256(entries.sort().join('\n')).slice(0, 16);
}

function regionOfPoint(y: number, screen: Rect): Candidate['region'] {
  const share = (y - screen.y) / screen.height;
  return share < 1 / 3 ? 'top' : share < 2 / 3 ? 'middle' : 'bottom';
}

interface Draft {
  i: number;
  role: Role;
  name: string;
  /** Name with volatile parts removed (fingerprints); null = entire name is volatile → excluded from fingerprints. */
  stableName: string | null;
  ownName: boolean;
  actionable: boolean;
  region: VisibleRegion;
  dropped: boolean;
}

/**
 * Builds the normalized screen model (architecture §2). Requires `snapshot.nodes` in DFS pre-order by z (as produced
 * by parseAndroidSource / parseIosSource / parseWebSource).
 */
export function buildScreenModel(snapshot: Snapshot, opts: ScreenModelOptions = {}): ScreenModel {
  const volatile = compileVolatile(opts.volatile);
  const isVolatile = (s: string): boolean => volatile.some((re) => re.test(s));
  const { screen, platform } = snapshot;
  const screenArea = screen.width * screen.height;
  const nodes = [...snapshot.nodes].sort((a, b) => a.z - b.z);
  const count = nodes.length;
  const index = new Map<string, number>();
  nodes.forEach((n, i) => index.set(n.id, i));

  const parent = new Int32Array(count).fill(-1);
  for (let i = 0; i < count; i++) {
    const p = nodes[i]!.parentId;
    if (p === null) continue;
    const pi = index.get(p);
    if (pi === undefined || pi >= i) throw new Error(`snapshot nodes are not in DFS pre-order (node ${nodes[i]!.id})`);
    parent[i] = pi;
  }
  // Last index of each subtree (pre-order ⇒ descendants of i are i+1..end[i]).
  const end = Int32Array.from({ length: count }, (_, i) => i);
  for (let i = count - 1; i >= 0; i--) {
    const p = parent[i]!;
    if (p >= 0 && end[i]! > end[p]!) end[p] = end[i]!;
  }

  // ── browser UI (web surface in a device browser): everything outside the page content host ──
  // Android: Chrome's own views (`<browser>:id/*` and their descendants: address bar, toolbar, snackbars) that do not
  // contain the page. iOS: every node outside a WebView subtree that does not contain one (Safari toolbar, address
  // field), except alerts (JavaScript alert/confirm dialogs are drawn natively). Browser UI is never a candidate or a
  // text line, but it still occludes the page.
  const browserUi = new Uint8Array(count);
  const deviceBrowser = snapshot.surface === 'web' && (platform === 'android' || platform === 'ios');
  /** Outermost page content hosts (device browsers only); OCR lines outside them are browser or system UI. */
  const pageHosts: number[] = [];
  if (deviceBrowser) {
    const hostClass = WEB_CONTENT_CLASS[platform];
    const chromeId = `${PLATFORM_INFO[platform].browser}:id/`;
    const inWeb = new Uint8Array(count);
    const hasWeb = new Uint8Array(count);
    const inAlert = new Uint8Array(count);
    for (let i = 0; i < count; i++) {
      const p = parent[i]!;
      inWeb[i] = nodes[i]!.className === hostClass || (p >= 0 && inWeb[p]) ? 1 : 0;
      if (nodes[i]!.className === hostClass && !(p >= 0 && inWeb[p])) pageHosts.push(i);
      inAlert[i] = nodes[i]!.className === 'Alert' || (p >= 0 && inAlert[p]) ? 1 : 0;
    }
    for (let i = count - 1; i >= 0; i--) if ((inWeb[i] || hasWeb[i]) && parent[i]! >= 0) hasWeb[parent[i]!] = 1;
    for (let i = 0; i < count; i++) {
      if (inWeb[i] || hasWeb[i]) continue;
      const p = parent[i]!;
      const own = platform === 'ios' ? !inAlert[i] : nodes[i]!.resourceId?.startsWith(chromeId) === true;
      browserUi[i] = own || (p >= 0 && browserUi[p]) ? 1 : 0;
    }
  }

  // ── iOS Safari top safe area: page content scrolled under the status bar is visible but cannot be tapped ──
  // With `viewport-fit=cover` the page scrolls under the status bar, and touches there go to the system (tap = scroll to
  // top), never to the page. Edge: the StatusBar element when the tree has one, else the lowest top-anchored full-width
  // browser-UI strip (Safari's status-bar backdrop), else the WebView's visible top. Only tap regions avoid the strip;
  // text lines under it stay readable.
  let tapStrip: Rect | null = null;
  if (snapshot.surface === 'web' && platform === 'ios') {
    let edge = screen.y;
    const bar = nodes.find((n) => n.className === 'StatusBar');
    if (bar) edge = bar.rect.y + bar.rect.height;
    else {
      for (let i = 0; i < count; i++) {
        const r = nodes[i]!.rect;
        if (browserUi[i] && r.y <= screen.y && r.width >= 0.9 * screen.width && r.height < TOP_STRIP_SHARE * screen.height) {
          edge = Math.max(edge, r.y + r.height);
        }
      }
      const host = nodes.find((n) => n.className === WEB_CONTENT_CLASS.ios);
      if (edge === screen.y && host) edge = Math.max(edge, host.rect.y);
    }
    if (edge > screen.y) tapStrip = { x: screen.x, y: screen.y, width: screen.width, height: edge - screen.y };
  }

  // ── clipping (screen + scroll viewports) and removal ──
  const keyboardHosts = new Set(platform === 'ios' ? iosKeyboardHosts(nodes, screen).map((h) => h.id) : []);
  const noArea: Rect = { x: 0, y: 0, width: 0, height: 0 };
  const clip: (Rect | null)[] = new Array(count);
  const childClip: Rect[] = new Array(count);
  const excluded = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    const n = nodes[i]!;
    const p = parent[i]!;
    const base = p < 0 ? screen : childClip[p]!;
    const c = intersect(n.rect, base);
    clip[i] = c;
    childClip[i] = isScrollContainer(n) ? (c ?? noArea) : base;
    const pkg = (n as RawNode & Partial<AndroidExtras>).package;
    const self =
      browserUi[i] === 1 ||
      (platform === 'android' && typeof pkg === 'string' && SYSTEM_PACKAGE.test(pkg)) ||
      (platform === 'ios' && (n.className === 'Keyboard' || n.className === 'Key' || keyboardHosts.has(n.id))) ||
      SCROLL_BAR.test(n.desc ?? '');
    excluded[i] = (p >= 0 && excluded[p]) || self ? 1 : 0;
  }

  // ── occlusion: touchable-only occluders drawn after (and outside) the target ──
  const touch: number[] = [];
  for (let i = 0; i < count; i++) if (clip[i] && isTouchable(nodes[i]!)) touch.push(i);
  const visCache = new Map<number, VisibleRegion | null>();
  /** `tap`: the region a touch can reach (also avoids the top safe-area strip); otherwise what the user can see. */
  const regionOf = (i: number, tap: boolean): VisibleRegion | null => {
    const r = clip[i]!;
    const strip = tap && tapStrip && intersect(tapStrip, r) ? tapStrip : null;
    const key = strip ? -1 - i : i;
    const cached = visCache.get(key);
    if (cached !== undefined) return cached;
    const occluders: Rect[] = strip ? [strip] : [];
    const avoid: Rect[] = [];
    for (let k = lowerBound(touch, i + 1); k < touch.length; k++) {
      const t = touch[k]!;
      const tr = clip[t]!;
      if (!intersect(tr, r)) continue;
      if (t > end[i]!) occluders.push(tr);
      else {
        const f = nodes[t]!.flags;
        if (f.clickable || f.longClickable || f.editable || f.checkable) avoid.push(tr);
      }
    }
    const v = visibleRegion(r, occluders, avoid);
    visCache.set(key, v);
    return v;
  };

  // ── per-node semantics ──
  const roles: Role[] = new Array(count);
  const actionable = new Uint8Array(count);
  const own: (string | null)[] = new Array(count);
  const scrim = new Uint8Array(count);
  const boundary = new Uint8Array(count);
  const absorbedBy = new Int32Array(count).fill(-1);
  for (let i = 0; i < count; i++) {
    const p = parent[i]!;
    absorbedBy[i] = p < 0 ? -1 : boundary[p] ? p : absorbedBy[p]!;
    const c = clip[i];
    if (excluded[i] || !c) continue;
    const n = nodes[i]!;
    const role = roleOf(n, platform);
    roles[i] = role;
    actionable[i] = isActionable(n, role) ? 1 : 0;
    own[i] = ownLabel(n);
    const area = c.width * c.height;
    scrim[i] =
      (platform === 'ios' && isIosBackdrop(n, screen)) || (actionable[i] && own[i] === null && area >= SCRIM_SHARE * screenArea) ? 1 : 0;
    boundary[i] = !scrim[i] && (actionable[i] || (n.flags.focusable && own[i] !== null)) && area < SCRIM_SHARE * screenArea ? 1 : 0;
  }

  // iOS tab bars: labelled items drawn inside a TabBar (as its descendants or siblings) are tabs.
  if (platform === 'ios') {
    const bars = nodes.map((n, i) => (n.className === 'TabBar' && clip[i] && !excluded[i] ? i : -1)).filter((i) => i >= 0);
    for (const b of bars) {
      const br = nodes[b]!.rect;
      for (let i = 0; i < count; i++) {
        if (i === b || roles[i] === undefined || own[i] === null || (roles[i] !== 'other' && roles[i] !== 'button')) continue;
        const inside = parent[i] === parent[b] || (i > b && i <= end[b]!);
        const r = nodes[i]!.rect;
        if (inside && containsPoint(br, { x: r.x + r.width / 2, y: r.y + r.height / 2 })) {
          roles[i] = 'tab';
          actionable[i] = 1;
        }
      }
    }
  } else if (platform === 'android') {
    for (let i = 0; i < count; i++) {
      const p = parent[i]!;
      if (roles[i] === 'button' && p >= 0 && ANDROID_TAB_PARENT.test(nodes[p]!.className)) roles[i] = 'tab';
    }
  }

  const synthesize = (i: number): string[] => {
    const parts: string[] = [];
    let length = 0;
    for (let k = i + 1; k <= end[i]! && length < SYNTH_MAX; k++) {
      if (excluded[k] || !clip[k]) {
        k = end[k]!;
        continue;
      }
      const d = nodes[k]!;
      const desc = d.desc ? cleanText(d.desc) : '';
      const label = desc || (d.text ? cleanText(d.text) : '');
      if (label && parts[parts.length - 1] !== label) {
        parts.push(label);
        length += label.length + 1;
      }
      if (desc) k = end[k]!; // a described element already summarizes its subtree
    }
    return parts;
  };

  // ── candidates (visible, not absorbed into an enclosing target) ──
  const occluded = new Set<number>();
  const drafts: Draft[] = [];
  const draftAt = new Map<number, Draft>();
  for (let i = 0; i < count; i++) {
    if (roles[i] === undefined || scrim[i] || ROOT_CLASSES[nodes[i]!.className] === true) continue;
    const name = own[i] ?? null;
    if (!actionable[i] && (name === null || absorbedBy[i]! >= 0)) continue;
    const region = regionOf(i, true);
    if (!region) {
      occluded.add(i);
      continue;
    }
    let draft: Draft;
    if (name !== null) {
      draft = { i, role: roles[i]!, name, stableName: isVolatile(name) ? null : name, ownName: true, actionable: !!actionable[i], region, dropped: false };
    } else {
      const parts = synthesize(i);
      const joined = parts.join(' ');
      draft = {
        i,
        role: roles[i]!,
        name: parts.length > 1 ? truncate(joined, SYNTH_MAX) : joined,
        stableName: parts.filter((s) => !isVolatile(s)).join(' '),
        ownName: false,
        actionable: !!actionable[i],
        region,
        dropped: false,
      };
    }
    drafts.push(draft);
    draftAt.set(i, draft);
  }

  // ── dedupe: same label + ancestor/descendant + IoU ≥ 0.9 only (repeated rows are never merged) ──
  for (const d of drafts) {
    const key = normLabel(d.name);
    for (let a = parent[d.i]!; a >= 0 && !d.dropped; a = parent[a]!) {
      const anc = draftAt.get(a);
      if (!anc || anc.dropped || normLabel(anc.name) !== key || iou(clip[a]!, clip[d.i]!) < DEDUPE_IOU) continue;
      const keepDescendant =
        d.actionable !== anc.actionable ? d.actionable : d.ownName !== anc.ownName ? d.ownName : false;
      if (keepDescendant) anc.dropped = true;
      else d.dropped = true;
    }
  }
  const kept = drafts.filter((d) => !d.dropped);

  // On web pages, a text field without any name takes the name of the one text label beside it (same line, to its
  // left) or right above it — the `<label>` + field pattern whose association Android Chrome's tree drops (label as a
  // TextView, field with only its placeholder). Ties or distant labels: no name. Native screens keep their tree names
  // (their calibrated Jev rows depend on them).
  for (const f of snapshot.surface === 'web' ? kept : []) {
    if (f.name !== '' || (f.role !== 'input' && f.role !== 'secure-input')) continue;
    const e = clip[f.i]!;
    const gapTo = (l: Rect): number | null => {
      const sameLine = Math.abs(e.y + e.height / 2 - (l.y + l.height / 2)) <= Math.max(l.height, e.height) / 2 && e.x >= l.x + l.width - 4;
      if (sameLine) return e.x - (l.x + l.width) <= 3 * l.height ? Math.max(0, e.x - (l.x + l.width)) : null;
      const below = e.x < l.x + l.width && e.x + e.width > l.x && e.y >= l.y + l.height - 4;
      return below && e.y - (l.y + l.height) <= 2 * l.height ? Math.max(0, e.y - (l.y + l.height)) : null;
    };
    const labels = kept.flatMap((l) => {
      const gap = l.role === 'text' && l.ownName && l.name !== '' ? gapTo(clip[l.i]!) : null;
      return gap === null ? [] : [{ l, gap }];
    });
    labels.sort((a, b) => a.gap - b.gap);
    if (labels.length === 0 || (labels.length > 1 && labels[1]!.gap === labels[0]!.gap)) continue;
    f.name = labels[0]!.l.name;
    f.stableName = labels[0]!.l.stableName;
  }

  // Bottom tab strip heuristic (RN/Compose tabs expose plain clickable views): 3–6 sibling buttons with short labels,
  // equal top/height/width, touching the bottom 15% of the screen and spanning ≥60% of its width. Three-item rows must
  // all carry an icon so a dialog's text-only [취소][저장][삭제] button row is not mistaken for navigation. Desktop DOM
  // roles are explicit (role="tab"), so the heuristic does not apply there.
  const byParent = new Map<number, Draft[]>();
  for (const d of kept) {
    if (d.role !== 'button' || PLATFORM_INFO[platform].host === 'desktop') continue;
    const list = byParent.get(parent[d.i]!) ?? [];
    list.push(d);
    byParent.set(parent[d.i]!, list);
  }
  for (const group of byParent.values()) {
    if (group.length < 3 || group.length > 6) continue;
    const rects = group.map((d) => clip[d.i]!);
    const first = rects[0]!;
    const left = Math.min(...rects.map((r) => r.x));
    const right = Math.max(...rects.map((r) => r.x + r.width));
    const isStrip = rects.every(
      (r) =>
        r.y + r.height >= screen.y + 0.85 * screen.height &&
        Math.abs(r.y - first.y) <= 0.02 * screen.height &&
        Math.abs(r.height - first.height) <= 0.15 * first.height &&
        Math.abs(r.width - first.width) <= 0.15 * first.width,
    );
    const hasIcon = (d: Draft): boolean => {
      for (let k = d.i + 1; k <= end[d.i]!; k++) if (roles[k] === 'image' || /Svg|Image|Icon/.test(nodes[k]!.className)) return true;
      return false;
    };
    if (
      isStrip &&
      right - left >= 0.6 * screen.width &&
      group.every((d) => d.name.length > 0 && d.name.length <= 12) &&
      (group.length >= 4 || group.every(hasIcon))
    ) {
      for (const d of group) d.role = 'tab';
    }
  }

  // ── reading order and keys ──
  kept.sort((a, b) => clip[a.i]!.y - clip[b.i]!.y || clip[a.i]!.x - clip[b.i]!.x || a.i - b.i);
  const candidates: Candidate[] = kept.map((d, k) => {
    const n = nodes[d.i]!;
    const f = n.flags;
    const state: string[] = [];
    if (!f.enabled) state.push('disabled');
    if (f.checkable) state.push(f.checked ? 'checked' : 'unchecked');
    if (f.selected) state.push('selected');
    if (f.focused) state.push('focused');
    let value = f.checkable || !n.value ? null : n.value.normalize('NFC');
    if (value !== null && f.password) value = '•'.repeat([...value].length);
    return {
      key: `e${k + 1}`,
      nodeId: n.id,
      resourceId: n.resourceId,
      role: d.role,
      name: d.name,
      value,
      state,
      rect: clip[d.i]!,
      tapPoint: d.region.tapPoint,
      actionable: d.actionable,
      region: regionOfPoint(d.region.tapPoint.y, screen),
      source: 'tree',
    };
  });

  // ── texts: visible text lines of every non-removed node, reading order, no parent/child repeats ──
  const hasTextBelow = new Uint8Array(count);
  for (let i = count - 1; i >= 0; i--) {
    const p = parent[i]!;
    const n = nodes[i]!;
    if (p >= 0 && !excluded[i] && clip[i] && (n.text || n.desc || n.value || hasTextBelow[i])) hasTextBelow[p] = 1;
  }
  const lineAt = new Map<number, string>();
  const lines: { i: number; text: string }[] = [];
  for (let i = 0; i < count; i++) {
    if (roles[i] === undefined || ROOT_CLASSES[nodes[i]!.className] === true) continue;
    const n = nodes[i]!;
    const f = n.flags;
    const found: string[] = [];
    if (n.text) found.push(cleanText(n.text));
    else if (n.value && f.editable && !f.password) found.push(cleanText(n.value));
    else if (n.desc && !f.editable && roles[i] !== 'image' && !hasTextBelow[i] && !scrim[i]) found.push(cleanText(n.desc));
    const error = (n as RawNode & Partial<AndroidExtras>).error;
    if (typeof error === 'string' && error.trim()) found.push(cleanText(error));
    const nodeLines = found.filter(Boolean);
    if (!nodeLines.length) continue;
    if (!regionOf(i, false)) {
      occluded.add(i);
      continue;
    }
    for (const text of nodeLines) {
      let repeat = false;
      for (let a = parent[i]!; a >= 0 && !repeat; a = parent[a]!) repeat = lineAt.get(a) === text;
      if (repeat) continue;
      lineAt.set(i, text);
      lines.push({ i, text });
    }
  }
  lines.sort((a, b) => clip[a.i]!.y - clip[b.i]!.y || clip[a.i]!.x - clip[b.i]!.x || a.i - b.i);
  const texts = lines.map((l) => l.text);

  const actionableCount = candidates.filter((c) => c.actionable).length;
  const textChars = texts.reduce((sum, t) => sum + [...t].length, 0);
  const sparse = actionableCount < 3 && textChars < 32;

  const identity: string[] = [];
  const layout: string[] = [];
  for (const d of kept) {
    if (d.stableName === null) continue;
    identity.push(`${d.role}\u0000${normLabel(d.stableName)}`);
    const r = clip[d.i]!;
    layout.push([r.x, r.y, r.width, r.height].map((v) => Math.round(v / LAYOUT_GRID)).join(','));
  }

  // ── OCR lines: pixels have no occlusion, but keyboard/system areas, browser UI and tree duplicates are skipped ──
  if (opts.ocr?.length) {
    const blocked = nodes.flatMap((n, i) => (excluded[i] && clip[i] && isTouchable(n) ? [clip[i]!] : []));
    // Device browsers: only the page is read. Pixels outside the page hosts (status bar clock, Chrome's toolbar), under
    // the iOS status-bar strip, or on browser UI drawn over the page (Safari's toolbar) are browser/system UI, dropped
    // like browser-UI nodes. A browser-UI node spanning a whole page host is a container around the page, not chrome.
    const pages = pageHosts.flatMap((i) => (clip[i] ? [clip[i]!] : []));
    if (deviceBrowser) {
      const spansPage = (r: Rect): boolean =>
        pages.some((h) => r.x <= h.x && r.y <= h.y && r.x + r.width >= h.x + h.width && r.y + r.height >= h.y + h.height);
      for (let i = 0; i < count; i++) if (browserUi[i] && clip[i] && !spansPage(clip[i]!)) blocked.push(clip[i]!);
      if (tapStrip) blocked.push(tapStrip);
    }
    let k = 0;
    for (const line of opts.ocr) {
      const text = cleanText(line.text);
      const rect = intersect(line.rect, screen);
      if (!text || !rect) continue;
      const center = { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
      if (blocked.some((b) => containsPoint(b, center)) || (deviceBrowser && !pages.some((h) => containsPoint(h, center)))) continue;
      const key = normLabel(text);
      const duplicate =
        candidates.some((c) => c.source === 'tree' && normLabel(c.name) === key && containsPoint(c.rect, center)) ||
        lines.some((l) => normLabel(l.text) === key && containsPoint(clip[l.i]!, center));
      if (duplicate) continue;
      candidates.push({
        key: '',
        nodeId: `ocr:${k++}`,
        resourceId: null,
        role: 'text',
        name: text,
        value: null,
        state: [],
        rect,
        tapPoint: center,
        actionable: true,
        region: regionOfPoint(center.y, screen),
        source: 'ocr',
      });
      if (!texts.includes(text)) texts.push(text);
    }
    candidates.sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);
    candidates.forEach((c, i) => (c.key = `e${i + 1}`));
  }

  return {
    snapshot,
    candidates,
    texts,
    occludedNodeIds: [...occluded].sort((a, b) => a - b).map((i) => nodes[i]!.id),
    fingerprints: { identity: fingerprint(identity), layout: fingerprint(layout) },
    sparse,
    overflow: candidates.length > MAX_CANDIDATES,
  };
}
