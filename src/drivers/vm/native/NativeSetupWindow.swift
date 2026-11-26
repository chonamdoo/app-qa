import AppKit
@preconcurrency import Virtualization

@MainActor
final class NativeGuestView: VZVirtualMachineView {
    var inputAllowed = false

    override var acceptsFirstResponder: Bool { inputAllowed && super.acceptsFirstResponder }
    override func hitTest(_ point: NSPoint) -> NSView? { inputAllowed ? super.hitTest(point) : nil }
    override func performKeyEquivalent(with event: NSEvent) -> Bool { inputAllowed && super.performKeyEquivalent(with: event) }
    override func keyDown(with event: NSEvent) { if inputAllowed { super.keyDown(with: event) } }
    override func keyUp(with event: NSEvent) { if inputAllowed { super.keyUp(with: event) } }
    override func flagsChanged(with event: NSEvent) { if inputAllowed { super.flagsChanged(with: event) } }
    override func mouseDown(with event: NSEvent) { if inputAllowed { super.mouseDown(with: event) } }
    override func mouseUp(with event: NSEvent) { if inputAllowed { super.mouseUp(with: event) } }
    override func mouseDragged(with event: NSEvent) { if inputAllowed { super.mouseDragged(with: event) } }
    override func mouseMoved(with event: NSEvent) { if inputAllowed { super.mouseMoved(with: event) } }
    override func rightMouseDown(with event: NSEvent) { if inputAllowed { super.rightMouseDown(with: event) } }
    override func rightMouseUp(with event: NSEvent) { if inputAllowed { super.rightMouseUp(with: event) } }
    override func rightMouseDragged(with event: NSEvent) { if inputAllowed { super.rightMouseDragged(with: event) } }
    override func otherMouseDown(with event: NSEvent) { if inputAllowed { super.otherMouseDown(with: event) } }
    override func otherMouseUp(with event: NSEvent) { if inputAllowed { super.otherMouseUp(with: event) } }
    override func otherMouseDragged(with event: NSEvent) { if inputAllowed { super.otherMouseDragged(with: event) } }
    override func scrollWheel(with event: NSEvent) { if inputAllowed { super.scrollWheel(with: event) } }
    override func magnify(with event: NSEvent) { if inputAllowed { super.magnify(with: event) } }
    override func rotate(with event: NSEvent) { if inputAllowed { super.rotate(with: event) } }
    override func swipe(with event: NSEvent) { if inputAllowed { super.swipe(with: event) } }
    override func smartMagnify(with event: NSEvent) { if inputAllowed { super.smartMagnify(with: event) } }
    override func pressureChange(with event: NSEvent) { if inputAllowed { super.pressureChange(with: event) } }
    override func tabletPoint(with event: NSEvent) { if inputAllowed { super.tabletPoint(with: event) } }
    override func tabletProximity(with event: NSEvent) { if inputAllowed { super.tabletProximity(with: event) } }
}

@MainActor
final class NativeSetupWindow: NSWindow {
    var inputAllowed = false
    private var heldKeys = Set<UInt16>()
    private var heldButtons = Set<Int>()
    private var heldModifiers: NSEvent.ModifierFlags = []

    override var canBecomeKey: Bool { inputAllowed && super.canBecomeKey }
    override var canBecomeMain: Bool { inputAllowed && super.canBecomeMain }

    var hasHeldInput: Bool {
        !heldKeys.isEmpty || !heldButtons.isEmpty || !heldModifiers.intersection([.shift, .control, .option, .command]).isEmpty
    }

    override func sendEvent(_ event: NSEvent) {
        let isInput: Bool
        switch event.type {
        case .keyDown, .keyUp, .flagsChanged,
             .leftMouseDown, .leftMouseUp, .rightMouseDown, .rightMouseUp,
             .otherMouseDown, .otherMouseUp, .leftMouseDragged, .rightMouseDragged, .otherMouseDragged,
             .mouseMoved, .mouseEntered, .mouseExited, .scrollWheel,
             .gesture, .magnify, .rotate, .swipe, .smartMagnify, .beginGesture, .endGesture,
             .pressure, .tabletPoint, .tabletProximity, .systemDefined:
            isInput = true
        default: isInput = false
        }
        guard !isInput || inputAllowed else { return }
        if isInput {
            heldModifiers = event.modifierFlags
            switch event.type {
            case .keyDown: heldKeys.insert(event.keyCode)
            case .keyUp: heldKeys.remove(event.keyCode)
            case .leftMouseDown, .rightMouseDown, .otherMouseDown: heldButtons.insert(event.buttonNumber)
            case .leftMouseUp, .rightMouseUp, .otherMouseUp: heldButtons.remove(event.buttonNumber)
            default: break
            }
        }
        super.sendEvent(event)
    }
}
