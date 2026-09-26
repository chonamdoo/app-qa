// A laid-out page for running the real WEB_EXTRACT_SCRIPT without a browser: the DOM surface the script reads
// (tree, attributes, computed style, boxes, elementFromPoint, ranges) with boxes given by the test instead of a layout
// engine. Enough for pages of plain elements and text; no shadow roots, forms or scrolling.
import { WEB_EXTRACT_SCRIPT } from '../../src/observe/web.ts';

type Box = [x: number, y: number, width: number, height: number];

export interface PageText {
  text: string;
  box: Box;
}

export interface PageElement {
  tag: string;
  box: Box;
  attrs?: Record<string, string>;
  style?: Partial<Record<'display' | 'visibility' | 'opacity' | 'cursor' | 'position', string>>;
  children?: (PageElement | PageText)[];
}

const DEFAULT_STYLE = { display: 'block', visibility: 'visible', opacity: '1', cursor: 'auto', position: 'static', overflowX: 'visible', overflowY: 'visible' };
const FOCUSABLE_TAGS: Record<string, true> = { BUTTON: true, A: true, INPUT: true, SELECT: true, TEXTAREA: true };

class FakeShadowRoot {}

interface FakeNode {
  nodeType: number;
  parentNode: FakeNode | null;
  assignedSlot: null;
  box: Box;
  getRootNode(): FakeNode;
}

function rect([x, y, width, height]: Box) {
  return { left: x, top: y, right: x + width, bottom: y + height, width, height, x, y };
}

/** Runs WEB_EXTRACT_SCRIPT on `body` (its children laid out as given) in a `width` × `height` viewport and returns the extract. */
export function runExtract(body: PageElement, viewport: { width: number; height: number }, title = '문서'): unknown {
  const document = {
    nodeType: 9,
    parentNode: null,
    title,
    activeElement: null as unknown,
    body: null as unknown,
    documentElement: null as unknown,
    scrollingElement: null as unknown,
    getRootNode: () => document,
    getElementById: () => null,
    createRange: () => {
      let node: FakeNode | null = null;
      return { selectNodeContents: (n: FakeNode) => void (node = n), getBoundingClientRect: () => rect(node!.box) };
    },
    elementFromPoint: (x: number, y: number) => {
      let hit: unknown = null;
      for (const el of order) {
        const [bx, by, bw, bh] = el.box;
        if (styles.get(el)!.display !== 'none' && x >= bx && y >= by && x < bx + bw && y < by + bh) hit = el;
      }
      return hit;
    },
  };
  const styles = new Map<FakeNode, typeof DEFAULT_STYLE>();
  /** Elements in document order: the last one containing a point is on top (no z-index in these pages). */
  const order: FakeNode[] = [];
  const build = (spec: PageElement | PageText, parentNode: FakeNode): FakeNode => {
    if ('text' in spec) return { nodeType: 3, data: spec.text, parentNode, assignedSlot: null, box: spec.box, getRootNode: () => document as unknown as FakeNode } as FakeNode;
    const attrs = spec.attrs ?? {};
    const tagName = spec.tag.toUpperCase();
    const el = {
      nodeType: 1,
      tagName,
      parentNode,
      assignedSlot: null,
      shadowRoot: null,
      box: spec.box,
      childNodes: [] as FakeNode[],
      hidden: 'hidden' in attrs,
      id: attrs.id ?? '',
      tabIndex: FOCUSABLE_TAGS[tagName] ? 0 : -1,
      isContentEditable: false,
      contentEditable: 'inherit',
      scrollHeight: 0,
      clientHeight: 0,
      scrollWidth: 0,
      clientWidth: 0,
      getAttribute: (name: string) => attrs[name] ?? null,
      hasAttribute: (name: string) => name in attrs,
      matches: (selector: string) => selector === ':disabled' && 'disabled' in attrs,
      getBoundingClientRect: () => rect(spec.box),
      getRootNode: () => document as unknown as FakeNode,
    };
    styles.set(el, { ...DEFAULT_STYLE, ...spec.style });
    order.push(el);
    el.childNodes = (spec.children ?? []).map((c) => build(c, el));
    return el;
  };
  const html = build({ tag: 'html', box: [0, 0, viewport.width, viewport.height], children: [] }, document as unknown as FakeNode) as FakeNode & { childNodes: FakeNode[] };
  const bodyEl = build(body, html);
  html.childNodes = [bodyEl];
  document.body = bodyEl;
  document.documentElement = html;
  document.scrollingElement = html;
  document.activeElement = bodyEl;
  const window = { innerWidth: viewport.width, innerHeight: viewport.height, devicePixelRatio: 2, scrollX: 0, scrollY: 0 };
  const run = new Function('window', 'document', 'location', 'getComputedStyle', 'ShadowRoot', WEB_EXTRACT_SCRIPT);
  return run(window, document, { href: 'http://localhost:4173/' }, (el: FakeNode) => styles.get(el), FakeShadowRoot);
}
