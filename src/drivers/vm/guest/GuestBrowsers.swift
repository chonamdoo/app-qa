import Foundation
import Darwin
import AppKit
import CryptoKit

struct GuestHTTPResult { let status: Int; let body: Any }

private final class GuestHTTPPending {
    let task: URLSessionDataTask
    let completion: (Result<GuestHTTPResult, GuestFault>) -> Void
    var data = Data()
    var status = 0
    var timer: DispatchSourceTimer?
    init(task: URLSessionDataTask, completion: @escaping (Result<GuestHTTPResult, GuestFault>) -> Void) { self.task = task; self.completion = completion }
}

// Request state stays on queue; URLSession delegates only enqueue changes there.
final class GuestDriverHTTP: NSObject, URLSessionDataDelegate, URLSessionTaskDelegate, @unchecked Sendable {
    private let queue: DispatchQueue
    private var requests: [Int: GuestHTTPPending] = [:]
    private lazy var session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil; configuration.httpShouldSetCookies = false
        configuration.urlCredentialStorage = nil; configuration.urlCache = nil
        configuration.connectionProxyDictionary = [:]; configuration.waitsForConnectivity = false
        configuration.httpMaximumConnectionsPerHost = 16
        let operations = OperationQueue(); operations.maxConcurrentOperationCount = 1
        return URLSession(configuration: configuration, delegate: self, delegateQueue: operations)
    }()
    init(queue: DispatchQueue) { self.queue = queue; super.init() }
    @discardableResult func send(port: UInt16, method: String, path: String, body: Any?, deadline: Int, completion: @escaping (Result<GuestHTTPResult, GuestFault>) -> Void) throws -> Int {
        guard deadline > guestNow(), let url = URL(string: "http://127.0.0.1:\(port)\(path)") else { throw GuestFault("webdriver_deadline") }
        var request = URLRequest(url: url); request.httpMethod = method
        request.timeoutInterval = Double(deadline - guestNow()) / 1000
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body = body {
            let data = try GuestJSON.encode(body)
            guard data.count <= GuestLimits.body else { throw GuestFault("webdriver_body_limit") }
            request.httpBody = data; request.setValue("application/json; charset=utf-8", forHTTPHeaderField: "Content-Type")
        }
        let task = session.dataTask(with: request)
        let pending = GuestHTTPPending(task: task, completion: completion); requests[task.taskIdentifier] = pending
        let timer = DispatchSource.makeTimerSource(queue: queue); pending.timer = timer
        timer.schedule(deadline: .now() + .milliseconds(max(1, deadline - guestNow())))
        timer.setEventHandler { [weak self] in self?.finish(task.taskIdentifier, .failure(GuestFault("webdriver_outcome_unknown", "The dispatched browser command timed out; its effect is unknown."))) }
        timer.resume(); task.resume(); return task.taskIdentifier
    }
    func cancel(_ id: Int) { finish(id, .failure(GuestFault("webdriver_outcome_unknown", "The dispatched browser command was interrupted; its effect is unknown."))) }
    private func finish(_ id: Int, _ result: Result<GuestHTTPResult, GuestFault>) {
        guard let pending = requests.removeValue(forKey: id) else { return }
        pending.timer?.cancel(); pending.task.cancel(); pending.completion(result)
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
        queue.async { self.finish(task.taskIdentifier, .failure(GuestFault("webdriver_redirect_unknown"))) }
    }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse, completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        guard let response = response as? HTTPURLResponse, (200...599).contains(response.statusCode), response.expectedContentLength <= GuestLimits.response else {
            completionHandler(.cancel); queue.async { self.finish(dataTask.taskIdentifier, .failure(GuestFault("webdriver_response_limit_unknown"))) }; return
        }
        completionHandler(.allow)
        queue.async { self.requests[dataTask.taskIdentifier]?.status = response.statusCode }
    }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        queue.async {
            guard let pending = self.requests[dataTask.taskIdentifier] else { return }
            guard pending.data.count + data.count <= GuestLimits.response else { self.finish(dataTask.taskIdentifier, .failure(GuestFault("webdriver_response_limit_unknown"))); return }
            pending.data.append(data)
        }
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        queue.async {
            guard let pending = self.requests[task.taskIdentifier] else { return }
            guard error == nil, pending.status > 0 else { self.finish(task.taskIdentifier, .failure(GuestFault("webdriver_transport_unknown"))); return }
            do {
                let body = try GuestJSON.parse(pending.data, stringLimit: GuestLimits.response); let object = try GuestJSON.object(body)
                guard object.keys.contains("value") else { throw GuestFault("webdriver_malformed_unknown") }
                if pending.status >= 400 {
                    let value = try GuestJSON.object(object["value"]!)
                    _ = try GuestJSON.string(value["error"], maximum: 256)
                }
                self.finish(task.taskIdentifier, .success(GuestHTTPResult(status: pending.status, body: body)))
            } catch { self.finish(task.taskIdentifier, .failure(GuestFault("webdriver_malformed_unknown"))) }
        }
    }
}

private final class GuestBrowserContext {
    let id: String
    var process: Process?
    var port: UInt16 = 0
    var profile: URL?
    var sessionId: String?
    var capabilities: [String: Any]?
    var creationDispatched = false
    var originalSessionId: String?
    var requestedCapabilities: [String: Any]?
    var observing = false
    var runtimeBrowser: NSRunningApplication?
    var commands: [(GuestRequest, String, String, Any?, Int)] = []
    var active: GuestRequest?
    var task: Int?
    init(_ id: String) { self.id = id }
}

final class GuestBrowserOwner {
    private let bootstrap: GuestBootstrap
    private let queue: DispatchQueue
    private let http: GuestDriverHTTP
    private var chrome: GuestChromeInstallation?
    private var contexts: [String: GuestBrowserContext] = [:]
    private var retainedBytes = 0
    private var commandCount = 0
    private(set) var quarantineReason: String?
    private(set) var revoked = false
    var onQuarantine: ((String) -> Void)?
    var beforeDispatch: ((String, String) throws -> Void)?
    init(bootstrap: GuestBootstrap, queue: DispatchQueue, chrome: GuestChromeInstallation?) {
        self.bootstrap = bootstrap; self.queue = queue; self.chrome = chrome; http = GuestDriverHTTP(queue: queue)
    }
    var chromePresent: Bool { chrome != nil }
    var usable: Bool { quarantineReason == nil && !revoked }
    private func evidenceContext(_ identity: GuestRecordingIdentity, session: String? = nil) throws -> GuestBrowserContext {
        try GuestFiles.requireGuestUser()
        try bootstrap.current()
        guard usable, let context = contexts[identity.contextId], context.active == nil, context.commands.isEmpty,
              let current = context.sessionId, current == context.originalSessionId, session == nil || session == current,
              let process = context.process, process.isRunning, try ownsListener(process, port: context.port) else { throw GuestFault("guest_runtime_session_fenced") }
        return context
    }
    func observeRuntime(_ request: GuestRequest, identity: GuestRecordingIdentity) {
        var observing: GuestBrowserContext?
        do {
            let context = try evidenceContext(identity)
            guard !context.observing, let session = context.sessionId else { throw GuestFault("guest_runtime_observation_busy") }
            context.observing = true
            observing = context
            let script = "return {width:innerWidth,height:innerHeight,dpr:devicePixelRatio,language:navigator.language,languages:Array.from(navigator.languages),timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,userAgent:navigator.userAgent,cookieEnabled:navigator.cookieEnabled,online:navigator.onLine};"
            _ = try http.send(port: context.port, method: "POST", path: "/session/" + session + "/execute/sync", body: ["script":script,"args":[]], deadline: request.deadline) { [weak self, weak context] result in
                guard let self = self, let context = context else { return }
                do {
                    _ = try self.evidenceContext(identity, session: session)
                    let page = try Self.evidenceValue(result)
                    _ = try self.http.send(port: context.port, method: "GET", path: "/session/" + session + "/window/rect", body: nil, deadline: request.deadline) { [weak self, weak context] result in
                        guard let self = self, let context = context else { return }
                        defer { context.observing = false }
                        do {
                            _ = try self.evidenceContext(identity, session: session)
                            let window = try Self.evidenceValue(result)
                            let value = try self.runtime(context, identity: identity, page: page, window: window, deadline: request.deadline)
                            _ = try self.evidenceContext(identity, session: session)
                            request.reply(.success(value))
                        } catch { request.reply(.failure(GuestFault("guest_runtime_unverified"), "not_started")) }
                    }
                } catch { context.observing = false; request.reply(.failure(GuestFault("guest_runtime_unverified"), "not_started")) }
            }
        } catch { observing?.observing = false; request.reply(.failure(GuestFault("guest_runtime_session_fenced"), "not_started")) }
    }
    private static func evidenceValue(_ result: Result<GuestHTTPResult, GuestFault>) throws -> [String: Any] {
        let response = try result.get()
        guard (200...299).contains(response.status) else { throw GuestFault("guest_runtime_session_missing") }
        return try GuestJSON.object(try GuestJSON.object(response.body)["value"] as Any)
    }
    private static func executablePath(_ pid: pid_t) throws -> String {
        var path = [CChar](repeating: 0, count: 4096)
        guard proc_pidpath(pid, &path, UInt32(path.count)) > 0 else { throw GuestFault("guest_runtime_process_missing") }
        return URL(fileURLWithPath: String(cString: path)).resolvingSymlinksInPath().path
    }
    private static func arguments(_ pid: pid_t) throws -> [String] {
        var mib: [Int32] = [CTL_KERN, KERN_PROCARGS2, pid]
        var size = 0
        guard sysctl(&mib, 3, nil, &size, nil, 0) == 0, size > 4, size <= 256 * 1024 else { throw GuestFault("guest_runtime_arguments_unavailable") }
        var bytes = [UInt8](repeating: 0, count: size)
        guard sysctl(&mib, 3, &bytes, &size, nil, 0) == 0 else { throw GuestFault("guest_runtime_arguments_unavailable") }
        let argc = bytes.withUnsafeBytes { $0.loadUnaligned(as: Int32.self) }
        guard argc > 0, argc <= 256 else { throw GuestFault("guest_runtime_arguments_unavailable") }
        var offset = 4
        while offset < size && bytes[offset] != 0 { offset += 1 }
        while offset < size && bytes[offset] == 0 { offset += 1 }
        var args: [String] = []
        for _ in 0..<Int(argc) {
            let start = offset
            while offset < size && bytes[offset] != 0 { offset += 1 }
            guard offset < size, offset - start <= 4096, let arg = String(bytes: bytes[start..<offset], encoding: .utf8) else { throw GuestFault("guest_runtime_arguments_unavailable") }
            args.append(arg); offset += 1
        }
        return args
    }
    private static func mappedExecutable(_ pid: pid_t, path: String, info: stat) throws {
        let result = try GuestProcess.run("/usr/sbin/lsof", ["-a","-p",String(pid),"-d","txt","-FfinD"], seconds: 2, maximum: 128 * 1024)
        guard result.status == 0, let text = String(data: result.output, encoding: .utf8) else { throw GuestFault("guest_runtime_mapping_unavailable") }
        var fields: [Character: String] = [:]; var matched = false
        func matches() -> Bool { fields["n"].map { URL(fileURLWithPath: $0).resolvingSymlinksInPath().path } == path && fields["i"] == String(info.st_ino) && fields["D"].flatMap { UInt64($0.dropFirst(2), radix: 16) } == UInt64(UInt32(bitPattern: info.st_dev)) }
        for line in text.split(separator: "\n") {
            guard let kind = line.first else { continue }
            if kind == "f" { matched = matched || matches(); fields = [:] }
            fields[kind] = String(line.dropFirst())
        }
        guard matched || matches() else { throw GuestFault("guest_runtime_loaded_binary_changed") }
    }
    private static func binary(_ path: String, pid: pid_t, deadline: Int) throws -> [String: Any] {
        let canonical = URL(fileURLWithPath: path).resolvingSymlinksInPath().path
        let fd = open(canonical, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK)
        guard fd >= 0 else { throw GuestFault("guest_runtime_binary_missing") }
        defer { close(fd) }
        var before = stat()
        guard fstat(fd, &before) == 0, before.st_mode & S_IFMT == S_IFREG, before.st_size > 0, before.st_size <= 1024 * 1024 * 1024 else { throw GuestFault("guest_runtime_binary_invalid") }
        try mappedExecutable(pid, path: canonical, info: before)
        var hash = SHA256(); var buffer = [UInt8](repeating: 0, count: 1024 * 1024); var total = 0
        while total < before.st_size {
            guard guestNow() < deadline else { throw GuestFault("guest_runtime_hash_deadline") }
            let count = Darwin.read(fd, &buffer, min(buffer.count, Int(before.st_size) - total))
            guard count > 0 else { throw GuestFault("guest_runtime_binary_changed") }
            buffer.withUnsafeBytes { hash.update(bufferPointer: UnsafeRawBufferPointer(rebasing: $0[..<count])) }
            total += count
        }
        var after = stat(); var named = stat()
        func same(_ a: stat, _ b: stat) -> Bool { a.st_dev == b.st_dev && a.st_ino == b.st_ino && a.st_size == b.st_size && a.st_mtimespec.tv_sec == b.st_mtimespec.tv_sec && a.st_mtimespec.tv_nsec == b.st_mtimespec.tv_nsec && a.st_ctimespec.tv_sec == b.st_ctimespec.tv_sec && a.st_ctimespec.tv_nsec == b.st_ctimespec.tv_nsec }
        guard fstat(fd, &after) == 0, lstat(canonical, &named) == 0, same(before, after), same(after, named), URL(fileURLWithPath: path).resolvingSymlinksInPath().path == canonical else { throw GuestFault("guest_runtime_binary_changed") }
        try mappedExecutable(pid, path: canonical, info: after)
        return ["path":canonical,"sha256":guestHex(Data(hash.finalize())),"bytes":total,"coverage":"main-executable-only","device":String(before.st_dev),"inode":String(before.st_ino),"modifiedAt":"\(before.st_mtimespec.tv_sec).\(before.st_mtimespec.tv_nsec)"]
    }
    private func runtime(_ context: GuestBrowserContext, identity: GuestRecordingIdentity, page: [String: Any], window: [String: Any], deadline: Int) throws -> [String: Any] {
        guard let process = context.process, let driverURL = process.executableURL, let caps = context.capabilities, let requested = context.requestedCapabilities, let session = context.sessionId else { throw GuestFault("guest_runtime_session_missing") }
        let driverPath = try Self.executablePath(process.processIdentifier)
        guard driverPath == driverURL.resolvingSymlinksInPath().path else { throw GuestFault("guest_runtime_driver_changed") }
        let safari = bootstrap.platform == "desktop-safari"
        let applications = NSWorkspace.shared.runningApplications.filter { app in
            guard !app.isTerminated, let path = app.executableURL?.resolvingSymlinksInPath().path else { return false }
            if safari { return app.bundleIdentifier == "com.apple.Safari" }
            guard let chrome = chrome, path == chrome.browser.resolvingSymlinksInPath().path, let profile = context.profile, let args = try? Self.arguments(app.processIdentifier) else { return false }
            return args.filter { $0.hasPrefix("--user-data-dir=") } == ["--user-data-dir=" + profile.path]
        }
        guard applications.count == 1, let app = applications.first, let browserURL = app.executableURL, let bundleURL = app.bundleURL, let bundle = Bundle(url: bundleURL),
              let version = bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String, let build = bundle.object(forInfoDictionaryKey: "CFBundleVersion") as? String,
              caps["browserVersion"] as? String == version else { throw GuestFault("guest_runtime_browser_ambiguous") }
        let browserPath = try Self.executablePath(app.processIdentifier)
        guard browserPath == browserURL.resolvingSymlinksInPath().path else { throw GuestFault("guest_runtime_browser_changed") }
        let args = try Self.arguments(app.processIdentifier)
        let driverVersion: String
        if safari {
            let signature = try GuestProcess.run("/usr/bin/codesign", ["--verify","--strict","-R","anchor apple",bundleURL.path], seconds: 2, maximum: 4096)
            guard signature.status == 0 else { throw GuestFault("guest_runtime_actual_safari_unverified") }
            let result = try GuestProcess.run(driverPath, ["--version"], seconds: 2, maximum: 4096)
            guard result.status == 0, let text = String(data: result.output, encoding: .utf8), !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw GuestFault("guest_runtime_driver_version_missing") }
            driverVersion = text.trimmingCharacters(in: .whitespacesAndNewlines)
        } else {
            guard let chromeCaps = caps["chrome"] as? [String: Any], let text = chromeCaps["chromedriverVersion"] as? String else { throw GuestFault("guest_runtime_driver_version_missing") }
            driverVersion = text
        }
        var preferences: [String: Any] = [:]
        if safari {
            let domain = UserDefaults.standard.persistentDomain(forName: "com.apple.Safari") ?? [:]
            for key in ["WebKitJavaScriptEnabled","WebKit2JavaScriptEnabled","BlockStoragePolicy","WebKitPreferences.privateClickMeasurementEnabled","WebKitPreferences.javaScriptCanOpenWindowsAutomatically"] { preferences[key] = domain[key] ?? NSNull() }
        } else {
            guard let profile = context.profile else { throw GuestFault("guest_runtime_profile_missing") }
            let bytes = try GuestFiles.read(profile.appendingPathComponent("Default/Preferences"), maximum: 4 * 1024 * 1024, privateMode: false)
            guard let actual = try JSONSerialization.jsonObject(with: bytes) as? [String: Any] else { throw GuestFault("guest_runtime_preferences_missing") }
            let profileSettings = actual["profile"] as? [String: Any] ?? [:]
            let translate = actual["translate"] as? [String: Any] ?? [:]
            preferences = ["credentials_enable_service":actual["credentials_enable_service"] ?? NSNull(),"profile.password_manager_enabled":profileSettings["password_manager_enabled"] ?? NSNull(),"profile.password_manager_leak_detection":profileSettings["password_manager_leak_detection"] ?? NSNull(),"translate.enabled":translate["enabled"] ?? NSNull()]
            let intl = actual["intl"] as? [String: Any] ?? [:]
            let download = actual["download"] as? [String: Any] ?? [:]
            let safeBrowsing = actual["safebrowsing"] as? [String: Any] ?? [:]
            preferences["intl.accept_languages"] = intl["accept_languages"] ?? NSNull()
            preferences["enable_do_not_track"] = actual["enable_do_not_track"] ?? NSNull()
            preferences["download.prompt_for_download"] = download["prompt_for_download"] ?? NSNull()
            preferences["safebrowsing.enabled"] = safeBrowsing["enabled"] ?? NSNull()
            for key in ["default_content_setting_values","managed_default_content_settings","cookie_controls_mode","block_third_party_cookies"] { preferences["profile." + key] = profileSettings[key] ?? NSNull() }
        }
        let systemData = try GuestFiles.read(URL(fileURLWithPath: "/System/Library/CoreServices/SystemVersion.plist"), maximum: 64 * 1024, privateMode: false)
        guard let system = try PropertyListSerialization.propertyList(from: systemData, format: nil) as? [String: Any] else { throw GuestFault("guest_runtime_os_missing") }
        let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let original = context.runtimeBrowser {
            guard original.processIdentifier == app.processIdentifier, original.launchDate == app.launchDate, !original.isTerminated else { throw GuestFault("guest_runtime_browser_replaced") }
        } else { context.runtimeBrowser = app }
        let browserBinary = try Self.binary(browserPath, pid: app.processIdentifier, deadline: deadline); let driverBinary = try Self.binary(driverPath, pid: process.processIdentifier, deadline: deadline)
        guard try Self.executablePath(app.processIdentifier) == browserPath, try Self.executablePath(process.processIdentifier) == driverPath, process.isRunning, !app.isTerminated else { throw GuestFault("guest_runtime_process_changed") }
        return ["schema":"qautra/guest-browser-runtime/v1","identity":identity.json,"sessionId":session,"observedAt":formatter.string(from: Date()),"platform":bootstrap.platform,"browserVersion":version,"browserBuild":build,"driverVersion":driverVersion,
                "browser":["pid":Int(app.processIdentifier),"executable":browserBinary],"driver":["pid":Int(process.processIdentifier),"executable":driverBinary],"association":safari ? "exclusive-guest-safari-session" : "owned-chrome-profile",
                "os":["platform":"darwin","release":try GuestFiles.sysctlText("kern.osrelease"),"version":try GuestJSON.string(system["ProductVersion"]),"build":try GuestJSON.string(system["ProductBuildVersion"]),"arch":try GuestFiles.sysctlText("hw.machine"),"languages":Locale.preferredLanguages,"timezone":TimeZone.current.identifier],
                "page":page,"window":window,"capabilities":caps,"requestedCapabilities":requested,"settings":["args":args,"preferenceSource":safari ? "safari-preference-overrides" : "chrome-profile-file","preferences":preferences],
                "ephemeral":["sessionId":"session","profilePath":safari ? NSNull() : (context.profile?.path as Any? ?? NSNull()),"browserPid":"process","driverPid":"process"]]
    }
    var status: Any {
        ["quarantined": quarantineReason != nil,"quarantineReason": quarantineReason as Any? ?? NSNull(),"revoked":revoked,"safariDriverPresent":FileManager.default.isExecutableFile(atPath: "/usr/bin/safaridriver"),"chromeDriverPresent":chrome != nil,"chromeVersion":chrome?.version as Any? ?? NSNull(),"contexts":contexts.values.sorted { $0.id < $1.id }.map { context -> [String: Any] in
            ["contextId":context.id,"sessionId":context.sessionId as Any? ?? NSNull(),"driverRunning":context.process?.isRunning ?? false,"commandInFlight":context.active != nil,"capabilities":context.capabilities as Any? ?? NSNull()]
        }]
    }
    func halt(_ reason: String) {
        guard quarantineReason == nil else { return }
        quarantineReason = reason
        let values = Array(contexts.values)
        for context in values {
            let pending = context.commands; context.commands.removeAll()
            for command in pending { retainedBytes -= command.0.bytes; commandCount -= 1; command.0.reply(.failure(GuestFault("machine_quarantined"), "not_started")) }
        }
        onQuarantine?(reason)
        for context in values { if let task = context.task { http.cancel(task) } }
    }
    func handle(_ request: GuestRequest) {
        do {
            guard usable else { throw GuestFault("machine_quarantined") }
            let p = request.payload
            try GuestJSON.keys(p, required: ["contextId","method","path","timeoutMs"], optional: ["body"])
            let id = try GuestJSON.uuid(p["contextId"])
            let method = try GuestJSON.string(p["method"], maximum: 6)
            let path = try GuestJSON.string(p["path"], maximum: 2048)
            let timeout = try GuestJSON.integer(p["timeoutMs"], minimum: 1, maximum: 240_000)
            try Self.endpoint(method: method, path: path)
            var body: Any? = p["body"]
            if method == "POST" { _ = try GuestJSON.object(body as Any) }
            else if body != nil { throw GuestFault("unexpected_webdriver_body") }
            if let body = body, try GuestJSON.encode(body).count > GuestLimits.body { throw GuestFault("webdriver_body_limit") }
            if method == "POST" && path == "/session" { body = try capabilities(try GuestJSON.object(body as Any)) }
            guard retainedBytes + request.bytes <= GuestLimits.queuedBytes, commandCount < 32 else { throw GuestFault("webdriver_queue_limit") }
            let context: GuestBrowserContext
            if let existing = contexts[id] { guard !existing.observing else { throw GuestFault("guest_runtime_observation_busy") }; context = existing }
            else {
                guard contexts.count < (bootstrap.platform == "desktop-safari" ? 1 : GuestLimits.contexts) else { throw GuestFault("guest_context_limit") }
                context = GuestBrowserContext(id); contexts[id] = context
            }
            guard context.commands.count < 4 else { throw GuestFault("context_queue_limit") }
            retainedBytes += request.bytes; commandCount += 1
            context.commands.append((request, method, path, body, timeout)); advance(context)
        } catch let fault as GuestFault { request.reply(.failure(fault, "not_started")) }
        catch { request.reply(.failure(GuestFault("invalid_webdriver_request"), "not_started")) }
    }
    private func advance(_ context: GuestBrowserContext) {
        guard context.active == nil, !context.observing, !context.commands.isEmpty else { return }
        let command = context.commands.removeFirst(); let request = command.0
        context.active = request
        do {
            guard usable, request.epoch == bootstrap.epoch, guestNow() < request.deadline else { throw GuestFault("webdriver_deadline_or_epoch") }
            try bootstrap.current()
            let method = command.1; let path = command.2
            try beforeDispatch?(method, path)
            if path != "/status" && path != "/session" {
                let parts = path.split(separator: "/")
                guard parts.count >= 2, context.sessionId == String(parts[1]) else { throw GuestFault("session_not_owned") }
            }
            if path == "/session" { guard method == "POST", context.sessionId == nil, !context.creationDispatched else { throw GuestFault("context_session_conflict") } }
            try start(context, deadline: request.deadline)
            try bootstrap.current()
            guard usable, guestNow() < request.deadline, let process = context.process, process.isRunning, try ownsListener(process, port: context.port) else { throw GuestFault("driver_ownership_lost") }
            var body = command.3
            if method == "POST" && path == "/session", bootstrap.platform == "desktop-chrome" {
                var outer = try GuestJSON.object(body as Any)
                var caps = try GuestJSON.object(outer["capabilities"] as Any)
                var always = try GuestJSON.object(caps["alwaysMatch"] as Any)
                var options = try GuestJSON.object(always["goog:chromeOptions"] as Any)
                var args = options["args"] as? [String] ?? []
                guard let profile = context.profile else { throw GuestFault("profile_missing") }
                args.append("--user-data-dir=" + profile.path)
                options["args"] = args; always["goog:chromeOptions"] = options; caps["alwaysMatch"] = always; outer["capabilities"] = caps; body = outer
            }
            let deadline = min(request.deadline, guestNow() + command.4)
            guard deadline > guestNow() else { throw GuestFault("webdriver_deadline") }
            if method == "POST" && path == "/session" { context.creationDispatched = true }
            if method == "POST" && path == "/session" { context.requestedCapabilities = try GuestJSON.object(try GuestJSON.object(body as Any)["capabilities"] as Any) }
            context.task = try http.send(port: context.port, method: method, path: path, body: body, deadline: deadline) { [weak self, weak context] result in
                guard let self = self, let context = context else { return }
                context.task = nil
                switch result {
                case .failure(let fault):
                    self.halt(fault.code); self.complete(context, .failure(fault, "unknown"))
                case .success(let response):
                    guard self.quarantineReason == nil, !self.revoked else { self.complete(context, .failure(GuestFault("machine_quarantined"), "unknown")); return }
                    do {
                        if method == "POST" && path == "/session" {
                            if (200...299).contains(response.status) {
                                let outer = try GuestJSON.object(response.body); let value = try GuestJSON.object(outer["value"] as Any)
                                let session = try GuestJSON.string(value["sessionId"], maximum: 128)
                                let caps = try GuestJSON.object(value["capabilities"] as Any)
                                let name = try GuestJSON.string(caps["browserName"], maximum: 64).lowercased()
                                let version = try GuestJSON.string(caps["browserVersion"], maximum: 128)
                                guard guestSafeSegment(session, maximum: 128), !self.contexts.values.contains(where: { $0 !== context && $0.sessionId == session }), name == (self.bootstrap.platform == "desktop-safari" ? "safari" : "chrome") else { throw GuestFault("session_identity_unknown") }
                                if let chrome = self.chrome, self.bootstrap.platform == "desktop-chrome", version != chrome.version { throw GuestFault("browser_version_unknown") }
                                context.sessionId = session; context.capabilities = caps
                                if context.originalSessionId == nil { context.originalSessionId = session }
                            } else {
                                self.halt("session_creation_failed")
                            }
                        }
                        if method == "DELETE", path == "/session/" + (context.sessionId ?? ""), (200...299).contains(response.status) {
                            let outer = try GuestJSON.object(response.body)
                            guard outer["value"] is NSNull else { throw GuestFault("session_close_unknown") }
                            context.sessionId = nil; context.capabilities = nil; context.creationDispatched = false
                            if let process = context.process, !GuestProcess.stop(process) { throw GuestFault("driver_exit_unknown") }
                            context.process = nil
                            if let profile = context.profile { try FileManager.default.removeItem(at: profile); context.profile = nil }
                        }
                        self.complete(context, .success(["status":response.status,"body":response.body]))
                    } catch {
                        self.halt("webdriver_protocol_unknown"); self.complete(context, .failure(GuestFault("webdriver_protocol_unknown"), "unknown"))
                    }
                }
            }
        } catch let fault as GuestFault {
            if context.sessionId != nil && context.process?.isRunning != true { halt("driver_ownership_lost") }
            complete(context, .failure(fault, "not_started"))
        } catch { complete(context, .failure(GuestFault("guest_driver_start_failed"), "not_started")) }
    }
    private func complete(_ context: GuestBrowserContext, _ reply: GuestReply) {
        guard let request = context.active else { return }
        context.active = nil; context.task = nil; retainedBytes -= request.bytes; commandCount -= 1
        request.reply(reply)
        if context.commands.isEmpty, context.sessionId == nil, context.process == nil, !context.creationDispatched { contexts.removeValue(forKey: context.id) }
        else { advance(context) }
    }
    private func start(_ context: GuestBrowserContext, deadline: Int) throws {
        if let process = context.process { guard process.isRunning else { throw GuestFault("driver_ownership_lost") }; return }
        guard guestNow() < deadline else { throw GuestFault("webdriver_deadline") }
        let root = GuestFiles.root.appendingPathComponent("contexts", isDirectory: true); try GuestFiles.ensureDirectory(root)
        let profile = root.appendingPathComponent(UUID().uuidString.lowercased(), isDirectory: true); try GuestFiles.ensureDirectory(profile, exclusive: true)
        context.profile = profile
        let port = try Self.freePort(); let process = Process()
        if bootstrap.platform == "desktop-safari" {
            guard FileManager.default.isExecutableFile(atPath: "/usr/bin/safaridriver") else { throw GuestFault("guest_safaridriver_missing") }
            process.executableURL = URL(fileURLWithPath: "/usr/bin/safaridriver"); process.arguments = ["--port",String(port)]
        } else {
            guard let chrome = chrome else { throw GuestFault("guest_chrome_not_installed", "Run the guest installer with --install-browser before creating a Chrome session.") }
            process.executableURL = chrome.driver; process.arguments = ["--port=" + String(port),"--allowed-ips=127.0.0.1,::1","--silent"]
        }
        process.environment = GuestProcess.environment(); process.standardInput = FileHandle.nullDevice
        process.standardOutput = FileHandle.nullDevice; process.standardError = FileHandle.nullDevice
        do { try process.run() } catch { throw GuestFault("guest_driver_start_failed") }
        context.process = process; context.port = port
        let end = min(deadline, guestNow() + 5000)
        while guestNow() < end && process.isRunning {
            if (try? ownsListener(process, port: port)) == true { return }
            usleep(50_000)
        }
        let stopped = GuestProcess.stop(process)
        if stopped { context.process = nil }
        if !stopped { halt("driver_exit_unknown") }
        throw GuestFault("guest_driver_listen_failed")
    }
    private func ownsListener(_ process: Process, port: UInt16) throws -> Bool {
        guard process.isRunning else { return false }
        let result = try GuestProcess.run("/usr/sbin/lsof", ["-nP","-a","-p",String(process.processIdentifier),"-iTCP:" + String(port),"-sTCP:LISTEN","-Fpn"], seconds: 2, maximum: 16 * 1024)
        guard result.status == 0, let text = String(data: result.output, encoding: .utf8) else { return false }
        let lines = text.split(separator: "\n").map(String.init)
        let owners = lines.filter { $0.hasPrefix("p") }
        let names = lines.filter { $0.hasPrefix("n") }
        return owners == ["p" + String(process.processIdentifier)] && !names.isEmpty && names.allSatisfy { $0 == "n127.0.0.1:" + String(port) || $0 == "n[::1]:" + String(port) }
    }
    private static func freePort() throws -> UInt16 {
        let fd = socket(AF_INET, SOCK_STREAM, 0); guard fd >= 0 else { throw GuestFault("driver_port_unavailable") }; defer { close(fd) }
        var address = sockaddr_in(); address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size); address.sin_family = sa_family_t(AF_INET); address.sin_addr.s_addr = inet_addr("127.0.0.1")
        let bound = withUnsafePointer(to: &address) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) } }
        guard bound == 0 else { throw GuestFault("driver_port_unavailable") }
        var size = socklen_t(MemoryLayout<sockaddr_in>.size)
        let got = withUnsafeMutablePointer(to: &address) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &size) } }
        guard got == 0 else { throw GuestFault("driver_port_unavailable") }; return UInt16(bigEndian: address.sin_port)
    }
    private func capabilities(_ outer: [String: Any]) throws -> [String: Any] {
        try GuestJSON.keys(outer, required: ["capabilities"])
        let raw = try GuestJSON.object(outer["capabilities"] as Any)
        try GuestJSON.keys(raw, required: [], optional: ["alwaysMatch","firstMatch"])
        var always = try cleanCapabilities(GuestJSON.object(raw["alwaysMatch"] ?? [:]), first: false)
        let first = raw["firstMatch"] as? [Any] ?? [[:]]
        guard !first.isEmpty, first.count <= 16 else { throw GuestFault("invalid_first_match") }
        let alternatives = try first.map { try cleanCapabilities(GuestJSON.object($0), first: true) }
        always["browserName"] = bootstrap.platform == "desktop-safari" ? "safari" : "chrome"; always["platformName"] = "mac"
        if bootstrap.platform == "desktop-chrome" {
            if chrome == nil {
                guard contexts.values.allSatisfy({ $0.sessionId == nil && $0.process == nil && $0.active == nil && $0.commands.isEmpty }) else { throw GuestFault("guest_browser_install_busy") }
                chrome = try GuestChromeInstallation.load(bootstrap)
            }
            guard let chrome = chrome else { throw GuestFault("guest_chrome_not_installed") }
            always["goog:chromeOptions"] = ["binary":chrome.browser.path,"args":["--no-first-run","--no-default-browser-check","--disable-search-engine-choice-screen","--disable-logging","--lang=ko-KR"],"prefs":["credentials_enable_service":false,"profile":["password_manager_enabled":false,"password_manager_leak_detection":false],"translate":["enabled":false]]]
        }
        return ["capabilities":["alwaysMatch":always,"firstMatch":alternatives]]
    }
    private func cleanCapabilities(_ input: [String: Any], first: Bool) throws -> [String: Any] {
        let allowed: Set<String> = ["browserName","platformName","browserVersion","acceptInsecureCerts","pageLoadStrategy","proxy","setWindowRect","timeouts","unhandledPromptBehavior","strictFileInteractability","goog:chromeOptions","goog:loggingPrefs"]
        var result: [String: Any] = [:]
        for (key, value) in input {
            if key.hasPrefix("appium:") { continue }
            guard allowed.contains(key), key != "proxy" else { throw GuestFault("unsupported_browser_capability") }
            if key == "browserName" {
                let name = try GuestJSON.string(value, maximum: 32).lowercased()
                guard name == (bootstrap.platform == "desktop-safari" ? "safari" : "chrome") else { throw GuestFault("browser_capability_conflict") }; continue
            }
            if key == "platformName" { guard ["mac","macos"].contains(try GuestJSON.string(value).lowercased()) else { throw GuestFault("browser_capability_conflict") }; continue }
            if key == "browserVersion" { guard (value as? String) == "" else { throw GuestFault("browser_version_override_refused") }; continue }
            if key == "goog:chromeOptions" {
                guard !first, bootstrap.platform == "desktop-chrome" else { throw GuestFault("unsupported_browser_capability") }
                let options = try GuestJSON.object(value); try GuestJSON.keys(options, required: [], optional: ["args","prefs"])
                if let args = options["args"] {
                    guard let list = args as? [String], list.allSatisfy({ ["--no-first-run","--no-default-browser-check","--disable-search-engine-choice-screen","--lang=ko-KR"].contains($0) }) else { throw GuestFault("chrome_argument_refused") }
                }
                if let prefs = options["prefs"] {
                    let expected: [String: Any] = ["credentials_enable_service":false,"profile":["password_manager_enabled":false,"password_manager_leak_detection":false],"translate":["enabled":false]]
                    guard try GuestJSON.encode(prefs) == GuestJSON.encode(expected) else { throw GuestFault("chrome_preferences_refused") }
                }
                continue
            }
            if key == "goog:loggingPrefs" {
                guard bootstrap.platform == "desktop-chrome", try GuestJSON.encode(value) == GuestJSON.encode(["browser":"ALL"]) else { throw GuestFault("browser_logging_capability_refused") }
            }
            result[key] = value
        }
        return result
    }
    private static func endpoint(method: String, path: String) throws {
        guard ["GET","POST","DELETE"].contains(method), path.hasPrefix("/"), !path.contains("//"), !path.contains("%"), !path.contains("?"), !path.contains("#"), !path.contains("\\"), !path.hasSuffix("/") else { throw GuestFault("invalid_webdriver_path") }
        let parts = path.split(separator: "/").map(String.init)
        guard parts.allSatisfy({ guestSafeSegment($0, maximum: 512) }) else { throw GuestFault("invalid_webdriver_path") }
        if path == "/status" && method == "GET" { return }
        if path == "/session" && method == "POST" { return }
        guard parts.count >= 2, parts[0] == "session", guestSafeSegment(parts[1], maximum: 128) else { throw GuestFault("unsupported_webdriver_endpoint") }
        let suffix = Array(parts.dropFirst(2)); let route = suffix.joined(separator: "/")
        let fixed: [String: Set<String>] = [
            "":["GET","DELETE"],"timeouts":["GET","POST"],"url":["GET","POST"],"back":["POST"],"forward":["POST"],"refresh":["POST"],"title":["GET"],"source":["GET"],"screenshot":["GET"],"window":["GET","POST","DELETE"],"window/handles":["GET"],"window/new":["POST"],"window/rect":["GET","POST"],"window/maximize":["POST"],"window/minimize":["POST"],"window/fullscreen":["POST"],"frame":["POST"],"frame/parent":["POST"],"element":["POST"],"elements":["POST"],"element/active":["GET"],"execute/sync":["POST"],"execute/async":["POST"],"actions":["POST","DELETE"],"alert/dismiss":["POST"],"alert/accept":["POST"],"alert/text":["GET","POST"],"cookie":["GET","POST","DELETE"],"print":["POST"],"se/log":["POST"]]
        if fixed[route]?.contains(method) == true { return }
        if suffix.count == 2 && suffix[0] == "cookie" && ["GET","DELETE"].contains(method) { return }
        if suffix.count >= 3 && suffix[0] == "element" {
            let tail = suffix[2]
            if suffix.count == 3 && ((["element","elements","click","clear","value"].contains(tail) && method == "POST") || (["text","name","rect","selected","enabled","displayed","screenshot"].contains(tail) && method == "GET")) { return }
            if suffix.count == 4 && ["attribute","property","css"].contains(tail) && method == "GET" { return }
        }
        throw GuestFault("unsupported_webdriver_endpoint")
    }
    func revoke(deadline: Int, completion: @escaping (Bool) -> Void) {
        guard !revoked else { completion(false); return }
        revoked = true
        for context in Array(contexts.values) {
            let pending = context.commands; context.commands.removeAll()
            for command in pending { retainedBytes -= command.0.bytes; commandCount -= 1; command.0.reply(.failure(GuestFault("guest_revoked"), "not_started")) }
        }
        for context in Array(contexts.values) { if let task = context.task { http.cancel(task) } }
        let values = Array(contexts.values)
        if values.isEmpty { completion(true); return }
        var remaining = values.count; var allClosed = true
        let finish: (Bool) -> Void = { closed in allClosed = allClosed && closed; remaining -= 1; if remaining == 0 { completion(allClosed) } }
        for context in values {
            guard let session = context.sessionId else {
                let safe = !context.creationDispatched
                let stopped = context.process.map(GuestProcess.stop) ?? true
                if stopped { context.process = nil }
                finish(safe && stopped); continue
            }
            do {
                try bootstrap.current()
                _ = try http.send(port: context.port, method: "DELETE", path: "/session/" + session, body: nil, deadline: deadline) { result in
                    var closed = false
                    if case .success(let response) = result, (200...299).contains(response.status), let outer = response.body as? [String: Any], outer["value"] is NSNull {
                        closed = context.process.map(GuestProcess.stop) ?? true
                        if closed { context.sessionId = nil; context.capabilities = nil; context.creationDispatched = false; context.process = nil }
                    }
                    finish(closed)
                }
            } catch { finish(false) }
        }
    }
}
