// XCUITest `/source` → RawNode[] in document (paint) order, with touchability derived from element types.
import type { NodeFlags, RawNode, Rect } from '../core/types.ts';
import { scanXml } from './text.ts';

/**
 * XCUITest reports no clickable flag. These element types intercept touches, so they may occlude what is below them
 * (and are the tap targets themselves). UIKit bars (TabBar, NavigationBar, Toolbar) swallow touches across their frame
 * even where content shows through. Generic containers (Other, Window…) do not: RN/XCUITest emit many full-screen
 * `Other` elements drawn above interactive content (e.g. after a sheet's rows) that never block touches.
 */
const TOUCHABLE_TYPES: Record<string, true> = {
  Button: true,
  Link: true,
  Cell: true,
  TextField: true,
  SecureTextField: true,
  SearchField: true,
  TextView: true,
  Switch: true,
  Toggle: true,
  Slider: true,
  Stepper: true,
  Tab: true,
  SegmentedControl: true,
  Picker: true,
  PickerWheel: true,
  DatePicker: true,
  MenuItem: true,
  MenuButton: true,
  PopUpButton: true,
  ComboBox: true,
  CheckBox: true,
  RadioButton: true,
  DisclosureTriangle: true,
  Incrementor: true,
  ColorWell: true,
  PageIndicator: true,
  Icon: true,
  Key: true,
  Keyboard: true,
  Alert: true,
  TabBar: true,
  NavigationBar: true,
  Toolbar: true,
};
const SCROLL_TYPES: Record<string, true> = { ScrollView: true, Table: true, CollectionView: true, WebView: true, Map: true };
const EDITABLE_TYPES: Record<string, true> = { TextField: true, SecureTextField: true, SearchField: true, TextView: true };
const CHECKABLE_TYPES: Record<string, true> = { Switch: true, Toggle: true, CheckBox: true, RadioButton: true };
/** RN/SwiftUI elements often come through as `Other` with a role trait; type them by that trait (first match wins). */
const OTHER_TRAIT_TYPES = ['KeyboardKey', 'TabBar', 'SearchField', 'Link', 'Button', 'Image', 'StaticText'] as const;
const TRAIT_TYPE_NAMES: Record<(typeof OTHER_TRAIT_TYPES)[number], string> = {
  KeyboardKey: 'Key',
  TabBar: 'TabBar',
  SearchField: 'SearchField',
  Link: 'Link',
  Button: 'Button',
  Image: 'Image',
  StaticText: 'StaticText',
};

/**
 * WebKit exposes a web `role="dialog"` element as `Other` whose label ends with the localized role description
 * ("도움말, 웹 대화상자" / "Help, web dialog"). Its box swallows touches (a modal's full-screen container sits over the
 * page), so it is marked focusable = touch-intercepting without becoming a target itself.
 */
const WEB_DIALOG_LABEL = /,\s*(웹 대화상자|web dialog)$/i;

/**
 * Modal backdrop: UIKit sheet/popover presentations insert a dimming/dismiss region (RN: Other "dismiss popup",
 * name PopoverDismissRegion; sometimes unlabelled) whose frame is 3× the screen (e.g. -402,-874 1206×2622).
 * It swallows every touch outside the sheet, so everything drawn before it is unreachable. Plain full-screen
 * containers are exactly screen-sized and never qualify.
 */
export function isIosBackdrop(n: RawNode, screen: Rect): boolean {
  if (n.desc === 'dismiss popup' || n.resourceId === 'PopoverDismissRegion') return true;
  const r = n.rect;
  return (
    r.x < screen.x &&
    r.y < screen.y &&
    r.x + r.width > screen.x + screen.width &&
    r.y + r.height > screen.y + screen.height
  );
}

/**
 * The on-screen keyboard is drawn by a host container larger than the `Keyboard` element (candidate bar above the
 * keys, globe/dictation row below). Host = outermost ancestor of a Keyboard node that is still smaller than 90% of the
 * screen and not a Window/Application. Its whole area covers app content and nothing inside it is an app target.
 */
export function iosKeyboardHosts(nodes: readonly RawNode[], screen: Rect): RawNode[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const limit = 0.9 * screen.width * screen.height;
  const hosts = new Map<string, RawNode>();
  for (const n of nodes) {
    if (n.className !== 'Keyboard') continue;
    let host = n;
    for (let p = n.parentId ? byId.get(n.parentId) : undefined; p; p = p.parentId ? byId.get(p.parentId) : undefined) {
      if (p.className === 'Window' || p.className === 'Application' || p.rect.width * p.rect.height >= limit) break;
      host = p;
    }
    hosts.set(host.id, host);
  }
  return [...hosts.values()];
}

/**
 * Parses an XCUITest page source (`pageSourceExcludedAttributes=visible,accessible,index`, so visibility is computed
 * later). z = DFS pre-order document order; rects are in points. `XCUIElementType` prefix is removed and `Other`
 * elements carrying a role trait are typed by it. `clickable` marks touch-intercepting elements: touchable types,
 * Button/Link/KeyboardKey traits, modal backdrops and keyboard hosts.
 */
export function parseIosSource(xml: string, screen: Rect): RawNode[] {
  const out: RawNode[] = [];
  const stack: { node: RawNode; childCount: number; windowId: string | null }[] = [];
  let rootCount = 0;
  scanXml(xml, {
    open(tag, a) {
      if (!tag.startsWith('XCUIElementType')) {
        stack.push({ node: null as never, childCount: 0, windowId: null });
        return;
      }
      const parent = stack.length ? stack[stack.length - 1]! : null;
      const parentNode = parent?.node ?? null;
      const index = parentNode ? parent!.childCount++ : rootCount++;
      const id = parentNode ? `${parentNode.id}.${index}` : String(index);
      const traits = new Set((a.traits ?? '').split(',').map((t) => t.trim()).filter(Boolean));
      let type = (a.type || tag).replace(/^XCUIElementType/, '');
      if (type === 'Other') {
        const trait = OTHER_TRAIT_TYPES.find((t) => traits.has(t));
        if (trait) type = TRAIT_TYPE_NAMES[trait];
      }
      const label = a.label || null;
      const placeholder = a.placeholderValue || null;
      const rawValue = a.value || null;
      const editable = EDITABLE_TYPES[type] === true;
      const checkable = CHECKABLE_TYPES[type] === true;
      const isText = type === 'StaticText';
      const flags: NodeFlags = {
        clickable: TOUCHABLE_TYPES[type] === true || traits.has('Button') || traits.has('Link') || traits.has('KeyboardKey'),
        longClickable: false,
        focusable: type === 'Other' && label !== null && WEB_DIALOG_LABEL.test(label),
        checkable,
        checked: checkable && (rawValue === '1' || rawValue === 'true' || rawValue === 'on'),
        enabled: a.enabled !== 'false' && !traits.has('NotEnabled'),
        selected: a.selected === 'true' || traits.has('Selected'),
        focused: a.focused === 'true' || a.hasFocus === 'true',
        scrollable: SCROLL_TYPES[type] === true,
        password: type === 'SecureTextField',
        editable,
        heading: traits.has('Header'),
      };
      const windowId = type === 'Window' ? id : (parent?.windowId ?? null);
      const node: RawNode = {
        id,
        parentId: parentNode ? parentNode.id : null,
        childIds: [],
        z: out.length,
        windowId,
        className: type,
        text: isText ? (rawValue ?? label) : null,
        desc: label,
        resourceId: a.name || null,
        // An empty field reports its placeholder as value; that is not content.
        value: isText || (editable && rawValue === placeholder) ? null : rawValue,
        hint: placeholder,
        rect: {
          x: Number(a.x ?? 0),
          y: Number(a.y ?? 0),
          width: Math.max(0, Number(a.width ?? 0)),
          height: Math.max(0, Number(a.height ?? 0)),
        },
        flags,
      };
      if (isIosBackdrop(node, screen)) node.flags.clickable = true;
      parentNode?.childIds.push(id);
      out.push(node);
      stack.push({ node, childCount: 0, windowId });
    },
    close() {
      stack.pop();
    },
  });
  for (const host of iosKeyboardHosts(out, screen)) host.flags.clickable = true;
  return out;
}
