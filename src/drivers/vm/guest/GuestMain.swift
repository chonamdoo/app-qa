import Foundation
import Darwin

private enum GuestUserInstall {
    static func install(_ bootstrap: GuestBootstrap) throws {
        let source = GuestFiles.kit.appendingPathComponent("QAutraGuestAgent.app", isDirectory: true)
        guard Bundle.main.bundleURL.standardizedFileURL.path == source.path, Bundle.main.bundleIdentifier == "com.qautra.guest-agent" else { throw GuestFault("guest_install_source_refused") }
        let signature = try GuestProcess.run("/usr/bin/codesign", ["--verify","--deep","--strict",source.path], seconds: 30, maximum: 16 * 1024)
        guard signature.status == 0 else { throw GuestFault("guest_agent_signature_refused") }
        let library = GuestFiles.home.appendingPathComponent("Library", isDirectory: true)
        let support = library.appendingPathComponent("Application Support", isDirectory: true)
        let agents = library.appendingPathComponent("LaunchAgents", isDirectory: true)
        try GuestFiles.ensureDirectory(library, privateMode: false); try GuestFiles.ensureDirectory(support, privateMode: false); try GuestFiles.ensureDirectory(agents, privateMode: false)
        let launch = agents.appendingPathComponent("com.qautra.guest-agent.plist")
        var info = stat(); guard lstat(launch.path, &info) != 0 && errno == ENOENT else { throw GuestFault("guest_launchagent_conflict") }
        guard let templateURL = Bundle.main.url(forResource: "com.qautra.guest-agent", withExtension: "plist") else { throw GuestFault("guest_launchagent_template_missing") }
        let templateData = try GuestFiles.read(templateURL, maximum: 64 * 1024, privateMode: false)
        guard var template = try PropertyListSerialization.propertyList(from: templateData, format: nil) as? [String: Any], template["Label"] as? String == "com.qautra.guest-agent" else { throw GuestFault("guest_launchagent_template_invalid") }
        try GuestFiles.ensureDirectory(GuestFiles.root, exclusive: true)
        try GuestFiles.atomic(GuestFiles.root.appendingPathComponent("identity.json"), value: ["version":1,"instanceId":bootstrap.instanceId,"platform":bootstrap.platform])
        let destination = GuestFiles.root.appendingPathComponent("QAutraGuestAgent.app", isDirectory: true)
        do { try FileManager.default.copyItem(at: source, to: destination) } catch { throw GuestFault("guest_agent_copy_failed") }
        let executable = destination.appendingPathComponent("Contents/MacOS/QAutraGuestAgent")
        guard FileManager.default.isExecutableFile(atPath: executable.path) else { throw GuestFault("guest_agent_executable_missing") }
        template["ProgramArguments"] = [executable.path,"--serve"]
        let plist = try PropertyListSerialization.data(fromPropertyList: template, format: .xml, options: 0)
        try GuestFiles.atomicData(launch, bytes: plist)
        print("Installed the guest user agent. No browser authorization or host settings were changed.")
    }
}

// After initialization, mutable state is confined to the agent's serial queue.
private final class GuestAgent: @unchecked Sendable {
    private let bootstrap: GuestBootstrap
    private let queue = DispatchQueue(label: "com.qautra.guest-agent.state")
    private let browsers: GuestBrowserOwner
    private let recording: GuestRecordingOwner
    private var channel: GuestControlChannel?
    private var routes: GuestRoutes?
    private var connection: GuestConnectionConfig?
    private var connected = false
    private var quarantined = false
    private var seen = Set<String>()
    private var lockFD: Int32 = -1
    private var poll: DispatchSourceTimer?
    private var heartbeat: DispatchSourceTimer?
    private let pollingStarted = Date()
    private var signals: [DispatchSourceSignal] = []
    init(bootstrap: GuestBootstrap) throws {
        self.bootstrap = bootstrap
        try bootstrap.verifyInstalledIdentity()
        guard Bundle.main.bundleURL.path == GuestFiles.root.appendingPathComponent("QAutraGuestAgent.app").path else { throw GuestFault("guest_runtime_source_refused") }
        let chrome = try GuestChromeInstallation.load(bootstrap)
        browsers = GuestBrowserOwner(bootstrap: bootstrap, queue: queue, chrome: chrome)
        let recorder = GuestRecordingOwner(bootstrap: bootstrap, queue: queue)
        recording = recorder
        browsers.beforeDispatch = { [weak recorder] method, path in
            if method != "GET" && !(method == "DELETE" && path.split(separator: "/").count == 2 && path.hasPrefix("/session/")) { try recorder?.assertBrowserDispatch() }
        }
        lockFD = open(GuestFiles.root.appendingPathComponent("agent.lock").path, O_RDWR | O_CREAT | O_NOFOLLOW | O_CLOEXEC, 0o600)
        var info = stat()
        guard lockFD >= 0, fstat(lockFD, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG, info.st_uid == getuid(), info.st_mode & 0o077 == 0, flock(lockFD, LOCK_EX | LOCK_NB) == 0 else { throw GuestFault("guest_agent_already_owned") }
        let marker = GuestFiles.root.appendingPathComponent("runtime.json")
        if FileManager.default.fileExists(atPath: marker.path) {
            let old = try GuestFiles.json(marker)
            try GuestJSON.keys(old, required: ["version","instanceId","epoch","bootID","disposition"])
            guard try GuestJSON.integer(old["version"], minimum: 1, maximum: 1) == 1, try GuestJSON.uuid(old["instanceId"]) == bootstrap.instanceId else { throw GuestFault("guest_runtime_identity_conflict") }
            guard try GuestJSON.string(old["bootID"]) != bootstrap.bootID else { throw GuestFault("guest_reconciliation_required", "This guest boot already had an agent owner. Stop the VM and start a fresh boot epoch; do not replay commands.") }
        }
        browsers.onQuarantine = { [weak self] reason in self?.latch(reason) }
    }
    func start() throws {
        try bootstrap.writeHello()
        let timer = DispatchSource.makeTimerSource(queue: queue); poll = timer
        timer.schedule(deadline: .now(), repeating: 1)
        timer.setEventHandler { [weak self] in self?.pollConnection() }; timer.resume()
        for number in [SIGTERM,SIGINT,SIGHUP] {
            signal(number, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: number, queue: queue)
            source.setEventHandler { [weak self] in
                self?.latch("guest_agent_terminated"); self?.channel?.close()
                exit(1)
            }
            source.resume(); signals.append(source)
        }
    }
    private func marker(_ disposition: String) throws {
        try GuestFiles.atomic(GuestFiles.root.appendingPathComponent("runtime.json"), value: ["version":1,"instanceId":bootstrap.instanceId,"epoch":bootstrap.epoch,"bootID":bootstrap.bootID,"disposition":disposition])
    }
    private func pollConnection() {
        do {
            try bootstrap.current()
            guard Date().timeIntervalSince(pollingStarted) < 600 else { throw GuestFault("guest_connection_bootstrap_timeout") }
            guard let config = try GuestConnectionConfig.load(bootstrap) else { return }
            poll?.cancel(); poll = nil
            try marker("active")
            connection = config
            let channel = GuestControlChannel(config: config, queue: queue); self.channel = channel
            routes = GuestRoutes(bootstrap: bootstrap, config: config, queue: queue, permitted: { [weak self] in self?.canMutate() == true })
            channel.onFrame = { [weak self] value, size in self?.receive(value, bytes: size) }
            channel.onClose = { [weak self] in self?.connected = false; self?.latch("control_connection_lost") }
            connected = true
            channel.start(bootstrap: bootstrap, chromePresent: browsers.chromePresent)
            let timer = DispatchSource.makeTimerSource(queue: queue); heartbeat = timer
            timer.schedule(deadline: .now() + 1, repeating: 1)
            timer.setEventHandler { [weak self] in
                guard let self = self else { return }
                do {
                    try self.bootstrap.current()
                    guard let current = try GuestConnectionConfig.load(self.bootstrap), let original = self.connection, current.host == original.host, current.port == original.port, current.pin == original.pin else { throw GuestFault("guest_connection_config_revoked") }
                } catch { self.latch("guest_epoch_or_connection_revoked"); self.channel?.close() }
            }
            timer.resume()
        } catch {
            poll?.cancel(); poll = nil; latch("guest_bootstrap_refused")
            fputs("QAutraGuestAgent: guest_bootstrap_refused\n", stderr)
        }
    }
    private func canMutate() -> Bool { connected && !quarantined && browsers.usable }
    private func latch(_ reason: String) {
        guard !quarantined else { return }; quarantined = true
        routes?.close(); recording.halt(); browsers.halt(reason)
        do { try marker("unknown") }
        catch { fputs("QAutraGuestAgent: quarantine_persistence_failed\n", stderr); channel?.close() }
    }
    private func receive(_ value: Any, bytes: Int) {
        var replyId: String?
        do {
            let object = try GuestJSON.object(value)
            try GuestJSON.keys(object, required: ["version","id","epoch","deadlineAt","operation","payload"])
            let id = try GuestJSON.uuid(object["id"]); replyId = id
            guard try GuestJSON.integer(object["version"], minimum: 1, maximum: 1) == 1 else { throw GuestFault("rpc_version") }
            let epoch = try GuestJSON.integer(object["epoch"], minimum: 1)
            let deadline = try GuestJSON.integer(object["deadlineAt"], minimum: 1)
            let operation = try GuestJSON.string(object["operation"], maximum: 32)
            let payload = try GuestJSON.object(object["payload"] as Any)
            guard !seen.contains(id) else { respond(id, .failure(GuestFault("duplicate_request_unknown", "The request identifier was already observed and will not be replayed."), "unknown")); return }
            guard seen.count < 16_384 else { latch("request_identifier_limit"); throw GuestFault("request_identifier_limit") }
            seen.insert(id)
            guard epoch == bootstrap.epoch, deadline > guestNow(), deadline <= guestNow() + 300_000 else { throw GuestFault("rpc_deadline_or_epoch") }
            try bootstrap.current()
            let request = GuestRequest(id: id, epoch: epoch, deadline: deadline, operation: operation, payload: payload, bytes: bytes, reply: { [weak self] reply in self?.respond(id, reply) })
            switch operation {
            case "status":
                try GuestJSON.keys(payload, required: [])
                respond(id, .success(["instanceId":bootstrap.instanceId,"epoch":bootstrap.epoch,"connected":connected,"quarantined":quarantined,"browser":browsers.status,"routes":routes?.status ?? ["ports":[],"activeStreams":0]]))
            case "webdriver":
                guard canMutate() else { throw GuestFault("machine_quarantined") }; browsers.handle(request)
            case "browser.evidence":
                guard canMutate() else { throw GuestFault("machine_quarantined") }
                try GuestJSON.keys(payload, required: ["identity"])
                let identity = try GuestRecordingIdentity(GuestJSON.object(payload["identity"] as Any), bootstrap: bootstrap)
                try recording.assertRuntimeIdentity(identity)
                browsers.observeRuntime(request, identity: identity)
            case "route.bind":
                guard canMutate(), let routes = routes else { throw GuestFault("machine_quarantined") }
                routes.bind(try GuestRoutes.ports(payload), deadline: deadline, completion: request.reply)
            case "route.unbind":
                guard let routes = routes else { throw GuestFault("routes_unavailable") }
                respond(id, .success(try routes.unbind(GuestRoutes.ports(payload))))
            case "recording":
                guard connected, !quarantined else { throw GuestFault("machine_quarantined") }
                recording.handle(request)
            case "revoke":
                try GuestJSON.keys(payload, required: [])
                routes?.close()
                recording.halt()
                browsers.revoke(deadline: deadline) { [weak self] closed in
                    guard let self = self else { return }
                    self.quarantined = true
                    do { try self.marker(closed ? "revoked" : "unknown") }
                    catch { self.respond(id, .failure(GuestFault("revoke_persistence_unknown"), "unknown")); return }
                    self.respond(id, closed ? .success(["closed":true]) : .failure(GuestFault("guest_close_unconfirmed", "At least one browser close is unconfirmed; stop the physical VM before releasing its ownership."), "unknown"))
                }
            default: throw GuestFault("unknown_guest_operation")
            }
        } catch let fault as GuestFault {
            if let id = replyId { respond(id, .failure(fault, "not_started")) } else { channel?.close() }
        } catch {
            if let id = replyId { respond(id, .failure(GuestFault("invalid_guest_request"), "not_started")) } else { channel?.close() }
        }
    }
    private func respond(_ id: String, _ reply: GuestReply) {
        switch reply {
        case .success(let result): channel?.send(["version":1,"id":id,"ok":true,"effect":"completed","result":result])
        case .failure(let fault, let effect): channel?.send(["version":1,"id":id,"ok":false,"effect":effect,"error":["code":fault.code,"message":fault.message]])
        }
    }
}

@main enum QAutraGuestAgentMain {
    private static func bootstrap(for command: String) throws -> GuestBootstrap {
        guard command == "--serve" else { return try GuestBootstrap.load() }
        try GuestFiles.requireGuestUser()
        let deadline = Date().addingTimeInterval(120)
        while true {
            do {
                try GuestFiles.mount(GuestFiles.kit, tag: "QAutraKit", readOnly: true)
                try GuestFiles.mount(GuestFiles.status, tag: "QAutraStatus", readOnly: false)
                return try GuestBootstrap.load()
            } catch let fault as GuestFault where ["guest_mount_missing", "guest_mount_identity_mismatch", "guest_network_pending"].contains(fault.code) && Date() < deadline {
                Thread.sleep(forTimeInterval: 1)
            }
        }
    }
    static func main() {
        umask(0o077)
        do {
            guard CommandLine.arguments.count == 2 else { throw GuestFault("guest_argument_refused") }
            let bootstrap = try bootstrap(for: CommandLine.arguments[1])
            switch CommandLine.arguments[1] {
            case "--verify-kit": print("Owned guest bootstrap and user-mapped virtiofs mounts verified.")
            case "--platform": print(bootstrap.platform)
            case "--install-user": try GuestUserInstall.install(bootstrap)
            case "--install-browser": try GuestChromeInstallation.install(bootstrap)
            case "--request-recording-permission":
                try requestGuestRecordingPermission(bootstrap)
                print("Guest screen recording permission is granted. Restart the prepared guest agent if macOS requests it.")
            case "--serve":
                let running = try GuestAgent(bootstrap: bootstrap)
                try running.start()
                withExtendedLifetime(running) { dispatchMain() }
            default: throw GuestFault("guest_argument_refused")
            }
        } catch let fault as GuestFault { fputs("QAutraGuestAgent: " + fault.code + "\n", stderr); exit(1) }
        catch { fputs("QAutraGuestAgent: preparation_failed\n", stderr); exit(1) }
    }
}
