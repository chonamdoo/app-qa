// UiAutomator2 `/source` → RawNode[] in global paint order.
import type { NodeFlags, RawNode, Rect } from '../core/types.ts';
import { scanXml } from './text.ts';

/**
 * Fields UiAutomator2 exposes that the shared RawNode contract does not carry yet.
 * They ride along on the node objects; buildScreenModel reads them (system-UI/IME removal, error text).
 */
export interface AndroidExtras {
  /** Owning package (`com.android.systemui`, IME packages, the app…). */
  package: string | null;
  /** EditText.setError / Compose error text. */
  error: string | null;
}

interface Pending {
  node: RawNode & AndroidExtras;
  drawingOrder: number;
  docIndex: number;
  children: Pending[];
}

const BOUNDS = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/;
const EDITABLE_CLASS = /EditText|AutoCompleteTextView|SearchAutoComplete/;
/**
 * Chrome exposes a web `role="dialog"` element as this class (native dialogs are FrameLayout decor views). Its box
 * swallows touches (a modal's full-screen container sits over the page), so it is marked focusable = touch-intercepting
 * without becoming a target itself.
 */
const WEB_DIALOG_CLASS = 'android.app.AlertDialog';

function parseBounds(bounds: string | undefined): Rect {
  const m = bounds ? BOUNDS.exec(bounds) : null;
  if (!m) return { x: 0, y: 0, width: 0, height: 0 };
  const [x1, y1, x2, y2] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  return { x: x1, y: y1, width: Math.max(0, x2 - x1), height: Math.max(0, y2 - y1) };
}

/**
 * Parses a UiAutomator2 page source. Global z = window order (document order of `<hierarchy>` children), then DFS
 * pre-order with siblings sorted by `drawing-order` (stable on document order). Returned array is sorted by z.
 * Nodes with `displayed="false"` are dropped with their subtree (not visible to the user, cannot receive touches).
 * Showing-hint text is reported as `hint` only; editable text is reported as `value` (never as `text`).
 * `screen` is accepted for signature symmetry with parseIosSource; UIA2 bounds are already in device pixels.
 */
export function parseAndroidSource(xml: string, _screen: Rect): RawNode[] {
  const roots: Pending[] = [];
  const stack: (Pending | null)[] = [];
  let hiddenDepth = 0;
  scanXml(xml, {
    open(tag, a) {
      if (hiddenDepth > 0) {
        hiddenDepth++;
        return;
      }
      if (tag === 'hierarchy' && stack.length === 0) {
        stack.push(null);
        return;
      }
      const parent = stack.length ? stack[stack.length - 1]! : null;
      const siblings = parent ? parent.children : roots;
      const docIndex = siblings.length;
      if (a.displayed === 'false') {
        // Keep the slot so path ids of later siblings stay stable, but drop the subtree.
        siblings.push({ node: null as never, drawingOrder: Number.NaN, docIndex, children: [] });
        hiddenDepth = 1;
        return;
      }
      const className = a.class || tag;
      const showingHint = a['showing-hint'] === 'true';
      const password = a.password === 'true';
      const editable = EDITABLE_CLASS.test(className) || (a['input-type'] !== undefined && a['input-type'] !== '0');
      const rawText = a.text || null;
      const flags: NodeFlags = {
        clickable: a.clickable === 'true',
        longClickable: a['long-clickable'] === 'true',
        focusable: a.focusable === 'true' || className === WEB_DIALOG_CLASS,
        checkable: a.checkable === 'true',
        checked: a.checked === 'true',
        enabled: a.enabled !== 'false',
        selected: a.selected === 'true',
        focused: a.focused === 'true',
        scrollable: a.scrollable === 'true',
        password,
        editable,
        heading: a.heading === 'true',
      };
      const node: RawNode & AndroidExtras = {
        id: '',
        parentId: null,
        childIds: [],
        z: 0,
        windowId: a['window-id'] || null,
        className,
        text: showingHint || editable || password ? null : rawText,
        desc: a['content-desc'] || null,
        resourceId: a['resource-id'] || null,
        value: !showingHint && (editable || password) ? rawText : null,
        hint: a.hint || (showingHint ? rawText : null),
        rect: parseBounds(a.bounds),
        flags,
        package: a.package || null,
        error: a.error || null,
      };
      const pending: Pending = { node, drawingOrder: Number(a['drawing-order'] ?? 0), docIndex, children: [] };
      siblings.push(pending);
      stack.push(pending);
    },
    close() {
      if (hiddenDepth > 0) {
        hiddenDepth--;
        return;
      }
      stack.pop();
    },
  });

  const out: RawNode[] = [];
  const visit = (p: Pending, id: string, parentId: string | null): void => {
    const n = p.node;
    n.id = id;
    n.parentId = parentId;
    n.z = out.length;
    out.push(n);
    const kids = p.children
      .filter((c) => c.node)
      .sort((a, b) => a.drawingOrder - b.drawingOrder || a.docIndex - b.docIndex);
    for (const c of kids) {
      const childId = `${id}.${c.docIndex}`;
      n.childIds.push(childId);
      visit(c, childId, id);
    }
  };
  for (const r of roots) if (r.node) visit(r, String(r.docIndex), null);
  return out;
}
