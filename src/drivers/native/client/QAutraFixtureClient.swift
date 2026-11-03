import Foundation
import CryptoKit
import Darwin
import Security

private final class QAutraNoRedirect: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}

private struct QAutraPublicationPending: Error {}

final class QAutraFixtureClient {
    private static let hexDigits = Array("0123456789abcdef".utf8)
    private let root: URL
    private let endpoint: URL
    private let credential: String
    private let applicationId: String
    private let principal: [String: String]
    private let session: URLSession
    private let files = FileManager.default
    private let lock = NSLock()
    private var polling: Task<Void, Never>?
    private var failure: Error?
    private var stopped = false
    private var waiting = false
    private var authorizationDeadline: TimeInterval = 0
    private var authorization: [String: Any]?
    private var originalNative: NSDictionary?
    private var originalBootstrap: NSDictionary?

    init(clientEndpoint: URL, appCredential: String, expectedPrincipal: [String: String]) throws {
        #if !DEBUG
        throw CocoaError(.fileReadNoPermission)
        #endif
        guard clientEndpoint.scheme == "https", let host = clientEndpoint.host, !host.isEmpty, clientEndpoint.user == nil, clientEndpoint.password == nil, clientEndpoint.query == nil, clientEndpoint.fragment == nil, appCredential.utf8.count >= 32, appCredential.utf8.count <= 4096, appCredential.utf8.allSatisfy({ $0 >= 33 && $0 <= 126 }), let app = Bundle.main.bundleIdentifier else { throw CocoaError(.fileReadNoPermission) }
        try Self.keys(expectedPrincipal, ["clientAuthorityId", "principalRef", "accountRef", "tenant"])
        for value in expectedPrincipal.values { guard Self.matches(value, "^[A-Za-z0-9][A-Za-z0-9._:@-]{0,199}$") else { throw CocoaError(.fileReadCorruptFile) } }
        endpoint = clientEndpoint
        credential = appCredential
        applicationId = app
        principal = expectedPrincipal
        root = try files.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true).appendingPathComponent("qautra-fixture", isDirectory: true)
        var directory: ObjCBool = false
        if files.fileExists(atPath: root.path, isDirectory: &directory) {
            guard directory.boolValue else { throw CocoaError(.fileReadNoPermission) }
        } else {
            try files.createDirectory(at: root, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        }
        guard root.resolvingSymlinksInPath().path == root.path else { throw CocoaError(.fileReadNoPermission) }
        try files.setAttributes([.posixPermissions: 0o700], ofItemAtPath: root.path)
        let ready = root.appendingPathComponent("ready.json")
        if !files.fileExists(atPath: ready.path) { try Self.write(["schema": "qautra/native-private-mailbox/v1", "applicationId": app], to: ready) }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.urlCredentialStorage = nil
        configuration.urlCache = nil
        configuration.timeoutIntervalForRequest = 3
        configuration.timeoutIntervalForResource = 4
        session = URLSession(configuration: configuration, delegate: QAutraNoRedirect(), delegateQueue: nil)
    }

    static func provisioned() throws -> QAutraFixtureClient {
        let support = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        let value = try read(support.appendingPathComponent("qautra-client.json"), maximum: 16384)
        try keys(value, ["schema", "clientEndpoint", "appCredential", "principal"])
        guard value["schema"] as? String == "qautra/native-client-provision/v1", let urlString = value["clientEndpoint"] as? String, let url = URL(string: urlString), url.absoluteString == urlString, let credential = value["appCredential"] as? String, let principal = value["principal"] as? [String: String] else { throw CocoaError(.fileReadCorruptFile) }
        return try QAutraFixtureClient(clientEndpoint: url, appCredential: credential, expectedPrincipal: principal)
    }

    private func synchronized<T>(_ body: () throws -> T) rethrows -> T {
        lock.lock(); defer { lock.unlock() }
        return try body()
    }

    private func start() throws {
        try synchronized {
            guard polling == nil, !stopped, failure == nil else { throw CocoaError(.fileWriteFileExists) }
            polling = Task { [weak self] in
                while !Task.isCancelled {
                    guard let self = self else { return }
                    do {
                        try await self.pollOnce()
                        try await Task.sleep(nanoseconds: 50_000_000)
                    } catch {
                        self.synchronized { self.failure = error; self.authorization = nil }
                        return
                    }
                }
            }
        }
    }

    func waitForAuthorization(timeoutMs: Int = 30000) async throws {
        guard (50...60000).contains(timeoutMs) else { throw CocoaError(.fileReadNoPermission) }
        try synchronized { guard !waiting, !stopped else { throw CocoaError(.userCancelled) }; waiting = true }
        do {
            try start()
            let deadline = ProcessInfo.processInfo.systemUptime + Double(timeoutMs) / 1000
            while true {
                try Task.checkCancellation()
                let ready = try synchronized { () throws -> Bool in
                    if stopped { throw CocoaError(.userCancelled) }
                    if let failure = failure { throw failure }
                    return authorization != nil
                }
                if ready { try requireAuthorization(); return }
                guard ProcessInfo.processInfo.systemUptime < deadline else { throw URLError(.timedOut) }
                try await Task.sleep(nanoseconds: 20_000_000)
            }
        } catch { stop(); throw error }
    }

    func requireAuthorization() throws {
        try synchronized {
            guard let bootstrap = originalBootstrap, let native = bootstrap["nativeClient"] as? [String: Any], let originalSession = native["sessionId"] as? String, bootstrap.isEqual(to: try Self.read(root.appendingPathComponent(originalSession).appendingPathComponent("bootstrap.json"), maximum: 16384)) else { throw CocoaError(.fileReadNoPermission) }
            guard !stopped, failure == nil, authorization != nil, ProcessInfo.processInfo.systemUptime < authorizationDeadline else { throw CocoaError(.fileReadNoPermission) }
        }
    }

    func stop() {
        let task = synchronized { () -> Task<Void, Never>? in
            stopped = true; authorization = nil
            let task = polling; polling = nil
            return task
        }
        task?.cancel()
        session.invalidateAndCancel()
    }

    private static func matches(_ value: String, _ expression: String) -> Bool { value.range(of: expression, options: .regularExpression) != nil }
    private static func keys<T>(_ value: [String: T], _ expected: [String]) throws {
        guard Set(value.keys) == Set(expected) else { throw CocoaError(.fileReadCorruptFile) }
    }
    private static func date(_ value: String) throws -> Date {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let date = formatter.date(from: value) else { throw CocoaError(.fileReadCorruptFile) }
        return date
    }
    private static func read(_ url: URL, maximum: Int) throws -> [String: Any] {
        let fd = Darwin.open(url.path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
        guard fd >= 0 else { throw CocoaError(.fileReadNoPermission) }
        defer { Darwin.close(fd) }
        var before = stat()
        guard fstat(fd, &before) == 0, (before.st_mode & S_IFMT) == S_IFREG, before.st_uid == geteuid(), (before.st_mode & 0o077) == 0, before.st_size >= 0, before.st_size <= maximum else { throw CocoaError(.fileReadNoPermission) }
        if before.st_nlink > 1 { throw QAutraPublicationPending() }
        guard before.st_nlink == 1 else { throw CocoaError(.fileReadNoPermission) }
        var data = Data(count: Int(before.st_size))
        try data.withUnsafeMutableBytes { buffer in
            var offset = 0
            while offset < buffer.count {
                let count = Darwin.read(fd, buffer.baseAddress!.advanced(by: offset), buffer.count - offset)
                guard count > 0 else { throw CocoaError(.fileReadCorruptFile) }
                offset += count
            }
        }
        var after = stat()
        guard fstat(fd, &after) == 0, before.st_dev == after.st_dev, before.st_ino == after.st_ino, before.st_size == after.st_size, before.st_mtimespec.tv_sec == after.st_mtimespec.tv_sec, before.st_mtimespec.tv_nsec == after.st_mtimespec.tv_nsec, let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw CocoaError(.fileReadCorruptFile) }
        return object
    }
    private static func persistClaim(_ url: URL) throws {
        let fd = Darwin.open(url.path, O_RDWR | O_NOFOLLOW | O_NONBLOCK)
        guard fd >= 0 else { throw CocoaError(.fileWriteUnknown) }
        defer { Darwin.close(fd) }
        var info = stat()
        guard fstat(fd, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG, info.st_nlink == 1, info.st_uid == geteuid(), (info.st_mode & 0o077) == 0, fsync(fd) == 0 else { throw CocoaError(.fileWriteUnknown) }
        try syncDirectory(url.deletingLastPathComponent())
    }
    private static func syncDirectory(_ url: URL) throws {
        let fd = Darwin.open(url.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
        guard fd >= 0 else { throw CocoaError(.fileWriteUnknown) }
        defer { Darwin.close(fd) }
        guard fsync(fd) == 0 else { throw CocoaError(.fileWriteUnknown) }
    }
    private static func write(_ value: [String: Any], to url: URL) throws {
        let pending = url.appendingPathExtension("pending")
        let fd = Darwin.open(pending.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
        guard fd >= 0 else { throw CocoaError(.fileWriteFileExists) }
        defer { Darwin.close(fd) }
        let data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
        try data.withUnsafeBytes { buffer in
            var offset = 0
            while offset < buffer.count {
                let count = Darwin.write(fd, buffer.baseAddress!.advanced(by: offset), buffer.count - offset)
                guard count > 0 else { throw CocoaError(.fileWriteUnknown) }
                offset += count
            }
        }
        guard fsync(fd) == 0, Darwin.link(pending.path, url.path) == 0 else { throw CocoaError(.fileWriteFileExists) }
        guard Darwin.unlink(pending.path) == 0 else { throw CocoaError(.fileWriteUnknown) }
        let directory = Darwin.open(url.deletingLastPathComponent().path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
        guard directory >= 0 else { throw CocoaError(.fileWriteUnknown) }
        defer { Darwin.close(directory) }
        guard fsync(directory) == 0 else { throw CocoaError(.fileWriteUnknown) }
    }

    private func validate(_ result: [String: Any], probe: String, claim: [String: Any], bootstrap: [String: Any], dispatchedAt: TimeInterval) throws -> (envelope: [String: Any], deadline: TimeInterval) {
        try Self.keys(result, ["schema", "payload", "mac"])
        guard result["schema"] as? String == "qautra/native-client-authenticated-response/v1", let payload = result["payload"] as? String, let data = Data(base64Encoded: payload), data.count <= 196608, let mac = result["mac"] as? String, Self.matches(mac, "^[a-f0-9]{64}$") else { throw CocoaError(.fileReadCorruptFile) }
        let message = Data("qautra/native-client-response/v1\n".utf8) + data
        let received = stride(from: 0, to: 64, by: 2).map { index -> UInt8 in let start = mac.index(mac.startIndex, offsetBy: index); return UInt8(mac[start..<mac.index(start, offsetBy: 2)], radix: 16)! }
        guard HMAC<SHA256>.isValidAuthenticationCode(received, authenticating: message, using: SymmetricKey(data: Data(credential.utf8))), let value = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw CocoaError(.fileReadNoPermission) }
        try Self.keys(value, ["schema", "clientProbe", "claim", "witness"])
        guard value["schema"] as? String == "qautra/native-start-authorization/v1", value["clientProbe"] as? String == probe, let echoed = value["claim"] as? NSDictionary, echoed.isEqual(to: claim), let envelope = value["witness"] as? [String: Any], let witness = envelope["witness"] as? [String: Any], let signature = envelope["signature"] as? String, Self.matches(signature, "^[a-f0-9]{64}$") else { throw CocoaError(.fileReadNoPermission) }
        try Self.keys(envelope, ["witness", "signature"])
        try Self.keys(witness, ["schema", "challenge", "attemptId", "ownerId", "subjectSha256", "adapterSha256", "scopeSha256", "receiptSha256", "lease", "clientAuthorityId", "principalRef", "accountRef", "tenant", "conditions", "nativeClient", "observedAt", "expiresAt"])
        guard witness["schema"] as? String == "qautra/project-fixture-client-witness/v1", let native = witness["nativeClient"] as? NSDictionary, let expectedNative = bootstrap["nativeClient"] as? [String: Any], native.isEqual(to: expectedNative) else { throw CocoaError(.fileReadCorruptFile) }
        for field in ["challenge", "receiptSha256"] { guard witness[field] as? String == claim[field] as? String else { throw CocoaError(.fileReadCorruptFile) } }
        for field in ["attemptId", "ownerId", "subjectSha256", "scopeSha256", "clientAuthorityId"] { guard witness[field] as? String == bootstrap[field] as? String else { throw CocoaError(.fileReadCorruptFile) } }
        for (field, expected) in principal { guard witness[field] as? String == expected else { throw CocoaError(.fileReadNoPermission) } }
        guard principal["principalRef"] != expectedNative["sessionId"] as? String, principal["clientAuthorityId"] != expectedNative["sessionId"] as? String else { throw CocoaError(.fileReadNoPermission) }
        for field in ["subjectSha256", "adapterSha256", "scopeSha256", "receiptSha256", "challenge"] { guard let value = witness[field] as? String, Self.matches(value, "^[a-f0-9]{64}$") else { throw CocoaError(.fileReadCorruptFile) } }
        guard let lease = witness["lease"] as? [String: Any], let expectedLease = bootstrap["lease"] as? [String: Any], let conditions = witness["conditions"] as? [String: String] else { throw CocoaError(.fileReadCorruptFile) }
        try Self.keys(lease, ["id", "generation", "fence", "expiresAt"])
        for field in ["id", "generation", "fence"] { guard let actual = lease[field] as? NSObject, let expected = expectedLease[field] as? NSObject, actual.isEqual(expected) else { throw CocoaError(.fileReadCorruptFile) } }
        try Self.keys(conditions, ["frontendSha256", "apiSha256", "configSha256"])
        guard conditions.values.allSatisfy({ Self.matches($0, "^[a-f0-9]{64}$") }), let observed = witness["observedAt"] as? String, let expires = witness["expiresAt"] as? String, let leaseExpires = lease["expiresAt"] as? String else { throw CocoaError(.fileReadCorruptFile) }
        let observedDate = try Self.date(observed), expiryDate = try Self.date(expires)
        let proofTtl = expiryDate.timeIntervalSince(observedDate), leaseTtl = try Self.date(leaseExpires).timeIntervalSince(observedDate)
        let deadline = dispatchedAt + min(proofTtl, leaseTtl)
        guard proofTtl > 0, proofTtl <= 60, leaseTtl > 0, ProcessInfo.processInfo.systemUptime < deadline else { throw CocoaError(.fileReadNoPermission) }
        return (envelope, deadline)
    }

    private func pollOnce() async throws {
        try synchronized { if stopped { throw CocoaError(.userCancelled) }; if let failure = failure { throw failure } }
        let directories = try files.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)
        guard directories.count <= 100 else { throw CocoaError(.fileReadTooLarge) }
        for directory in directories {
            let name = directory.lastPathComponent
            guard Self.matches(name, "^[A-Za-z0-9][A-Za-z0-9._:@-]{0,199}$"), (try? directory.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true, directory.resolvingSymlinksInPath().path == directory.path else { continue }
            let bootstrapURL = directory.appendingPathComponent("bootstrap.json")
            guard files.fileExists(atPath: bootstrapURL.path) else { continue }
            let bootstrap: [String: Any]
            do { bootstrap = try Self.read(bootstrapURL, maximum: 16384) } catch is QAutraPublicationPending { continue }
            try Self.keys(bootstrap, ["kind", "nativeClient", "clientEndpoint", "mailbox", "token", "clientAuthorityId", "lease", "attemptId", "ownerId", "subjectSha256", "scopeSha256"])
            guard bootstrap["kind"] as? String == "native-private-mailbox", bootstrap["clientEndpoint"] as? String == endpoint.absoluteString, let native = bootstrap["nativeClient"] as? [String: Any], native["applicationId"] as? String == applicationId, native["platform"] as? String == "ios", native["sessionId"] as? String == name else { throw CocoaError(.fileReadCorruptFile) }
            try Self.keys(native, ["platform", "deviceId", "applicationId", "buildSha256", "sessionId"])
            guard let build = native["buildSha256"] as? String, Self.matches(build, "^[a-f0-9]{64}$") else { throw CocoaError(.fileReadCorruptFile) }
            try synchronized {
                if let original = originalNative, !original.isEqual(to: native) { throw CocoaError(.fileReadNoPermission) }
                if let original = originalBootstrap, !original.isEqual(to: bootstrap) { throw CocoaError(.fileReadNoPermission) }
                originalNative = native as NSDictionary; originalBootstrap = bootstrap as NSDictionary
            }
            let requests = try files.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil).filter { Self.matches($0.lastPathComponent, "^[a-f0-9]{64}\\.request\\.json$") }.sorted { $0.lastPathComponent < $1.lastPathComponent }
            guard requests.count <= 10000 else { throw CocoaError(.fileReadTooLarge) }
            for requestURL in requests {
                let claimed = directory.appendingPathComponent(requestURL.lastPathComponent.replacingOccurrences(of: ".request.", with: ".claimed."))
                guard !files.fileExists(atPath: claimed.path) else { continue }
                do { _ = try Self.read(requestURL, maximum: 16384) } catch is QAutraPublicationPending { continue }
                try files.moveItem(at: requestURL, to: claimed)
                try Self.persistClaim(claimed)
                let claim = try Self.read(claimed, maximum: 16384)
                try Self.keys(claim, ["schema", "token", "nativeClient", "challenge", "receiptSha256"])
                guard claim["schema"] as? String == "qautra/project-fixture-native-claim/v1", claim["token"] as? String == bootstrap["token"] as? String, let claimNative = claim["nativeClient"] as? NSDictionary, claimNative.isEqual(to: native), let challenge = claim["challenge"] as? String, Self.matches(challenge, "^[a-f0-9]{64}$"), claimed.lastPathComponent == challenge + ".claimed.json" else { throw CocoaError(.fileReadCorruptFile) }
                var random = [UInt8](repeating: 0, count: 32)
                guard SecRandomCopyBytes(kSecRandomDefault, random.count, &random) == errSecSuccess else { throw CocoaError(.fileReadNoPermission) }
                var encoded = [UInt8](repeating: 0, count: random.count * 2)
                for index in random.indices {
                    encoded[index * 2] = Self.hexDigits[Int(random[index] >> 4)]
                    encoded[index * 2 + 1] = Self.hexDigits[Int(random[index] & 15)]
                }
                let probe = String(decoding: encoded, as: UTF8.self)
                var request = URLRequest(url: endpoint)
                request.httpMethod = "POST"
                request.setValue("application/json", forHTTPHeaderField: "Content-Type")
                request.setValue("Bearer " + credential, forHTTPHeaderField: "Authorization")
                request.httpBody = try JSONSerialization.data(withJSONObject: ["schema": "qautra/native-client-probe/v1", "clientProbe": probe, "claim": claim])
                let dispatchedAt = ProcessInfo.processInfo.systemUptime
                let (bytes, response) = try await session.bytes(for: request)
                guard let response = response as? HTTPURLResponse, response.statusCode == 200, response.url == endpoint, response.value(forHTTPHeaderField: "Content-Type") == "application/json", response.value(forHTTPHeaderField: "Location") == nil else { throw CocoaError(.fileReadNoPermission) }
                var data = Data()
                for try await byte in bytes { guard data.count < 262144 else { throw CocoaError(.fileReadTooLarge) }; data.append(byte) }
                guard let result = try JSONSerialization.jsonObject(with: data) as? [String: Any], NSDictionary(dictionary: try Self.read(bootstrapURL, maximum: 16384)).isEqual(to: bootstrap), !Task.isCancelled else { throw CocoaError(.fileReadCorruptFile) }
                let validated = try validate(result, probe: probe, claim: claim, bootstrap: bootstrap, dispatchedAt: dispatchedAt)
                let envelope = validated.envelope
                try synchronized {
                    guard !stopped, failure == nil, !Task.isCancelled else { throw CocoaError(.userCancelled) }
                    try Self.write(envelope, to: directory.appendingPathComponent(challenge + ".response.json"))
                    authorizationDeadline = validated.deadline
                    authorization = envelope["witness"] as? [String: Any]
                }
            }
        }
    }
}
