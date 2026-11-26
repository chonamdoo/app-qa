import Foundation
import Security
import Darwin

// The serial delegate queue owns mutations; run reads after semaphore completion.
private final class GuestDownload: NSObject, URLSessionDataDelegate, URLSessionTaskDelegate, @unchecked Sendable {
    private let destination: URL
    private let expected: URL
    private let maximum: Int
    private let signal = DispatchSemaphore(value: 0)
    private var fd: Int32 = -1
    private var count = 0
    private var redirects = 0
    private var failure: GuestFault?
    private var accepted = false
    init(destination: URL, expected: URL, maximum: Int) { self.destination = destination; self.expected = expected; self.maximum = maximum }
    static func fetch(_ url: URL, to destination: URL, maximum: Int) throws {
        let download = GuestDownload(destination: destination, expected: url, maximum: maximum)
        try download.run()
    }
    private func allowed(_ url: URL) -> Bool {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false), components.scheme == "https", components.user == nil, components.password == nil, components.query == nil, components.fragment == nil, components.port == nil || components.port == 443 else { return false }
        return components.host == expected.host && components.percentEncodedPath == URLComponents(url: expected, resolvingAgainstBaseURL: false)?.percentEncodedPath
    }
    private func run() throws {
        guard allowed(expected) else { throw GuestFault("browser_download_url_refused") }
        fd = open(destination.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard fd >= 0 else { throw GuestFault("browser_download_conflict") }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil; configuration.httpShouldSetCookies = false; configuration.urlCredentialStorage = nil; configuration.urlCache = nil
        configuration.timeoutIntervalForRequest = 30; configuration.timeoutIntervalForResource = 300
        let operations = OperationQueue(); operations.maxConcurrentOperationCount = 1
        let session = URLSession(configuration: configuration, delegate: self, delegateQueue: operations)
        let task = session.dataTask(with: expected); task.resume()
        if signal.wait(timeout: .now() + 330) == .timedOut {
            task.cancel(); session.invalidateAndCancel()
            if signal.wait(timeout: .now() + 10) == .timedOut { throw GuestFault("browser_download_timeout") }
        }
        session.finishTasksAndInvalidate()
        guard failure == nil, accepted, count > 0 else { throw failure ?? GuestFault("browser_download_failed") }
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        redirects += 1
        guard redirects <= 5, let url = request.url, allowed(url) else { failure = GuestFault("browser_download_redirect_refused"); completionHandler(nil); return }
        var clean = URLRequest(url: url); clean.httpMethod = "GET"; clean.timeoutInterval = 30; completionHandler(clean)
    }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse, completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        guard let response = response as? HTTPURLResponse, response.statusCode == 200, let url = response.url, allowed(url), response.expectedContentLength <= maximum else { failure = GuestFault("browser_download_response_refused"); completionHandler(.cancel); return }
        accepted = true; completionHandler(.allow)
    }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        guard failure == nil, count + data.count <= maximum else { failure = GuestFault("browser_download_limit"); dataTask.cancel(); return }
        do {
            try data.withUnsafeBytes { raw in
                var offset = 0
                while offset < raw.count {
                    let written = Darwin.write(fd, raw.baseAddress!.advanced(by: offset), raw.count - offset)
                    if written < 0 && errno == EINTR { continue }
                    guard written > 0 else { throw GuestFault("browser_download_write_failed") }; offset += written
                }
            }
            count += data.count
        } catch { failure = GuestFault("browser_download_write_failed"); dataTask.cancel() }
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if error != nil && failure == nil { failure = GuestFault("browser_download_failed") }
        if fd >= 0 {
            if fsync(fd) != 0 && failure == nil { failure = GuestFault("browser_download_sync_failed") }
            close(fd); fd = -1
        }
        signal.signal()
    }
}

private struct GuestZipEntry {
    let path: String
    let directory: Bool
    let link: Bool
    let size: Int
    let mode: UInt32
    let lower: Int
    let upper: Int
}

private enum GuestZip {
    static func extract(_ archive: URL, into target: URL, root expectedRoot: String, allowAppLinks: Bool) throws {
        let bytes: Data
        do { bytes = try Data(contentsOf: archive, options: .mappedIfSafe) } catch { throw GuestFault("browser_archive_read_failed") }
        guard bytes.count >= 22, bytes.count <= 1024 * 1024 * 1024 else { throw GuestFault("browser_archive_limit") }
        func u16(_ offset: Int) throws -> Int {
            guard offset >= 0, offset + 2 <= bytes.count else { throw GuestFault("invalid_zip") }
            return Int(bytes[offset]) | Int(bytes[offset + 1]) << 8
        }
        func u32(_ offset: Int) throws -> Int {
            guard offset >= 0, offset + 4 <= bytes.count else { throw GuestFault("invalid_zip") }
            return Int(bytes[offset]) | Int(bytes[offset + 1]) << 8 | Int(bytes[offset + 2]) << 16 | Int(bytes[offset + 3]) << 24
        }
        func extras(_ offset: Int, _ count: Int) throws {
            var cursor = offset; let end = offset + count
            guard end <= bytes.count else { throw GuestFault("invalid_zip") }
            while cursor < end {
                let type = try u16(cursor); let size = try u16(cursor + 2); cursor += 4
                guard cursor + size <= end, [0x5455,0x7875].contains(type) else { throw GuestFault("unsupported_zip_extra") }; cursor += size
            }
            guard cursor == end else { throw GuestFault("invalid_zip") }
        }
        var end: Int?
        for cursor in stride(from: bytes.count - 22, through: max(0, bytes.count - 65557), by: -1) {
            if try u32(cursor) == 0x06054b50, cursor + 22 + (try u16(cursor + 20)) == bytes.count { end = cursor; break }
        }
        guard let end = end, try u16(end + 4) == 0, try u16(end + 6) == 0 else { throw GuestFault("unsupported_zip") }
        let count = try u16(end + 10); let directorySize = try u32(end + 12); let directoryOffset = try u32(end + 16)
        guard count > 0, count < 65535, count == (try u16(end + 8)), directoryOffset + directorySize == end else { throw GuestFault("unsupported_zip") }
        var entries: [String: GuestZipEntry] = [:]; var folded = Set<String>(); var cursor = directoryOffset; var total = 0
        for _ in 0..<count {
            guard try u32(cursor) == 0x02014b50 else { throw GuestFault("invalid_zip") }
            let flags = try u16(cursor + 8); let method = try u16(cursor + 10); let compressed = try u32(cursor + 20); let expanded = try u32(cursor + 24)
            let nameLength = try u16(cursor + 28); let extraLength = try u16(cursor + 30); let commentLength = try u16(cursor + 32)
            let attributes = UInt32(try u32(cursor + 38)); let local = try u32(cursor + 42)
            guard flags & ~0x080e == 0, [0,8].contains(method), try u16(cursor + 34) == 0, compressed < 0xffffffff, expanded < 0xffffffff, nameLength > 0, nameLength <= 2048 else { throw GuestFault("unsupported_zip") }
            let nameStart = cursor + 46; let next = nameStart + nameLength + extraLength + commentLength
            guard next <= end, let rawName = String(data: bytes[nameStart..<(nameStart + nameLength)], encoding: .utf8), rawName == rawName.precomposedStringWithCanonicalMapping else { throw GuestFault("invalid_zip_path") }
            try extras(nameStart + nameLength, extraLength)
            let directory = rawName.hasSuffix("/"); let path = directory ? String(rawName.dropLast()) : rawName
            let components = path.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
            guard components.first == expectedRoot, components.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." && $0 != "__MACOSX" && !$0.hasPrefix("._") && !$0.contains(":") && !$0.contains("\\") && !$0.contains("*") && !$0.contains("?") && !$0.contains("[") && !$0.contains("]") && $0.utf8.allSatisfy({ $0 >= 32 && $0 != 127 }) }) else { throw GuestFault("unsafe_zip_path") }
            let foldedPath = path.folding(options: [.caseInsensitive,.diacriticInsensitive], locale: Locale(identifier: "en_US_POSIX"))
            guard folded.insert(foldedPath).inserted else { throw GuestFault("zip_path_collision") }
            let mode = attributes >> 16; let kind = mode & UInt32(S_IFMT); let link = kind == UInt32(S_IFLNK)
            guard mode & 0o7000 == 0, kind == 0 || kind == UInt32(S_IFREG) || kind == UInt32(S_IFDIR) || (link && allowAppLinks && path.contains(".app/")), (kind != UInt32(S_IFDIR) || directory), (!directory || expanded == 0) else { throw GuestFault("zip_special_entry_refused") }
            guard expanded <= 768 * 1024 * 1024, compressed > 0 || expanded == 0, expanded <= max(1, compressed) * 2000 else { throw GuestFault("zip_expansion_limit") }
            total += expanded; guard total <= 3 * 1024 * 1024 * 1024 else { throw GuestFault("zip_expansion_limit") }
            guard local < directoryOffset, try u32(local) == 0x04034b50, try u16(local + 6) == flags, try u16(local + 8) == method else { throw GuestFault("zip_header_mismatch") }
            let localNameLength = try u16(local + 26); let localExtraLength = try u16(local + 28)
            guard localNameLength == nameLength, local + 30 + localNameLength + localExtraLength + compressed <= directoryOffset, bytes[(local + 30)..<(local + 30 + localNameLength)] == bytes[nameStart..<(nameStart + nameLength)] else { throw GuestFault("zip_header_mismatch") }
            try extras(local + 30 + localNameLength, localExtraLength)
            if flags & 8 == 0 { guard try u32(local + 18) == compressed, try u32(local + 22) == expanded else { throw GuestFault("zip_header_mismatch") } }
            entries[path] = GuestZipEntry(path: path, directory: directory, link: link, size: expanded, mode: mode, lower: local, upper: local + 30 + localNameLength + localExtraLength + compressed)
            cursor = next
        }
        guard cursor == end else { throw GuestFault("invalid_zip_directory") }
        let ranges = entries.values.sorted { $0.lower < $1.lower }
        guard ranges.first?.lower == 0 else { throw GuestFault("zip_prefix_refused") }
        for index in 1..<ranges.count { guard ranges[index - 1].upper <= ranges[index].lower else { throw GuestFault("zip_overlapping_entries") } }
        var known = Set(entries.keys)
        for entry in entries.values {
            var parent = (entry.path as NSString).deletingLastPathComponent
            while !parent.isEmpty { known.insert(parent); parent = (parent as NSString).deletingLastPathComponent }
        }
        var links: [String: String] = [:]
        for entry in entries.values where entry.link {
            guard entry.size > 0, entry.size <= 4096 else { throw GuestFault("zip_link_refused") }
            let value = try GuestProcess.run("/usr/bin/unzip", ["-p",archive.path,entry.path], seconds: 5, maximum: 4096)
            guard value.status == 0, value.output.count == entry.size, let destination = String(data: value.output, encoding: .utf8), !destination.hasPrefix("/"), !destination.contains("\\"), destination.utf8.allSatisfy({ $0 >= 32 && $0 != 127 }) else { throw GuestFault("zip_link_refused") }
            links[entry.path] = destination
        }
        func normalize(_ input: String) throws -> String {
            var result: [String] = []
            for part in input.split(separator: "/", omittingEmptySubsequences: false) {
                if part == "." || part.isEmpty { continue }
                if part == ".." { guard result.count > 1 else { throw GuestFault("zip_link_escape") }; result.removeLast() }
                else { result.append(String(part)) }
            }
            guard result.first == expectedRoot else { throw GuestFault("zip_link_escape") }; return result.joined(separator: "/")
        }
        func resolve(_ input: String, visited: Set<String> = []) throws -> String {
            let input = try normalize(input); let parts = input.split(separator: "/").map(String.init)
            for index in parts.indices {
                let prefix = parts[0...index].joined(separator: "/")
                if let target = links[prefix] {
                    guard visited.count < 32, !visited.contains(prefix) else { throw GuestFault("zip_link_cycle") }
                    let parent = (prefix as NSString).deletingLastPathComponent
                    let tail = parts.dropFirst(index + 1).joined(separator: "/")
                    return try resolve(parent + "/" + target + (tail.isEmpty ? "" : "/" + tail), visited: visited.union([prefix]))
                }
            }
            return input
        }
        for entry in entries.values {
            var parent = (entry.path as NSString).deletingLastPathComponent
            while !parent.isEmpty {
                guard links[parent] == nil, entries[parent]?.directory != false else { throw GuestFault("zip_link_parent_refused") }
                parent = (parent as NSString).deletingLastPathComponent
            }
            if entry.link { guard known.contains(try resolve(entry.path)) else { throw GuestFault("zip_link_target_missing") } }
        }
        try GuestFiles.ensureDirectory(target, exclusive: true)
        let unpack = try GuestProcess.run("/usr/bin/ditto", ["-x","-k","--norsrc","--noextattr","--noacl","--noqtn",archive.path,target.path], seconds: 180, maximum: 64 * 1024)
        guard unpack.status == 0 else { throw GuestFault("browser_archive_extract_failed") }
        guard let enumerator = FileManager.default.enumerator(at: target, includingPropertiesForKeys: nil, options: [], errorHandler: { _, _ in false }) else { throw GuestFault("browser_archive_audit_failed") }
        var observed = Set<String>(); var observedCount = 0
        for case let url as URL in enumerator {
            observedCount += 1; guard observedCount <= 100_000 else { throw GuestFault("browser_archive_entry_limit") }
            let relative = String(url.path.dropFirst(target.path.count + 1))
            var info = stat(); guard lstat(url.path, &info) == 0, known.contains(relative) else { throw GuestFault("browser_archive_audit_failed") }
            observed.insert(relative); let kind = info.st_mode & S_IFMT
            if let link = links[relative] {
                guard kind == S_IFLNK else { throw GuestFault("browser_archive_audit_failed") }
                var buffer = [CChar](repeating: 0, count: 4097); let size = readlink(url.path, &buffer, 4096)
                guard size > 0, String(decoding: buffer.prefix(size).map { UInt8(bitPattern: $0) }, as: UTF8.self) == link else { throw GuestFault("browser_archive_audit_failed") }
                enumerator.skipDescendants()
            } else if let entry = entries[relative], !entry.directory {
                guard kind == S_IFREG, info.st_size == entry.size, chmod(url.path, mode_t(entry.mode == 0 ? 0o644 : entry.mode & 0o755)) == 0 else { throw GuestFault("browser_archive_audit_failed") }
            } else {
                guard kind == S_IFDIR, chmod(url.path, 0o755) == 0 else { throw GuestFault("browser_archive_audit_failed") }
            }
        }
        guard Set(entries.keys).isSubset(of: observed) else { throw GuestFault("browser_archive_missing_entry") }
    }
}

struct GuestChromeInstallation {
    let version: String
    let browser: URL
    let driver: URL
    private static let browserRelative = "chrome/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
    private static let driverRelative = "driver/chromedriver-mac-arm64/chromedriver"
    static func verifyGoogle(_ url: URL) throws {
        let result = try GuestProcess.run("/usr/bin/codesign", ["--verify","--deep","--strict","--test-requirement=anchor apple generic and certificate leaf[subject.OU] = \"EQHXZ8M8AV\"",url.path], seconds: 45, maximum: 16 * 1024)
        guard result.status == 0 else { throw GuestFault("browser_signature_refused") }
    }
    private static func architecture(_ url: URL) throws {
        let result = try GuestProcess.run("/usr/bin/lipo", ["-archs",url.path], maximum: 4096)
        let text = String(data: result.output, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
        guard result.status == 0, text == "arm64" else { throw GuestFault("browser_architecture_refused") }
    }
    static func load(_ bootstrap: GuestBootstrap) throws -> GuestChromeInstallation? {
        guard bootstrap.platform == "desktop-chrome" else { return nil }
        let root = GuestFiles.root.appendingPathComponent("browsers", isDirectory: true)
        var info = stat()
        if lstat(root.path, &info) != 0 && errno == ENOENT { return nil }
        try GuestFiles.ensureDirectory(root)
        let manifest = try GuestFiles.json(root.appendingPathComponent("manifest.json"))
        try GuestJSON.keys(manifest, required: ["version","instanceId","platform","browserVersion","browserRelativePath","driverRelativePath","browserSha256","driverSha256","metadataURL","chromeArchiveSha256","driverArchiveSha256"])
        guard try GuestJSON.integer(manifest["version"], minimum: 1, maximum: 1) == 1, try GuestJSON.uuid(manifest["instanceId"]) == bootstrap.instanceId, try GuestJSON.string(manifest["platform"]) == "mac-arm64", try GuestJSON.string(manifest["browserRelativePath"]) == browserRelative, try GuestJSON.string(manifest["driverRelativePath"]) == driverRelative else { throw GuestFault("browser_manifest_conflict") }
        let version = try GuestJSON.string(manifest["browserVersion"], maximum: 64)
        let browser = root.appendingPathComponent(browserRelative); let driver = root.appendingPathComponent(driverRelative)
        guard browser.resolvingSymlinksInPath().path.hasPrefix(root.path + "/"), driver.resolvingSymlinksInPath().path.hasPrefix(root.path + "/"), FileManager.default.isExecutableFile(atPath: browser.path), FileManager.default.isExecutableFile(atPath: driver.path), try GuestFiles.hashFile(browser) == GuestJSON.string(manifest["browserSha256"]), try GuestFiles.hashFile(driver) == GuestJSON.string(manifest["driverSha256"]) else { throw GuestFault("browser_identity_refused") }
        let app = browser.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        try verifyGoogle(app); try verifyGoogle(driver); try architecture(browser); try architecture(driver)
        let bundle = NSDictionary(contentsOf: app.appendingPathComponent("Contents/Info.plist"))
        guard bundle?["CFBundleIdentifier"] as? String == "com.google.chrome.for.testing", bundle?["CFBundleShortVersionString"] as? String == version else { throw GuestFault("chrome_bundle_version_refused") }
        let actual = try GuestProcess.run(driver.path, ["--version"], maximum: 4096)
        guard actual.status == 0, let text = String(data: actual.output, encoding: .utf8), text.split(separator: " ").prefix(2).map(String.init) == ["ChromeDriver",version] else { throw GuestFault("chromedriver_version_refused") }
        return GuestChromeInstallation(version: version, browser: browser, driver: driver)
    }
    static func install(_ bootstrap: GuestBootstrap) throws {
        try bootstrap.current(); try bootstrap.verifyInstalledIdentity()
        if bootstrap.platform == "desktop-safari" {
            guard FileManager.default.isExecutableFile(atPath: "/usr/bin/safaridriver") else { throw GuestFault("guest_safaridriver_missing") }
            print("Safari is supplied by guest macOS. Guest Safari authorization is still required; no authorization settings were changed."); return
        }
        let final = GuestFiles.root.appendingPathComponent("browsers", isDirectory: true)
        var info = stat(); guard lstat(final.path, &info) != 0 && errno == ENOENT else { throw GuestFault("browser_install_conflict") }
        let stage = GuestFiles.root.appendingPathComponent("browser-staging-" + UUID().uuidString.lowercased(), isDirectory: true)
        try GuestFiles.ensureDirectory(stage, exclusive: true)
        let metadataURL = URL(string: "https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json")!
        let metadataFile = stage.appendingPathComponent("source-metadata.json")
        try GuestDownload.fetch(metadataURL, to: metadataFile, maximum: 1024 * 1024)
        let metadata = try GuestFiles.json(metadataFile, maximum: 1024 * 1024)
        try GuestJSON.keys(metadata, required: ["timestamp","channels"])
        let channels = try GuestJSON.object(metadata["channels"] as Any)
        let stable = try GuestJSON.object(channels["Stable"] as Any)
        try GuestJSON.keys(stable, required: ["channel","version","revision","downloads"])
        guard try GuestJSON.string(stable["channel"]) == "Stable" else { throw GuestFault("browser_metadata_refused") }
        let version = try GuestJSON.string(stable["version"], maximum: 64)
        let parts = version.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 4, parts.allSatisfy({ !$0.isEmpty && $0.count <= 10 && $0.utf8.allSatisfy({ (48...57).contains($0) }) }) else { throw GuestFault("browser_metadata_version_refused") }
        let downloads = try GuestJSON.object(stable["downloads"] as Any)
        func select(_ product: String) throws -> URL {
            guard let list = downloads[product] as? [Any], !list.isEmpty, list.count <= 16 else { throw GuestFault("browser_metadata_download_missing") }
            var selected: URL?; var platforms = Set<String>()
            for item in list {
                let item = try GuestJSON.object(item); try GuestJSON.keys(item, required: ["platform","url"])
                let platform = try GuestJSON.string(item["platform"], maximum: 32)
                guard platforms.insert(platform).inserted else { throw GuestFault("browser_metadata_duplicate_platform") }
                if platform == "mac-arm64" {
                    let expected = "https://storage.googleapis.com/chrome-for-testing-public/" + version + "/mac-arm64/" + product + "-mac-arm64.zip"
                    guard try GuestJSON.string(item["url"], maximum: 2048) == expected, let url = URL(string: expected) else { throw GuestFault("browser_metadata_url_refused") }; selected = url
                }
            }
            guard let selected = selected else { throw GuestFault("browser_metadata_arm64_missing") }; return selected
        }
        let chromeURL = try select("chrome"); let driverURL = try select("chromedriver")
        let chromeZip = stage.appendingPathComponent("chrome.zip"); let driverZip = stage.appendingPathComponent("driver.zip")
        try GuestDownload.fetch(chromeURL, to: chromeZip, maximum: 1024 * 1024 * 1024)
        try GuestDownload.fetch(driverURL, to: driverZip, maximum: 128 * 1024 * 1024)
        let chromeHash = try GuestFiles.hashFile(chromeZip); let driverHash = try GuestFiles.hashFile(driverZip)
        try GuestZip.extract(chromeZip, into: stage.appendingPathComponent("chrome", isDirectory: true), root: "chrome-mac-arm64", allowAppLinks: true)
        try GuestZip.extract(driverZip, into: stage.appendingPathComponent("driver", isDirectory: true), root: "chromedriver-mac-arm64", allowAppLinks: false)
        let browser = stage.appendingPathComponent(browserRelative); let driver = stage.appendingPathComponent(driverRelative)
        let manifest: [String: Any] = ["version":1,"instanceId":bootstrap.instanceId,"platform":"mac-arm64","browserVersion":version,"browserRelativePath":browserRelative,"driverRelativePath":driverRelative,"browserSha256":try GuestFiles.hashFile(browser),"driverSha256":try GuestFiles.hashFile(driver),"metadataURL":metadataURL.absoluteString,"chromeArchiveSha256":chromeHash,"driverArchiveSha256":driverHash]
        try GuestFiles.atomic(stage.appendingPathComponent("manifest.json"), value: manifest)
        let app = browser.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        try verifyGoogle(app); try verifyGoogle(driver); try architecture(browser); try architecture(driver)
        let bundle = NSDictionary(contentsOf: app.appendingPathComponent("Contents/Info.plist"))
        guard bundle?["CFBundleIdentifier"] as? String == "com.google.chrome.for.testing", bundle?["CFBundleShortVersionString"] as? String == version else { throw GuestFault("chrome_bundle_version_refused") }
        let driverVersion = try GuestProcess.run(driver.path, ["--version"], maximum: 4096)
        guard driverVersion.status == 0, let text = String(data: driverVersion.output, encoding: .utf8), text.split(separator: " ").prefix(2).map(String.init) == ["ChromeDriver",version] else { throw GuestFault("chromedriver_version_refused") }
        try FileManager.default.removeItem(at: chromeZip); try FileManager.default.removeItem(at: driverZip)
        try bootstrap.current()
        guard lstat(final.path, &info) != 0 && errno == ENOENT, rename(stage.path, final.path) == 0 else { throw GuestFault("browser_publish_conflict") }
        print("Installed matching mac-arm64 Chrome for Testing and ChromeDriver " + version + " inside the guest. Original bundle resources and supplied license notices were retained.")
    }
}
