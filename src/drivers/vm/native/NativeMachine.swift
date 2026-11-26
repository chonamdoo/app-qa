import AppKit
import Foundation
@preconcurrency import Virtualization

// Native platform construction and lease lifetime patterns are adapted from E2EVM; see LICENSE.e2evm.
@MainActor
final class NativeMachine: NSObject, @preconcurrency VZVirtualMachineDelegate, NSWindowDelegate {
    private(set) var metadata: NativeMetadata
    private let store: NativeStore
    private var ownerLease: NativeFileLease?
    private var diskLease: NativeFileLease?
    private var machine: VZVirtualMachine?
    private var installer: VZMacOSInstaller?
    private var download: NativeAppleDownload?
    private var checkpointTimer: Timer?
    private var view: NativeGuestView?
    private var setupWindow: NativeSetupWindow?
    private var generation = UUID().uuidString.lowercased()
    private var startPending = false
    private var shutdownRequested = false
    private var automation = false
    private var durabilityError: String?
    private var bootSharesAttached = false
    private var recoveryAttempts: [NativeGuestAttempt] = []

    init(metadata: NativeMetadata, store: NativeStore, ownerLease: NativeFileLease? = nil) {
        self.metadata = metadata
        self.store = store
        self.ownerLease = ownerLease
        super.init()
    }

    var hasActiveWork: Bool { download != nil || installer != nil || machine != nil || metadata.phase == "preparing" }
    var canShow: Bool { machine != nil }

    private var state: String {
        if installer != nil { return "installing" }
        if startPending { return "starting" }
        guard let machine else { return metadata.state }
        switch machine.state {
        case .running: return shutdownRequested ? "stopping" : "running"
        case .starting: return "starting"
        case .stopping: return "stopping"
        case .error: return "error"
        case .stopped: return metadata.phase == "idle" ? metadata.state : "unknown"
        case .paused, .pausing, .resuming, .saving, .restoring: return "unknown"
        @unknown default: return "unknown"
        }
    }

    var status: NativeJSON {
        let progress = installer.map { $0.progress.fractionCompleted }.flatMap { $0.isFinite ? min(1, max(0, $0)) : nil } ?? metadata.progress
        return .object([
            "id": .string(metadata.id), "name": .string(metadata.name), "platform": .string(metadata.platform),
            "state": .string(state), "progress": .optional(progress), "error": .optional(durabilityError ?? metadata.error),
            "cpuCount": .integer(metadata.cpuCount), "memoryMiB": .integer(metadata.memoryMiB),
            "diskGiB": .integer(metadata.diskGiB), "windowVisible": .bool(setupWindow?.isVisible == true),
            "automation": .bool(automation)
        ])
    }

    private func persist() throws { try store.save(metadata) }

    private func checkpoint() {
        do { try persist() }
        catch { durabilityError = "Native ownership metadata could not be persisted; new starts and automation attachment are blocked" }
    }

    func beginPreparation() {
        guard VZVirtualMachine.isSupported else {
            failPreparation(NativeFault("virtualization_unsupported", "Virtualization is unavailable on this host"))
            return
        }
        NativeRestoreLookup.latest { [weak self] result in
            guard let self else { return }
            do {
                let info = try result.get()
                try self.checkRequirements(info)
                let directory = try self.store.directory(self.metadata.id)
                let download = try NativeAppleDownload(url: info.url, destination: URL(fileURLWithPath: directory + "/restore.ipsw"),
                    progress: { [weak self] fraction in
                        guard let self else { return }
                        self.metadata.progress = fraction
                        self.checkpoint()
                    }, completion: { [weak self] outcome in
                        guard let self else { return }
                        self.download = nil
                        switch outcome {
                        case .success(let url):
                            self.metadata.progress = 1
                            self.checkpoint()
                            self.loadDownloadedImage(url)
                        case .failure(let error): self.failPreparation(error)
                        }
                    })
                self.download = download
                download.start()
            } catch { self.failPreparation(error) }
        }
    }

    private func checkRequirements(_ info: NativeRestoreInfo) throws {
        guard metadata.cpuCount >= info.minimumCPUCount,
              UInt64(metadata.memoryMiB) * 1024 * 1024 >= info.minimumMemorySize else {
            throw NativeFault("insufficient_resources", "This Apple restore image requires at least \(info.minimumCPUCount) CPUs and \((info.minimumMemorySize + 1048575) / 1048576) MiB memory")
        }
    }

    private func loadDownloadedImage(_ url: URL) {
        NativeRestoreLookup.load(url) { [weak self] result in
            guard let self else { return }
            do {
                let info = try result.get()
                try self.checkRequirements(info)
                try self.install(info: info, url: url)
            } catch { self.failPreparation(error) }
        }
    }

    private static func graphics() -> VZMacGraphicsDeviceConfiguration {
        let graphics = VZMacGraphicsDeviceConfiguration()
        graphics.displays = [VZMacGraphicsDisplayConfiguration(widthInPixels: 1920, heightInPixels: 1200, pixelsPerInch: 80)]
        return graphics
    }

    private func configuration(platform: VZMacPlatformConfiguration, directory: String, includeBootShares: Bool) throws -> VZVirtualMachineConfiguration {
        let configuration = VZVirtualMachineConfiguration()
        configuration.platform = platform
        configuration.bootLoader = VZMacOSBootLoader()
        configuration.cpuCount = metadata.cpuCount
        configuration.memorySize = UInt64(metadata.memoryMiB) * 1024 * 1024
        let disk = try VZDiskImageStorageDeviceAttachment(url: URL(fileURLWithPath: directory + "/disk.img"), readOnly: false, cachingMode: .cached, synchronizationMode: .fsync)
        configuration.storageDevices = [VZVirtioBlockDeviceConfiguration(attachment: disk)]
        configuration.graphicsDevices = [Self.graphics()]
        configuration.keyboards = [VZMacKeyboardConfiguration()]
        configuration.pointingDevices = [VZUSBScreenCoordinatePointingDeviceConfiguration()]
        let network = VZVirtioNetworkDeviceConfiguration()
        network.attachment = VZNATNetworkDeviceAttachment()
        configuration.networkDevices = [network]
        configuration.entropyDevices = [VZVirtioEntropyDeviceConfiguration()]
        if includeBootShares {
            try store.verifyBootShares(metadata)
            let kit = VZVirtioFileSystemDeviceConfiguration(tag: "QAutraKit")
            kit.share = VZSingleDirectoryShare(directory: VZSharedDirectory(url: URL(fileURLWithPath: directory + "/kit"), readOnly: true))
            let status = VZVirtioFileSystemDeviceConfiguration(tag: "QAutraStatus")
            status.share = VZSingleDirectoryShare(directory: VZSharedDirectory(url: URL(fileURLWithPath: directory + "/status"), readOnly: false))
            configuration.directorySharingDevices = [kit, status]
        }
        try configuration.validate()
        return configuration
    }

    private func install(info: NativeRestoreInfo, url: URL) throws {
        guard durabilityError == nil else { throw NativeFault("ownership_not_durable", "Cannot install without durable native ownership metadata") }
        let directory = try store.directory(metadata.id)
        guard let hardware = VZMacHardwareModel(dataRepresentation: info.hardwareData), hardware.isSupported else {
            throw NativeFault("hardware_unsupported", "Downloaded restore hardware model is not supported")
        }
        let identifier = VZMacMachineIdentifier()
        try NativeFiles.sparseDisk(directory + "/disk.img", bytes: Int64(metadata.diskGiB) * 1024 * 1024 * 1024)
        diskLease = try store.diskLease(directory + "/disk.img")
        try NativeFiles.writeNew(hardware.dataRepresentation, to: directory + "/hardware-model.bin")
        try NativeFiles.writeNew(identifier.dataRepresentation, to: directory + "/machine-identifier.bin")
        let auxiliary = try VZMacAuxiliaryStorage(creatingStorageAt: URL(fileURLWithPath: directory + "/auxiliary-storage"), hardwareModel: hardware, options: [])
        let platform = VZMacPlatformConfiguration()
        platform.hardwareModel = hardware
        platform.machineIdentifier = identifier
        platform.auxiliaryStorage = auxiliary
        let configuration = try configuration(platform: platform, directory: directory, includeBootShares: false)
        metadata.artifacts = NativeArtifacts(
            diskIdentity: NativeFiles.identity(try NativeFiles.inspect(directory + "/disk.img")),
            auxiliaryIdentity: NativeFiles.identity(try NativeFiles.inspect(directory + "/auxiliary-storage")),
            hardwareHash: NativeFiles.hash(hardware.dataRepresentation), machineHash: NativeFiles.hash(identifier.dataRepresentation),
            minimumCPUCount: info.minimumCPUCount, minimumMemoryMiB: Int((info.minimumMemorySize + 1048575) / 1048576))
        try NativeFiles.syncDirectory(directory)
        let machine = VZVirtualMachine(configuration: configuration)
        machine.delegate = self
        self.machine = machine
        bootSharesAttached = false
        metadata.state = "installing"
        metadata.phase = "installing"
        metadata.progress = 0
        try persist()
        let installer = VZMacOSInstaller(virtualMachine: machine, restoringFromImageAt: url)
        self.installer = installer
        let currentGeneration = generation
        checkpointTimer = Timer.scheduledTimer(timeInterval: 1, target: self, selector: #selector(sampleInstallation), userInfo: nil, repeats: true)
        installer.install { [weak self] result in
            MainActor.assumeIsolated {
                guard let self, self.generation == currentGeneration else { return }
                self.checkpointTimer?.invalidate()
                self.checkpointTimer = nil
                self.installer = nil
                switch result {
                case .success:
                    self.metadata.installed = true
                    self.metadata.progress = 1
                    self.metadata.error = nil
                    if self.machine?.state == .stopped {
                        self.confirmTermination(state: "installed", error: nil)
                    } else {
                        self.metadata.phase = "active"
                        self.metadata.state = self.state
                        self.checkpoint()
                        self.updateInputGate()
                    }
                case .failure(let error): self.failPreparation(error)
                }
            }
        }
        updateInputGate()
    }

    @objc private func sampleInstallation() {
        guard let installer else { return }
        let fraction = installer.progress.fractionCompleted
        metadata.progress = fraction.isFinite ? min(1, max(0, fraction)) : nil
        checkpoint()
    }

    private func failPreparation(_ error: Error) {
        guard installer == nil else { return }
        metadata.error = String(error.localizedDescription.prefix(2048))
        metadata.progress = nil
        if machine == nil || machine?.state == .stopped || machine?.state == .error {
            view?.virtualMachine = nil
            machine = nil
            ownerLease = nil
            diskLease = nil
            metadata.phase = "failed"
            metadata.state = "error"
        } else {
            metadata.phase = "unknown"
            metadata.state = "unknown"
        }
        checkpoint()
        updateInputGate()
    }

    func start() throws {
        guard durabilityError == nil, metadata.installed, metadata.phase == "idle", machine == nil, download == nil, installer == nil else {
            throw NativeFault("invalid_transition", "Start requires an installed, durably idle owned machine; incomplete or unknown ownership cannot be adopted")
        }
        guard VZVirtualMachine.isSupported,
              (VZVirtualMachineConfiguration.minimumAllowedCPUCount...VZVirtualMachineConfiguration.maximumAllowedCPUCount).contains(metadata.cpuCount),
              UInt64(metadata.memoryMiB) * 1048576 >= VZVirtualMachineConfiguration.minimumAllowedMemorySize,
              UInt64(metadata.memoryMiB) * 1048576 <= VZVirtualMachineConfiguration.maximumAllowedMemorySize else {
            throw NativeFault("host_resources_changed", "Recorded machine resources are unsupported on this host")
        }
        let directory = try store.directory(metadata.id)
        let owner = try store.machineLease(metadata.id)
        try store.verifyArtifacts(metadata)
        let diskOwner = try store.diskLease(directory + "/disk.img")
        guard let hardware = VZMacHardwareModel(dataRepresentation: try NativeFiles.read(directory + "/hardware-model.bin", maximum: 1048576)), hardware.isSupported,
              let identifier = VZMacMachineIdentifier(dataRepresentation: try NativeFiles.read(directory + "/machine-identifier.bin", maximum: 1048576)) else {
            throw NativeFault("hardware_unsupported", "Recorded hardware model or machine identifier is invalid or unsupported")
        }
        let platform = VZMacPlatformConfiguration()
        platform.hardwareModel = hardware
        platform.machineIdentifier = identifier
        platform.auxiliaryStorage = VZMacAuxiliaryStorage(url: URL(fileURLWithPath: directory + "/auxiliary-storage"))
        let configuration = try configuration(platform: platform, directory: directory, includeBootShares: true)
        let vm = VZVirtualMachine(configuration: configuration)
        vm.delegate = self
        ownerLease = owner
        diskLease = diskOwner
        machine = vm
        bootSharesAttached = true
        generation = UUID().uuidString.lowercased()
        recoveryAttempts = []
        let currentGeneration = generation
        metadata.phase = "active"
        metadata.state = "starting"
        metadata.error = nil
        metadata.progress = nil
        automation = false
        shutdownRequested = false
        startPending = true
        do { try persist() }
        catch {
            startPending = false
            machine = nil
            ownerLease = nil
            diskLease = nil
            metadata.phase = "unknown"
            metadata.state = "unknown"
            durabilityError = "Start ownership could not be durably recorded; no VZ start was dispatched"
            throw NativeFault("ownership_not_durable", durabilityError!, effect: "unknown")
        }
        view?.virtualMachine = vm
        vm.start { [weak self] result in
            MainActor.assumeIsolated {
                guard let self, self.generation == currentGeneration, let active = self.machine else { return }
                self.startPending = false
                switch result {
                case .success:
                    self.metadata.state = self.state
                    self.checkpoint()
                case .failure(let error):
                    if active.state == .stopped || active.state == .error {
                        self.confirmTermination(state: "error", error: error.localizedDescription, observation: active.state == .stopped ? "vz-start-failure" : nil)
                    } else {
                        self.metadata.state = "unknown"
                        self.metadata.error = String(error.localizedDescription.prefix(2048))
                        self.checkpoint()
                    }
                }
                self.updateInputGate()
            }
        }
        updateInputGate()
    }

    func stop(force: Bool) throws {
        guard installer == nil, download == nil, metadata.phase != "preparing", metadata.phase != "installing" else {
            throw NativeFault("installation_in_progress", "Stop and poweroff are prohibited during preparation or installation; stopping VZMacOSInstaller's VM has undefined behavior")
        }
        if force && machine == nil {
            try reconcileStoppedOwnership()
            return
        }
        guard let machine, !startPending else { throw NativeFault("invalid_transition", "No stoppable owned VM is active") }
        guard force ? machine.canStop : machine.canRequestStop else { throw NativeFault("invalid_transition", "Virtualization does not permit this stop transition") }
        metadata.phase = "active"
        metadata.state = "stopping"
        checkpoint()
        let currentGeneration = generation
        if force {
            shutdownRequested = true
            machine.stop { [weak self] error in
                MainActor.assumeIsolated {
                    guard let self, self.generation == currentGeneration, let active = self.machine else { return }
                    if error == nil && active.state == .stopped {
                        self.confirmTermination(state: "stopped", error: nil, observation: "vz-stop-completion")
                    } else if active.state == .stopped {
                        self.confirmTermination(state: "stopped", error: error?.localizedDescription, observation: "vz-stop-completion")
                    } else {
                        self.shutdownRequested = active.state == .stopping
                        self.metadata.error = error.map { String($0.localizedDescription.prefix(2048)) } ?? "Poweroff completion did not confirm a stopped VM"
                        self.metadata.state = self.state
                        self.checkpoint()
                        self.updateInputGate()
                    }
                }
            }
        } else {
            do {
                try machine.requestStop()
                shutdownRequested = true
                metadata.state = "stopping"
                checkpoint()
            } catch {
                metadata.error = String(error.localizedDescription.prefix(2048))
                metadata.state = state
                checkpoint()
                throw NativeFault("stop_request_failed", "The guest shutdown request was not confirmed; inspect native status", effect: "unknown")
            }
        }
        updateInputGate()
    }

    private func reconcileStoppedOwnership() throws {
        guard durabilityError == nil, metadata.installed, metadata.phase == "unknown",
              !startPending, !shutdownRequested, ownerLease == nil, diskLease == nil else {
            throw NativeFault("invalid_transition", "Forced cold recovery requires an installed machine with lost ownership and no active native operation")
        }
        let directory = try store.directory(metadata.id)
        let owner = try store.machineLease(metadata.id)
        let disk = try store.diskLease(directory + "/disk.img")
        let image = try NativeFileLease(directory + "/disk.img")
        try store.verifyArtifacts(metadata)
        let previous = metadata
        metadata.state = "stopped"
        metadata.phase = "idle"
        metadata.progress = nil
        metadata.error = nil
        do {
            try persist()
        } catch {
            metadata = previous
            durabilityError = "Cold recovery could not durably record stopped ownership"
            throw NativeFault("ownership_not_durable", "Cold recovery has an unconfirmed durable outcome", effect: "unknown")
        }
        withExtendedLifetime((owner, disk, image)) {}
        updateInputGate()
    }

    private func confirmTermination(state terminal: String, error: String?, observation: String? = nil) {
        guard installer == nil else { return }
        if let observation {
            for attempt in recoveryAttempts {
                do { try attempt.sealStopped(observation: observation) }
                catch { durabilityError = "Original VZ stop was observed, but its guest recorder inventory could not be durably sealed" }
            }
        }
        startPending = false
        shutdownRequested = false
        automation = false
        view?.virtualMachine = nil
        machine = nil
        bootSharesAttached = false
        metadata.state = terminal
        metadata.phase = metadata.installed ? "idle" : "failed"
        metadata.error = error.map { String($0.prefix(2048)) }
        metadata.progress = terminal == "installed" ? 1 : nil
        checkpoint()
        diskLease = nil
        ownerLease = nil
        updateInputGate()
    }

    func guestDidStop(_ virtualMachine: VZVirtualMachine) {
        guard machine === virtualMachine, installer == nil else { return }
        confirmTermination(state: metadata.installed ? "stopped" : "error", error: metadata.installed ? nil : "Guest stopped before installation completed", observation: "vz-delegate-stop")
    }

    func virtualMachine(_ virtualMachine: VZVirtualMachine, didStopWithError error: Error) {
        guard machine === virtualMachine, installer == nil else { return }
        confirmTermination(state: "error", error: error.localizedDescription, observation: "vz-delegate-error")
    }

    func registerRecovery(_ payload: [String: NativeJSON]) throws -> NativeJSON {
        guard machine?.state == .running, ownerLease != nil, diskLease != nil, bootSharesAttached,
              installer == nil, !startPending, !shutdownRequested, durabilityError == nil else {
            throw NativeFault("guest_original_owner_unverified", "Only the active original native VZ owner can register a frozen guest attempt")
        }
        guard recoveryAttempts.count < 128 else { throw NativeFault("guest_recovery_limit", "Original guest attempt registration limit reached") }
        let attempt = try NativeGuestAttempt(payload: payload, metadata: metadata, store: store, generation: generation)
        recoveryAttempts.append(attempt)
        return attempt.registration
    }

    func observeRecovery(_ payload: [String: NativeJSON]) throws -> NativeJSON {
        try NativeGuestAttempt.observe(payload: payload, machineId: metadata.id, store: store)
    }
    func runtimeRecovery(_ payload: [String: NativeJSON]) throws -> NativeJSON {
        let recorderId = try payload.text("recorderId")
        guard Set(payload.keys) == Set(["recorderId","nativeGeneration"]), try payload.text("nativeGeneration") == generation,
              machine?.state == .running, ownerLease != nil, diskLease != nil, bootSharesAttached, automation,
              installer == nil, !startPending, !shutdownRequested, durabilityError == nil,
              let attempt = recoveryAttempts.first(where: { $0.recorderId == recorderId && $0.generation == generation }) else {
            throw NativeFault("guest_original_runtime_fenced", "Runtime evidence requires the original registered, running native generation")
        }
        return attempt.registration
    }

    func setAutomation(_ enabled: Bool) throws {
        guard machine?.state == .running, installer == nil, !startPending, !shutdownRequested,
              bootSharesAttached, durabilityError == nil else {
            throw NativeFault("invalid_transition", "Automation binding requires a running owned VM booted with validated private guest shares")
        }
        if enabled && setupWindow?.hasHeldInput == true {
            throw NativeFault("manual_input_held", "Release manual guest keys, modifiers, and pointer buttons before attaching automation")
        }
        automation = enabled
        updateInputGate()
        if enabled && setupWindow?.isKeyWindow == true { setupWindow?.orderOut(nil) }
    }

    private func updateInputGate() {
        let allowed = !automation && installer == nil && !startPending && !shutdownRequested && machine?.state == .running
        view?.inputAllowed = allowed
        setupWindow?.inputAllowed = allowed
        if !allowed { setupWindow?.makeFirstResponder(nil) }
    }

    func show() throws {
        guard let machine else { throw NativeFault("display_unavailable", "This machine does not currently have a VZ display") }
        if setupWindow == nil {
            let view = NativeGuestView(frame: NSRect(x: 0, y: 0, width: 1440, height: 900))
            view.capturesSystemKeys = false
            view.automaticallyReconfiguresDisplay = false
            let window = NativeSetupWindow(contentRect: view.frame, styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
            window.title = "QAutra — \(metadata.name) — Guest Setup"
            window.minSize = NSSize(width: 720, height: 450)
            window.isReleasedWhenClosed = false
            window.delegate = self
            window.contentView = view
            window.center()
            self.view = view
            setupWindow = window
        }
        view?.virtualMachine = machine
        updateInputGate()
        if view?.inputAllowed == true {
            setupWindow?.makeKeyAndOrderFront(nil)
            setupWindow?.makeFirstResponder(view)
            NSApp.activate(ignoringOtherApps: true)
        } else {
            setupWindow?.orderFront(nil)
        }
    }

    func hide() { setupWindow?.orderOut(nil) }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        sender.orderOut(nil)
        return false
    }
}
