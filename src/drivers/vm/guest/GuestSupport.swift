import Foundation
import CryptoKit
import Darwin
import CoreFoundation

struct GuestFault: Error {
    let code: String
    let message: String
    init(_ code: String, _ message: String = "Guest operation refused.") { self.code = code; self.message = message }
}

enum GuestLimits {
    static let frame = 16 * 1024 * 1024
    static let body = 8 * 1024 * 1024
    static let response = 15 * 1024 * 1024
    static let queuedBytes = 32 * 1024 * 1024
    static let streams = 64
    static let contexts = 8
    static let ports = 32
}

enum GuestJSON {
    static func parse(_ data: Data, stringLimit: Int = GuestLimits.body) throws -> Any {
        guard data.count <= GuestLimits.frame else { throw GuestFault("invalid_json") }
        return try data.withUnsafeBytes { (bytes: UnsafeRawBufferPointer) in
            var parser = Parser(bytes: bytes, stringLimit: stringLimit)
            let value = try parser.value(0)
            parser.space()
            guard parser.index == bytes.count else { throw GuestFault("invalid_json") }
            return value
        }
    }
    static func encode(_ value: Any) throws -> Data {
        do { return try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .fragmentsAllowed]) }
        catch { throw GuestFault("invalid_json") }
    }
    static func object(_ value: Any) throws -> [String: Any] {
        guard let result = value as? [String: Any] else { throw GuestFault("invalid_object") }
        return result
    }
    static func keys(_ object: [String: Any], required: Set<String>, optional: Set<String> = []) throws {
        let actual = Set(object.keys)
        guard required.isSubset(of: actual), actual.isSubset(of: required.union(optional)) else { throw GuestFault("invalid_keys") }
    }
    static func string(_ value: Any?, maximum: Int = 4096) throws -> String {
        guard let result = value as? String, !result.isEmpty, result.utf8.count <= maximum else { throw GuestFault("invalid_string") }
        return result
    }
    static func integer(_ value: Any?, minimum: Int = 0, maximum: Int = 9_007_199_254_740_991) throws -> Int {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { throw GuestFault("invalid_integer") }
        let x = number.doubleValue
        guard x.isFinite, x.rounded() == x, x >= Double(minimum), x <= Double(maximum) else { throw GuestFault("invalid_integer") }
        return Int(x)
    }
    static func uuid(_ value: Any?) throws -> String {
        let text = try string(value, maximum: 36)
        guard let uuid = UUID(uuidString: text), uuid.uuidString.lowercased() == text else { throw GuestFault("invalid_uuid") }
        return text
    }
    private struct Parser {
        let bytes: UnsafeRawBufferPointer
        let stringLimit: Int
        var index = 0
        var nodes = 0
        mutating func space() {
            while index < bytes.count {
                switch bytes[index] {
                case 9, 10, 13, 32: index += 1
                default: return
                }
            }
        }
        mutating func value(_ depth: Int) throws -> Any {
            nodes += 1
            guard depth <= 64, nodes <= 200_000 else { throw GuestFault("json_limit") }
            space()
            guard index < bytes.count else { throw GuestFault("invalid_json") }
            switch bytes[index] {
            case 123:
                index += 1; space(); var result: [String: Any] = [:]
                if take(125) { return result }
                while true {
                    space(); let key = try string()
                    guard result[key] == nil else { throw GuestFault("duplicate_json_key") }
                    space(); guard take(58) else { throw GuestFault("invalid_json") }
                    result[key] = try value(depth + 1); space()
                    if take(125) { return result }
                    guard take(44) else { throw GuestFault("invalid_json") }
                }
            case 91:
                index += 1; space(); var result: [Any] = []
                if take(93) { return result }
                while true {
                    result.append(try value(depth + 1)); space()
                    if take(93) { return result }
                    guard take(44) else { throw GuestFault("invalid_json") }
                }
            case 34: return try string()
            case 116: try literal("true"); return true
            case 102: try literal("false"); return false
            case 110: try literal("null"); return NSNull()
            default: return try number()
            }
        }
        mutating func take(_ byte: UInt8) -> Bool {
            if index < bytes.count && bytes[index] == byte { index += 1; return true }; return false
        }
        mutating func literal(_ expected: StaticString) throws {
            let matches = expected.withUTF8Buffer { expected in
                for byte in expected { if !take(byte) { return false } }
                return true
            }
            guard matches else { throw GuestFault("invalid_json") }
        }
        mutating func string() throws -> String {
            let start = index
            guard take(34) else { throw GuestFault("invalid_json") }
            var escaped = false
            var hasEscape = false
            while index < bytes.count {
                let byte = bytes[index]; index += 1
                if escaped { escaped = false; continue }
                if byte == 92 { escaped = true; hasEscape = true; continue }
                if byte == 34 {
                    let text: String
                    if hasEscape {
                        let fragment = Data(bytes: bytes.baseAddress!.advanced(by: start), count: index - start)
                        guard let decoded = try JSONSerialization.jsonObject(with: fragment, options: [.fragmentsAllowed]) as? String else { throw GuestFault("invalid_json_string") }
                        text = decoded
                    } else {
                        guard index - start - 2 <= stringLimit,
                              let decoded = String(bytes: bytes[(start + 1)..<(index - 1)], encoding: .utf8) else { throw GuestFault("invalid_json_string") }
                        text = decoded
                    }
                    guard text.utf8.count <= stringLimit else { throw GuestFault("json_string_limit") }
                    return text
                }
                guard byte >= 32 else { throw GuestFault("invalid_json_string") }
            }
            throw GuestFault("invalid_json_string")
        }
        mutating func number() throws -> NSNumber {
            let start = index
            _ = take(45)
            guard index < bytes.count else { throw GuestFault("invalid_json_number") }
            if take(48) {
                if index < bytes.count && bytes[index] >= 48 && bytes[index] <= 57 { throw GuestFault("invalid_json_number") }
            } else {
                guard index < bytes.count, bytes[index] >= 49, bytes[index] <= 57 else { throw GuestFault("invalid_json_number") }
                while index < bytes.count && bytes[index] >= 48 && bytes[index] <= 57 { index += 1 }
            }
            if take(46) {
                let first = index
                while index < bytes.count && bytes[index] >= 48 && bytes[index] <= 57 { index += 1 }
                guard index > first else { throw GuestFault("invalid_json_number") }
            }
            if index < bytes.count && [69,101].contains(bytes[index]) {
                index += 1
                if index < bytes.count && [43,45].contains(bytes[index]) { index += 1 }
                let first = index
                while index < bytes.count && bytes[index] >= 48 && bytes[index] <= 57 { index += 1 }
                guard index > first else { throw GuestFault("invalid_json_number") }
            }
            guard index - start <= 128, let text = String(bytes: bytes[start..<index], encoding: .utf8), let x = Double(text), x.isFinite else { throw GuestFault("invalid_json_number") }
            return NSNumber(value: x)
        }
    }
}

func guestNow() -> Int { Int(Date().timeIntervalSince1970 * 1000) }
func guestHex(_ data: Data) -> String { data.map { String(format: "%02x", $0) }.joined() }
func guestHash(_ data: Data) -> String { guestHex(Data(SHA256.hash(data: data))) }
func guestCText<T>(_ value: inout T) -> String { withUnsafeBytes(of: &value) { String(decoding: $0.prefix { $0 != 0 }, as: UTF8.self) } }
func guestSafeSegment(_ value: String, maximum: Int = 256) -> Bool {
    !value.isEmpty && value.utf8.count <= maximum && value.utf8.allSatisfy { (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0) || [45,46,58,95].contains($0) } && value != "." && value != ".."
}

struct GuestCommandResult { let status: Int32; let output: Data }

enum GuestProcess {
    static func environment() -> [String: String] {
        ["PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "HOME": GuestFiles.home.path, "LANG": "en_US.UTF-8", "CHROME_LOG_FILE": "/dev/null"]
    }
    static func stop(_ process: Process) -> Bool {
        if !process.isRunning { return true }
        process.terminate()
        let soft = Date().addingTimeInterval(1)
        while process.isRunning && Date() < soft { usleep(10_000) }
        if process.isRunning { _ = Darwin.kill(process.processIdentifier, SIGKILL) }
        let hard = Date().addingTimeInterval(2)
        while process.isRunning && Date() < hard { usleep(10_000) }
        return !process.isRunning
    }
    static func run(_ executable: String, _ arguments: [String], seconds: TimeInterval = 10, maximum: Int = 64 * 1024) throws -> GuestCommandResult {
        let process = Process(); let pipe = Pipe()
        process.executableURL = URL(fileURLWithPath: executable); process.arguments = arguments
        process.environment = environment(); process.standardInput = FileHandle.nullDevice
        process.standardOutput = pipe; process.standardError = pipe
        do { try process.run() } catch { throw GuestFault("guest_tool_start_failed") }
        pipe.fileHandleForWriting.closeFile()
        let fd = pipe.fileHandleForReading.fileDescriptor
        _ = fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK)
        defer { pipe.fileHandleForReading.closeFile() }
        let end = Date().addingTimeInterval(seconds); var output = Data(); var buffer = [UInt8](repeating: 0, count: 16 * 1024)
        while true {
            while true {
                let count = Darwin.read(fd, &buffer, buffer.count)
                if count > 0 {
                    guard output.count + count <= maximum else { _ = stop(process); throw GuestFault("guest_tool_output_limit") }
                    output.append(contentsOf: buffer.prefix(count))
                } else { break }
            }
            if !process.isRunning { break }
            guard Date() < end else { _ = stop(process); throw GuestFault("guest_tool_timeout") }
            usleep(10_000)
        }
        return GuestCommandResult(status: process.terminationStatus, output: output)
    }
}

enum GuestFiles {
    static let kit = URL(fileURLWithPath: "/Volumes/QAutraKit", isDirectory: true)
    static let status = URL(fileURLWithPath: "/Volumes/QAutraStatus", isDirectory: true)
    static let home: URL = {
        guard let account = getpwuid(getuid()), let directory = account.pointee.pw_dir else { fatalError("guest_account_unavailable") }
        return URL(fileURLWithPath: String(cString: directory), isDirectory: true)
    }()
    static var root: URL { home.appendingPathComponent("Library/Application Support/QAutraGuest", isDirectory: true) }
    static func ensureDirectory(_ url: URL, privateMode: Bool = true, exclusive: Bool = false) throws {
        guard url.standardizedFileURL.path == url.path, url.resolvingSymlinksInPath().path == url.path else { throw GuestFault("unsafe_directory") }
        let made = mkdir(url.path, privateMode ? 0o700 : 0o755)
        if made != 0 && (errno != EEXIST || exclusive) { throw GuestFault("directory_conflict") }
        var info = stat()
        guard lstat(url.path, &info) == 0, (info.st_mode & S_IFMT) == S_IFDIR, info.st_uid == getuid(), (info.st_mode & 0o022) == 0 else { throw GuestFault("unsafe_directory") }
        if privateMode && (info.st_mode & 0o077) != 0 { throw GuestFault("directory_permissions") }
    }
    static func read(_ url: URL, maximum: Int = 64 * 1024, privateMode: Bool = true) throws -> Data {
        let fd = open(url.path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
        guard fd >= 0 else { throw GuestFault(errno == ENOENT ? "file_missing" : "file_access_denied") }
        defer { close(fd) }
        var info = stat()
        guard fstat(fd, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG, info.st_size >= 0, info.st_size <= maximum else { throw GuestFault("unsafe_file") }
        if privateMode && (info.st_uid != getuid() || (info.st_mode & 0o077) != 0) { throw GuestFault("file_permissions") }
        var data = Data(); var buffer = [UInt8](repeating: 0, count: 16 * 1024)
        while true {
            let count = Darwin.read(fd, &buffer, buffer.count)
            if count == 0 { break }
            if count < 0 { if errno == EINTR { continue }; throw GuestFault("file_read_failed") }
            guard data.count + count <= maximum else { throw GuestFault("file_limit") }
            data.append(contentsOf: buffer.prefix(count))
        }
        return data
    }
    static func json(_ url: URL, maximum: Int = 64 * 1024) throws -> [String: Any] { try GuestJSON.object(GuestJSON.parse(read(url, maximum: maximum))) }
    static func atomic(_ url: URL, value: Any) throws {
        let bytes = try GuestJSON.encode(value)
        try atomicData(url, bytes: bytes)
    }
    static func atomicData(_ url: URL, bytes: Data) throws {
        let temporary = url.deletingLastPathComponent().appendingPathComponent(".qautra-" + UUID().uuidString.lowercased())
        let fd = open(temporary.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard fd >= 0 else { throw GuestFault("atomic_create_failed") }
        var published = false
        defer { close(fd); if !published { _ = unlink(temporary.path) } }
        try bytes.withUnsafeBytes { raw in
            var offset = 0
            while offset < raw.count {
                let count = Darwin.write(fd, raw.baseAddress!.advanced(by: offset), raw.count - offset)
                if count < 0 && errno == EINTR { continue }
                guard count > 0 else { throw GuestFault("atomic_write_failed") }
                offset += count
            }
        }
        guard fsync(fd) == 0, fchmod(fd, 0o600) == 0, rename(temporary.path, url.path) == 0 else { throw GuestFault("atomic_publish_failed") }
        published = true
    }
    static func hashFile(_ url: URL, maximum: Int = 1024 * 1024 * 1024) throws -> String {
        let handle: FileHandle
        do { handle = try FileHandle(forReadingFrom: url) } catch { throw GuestFault("artifact_read_failed") }
        defer { try? handle.close() }
        var hash = SHA256(); var total = 0
        while true {
            let data: Data
            do { data = try handle.read(upToCount: 1024 * 1024) ?? Data() } catch { throw GuestFault("artifact_read_failed") }
            if data.isEmpty { break }; total += data.count
            guard total <= maximum else { throw GuestFault("artifact_limit") }
            hash.update(data: data)
        }
        return guestHex(Data(hash.finalize()))
    }
    static func mount(_ url: URL, tag: String, readOnly: Bool) throws {
        let fd = open(url.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard fd >= 0 else { throw GuestFault("guest_mount_missing") }; defer { close(fd) }
        var fs = statfs()
        guard fstatfs(fd, &fs) == 0 else { throw GuestFault("guest_mount_unavailable") }
        let kind = guestCText(&fs.f_fstypename); let source = guestCText(&fs.f_mntfromname); let target = guestCText(&fs.f_mntonname)
        guard kind == "virtiofs", source == tag, target == url.path, ((fs.f_flags & UInt32(MNT_RDONLY)) != 0) == readOnly else { throw GuestFault("guest_mount_identity_mismatch") }
    }
    static func sysctlText(_ key: String) throws -> String {
        var size = 0
        guard sysctlbyname(key, nil, &size, nil, 0) == 0, size > 1, size <= 4096 else { throw GuestFault("guest_sysctl_unavailable") }
        var bytes = [CChar](repeating: 0, count: size)
        guard sysctlbyname(key, &bytes, &size, nil, 0) == 0 else { throw GuestFault("guest_sysctl_unavailable") }
        return bytes.withUnsafeBytes { String(decoding: $0.prefix(while: { $0 != 0 }), as: UTF8.self) }
    }
    static func requireGuestUser() throws {
        #if !arch(arm64)
        throw GuestFault("guest_requires_arm64")
        #endif
        var present: Int32 = 0; var size = MemoryLayout<Int32>.size
        guard geteuid() != 0, sysctlbyname("kern.hv_vmm_present", &present, &size, nil, 0) == 0, present == 1 else { throw GuestFault("real_guest_user_required", "Run only as the logged-in user inside the owned macOS virtual machine.") }
        var console = stat()
        guard stat("/dev/console", &console) == 0, console.st_uid == getuid() else { throw GuestFault("guest_gui_login_required") }
    }
    static func requireGuest() throws {
        try requireGuestUser()
        try mount(kit, tag: "QAutraKit", readOnly: true)
        try mount(status, tag: "QAutraStatus", readOnly: false)
    }
}

struct GuestBootstrap: Sendable {
    let instanceId: String
    let epoch: Int
    let token: String
    let platform: String
    let gateway: String
    let address: String
    let bootID: String
    static func load() throws -> GuestBootstrap {
        try GuestFiles.requireGuest()
        let object = try GuestFiles.json(GuestFiles.kit.appendingPathComponent("instance.json"))
        try GuestJSON.keys(object, required: ["version","instanceId","epoch","bootToken","platform"])
        guard try GuestJSON.integer(object["version"], minimum: 1, maximum: 1) == 1 else { throw GuestFault("bootstrap_version") }
        let instance = try GuestJSON.uuid(object["instanceId"])
        let epoch = try GuestJSON.integer(object["epoch"], minimum: 1)
        let token = try GuestJSON.string(object["bootToken"], maximum: 512)
        guard token.utf8.count >= 32, token.utf8.allSatisfy({ $0 >= 33 && $0 <= 126 }) else { throw GuestFault("invalid_boot_token") }
        let platform = try GuestJSON.string(object["platform"], maximum: 32)
        guard ["desktop-safari","desktop-chrome"].contains(platform) else { throw GuestFault("invalid_guest_platform") }
        let route = try GuestProcess.run("/sbin/route", ["-n","get","default"], maximum: 16 * 1024)
        guard route.status == 0 else { throw GuestFault("guest_network_pending") }
        guard let text = String(data: route.output, encoding: .utf8) else { throw GuestFault("guest_route_unavailable") }
        var fields: [String: String] = [:]
        for line in text.split(separator: "\n") {
            let pair = line.split(separator: ":", maxSplits: 1).map { $0.trimmingCharacters(in: .whitespaces) }
            if pair.count == 2 && ["gateway","interface"].contains(pair[0]) {
                guard fields[pair[0]] == nil else { throw GuestFault("ambiguous_guest_route") }; fields[pair[0]] = pair[1]
            }
        }
        guard let gateway = fields["gateway"], ipv4(gateway), let interface = fields["interface"], guestSafeSegment(interface, maximum: 32) else { throw GuestFault("guest_route_unavailable") }
        var head: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&head) == 0 else { throw GuestFault("guest_address_unavailable") }
        defer { freeifaddrs(head) }
        var cursor = head; var addresses = Set<String>()
        while let item = cursor {
            defer { cursor = item.pointee.ifa_next }
            guard String(cString: item.pointee.ifa_name) == interface, let addr = item.pointee.ifa_addr, addr.pointee.sa_family == UInt8(AF_INET) else { continue }
            var buffer = [CChar](repeating: 0, count: Int(INET_ADDRSTRLEN))
            let source = UnsafeRawPointer(addr).assumingMemoryBound(to: sockaddr_in.self)
            var ip = source.pointee.sin_addr
            if let text = inet_ntop(AF_INET, &ip, &buffer, socklen_t(buffer.count)) { addresses.insert(String(cString: text)) }
        }
        guard !addresses.isEmpty else { throw GuestFault("guest_network_pending") }
        guard addresses.count == 1, let address = addresses.first, ipv4(address), address != gateway else { throw GuestFault("ambiguous_guest_address") }
        return GuestBootstrap(instanceId: instance, epoch: epoch, token: token, platform: platform, gateway: gateway, address: address, bootID: try GuestFiles.sysctlText("kern.bootsessionuuid"))
    }
    static func ipv4(_ value: String) -> Bool {
        let pieces = value.split(separator: ".", omittingEmptySubsequences: false)
        guard pieces.count == 4 else { return false }
        var values: [Int] = []
        for piece in pieces { guard let x = Int(piece), x >= 0, x <= 255, String(x) == piece else { return false }; values.append(x) }
        return values[0] > 0 && values[0] != 127 && values[0] < 224 && value != "255.255.255.255"
    }
    func current() throws {
        let object = try GuestFiles.json(GuestFiles.kit.appendingPathComponent("instance.json"))
        try GuestJSON.keys(object, required: ["version","instanceId","epoch","bootToken","platform"])
        guard try GuestJSON.integer(object["version"], minimum: 1, maximum: 1) == 1,
              try GuestJSON.uuid(object["instanceId"]) == instanceId,
              try GuestJSON.integer(object["epoch"], minimum: 1) == epoch,
              try GuestJSON.string(object["bootToken"], maximum: 512) == token,
              try GuestJSON.string(object["platform"], maximum: 32) == platform else { throw GuestFault("guest_epoch_revoked") }
    }
    func writeHello() throws {
        try GuestFiles.atomic(GuestFiles.status.appendingPathComponent("hello.json"), value: ["version":1,"instanceId":instanceId,"epoch":epoch,"bootTokenHash":guestHash(Data(token.utf8)),"guestPid":Int(getpid()),"gatewayIPv4":gateway,"guestIPv4":address,"osVersion":ProcessInfo.processInfo.operatingSystemVersionString])
    }
    func verifyInstalledIdentity() throws {
        try GuestFiles.ensureDirectory(GuestFiles.root)
        let identity = try GuestFiles.json(GuestFiles.root.appendingPathComponent("identity.json"))
        try GuestJSON.keys(identity, required: ["version","instanceId","platform"])
        guard try GuestJSON.integer(identity["version"], minimum: 1, maximum: 1) == 1, try GuestJSON.uuid(identity["instanceId"]) == instanceId, try GuestJSON.string(identity["platform"]) == platform else { throw GuestFault("guest_install_identity_conflict") }
    }
}

struct GuestConnectionConfig: Sendable {
    let host: String
    let port: UInt16
    let pin: String
    static func load(_ bootstrap: GuestBootstrap) throws -> GuestConnectionConfig? {
        let url = GuestFiles.kit.appendingPathComponent("connection.json")
        var info = stat()
        if lstat(url.path, &info) != 0 && errno == ENOENT { return nil }
        let object = try GuestFiles.json(url)
        try GuestJSON.keys(object, required: ["version","instanceId","epoch","host","port","certificateSha256"])
        guard try GuestJSON.integer(object["version"], minimum: 1, maximum: 1) == 1, try GuestJSON.uuid(object["instanceId"]) == bootstrap.instanceId else { throw GuestFault("connection_identity_conflict") }
        if try GuestJSON.integer(object["epoch"], minimum: 1) != bootstrap.epoch { return nil }
        let host = try GuestJSON.string(object["host"], maximum: 15)
        let port = try GuestJSON.integer(object["port"], minimum: 1, maximum: 65535)
        let pin = try GuestJSON.string(object["certificateSha256"], maximum: 64)
        guard host == bootstrap.gateway, GuestBootstrap.ipv4(host), pin.utf8.count == 64, pin.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }) else { throw GuestFault("invalid_connection_config") }
        return GuestConnectionConfig(host: host, port: UInt16(port), pin: pin)
    }
}

enum GuestReply { case success(Any); case failure(GuestFault, String) }
struct GuestRequest {
    let id: String
    let epoch: Int
    let deadline: Int
    let operation: String
    let payload: [String: Any]
    let bytes: Int
    let reply: @Sendable (GuestReply) -> Void
}
