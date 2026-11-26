import AppKit
import Foundation
import Security

@MainActor @Observable
final class EngineController {
    enum Phase: Equatable {
        case idle
        case starting(String)
        case connected
        case failed(String)
    }

    static let rootKey = "projectRootOverride"
    static let nodeKey = "nodePathOverride"
    static let portKey = "enginePort"

    private(set) var phase: Phase = .idle {
        didSet {
            if oldValue == .connected, phase != .connected { onDisconnect?() }
        }
    }
    private(set) var info: ServerInfo?
    /// True when this app spawned the engine (and therefore stops it on quit).
    private(set) var owned = false
    private(set) var root: URL?
    private(set) var nodePath: String?
    private(set) var lastExit: String?

    /// Called for every new engine instance we connect to.
    @ObservationIgnored var onConnect: (@MainActor (APIClient, ServerInfo) -> Void)?
    @ObservationIgnored var onDisconnect: (@MainActor () -> Void)?

    @ObservationIgnored private var process: Process?
    @ObservationIgnored private var stdinPipe: Pipe?
    /// Operator review secret handed to our child over its stdin pipe; never written to `.qa/server.json`.
    @ObservationIgnored private var reviewToken: String?
    @ObservationIgnored private var restarts: [Date] = []
    @ObservationIgnored private var stopping = false
    /// Bumped on every start/stop so stale async continuations and exit handlers become no-ops.
    @ObservationIgnored private var generation = 0

    var logURL: URL? { root?.appending(path: ".qa/logs/engine.log") }

    var bakedRoot: String? {
        guard let value = Bundle.main.object(forInfoDictionaryKey: "QAutraRoot") as? String, !value.isEmpty, !value.hasPrefix("$(") else { return nil }
        return value
    }

    func resolveRoot() -> URL? {
        if let override = UserDefaults.standard.string(forKey: Self.rootKey), !override.isEmpty {
            return URL(fileURLWithPath: (override as NSString).expandingTildeInPath)
        }
        return bakedRoot.map { URL(fileURLWithPath: $0) }
    }

    func start() async {
        stopping = false
        generation += 1
        let gen = generation
        guard let root = resolveRoot() else {
            phase = .failed("프로젝트 루트를 알 수 없습니다 — 설정에서 QAutra 프로젝트 폴더를 지정하세요")
            return
        }
        self.root = root
        phase = .starting("실행 중인 엔진 확인 중…")
        if let info = Self.readServerInfo(root: root) {
            do {
                try await verifyHealth(info, root: root)
                guard gen == generation else { return }
                owned = false
                reviewToken = nil
                connect(info)
                return
            } catch let error as APIError where error.status == 409 {
                guard gen == generation else { return }
                phase = .failed(error.message)
                return
            } catch {}
        }
        guard FileManager.default.fileExists(atPath: root.appending(path: "bin/qa.ts").path) else {
            phase = .failed("엔진 진입점이 없습니다: \(root.path)/bin/qa.ts")
            return
        }
        phase = .starting("node 찾는 중…")
        guard let node = await Self.resolveNode(), gen == generation else {
            if gen == generation { phase = .failed("node를 찾을 수 없습니다 — 설정에서 node 경로를 지정하세요") }
            return
        }
        nodePath = node
        await spawn(node: node, root: root, gen: gen)
    }

    /// Re-checks the connection after the event stream keeps failing (e.g. an external engine went away).
    func recover() async {
        if let info, let root {
            do { try await verifyHealth(info, root: root); return }
            catch let error as APIError where error.status == 409 { phase = .failed(error.message); return }
            catch {}
        }
        if owned, let process, process.isRunning { return }  // the exit handler owns restarts of our child
        info = nil
        await start()
    }

    func restart() async {
        stop()
        restarts.removeAll()
        await start()
    }

    /// Stops the child we own (SIGTERM, then SIGKILL after 3 s). External engines are left running.
    func stop() {
        stopping = true
        generation += 1
        info = nil
        reviewToken = nil
        phase = .idle
        guard let process, process.isRunning else { return }
        try? stdinPipe?.fileHandleForWriting.close()
        process.terminate()
        let deadline = Date().addingTimeInterval(3)
        while process.isRunning && Date() < deadline { usleep(50_000) }
        if process.isRunning { kill(process.processIdentifier, SIGKILL) }
        self.process = nil
        stdinPipe = nil
    }

    private func connect(_ info: ServerInfo) {
        self.info = info
        phase = .connected
        onConnect?(APIClient(port: info.port, token: info.token, reviewToken: owned ? reviewToken : nil, projectRoot: root?.standardizedFileURL.path), info)
    }

    private func verifyHealth(_ info: ServerInfo, root: URL) async throws {
        let health = try await APIClient(port: info.port, token: info.token).health()
        let observedRoot = URL(fileURLWithPath: health.root).resolvingSymlinksInPath().standardizedFileURL
        guard health.ok, health.pid == info.pid, health.startedAt == info.startedAt,
              observedRoot == root.resolvingSymlinksInPath().standardizedFileURL else {
            throw APIError(status: 409, message: "현재 작업 공간의 엔진 identity가 일치하지 않습니다. 기존 엔진을 자동 채택하거나 종료하지 않습니다.")
        }
        guard health.productProtocol == "qautra/product/v2" else {
            throw APIError(status: 409, message: "실행 중인 엔진은 현재 제품 계약을 지원하지 않습니다. 해당 엔진의 소유 앱에서 종료한 뒤 다시 연결하세요.")
        }
    }

    private func spawn(node: String, root: URL, gen: Int) async {
        phase = .starting("엔진 시작 중…")
        let child = Process()
        child.executableURL = URL(fileURLWithPath: node)
        let port = UserDefaults.standard.integer(forKey: Self.portKey)
        child.arguments = [root.appending(path: "bin/qa.ts").path, "serve", "--port", String(port), "--exit-with-stdin", "--review-token-stdin"]
        child.currentDirectoryURL = root
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = "\((node as NSString).deletingLastPathComponent):\(env["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin")"
        child.environment = env
        // The engine exits when this pipe closes, so a crashed app never leaves an orphan engine behind.
        let stdin = Pipe()
        child.standardInput = stdin
        if let log = Self.openLog(root: root) {
            child.standardOutput = log
            child.standardError = log
        }
        child.terminationHandler = { [weak self] finished in
            let status = finished.terminationStatus
            let bySignal = finished.terminationReason == .uncaughtSignal
            Task { @MainActor in self?.exited(status: status, bySignal: bySignal, gen: gen) }
        }
        guard let secret = Self.makeReviewToken() else {
            phase = .failed("로컬 검토 권한을 만들 수 없습니다")
            return
        }
        do {
            try child.run()
        } catch {
            phase = .failed("엔진 실행 실패: \(error.localizedDescription)")
            return
        }
        process = child
        stdinPipe = stdin
        owned = true
        reviewToken = secret
        do {
            try stdin.fileHandleForWriting.write(contentsOf: Data("\(secret)\n".utf8))
        } catch {
            phase = .failed("엔진에 로컬 검토 권한을 전달하지 못했습니다: \(error.localizedDescription)")
            child.terminate()
            return
        }
        let pid = child.processIdentifier
        let deadline = ContinuousClock.now + .seconds(20)
        while ContinuousClock.now < deadline, gen == generation, child.isRunning {
            if let info = Self.readServerInfo(root: root), info.pid == pid, (try? await verifyHealth(info, root: root)) != nil {
                guard gen == generation else { return }
                connect(info)
                return
            }
            try? await Task.sleep(for: .milliseconds(200))
        }
        if gen == generation, child.isRunning {
            phase = .failed("엔진이 20초 안에 응답하지 않았습니다 — 로그: \(logURL?.path ?? "")")
            child.terminate()
        }
    }

    private func exited(status: Int32, bySignal: Bool, gen: Int) {
        guard gen == generation else { return }
        process = nil
        stdinPipe = nil
        reviewToken = nil
        info = nil
        let description = bySignal ? "시그널 \(status)" : "종료 코드 \(status)"
        lastExit = description
        if stopping {
            phase = .idle
            return
        }
        let now = Date()
        restarts = restarts.filter { now.timeIntervalSince($0) < 120 } + [now]
        guard restarts.count <= 5 else {
            phase = .failed("엔진이 반복해서 종료됩니다 (\(description)) — 로그를 확인한 뒤 다시 시작하세요")
            return
        }
        let delay = 1 << (restarts.count - 1)
        phase = .starting("엔진 종료됨 (\(description)) — \(delay)초 뒤 다시 시작")
        Task {
            try? await Task.sleep(for: .seconds(delay))
            guard gen == generation, !stopping else { return }
            await start()
        }
    }

    static func readServerInfo(root: URL) -> ServerInfo? {
        guard let data = try? Data(contentsOf: root.appending(path: ".qa/server.json")) else { return nil }
        return try? JSONDecoder().decode(ServerInfo.self, from: data)
    }

    /// 32 random bytes, base64url without padding — the shape `qa serve --review-token-stdin` accepts.
    private static func makeReviewToken() -> String? {
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { return nil }
        return Data(bytes).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    /// Settings override, then the login shell's `command -v node`, then Homebrew defaults.
    static func resolveNode() async -> String? {
        if let override = UserDefaults.standard.string(forKey: nodeKey), !override.isEmpty {
            let path = (override as NSString).expandingTildeInPath
            return FileManager.default.isExecutableFile(atPath: path) ? path : nil
        }
        let found = await Task.detached { () -> String? in
            let shell = Process()
            shell.executableURL = URL(fileURLWithPath: "/bin/zsh")
            shell.arguments = ["-lc", "command -v node"]
            let out = Pipe()
            shell.standardOutput = out
            shell.standardError = FileHandle.nullDevice
            guard (try? shell.run()) != nil else { return nil }
            let data = out.fileHandleForReading.readDataToEndOfFile()
            shell.waitUntilExit()
            return String(decoding: data, as: UTF8.self).split(separator: "\n").last.map { $0.trimmingCharacters(in: .whitespaces) }
        }.value
        if let found, FileManager.default.isExecutableFile(atPath: found) { return found }
        return ["/opt/homebrew/bin/node", "/usr/local/bin/node"].first { FileManager.default.isExecutableFile(atPath: $0) }
    }

    private static func openLog(root: URL) -> FileHandle? {
        let dir = root.appending(path: ".qa/logs")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let file = dir.appending(path: "engine.log")
        if !FileManager.default.fileExists(atPath: file.path) {
            FileManager.default.createFile(atPath: file.path, contents: nil, attributes: [.posixPermissions: 0o600])
        }
        guard let handle = try? FileHandle(forWritingTo: file) else { return nil }
        _ = try? handle.seekToEnd()
        return handle
    }
}
