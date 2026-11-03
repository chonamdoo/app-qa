import AppKit
import Foundation
import Darwin
@preconcurrency import Virtualization

@MainActor
final class NativeHostCoordinator {
    private let store: NativeStore
    private var machines: [String: NativeMachine] = [:]

    init(store: NativeStore) throws {
        self.store = store
        for metadata in try store.load() { machines[metadata.id] = NativeMachine(metadata: metadata, store: store) }
    }

    var hasActiveWork: Bool { machines.values.contains { $0.hasActiveWork } }

    private func createOptions(_ payload: [String: NativeJSON]) throws -> NativeCreateOptions {
        try payload.requireKeys(["name", "platform", "cpuCount", "memoryMiB"], optional: ["diskGiB"])
        let name = try payload.text("name")
        guard !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, name.count <= 80,
              name.utf8.count <= 320, !name.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else {
            throw NativeFault("invalid_name", "Machine name must contain 1–80 characters without control characters")
        }
        let platform = try payload.text("platform")
        guard ["desktop-safari", "desktop-chrome"].contains(platform) else { throw NativeFault("invalid_platform", "Native macOS guests support desktop-safari or desktop-chrome") }
        let cpu = try payload.integer("cpuCount", range: VZVirtualMachineConfiguration.minimumAllowedCPUCount...VZVirtualMachineConfiguration.maximumAllowedCPUCount)
        let minimumMemory = Int((VZVirtualMachineConfiguration.minimumAllowedMemorySize + 1048575) / 1048576)
        let maximumMemory = Int(VZVirtualMachineConfiguration.maximumAllowedMemorySize / 1048576)
        let memory = try payload.integer("memoryMiB", range: minimumMemory...maximumMemory)
        let disk = payload["diskGiB"] == nil ? 64 : try payload.integer("diskGiB", range: 64...512)
        return NativeCreateOptions(name: name, platform: platform, cpuCount: cpu, memoryMiB: memory, diskGiB: disk)
    }

    func handle(_ request: NativeRequest, reply: @escaping @Sendable (NativeJSON) -> Void) {
        do {
            try store.assertRoot()
            if request.action == "probe" {
                let supported = VZVirtualMachine.isSupported
                let base: [String: NativeJSON] = [
                    "supported": .bool(supported),
                    "minimumCPUCount": .integer(VZVirtualMachineConfiguration.minimumAllowedCPUCount),
                    "maximumCPUCount": .integer(VZVirtualMachineConfiguration.maximumAllowedCPUCount),
                    "minimumMemoryMiB": .number(Double((VZVirtualMachineConfiguration.minimumAllowedMemorySize + 1048575) / 1048576)),
                    "availableMemoryMiB": .integer(try NativeResources.availableMemoryMiB()),
                    "maximumMemoryMiB": .number(Double(VZVirtualMachineConfiguration.maximumAllowedMemorySize / 1048576))
                ]
                guard supported else {
                    var result = base
                    result["restore"] = .null
                    reply(nativeSuccess(request.id, .object(result)))
                    return
                }
                NativeRestoreLookup.latest { outcome in
                    switch outcome {
                    case .success(let info):
                        guard NativeAppleDownload.allowed(info.url) else {
                            reply(nativeFailure(request.id, NativeFault("restore_url_rejected", "Apple returned an unexpected restore URL")))
                            return
                        }
                        var result = base
                        result["restore"] = .object([
                            "url": .string(info.url.absoluteString),
                            "minimumCPUCount": .integer(info.minimumCPUCount),
                            "minimumMemoryMiB": .number(Double((info.minimumMemorySize + 1048575) / 1048576)),
                            "hardwareModelSupported": .bool(true)
                        ])
                        reply(nativeSuccess(request.id, .object(result)))
                    case .failure(let error): reply(nativeFailure(request.id, error))
                    }
                }
                return
            }
            if request.action == "list" {
                reply(nativeSuccess(request.id, .array(machines.values.sorted { $0.metadata.id < $1.metadata.id }.map(\.status))))
                return
            }
            guard let id = request.instanceID else { throw NativeFault("invalid_instance", "Machine UUID is required") }
            if request.action == "create" {
                guard VZVirtualMachine.isSupported else { throw NativeFault("virtualization_unsupported", "Virtualization is unavailable on this host") }
                guard machines[id] == nil else { throw NativeFault("instance_conflict", "Machine UUID already exists; no installation was repeated") }
                guard machines.count < 256 else { throw NativeFault("instance_limit", "Private native machine record limit reached") }
                let options = try createOptions(request.payload)
                let (metadata, lease) = try store.create(id: id, options: options)
                let machine = NativeMachine(metadata: metadata, store: store, ownerLease: lease)
                machines[id] = machine
                machine.beginPreparation()
                reply(nativeSuccess(request.id, machine.status))
                return
            }
            guard let machine = machines[id] else { throw NativeFault("instance_not_found", "No owned physical VM has this UUID") }
            switch request.action {
            case "recovery.register":
                reply(nativeSuccess(request.id, try machine.registerRecovery(request.payload)))
                return
            case "recovery.observe":
                reply(nativeSuccess(request.id, try machine.observeRecovery(request.payload)))
                return
            case "recovery.runtime":
                reply(nativeSuccess(request.id, try machine.runtimeRecovery(request.payload)))
                return
            case "status": break
            case "start": try machine.start()
            case "stop": try machine.stop(force: false)
            case "poweroff": try machine.stop(force: true)
            case "show":
                guard machine.canShow else { throw NativeFault("display_unavailable", "The selected machine has no active VZ display") }
                for (otherID, other) in machines where otherID != id { other.hide() }
                try machine.show()
            case "hide": machine.hide()
            case "automation":
                try request.payload.requireKeys(["enabled"])
                try machine.setAutomation(request.payload.boolean("enabled"))
            default: throw NativeFault("invalid_action", "Unsupported native action")
            }
            reply(nativeSuccess(request.id, machine.status))
        } catch let error as NativeFault { reply(nativeFailure(request.id, error)) }
        catch {
            reply(nativeFailure(request.id, NativeFault("native_failure", "Native operation failed; inspect owned metadata and status before any further mutation", effect: "unknown")))
        }
    }
}

@MainActor
final class NativeHostApplication: NSObject, NSApplicationDelegate {
    private let coordinator: NativeHostCoordinator
    private let server: NativeControlServer

    init(root: String) throws {
        let store = try NativeStore(root: root)
        let coordinator = try NativeHostCoordinator(store: store)
        self.coordinator = coordinator
        server = try NativeControlServer(runtime: store.runtime) { request, reply in coordinator.handle(request, reply: reply) }
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let menu = NSMenu()
        let application = NSMenuItem()
        let submenu = NSMenu()
        submenu.addItem(withTitle: "Quit QAutra Guest Host", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        application.submenu = submenu
        menu.addItem(application)
        NSApp.mainMenu = menu
        server.start()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        coordinator.hasActiveWork ? .terminateCancel : .terminateNow
    }
}

@main
struct QAutraGuestHostMain {
    @MainActor
    static func main() {
        umask(0o077)
        do {
            let arguments = CommandLine.arguments
            guard arguments.count == 3, arguments[1] == "--root" else {
                throw NativeFault("invalid_arguments", "Usage: QAutraGuestHost --root <absolute project .qa/instances/machines directory>")
            }
            let application = NSApplication.shared
            application.setActivationPolicy(.accessory)
            let delegate = try NativeHostApplication(root: arguments[2])
            application.delegate = delegate
            withExtendedLifetime(delegate) { application.run() }
        } catch {
            let text = "QAutraGuestHost: " + String(error.localizedDescription.prefix(2048)) + "\n"
            FileHandle.standardError.write(Data(text.utf8))
            exit(1)
        }
    }
}
