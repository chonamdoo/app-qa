// Desktop web observation: read-only DOM extract script → canonical web XML → RawNode[].
// The extract only observes (DOM walk, computed style, value read-back, elementFromPoint); it never acts on the page.
import { z } from 'zod';
import type { NodeFlags, RawNode, Rect } from '../core/types.ts';
import { scanXml } from './text.ts';

/** Node kinds the extract emits; RawNode.className is `web:<kind>`. */
export const WEB_KINDS = [
  'document',
  'button',
  'link',
  'input',
  'password',
  'checkbox',
  'radio',
  'switch',
  'tab',
  'heading',
  'image',
  'listitem',
  'option',
  'select',
  'dialog',
  'scroll',
  'text',
  'generic',
  'overlay',
] as const;
export type WebKind = (typeof WEB_KINDS)[number];

const WEB_FLAGS = [
  'clickable',
  'focusable',
  'enabled',
  'checkable',
  'checked',
  'selected',
  'focused',
  'scrollable',
  'editable',
  'heading',
  'password',
  'occluder',
] as const;
type WebFlag = (typeof WEB_FLAGS)[number];

/** Nodes past this count are not emitted (`truncated: true`); occluders are always emitted. */
export const WEB_NODE_CAP = 3000;

/**
 * Body for W3C `POST /session/:id/execute/sync` (`{script, args: []}`). Read-only. Returns
 * `{url, title, width, height, dpr, scrollX, scrollY, truncated, nodes}`; nodes are in DOM (flat tree) DFS pre-order with
 * `parent` = index of the nearest emitted ancestor (-1 for the root `document` node = the viewport), rects in
 * viewport-relative CSS px, and `flags` = names of the true flags. Only nodes that intersect the viewport are emitted;
 * hidden subtrees (display:none, `hidden`, aria-hidden, opacity 0) are skipped; visibility:hidden, display:contents and
 * zero-size elements are skipped but their children are still walked. Password fields report bullets × length, never the
 * value. For each interactive or text node, `elementFromPoint` at the centre of its on-screen part finds what a real click
 * would hit; when that is neither the node, inside it, nor an ancestor of it, the covering layer (nearest fixed/sticky
 * ancestor-or-self of the hit that does not contain the node, else the hit element) is flagged `occluder` (and emitted
 * as an `overlay` node when it was filtered out, e.g. an invisible click-catcher).
 */
export const WEB_EXTRACT_SCRIPT = String.raw`
const CAP = ${WEB_NODE_CAP};
const W = window.innerWidth;
const H = window.innerHeight;
const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'META', 'LINK', 'TITLE', 'BASE']);
const LEAF = new Set(['INPUT', 'TEXTAREA', 'SELECT', 'IFRAME', 'svg', 'CANVAS', 'VIDEO', 'AUDIO', 'OBJECT', 'EMBED']);
const ROLE_KIND = { button: 'button', link: 'link', textbox: 'input', searchbox: 'input', combobox: 'input', spinbutton: 'input', checkbox: 'checkbox', radio: 'radio', switch: 'switch', tab: 'tab', heading: 'heading', img: 'image', image: 'image', listitem: 'listitem', option: 'option', dialog: 'dialog', alertdialog: 'dialog', menuitem: 'button', menuitemcheckbox: 'checkbox', menuitemradio: 'radio', listbox: 'select' };
const INPUT_BUTTON = new Set(['button', 'submit', 'reset', 'image', 'file', 'color']);
const TEXT_INPUT = new Set(['text', 'search', 'email', 'url', 'tel', 'number', 'password', 'date', 'datetime-local', 'month', 'time', 'week', '']);
const CLICK_KINDS = new Set(['button', 'link', 'input', 'password', 'checkbox', 'radio', 'switch', 'tab', 'option', 'select']);
const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
const flatChildNodes = (el) => {
  if (el.tagName === 'SLOT') {
    const assigned = el.assignedNodes({ flatten: true });
    return assigned.length ? assigned : [...el.childNodes];
  }
  return [...(el.shadowRoot || el).childNodes];
};
const composedParent = (n) => n.assignedSlot || n.parentNode || (n instanceof ShadowRoot ? n.host : null) || (n.getRootNode && n.getRootNode() !== n && n.getRootNode().host) || null;
const composedContains = (outer, inner) => {
  for (let n = inner; n; n = composedParent(n)) if (n === outer) return true;
  return false;
};
const deepHit = (x, y) => {
  let hit = document.elementFromPoint(x, y);
  while (hit && hit.shadowRoot) {
    const inner = hit.shadowRoot.elementFromPoint(x, y);
    if (!inner || inner === hit) break;
    hit = inner;
  }
  return hit;
};
let active = document.activeElement;
while (active && active.shadowRoot && active.shadowRoot.activeElement) active = active.shadowRoot.activeElement;
const textWithout = (node, skip) => {
  if (node === skip) return '';
  if (node.nodeType === 3) return node.data;
  if (node.nodeType !== 1 || node.tagName === 'SELECT' || node.tagName === 'TEXTAREA') return '';
  let s = '';
  for (const c of node.childNodes) s += textWithout(c, skip) + ' ';
  return s;
};
const nameOf = (el) => {
  const aria = clean(el.getAttribute('aria-label'));
  if (aria) return aria;
  const by = el.getAttribute('aria-labelledby');
  if (by) {
    const root = el.getRootNode();
    const t = clean(by.split(/\s+/).map((id) => { const r = (root.getElementById ? root.getElementById(id) : null) || document.getElementById(id); return r ? r.textContent : ''; }).join(' '));
    if (t) return t;
  }
  if (el.labels && el.labels.length) {
    const t = clean([...el.labels].map((l) => textWithout(l, el)).join(' '));
    if (t) return t;
  }
  const alt = clean(el.getAttribute('alt'));
  if (alt && (el.tagName === 'IMG' || el.tagName === 'AREA' || el.tagName === 'INPUT')) return alt;
  return clean(el.getAttribute('title')) || null;
};
const kindOf = (el) => {
  const tag = el.tagName;
  if (tag === 'INPUT' && el.type === 'password') return 'password';
  const role = (el.getAttribute('role') || '').trim().split(/\s+/)[0];
  if (ROLE_KIND[role]) return ROLE_KIND[role];
  switch (tag) {
    case 'A': case 'AREA': return el.hasAttribute('href') ? 'link' : null;
    case 'BUTTON': case 'SUMMARY': return 'button';
    case 'INPUT':
      if (INPUT_BUTTON.has(el.type)) return 'button';
      if (el.type === 'checkbox') return el.hasAttribute('switch') ? 'switch' : 'checkbox';
      if (el.type === 'radio') return 'radio';
      return 'input';
    case 'TEXTAREA': return 'input';
    case 'SELECT': return 'select';
    case 'H1': case 'H2': case 'H3': case 'H4': case 'H5': case 'H6': return 'heading';
    case 'IMG': return 'image';
    case 'svg': return el.querySelector(':scope > title') || el.getAttribute('aria-label') ? 'image' : null;
    case 'LI': return 'listitem';
    case 'OPTION': return 'option';
    case 'DIALOG': return 'dialog';
  }
  return el.isContentEditable && el.contentEditable !== 'inherit' ? 'input' : null;
};
const scrollable = (el, cs) => {
  const ox = cs.overflowX;
  const oy = cs.overflowY;
  const can = (o) => o === 'auto' || o === 'scroll' || o === 'overlay';
  return (can(oy) && el.scrollHeight > el.clientHeight + 1) || (can(ox) && el.scrollWidth > el.clientWidth + 1);
};
const nodes = [];
const indexOf = new Map();
const elements = [document.body];
let truncated = false;
const se = document.scrollingElement || document.documentElement;
nodes.push({ parent: -1, kind: 'document', name: clean(document.title) || null, text: null, id: null, value: null, hint: null, x: 0, y: 0, w: W, h: H, flags: ['enabled'].concat(se.scrollHeight > H + 1 || se.scrollWidth > W + 1 ? ['scrollable'] : []) });
indexOf.set(document.body, 0);
const walk = (el, parent, parentPointer) => {
  if (SKIP.has(el.tagName) || el.hidden || el.getAttribute('aria-hidden') === 'true') return;
  if (el.tagName === 'INPUT' && el.type === 'hidden') return;
  const cs = getComputedStyle(el);
  if (cs.display === 'none' || Number(cs.opacity) === 0) return;
  const r = el.getBoundingClientRect();
  const shown = cs.display !== 'contents' && cs.visibility === 'visible' && r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 && r.left < W && r.top < H;
  const pointer = cs.cursor === 'pointer';
  let me = parent;
  if (shown) {
    if (nodes.length >= CAP) { truncated = true; return; }
    const tag = el.tagName;
    let kind = kindOf(el);
    const leaf = LEAF.has(tag) || kind === 'input' || kind === 'password' || kind === 'select';
    const own = leaf ? '' : clean(flatChildNodes(el).filter((c) => c.nodeType === 3).map((c) => c.data).join(' '));
    const disabled = el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true';
    const isScroll = scrollable(el, cs);
    const textual = (tag === 'INPUT' && TEXT_INPUT.has(el.type)) || tag === 'TEXTAREA' || (kind === 'input' && el.isContentEditable);
    const ariaChecked = el.getAttribute('aria-checked');
    const ariaPressed = el.getAttribute('aria-pressed');
    const checkable = kind === 'checkbox' || kind === 'radio' || kind === 'switch' || ariaChecked !== null || ariaPressed !== null;
    const checked = el.checked === true || ariaChecked === 'true' || ariaPressed === 'true';
    if (!kind) kind = isScroll ? 'scroll' : own ? 'text' : 'generic';
    let value = null;
    if (kind === 'password') value = '\u2022'.repeat(String(el.value || '').length);
    else if (tag === 'SELECT') value = el.selectedIndex >= 0 ? clean(el.options[el.selectedIndex].label) : null;
    else if (tag === 'INPUT' && !checkable && !INPUT_BUTTON.has(el.type)) value = el.value;
    else if (tag === 'TEXTAREA') value = el.value;
    else if (kind === 'input' && el.isContentEditable) value = el.innerText;
    const flags = [];
    if (CLICK_KINDS.has(kind) || el.hasAttribute('onclick') || (pointer && !parentPointer)) flags.push('clickable');
    if (el.tabIndex >= 0 && !disabled) flags.push('focusable');
    if (!disabled) flags.push('enabled');
    if (checkable) flags.push('checkable');
    if (checked) flags.push('checked');
    if (el.getAttribute('aria-selected') === 'true' || (tag === 'OPTION' && el.selected)) flags.push('selected');
    if (el === active) flags.push('focused');
    if (isScroll) flags.push('scrollable');
    if (textual && !disabled && !el.readOnly) flags.push('editable');
    if (kind === 'heading') flags.push('heading');
    if (kind === 'password') flags.push('password');
    me = nodes.length;
    indexOf.set(el, me);
    elements.push(el);
    nodes.push({
      parent,
      kind,
      name: nameOf(el),
      text: own || null,
      id: el.id || el.getAttribute('data-testid') || null,
      value,
      hint: el.getAttribute('placeholder') || el.getAttribute('aria-placeholder') || null,
      x: r.left, y: r.top, w: r.width, h: r.height,
      flags,
    });
    if (leaf) return;
  } else if (LEAF.has(el.tagName)) return;
  for (const c of flatChildNodes(el)) if (c.nodeType === 1) walk(c, me, pointer);
};
for (const c of flatChildNodes(document.body)) if (c.nodeType === 1) walk(c, 0, false);

const layers = new Set();
for (let i = 1; i < nodes.length; i++) {
  const n = nodes[i];
  if (!n.text && !n.flags.includes('clickable') && !n.flags.includes('editable') && !n.flags.includes('checkable')) continue;
  const el = elements[i];
  const x0 = Math.max(0, n.x), y0 = Math.max(0, n.y), x1 = Math.min(W, n.x + n.w), y1 = Math.min(H, n.y + n.h);
  if (x1 <= x0 || y1 <= y0) continue;
  const hit = deepHit((x0 + x1) / 2, (y0 + y1) / 2);
  if (!hit || composedContains(el, hit) || composedContains(hit, el)) continue;
  let layer = hit;
  for (let a = hit; a && a !== document.body && a !== document.documentElement; a = composedParent(a)) {
    if (a.nodeType === 1) {
      const p = getComputedStyle(a).position;
      if (p === 'fixed' || p === 'sticky') { layer = a; break; }
    }
  }
  if (composedContains(layer, el)) layer = hit;
  layers.add(layer);
}
for (const layer of layers) {
  let i = indexOf.get(layer);
  if (i === undefined) {
    let parent = 0;
    for (let a = composedParent(layer); a; a = composedParent(a)) if (indexOf.has(a)) { parent = indexOf.get(a); break; }
    const r = layer.getBoundingClientRect();
    i = nodes.length;
    indexOf.set(layer, i);
    elements.push(layer);
    nodes.push({ parent, kind: 'overlay', name: null, text: null, id: layer.id || null, value: null, hint: null, x: r.left, y: r.top, w: r.width, h: r.height, flags: ['enabled'] });
  }
  const n = nodes[i];
  if (n.kind === 'generic' || n.kind === 'text' || n.kind === 'scroll') n.kind = 'overlay';
  if (!n.flags.includes('clickable')) n.flags.push('clickable');
  n.flags.push('occluder');
}
return { url: location.href, title: document.title, width: W, height: H, dpr: window.devicePixelRatio, scrollX: window.scrollX, scrollY: window.scrollY, truncated, nodes };
`;

const finite = z.number().finite();
const nullableText = z.string().nullable();
const WebExtractNode = z.object({
  parent: z.number().int().min(-1),
  kind: z.enum(WEB_KINDS),
  name: nullableText,
  text: nullableText,
  id: nullableText,
  value: nullableText,
  hint: nullableText,
  x: finite,
  y: finite,
  w: finite.min(0),
  h: finite.min(0),
  flags: z.array(z.enum(WEB_FLAGS)),
});
const WebExtract = z
  .object({
    url: z.string(),
    title: z.string(),
    width: finite.positive(),
    height: finite.positive(),
    dpr: finite.positive(),
    scrollX: finite,
    scrollY: finite,
    truncated: z.boolean(),
    nodes: z.array(WebExtractNode).min(1),
  })
  .superRefine((e, ctx) => {
    e.nodes.forEach((n, i) => {
      const rootOk = i === 0 ? n.parent === -1 && n.kind === 'document' : n.parent >= 0 && n.parent < i;
      if (!rootOk) ctx.addIssue({ code: 'custom', path: ['nodes', i, 'parent'], message: i === 0 ? 'root must be the document node' : 'parent must precede the node' });
    });
  });
type WebExtractNode = z.infer<typeof WebExtractNode>;

// XML 1.0 forbids C0 controls other than tab/newline/CR (and lone surrogates / U+FFFE-F).
const XML_INVALID = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const XML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\n': '&#10;', '\r': '&#13;', '\t': '&#9;' };

function attr(name: string, value: string | number | null): string {
  if (value === null || value === '') return '';
  return ` ${name}="${String(value).replace(XML_INVALID, '').replace(/[&<>"\n\r\t]/g, (c) => XML_ESCAPES[c]!)}"`;
}

function nodeXml(n: WebExtractNode): string {
  const flags = new Set<WebFlag>(n.flags);
  // Fail-closed: whatever the page script reported, a password node never carries its value.
  if (n.kind === 'password') flags.add('password');
  const value = flags.has('password') && n.value !== null ? '\u2022'.repeat([...n.value].length) : n.value;
  const x1 = Math.round(n.x);
  const y1 = Math.round(n.y);
  const bounds = `[${x1},${y1}][${Math.max(x1, Math.round(n.x + n.w))},${Math.max(y1, Math.round(n.y + n.h))}]`;
  let out = `<node${attr('class', `web:${n.kind}`)}${attr('text', n.text)}${attr('content-desc', n.name)}${attr('resource-id', n.id)}`;
  out += `${attr('value', value)}${attr('hint', n.hint)}${attr('bounds', bounds)}`;
  for (const f of WEB_FLAGS) {
    // Only non-default flags are written: absent = false, except `enabled` (absent = true).
    if (f === 'enabled') out += flags.has(f) ? '' : ' enabled="false"';
    else if (flags.has(f)) out += ` ${f}="true"`;
  }
  return out;
}

/**
 * Validates a `WEB_EXTRACT_SCRIPT` result (throws on a malformed extract) and serializes the canonical web XML:
 * `<web url title width height dpr [truncated]>` wrapping nested `<node class="web:<kind>" …>` elements (UIA2-like
 * attributes; `password="true"` marks secure fields so the evidence sanitizer masks them structurally).
 */
export function webSourceFromExtract(extract: unknown): { xml: string; screen: Rect; pageUrl: string; title: string; truncated: boolean } {
  const parsed = WebExtract.safeParse(extract);
  if (!parsed.success) throw new Error(`웹 페이지 구조 추출 결과가 올바르지 않습니다: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  const e = parsed.data;
  const children: number[][] = e.nodes.map(() => []);
  e.nodes.forEach((n, i) => {
    if (i > 0) children[n.parent]!.push(i);
  });
  const parts: string[] = [
    `<?xml version="1.0" encoding="UTF-8"?><web${attr('url', e.url)}${attr('title', e.title)}${attr('width', e.width)}${attr('height', e.height)}${attr('dpr', e.dpr)}${e.truncated ? ' truncated="true"' : ''}>`,
  ];
  const stack: { i: number; open: boolean }[] = [{ i: 0, open: false }];
  while (stack.length) {
    const top = stack.pop()!;
    if (top.open) {
      parts.push('</node>');
      continue;
    }
    const kids = children[top.i]!;
    const open = nodeXml(e.nodes[top.i]!);
    if (!kids.length) {
      parts.push(`${open}/>`);
      continue;
    }
    parts.push(`${open}>`);
    stack.push({ i: top.i, open: true });
    for (let k = kids.length - 1; k >= 0; k--) stack.push({ i: kids[k]!, open: false });
  }
  parts.push('</web>');
  return { xml: parts.join(''), screen: { x: 0, y: 0, width: e.width, height: e.height }, pageUrl: e.url, title: e.title, truncated: e.truncated };
}

/** Rides along on desktop web RawNodes: the extract's hit test found this node covering an interactive element. */
export interface WebExtras {
  occluder: boolean;
}

const BOUNDS = /^\[(-?[\d.]+),(-?[\d.]+)\]\[(-?[\d.]+),(-?[\d.]+)\]$/;

interface WebPending {
  node: RawNode & WebExtras;
  children: WebPending[];
}

/**
 * Parses the canonical web XML. Ids are DFS pre-order path ids (`0`, `0.1`, `0.1.2`). z = DFS order, except that every
 * occluder subtree is lifted above all non-occluder nodes (a covering layer is painted over what it covers even when
 * it comes earlier in the DOM); the result stays pre-order (parents before children) and is sorted by z.
 * `screen` is accepted for signature symmetry with the native parsers; rects are already viewport CSS px.
 */
export function parseWebSource(xml: string, _screen: Rect): RawNode[] {
  const roots: WebPending[] = [];
  const stack: (WebPending | null)[] = [];
  scanXml(xml, {
    open(tag, a) {
      if (tag === 'web' && stack.length === 0) {
        stack.push(null);
        return;
      }
      if (tag !== 'node') throw new Error(`웹 소스에 알 수 없는 요소 <${tag}>`);
      const m = BOUNDS.exec(a.bounds ?? '');
      const [x1, y1, x2, y2] = m ? [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])] : [0, 0, 0, 0];
      const flags: NodeFlags = {
        clickable: a.clickable === 'true' || a.occluder === 'true',
        longClickable: false,
        focusable: a.focusable === 'true',
        checkable: a.checkable === 'true',
        checked: a.checked === 'true',
        enabled: a.enabled !== 'false',
        selected: a.selected === 'true',
        focused: a.focused === 'true',
        scrollable: a.scrollable === 'true',
        password: a.password === 'true',
        editable: a.editable === 'true',
        heading: a.heading === 'true',
      };
      const pending: WebPending = {
        node: {
          id: '',
          parentId: null,
          childIds: [],
          z: 0,
          windowId: null,
          className: a.class || 'web:generic',
          text: a.text || null,
          desc: a['content-desc'] || null,
          resourceId: a['resource-id'] || null,
          value: a.value || null,
          hint: a.hint || null,
          rect: { x: x1, y: y1, width: Math.max(0, x2 - x1), height: Math.max(0, y2 - y1) },
          flags,
          occluder: a.occluder === 'true',
        },
        children: [],
      };
      const parent = stack.length ? stack[stack.length - 1]! : null;
      (parent ? parent.children : roots).push(pending);
      stack.push(pending);
    },
    close() {
      stack.pop();
    },
  });

  const base: (RawNode & WebExtras)[] = [];
  const lifted: (RawNode & WebExtras)[] = [];
  const visit = (p: WebPending, id: string, parentId: string | null, inLifted: boolean): void => {
    const n = p.node;
    n.id = id;
    n.parentId = parentId;
    const up = inLifted || n.occluder;
    (up ? lifted : base).push(n);
    p.children.forEach((c, k) => {
      const childId = `${id}.${k}`;
      n.childIds.push(childId);
      visit(c, childId, id, up);
    });
  };
  roots.forEach((r, k) => visit(r, String(k), null, false));
  const out = [...base, ...lifted];
  out.forEach((n, z) => (n.z = z));
  return out;
}
