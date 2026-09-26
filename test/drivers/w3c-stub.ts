// A scripted desktop browser for DesktopWebDriver tests, on top of the Appium HTTP stub: session `s1`, a window whose
// viewport is its outer size minus the browser chrome, and one page that answers the driver's read-only scripts and
// applies mouse clicks and key actions the way a text field would (⌘A selects all, Backspace deletes, keys insert).
import { W3C_ELEMENT_KEY, W3C_KEYS } from '../../src/appium/client.ts';
import type { Rect } from '../../src/core/types.ts';
import { DESKTOP_SCRIPTS } from '../../src/drivers/desktop.ts';
import { WEB_EXTRACT_SCRIPT } from '../../src/observe/web.ts';
import { startAppiumStub, type AppiumStub, type Reply, type StubRequest } from './stubs.ts';

export interface FakeField {
  value: string;
  password: boolean;
  /** Characters the field keeps (like `maxlength`); the rest of the typing is dropped. */
  maxLength?: number;
  /** The page ignores ⌘A + Backspace (e.g. a field that re-fills itself). */
  ignoresClear?: boolean;
}

export interface FakePage {
  /** Browser chrome around the viewport: viewport = window − chrome. */
  chrome: { width: number; height: number };
  window: Rect;
  /** Largest window the screen allows (the window manager clamps larger requests). */
  maxWindow: { width: number; height: number };
  /** Field a click focuses; null = clicks focus nothing that takes text. */
  field: FakeField | null;
  history: { length: number; canGoBack: boolean | null };
  /** What `elementFromPoint` + ancestors report: [x, y, width, height] per box. */
  hitBoxes: unknown;
  /** Answer to WEB_EXTRACT_SCRIPT. */
  extract: unknown;
  /** Browser console buffer; `/se/log` drains it. */
  console: { timestamp: number; level: string; message: string }[];
  /** `document.hasFocus()`: the window is in front. */
  front: boolean;
  /** Switch To Window brings the window to the front (false: another app keeps it). */
  raises: boolean;
}

export interface W3CStub extends AppiumStub {
  page: FakePage;
  /** Actions of every `POST /actions` source, in order. */
  sources(): Record<string, unknown>[];
  /** Name (`DESKTOP_SCRIPTS` key or `extract`) of every executed script, in order. */
  scripts(): string[];
}

const SCRIPT_NAMES = new Map<string, string>([...Object.entries(DESKTOP_SCRIPTS).map(([name, text]): [string, string] => [text, name]), [WEB_EXTRACT_SCRIPT, 'extract']]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]).toString('base64');
const FIELD_REF = { [W3C_ELEMENT_KEY]: 'F1' };
const SPECIAL_KEYS = new Set<string>(Object.values(W3C_KEYS));

/** A valid WEB_EXTRACT_SCRIPT answer: the document plus one 검색 button. */
export function sampleExtract(over: Record<string, unknown> = {}): Record<string, unknown> {
  const node = (parent: number, kind: string, text: string | null, x: number, y: number, w: number, h: number, flags: string[]) => ({ parent, kind, name: null, text, id: null, value: null, hint: null, x, y, w, h, flags });
  return {
    url: 'http://localhost:4173/?q=1',
    title: '데모',
    width: 1280,
    height: 800,
    dpr: 2,
    scrollX: 0,
    scrollY: 0,
    truncated: false,
    nodes: [node(-1, 'document', null, 0, 0, 1280, 800, ['enabled']), node(0, 'button', '검색', 564, 86, 60, 44, ['clickable', 'focusable', 'enabled'])],
    ...over,
  };
}

const ok = (value: unknown): Reply => ({ body: { value } });

/** Starts the fake browser; `override` answers first (return undefined to fall through to the page). */
export async function startW3CStub(init: Partial<FakePage> = {}, override?: (req: StubRequest) => Reply | undefined): Promise<W3CStub> {
  const page: FakePage = {
    chrome: { width: 0, height: 87 },
    window: { x: 0, y: 0, width: 1000, height: 700 },
    maxWindow: { width: 3000, height: 2000 },
    field: { value: '', password: false },
    history: { length: 2, canGoBack: true },
    hitBoxes: [],
    extract: sampleExtract(),
    console: [],
    front: true,
    raises: true,
    ...init,
  };
  const sources: Record<string, unknown>[] = [];
  const scripts: string[] = [];
  let focused = false;
  let selected = false;
  let meta = false;

  const key = (value: string, down: boolean) => {
    if (value === W3C_KEYS.meta) return void (meta = down);
    const f = page.field;
    if (!down || !focused || !f) return;
    if (meta) {
      if (value === 'a') selected = !f.ignoresClear;
      if (value === W3C_KEYS.arrowDown) selected = false;
      return;
    }
    if (value === W3C_KEYS.backspace) {
      f.value = selected ? '' : [...f.value].slice(0, -1).join('');
    } else if (!SPECIAL_KEYS.has(value)) {
      const next = (selected ? '' : f.value) + value;
      f.value = [...next].slice(0, f.maxLength ?? Infinity).join('');
    }
    selected = false;
  };

  const perform = (body: Record<string, unknown> | null) => {
    for (const source of (body?.actions ?? []) as { type: string; actions: Record<string, unknown>[] }[]) {
      sources.push(source);
      for (const a of source.actions) {
        if (source.type === 'pointer' && a.type === 'pointerDown') focused = page.field !== null;
        if (source.type === 'key') key(String(a.value), a.type === 'keyDown');
      }
    }
  };

  const script = (body: Record<string, unknown> | null): Reply => {
    const name = SCRIPT_NAMES.get(String(body?.script)) ?? 'unknown';
    const args = (body?.args ?? []) as unknown[];
    scripts.push(name);
    const f = page.field;
    switch (name) {
      case 'viewport':
        return ok([page.window.width - page.chrome.width, page.window.height - page.chrome.height]);
      case 'field': {
        if (!f || (!focused && args[0] === null)) return ok(null);
        const secure = args[1] === true || f.password;
        return ok({ el: FIELD_REF, secure, length: [...f.value].length, value: secure ? null : f.value });
      }
      case 'history':
        return ok(page.history);
      case 'focused':
        return ok(page.front);
      case 'hit':
        return ok(page.hitBoxes);
      case 'extract':
        return ok(page.extract);
      default:
        return { status: 500, body: { value: { error: 'javascript error', message: `unknown script ${String(body?.script).slice(0, 40)}` } } };
    }
  };

  const stub = await startAppiumStub((req) => {
    const own = override?.(req);
    if (own !== undefined) return own;
    const { method, path, body } = req;
    if (method === 'POST' && path === '/session') return ok({ sessionId: 's1', capabilities: {} });
    if (path === '/session/s1/window/rect') {
      if (method === 'POST') {
        const want = body as Partial<Rect>;
        page.window = {
          x: want.x ?? page.window.x,
          y: want.y ?? page.window.y,
          width: Math.min(want.width ?? page.window.width, page.maxWindow.width),
          height: Math.min(want.height ?? page.window.height, page.maxWindow.height),
        };
      }
      return ok(page.window);
    }
    if (path === '/session/s1/execute/sync') return script(body);
    if (path === '/session/s1/actions') {
      perform(body);
      return ok(null);
    }
    if (path === '/session/s1/url' && method === 'POST') {
      page.history = { length: page.history.length + 1, canGoBack: true };
      return ok(null);
    }
    if (path === '/session/s1/window') {
      if (method === 'POST') page.front ||= page.raises;
      return ok(method === 'GET' ? 'W1' : null);
    }
    if (path === '/session/s1/screenshot') return ok(PNG);
    if (path === '/session/s1/se/log') return ok(page.console.splice(0));
    return ok(null);
  });
  return { ...stub, page, sources: () => sources, scripts: () => scripts };
}
