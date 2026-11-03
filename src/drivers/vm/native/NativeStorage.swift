import Foundation
import Darwin
import CryptoKit

// The file-lease and private-artifact patterns are adapted from E2EVM; see LICENSE.e2evm.
final class NativeFileLease {
    private let descriptor: Int32

    init(_ path: String) throws {
        let fd = open(path, O_RDWR | O_CREAT | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC, 0o600)
        guard fd >= 0 else { throw NativeFault("lease_unavailable", "Cannot open the private resource lease") }
        var info = stat()
        guard fstat(fd, &info) == 0, info.st_mode & S_IFMT == S_IFREG,
              info.st_uid == getuid(), info.st_nlink == 1, info.st_mode & 0o077 == 0 else {
            close(fd)
            throw NativeFault("unsafe_lease", "Resource lease is not a private owned regular file")
        }
        guard flock(fd, LOCK_EX | LOCK_NB) == 0 else {
            close(fd)
            throw NativeFault("resource_busy", "Another native owner holds this resource")
        }
        descriptor = fd
    }

    deinit { flock(descriptor, LOCK_UN); close(descriptor) }
}

enum NativeFiles {
    static func directory(_ path: String) throws {
        var info = stat()
        guard lstat(path, &info) == 0, info.st_mode & S_IFMT == S_IFDIR,
              info.st_uid == getuid(), info.st_mode & 0o077 == 0 else {
            throw NativeFault("unsafe_directory", "Expected an existing private owned directory")
        }
    }

    static func canonicalRoot(_ path: String) throws {
        guard path.hasPrefix("/"), !path.hasSuffix("/"), path.hasSuffix("/.qa/instances/machines"),
              URL(fileURLWithPath: path).standardizedFileURL.path == path else {
            throw NativeFault("invalid_root", "--root must be the absolute canonical project .qa/instances/machines directory")
        }
        var current = ""
        for part in path.split(separator: "/") {
            current += "/" + part
            var info = stat()
            guard lstat(current, &info) == 0, info.st_mode & S_IFMT == S_IFDIR else {
                throw NativeFault("invalid_root", "Every root path component must be an existing directory, not a symlink")
            }
        }
        try directory(path)
    }

    static func makeDirectory(_ path: String, exclusive: Bool) throws {
        if mkdir(path, 0o700) != 0 {
            guard !exclusive && errno == EEXIST else { throw NativeFault("directory_conflict", "Cannot create a fresh private directory") }
        }
        try directory(path)
    }

    static func inspect(_ path: String) throws -> stat {
        var info = stat()
        guard lstat(path, &info) == 0, info.st_mode & S_IFMT == S_IFREG,
              info.st_uid == getuid(), info.st_nlink == 1, info.st_mode & 0o077 == 0 else {
            throw NativeFault("unsafe_artifact", "Expected a private owned regular artifact without hard links")
        }
        return info
    }

    static func identity(_ info: stat) -> String { "\(info.st_dev):\(info.st_ino)" }

    static func read(_ path: String, maximum: Int) throws -> Data {
        let fd = open(path, O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC)
        guard fd >= 0 else { throw NativeFault("artifact_unavailable", "Cannot open the required owned artifact") }
        defer { close(fd) }
        var info = stat()
        guard fstat(fd, &info) == 0, info.st_mode & S_IFMT == S_IFREG,
              info.st_uid == getuid(), info.st_nlink == 1, info.st_mode & 0o077 == 0,
              info.st_size > 0, info.st_size <= Int64(maximum) else {
            throw NativeFault("unsafe_artifact", "Invalid artifact ownership, type, permissions, or size")
        }
        var result = Data(capacity: Int(info.st_size))
        var buffer = [UInt8](repeating: 0, count: min(maximum + 1, 65536))
        while true {
            let count = Darwin.read(fd, &buffer, buffer.count)
            if count < 0 && errno == EINTR { continue }
            guard count >= 0 else { throw NativeFault("artifact_read_failed", "Cannot read the owned artifact") }
            if count == 0 { break }
            guard result.count + count <= maximum else { throw NativeFault("artifact_too_large", "Artifact exceeds its bounded size") }
            result.append(contentsOf: buffer[0..<count])
        }
        var after = stat()
        guard fstat(fd, &after) == 0, after.st_size == info.st_size,
              identity(after) == identity(info), result.count == Int(info.st_size) else {
            throw NativeFault("artifact_changed", "Artifact changed while it was being read")
        }
        return result
    }

    static func writeNew(_ data: Data, to path: String) throws {
        let fd = open(path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard fd >= 0 else { throw NativeFault("artifact_conflict", "Cannot create a fresh owned artifact") }
        defer { close(fd) }
        try data.withUnsafeBytes { bytes in
            var offset = 0
            while offset < bytes.count {
                let count = Darwin.write(fd, bytes.baseAddress!.advanced(by: offset), bytes.count - offset)
                if count < 0 && errno == EINTR { continue }
                guard count > 0 else { throw NativeFault("artifact_write_failed", "Cannot write the owned artifact", effect: "unknown") }
                offset += count
            }
        }
        guard fsync(fd) == 0 else { throw NativeFault("artifact_sync_failed", "Cannot durably sync the owned artifact", effect: "unknown") }
    }

    static func syncDirectory(_ path: String) throws {
        let fd = open(path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard fd >= 0 else { throw NativeFault("directory_sync_failed", "Cannot open the owned directory for sync", effect: "unknown") }
        defer { close(fd) }
        guard fsync(fd) == 0 else { throw NativeFault("directory_sync_failed", "Cannot durably sync the owned directory", effect: "unknown") }
    }

    static func atomic(_ data: Data, to path: String) throws {
        guard data.count <= 65536 else { throw NativeFault("metadata_too_large", "Native metadata exceeds its bound") }
        var existing = stat()
        if lstat(path, &existing) == 0 { _ = try inspect(path) }
        else if errno != ENOENT { throw NativeFault("metadata_unavailable", "Cannot inspect native metadata") }
        let parent = URL(fileURLWithPath: path).deletingLastPathComponent().path
        try directory(parent)
        let temporary = parent + "/.native-write-" + UUID().uuidString.lowercased()
        var renamed = false
        defer { if !renamed { unlink(temporary) } }
        try writeNew(data, to: temporary)
        guard rename(temporary, path) == 0 else { throw NativeFault("metadata_replace_failed", "Cannot atomically replace native metadata", effect: "unknown") }
        renamed = true
        try syncDirectory(parent)
    }

    static func sparseDisk(_ path: String, bytes: Int64) throws {
        let fd = open(path, O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard fd >= 0 else { throw NativeFault("disk_conflict", "A fresh disk cannot replace an existing artifact") }
        defer { close(fd) }
        guard ftruncate(fd, bytes) == 0, fsync(fd) == 0 else {
            throw NativeFault("disk_create_failed", "Cannot create the requested sparse disk", effect: "unknown")
        }
    }

    static func hash(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    static func verifyShareTree(_ path: String, maximumEntries: Int, maximumBytes: Int64) throws {
        try directory(path)
        var pending = [path]
        var entries = 0
        var bytes: Int64 = 0
        while let directoryPath = pending.popLast() {
            for name in try FileManager.default.contentsOfDirectory(atPath: directoryPath) {
                entries += 1
                guard entries <= maximumEntries, name != ".", name != "..", !name.contains("/") else {
                    throw NativeFault("unsafe_share", "Shared directory exceeds its entry bound")
                }
                let child = directoryPath + "/" + name
                var info = stat()
                guard lstat(child, &info) == 0, info.st_uid == getuid(), info.st_mode & 0o077 == 0 else {
                    throw NativeFault("unsafe_share", "Shared entries must be private and owned")
                }
                if info.st_mode & S_IFMT == S_IFDIR { pending.append(child) }
                else {
                    guard info.st_mode & S_IFMT == S_IFREG, info.st_nlink == 1,
                          info.st_size >= 0, info.st_size <= maximumBytes - bytes else {
                        throw NativeFault("unsafe_share", "Shared entries must be bounded regular files, not links or special files")
                    }
                    bytes += info.st_size
                }
            }
        }
    }
}

struct NativeArtifacts: Codable, Sendable {
    let diskIdentity: String
    let auxiliaryIdentity: String
    let hardwareHash: String
    let machineHash: String
    let minimumCPUCount: Int
    let minimumMemoryMiB: Int
}

struct NativeMetadata: Codable, Sendable {
    var version = 1
    var owner = "QAutraGuestHost"
    let root: String
    let rootId: String
    let id: String
    let name: String
    let platform: String
    let cpuCount: Int
    let memoryMiB: Int
    let diskGiB: Int
    var state: String
    var progress: Double?
    var error: String?
    var phase: String
    var installed: Bool
    var artifacts: NativeArtifacts?
}

private struct NativeRootOwner: Codable {
    let version: Int
    let product: String
    let root: String
    let rootId: String
    let uid: UInt32
}

struct NativeCreateOptions {
    let name: String
    let platform: String
    let cpuCount: Int
    let memoryMiB: Int
    let diskGiB: Int
}

@MainActor
final class NativeStore {
    let root: String
    let runtime: String
    let rootId: String
    private let ownerLease: NativeFileLease
    private let rootIdentity: String

    init(root: String) throws {
        try NativeFiles.canonicalRoot(root)
        self.root = root
        runtime = root + "/runtime"
        try NativeFiles.makeDirectory(runtime, exclusive: false)
        ownerLease = try NativeFileLease(runtime + "/owner.lock")
        var rootInfo = stat()
        guard lstat(root, &rootInfo) == 0 else { throw NativeFault("invalid_root", "Cannot identify the private root") }
        rootIdentity = NativeFiles.identity(rootInfo)
        let path = root + "/.native-owner.json"
        var existing = stat()
        if lstat(path, &existing) == 0 {
            let data = try NativeFiles.read(path, maximum: 4096)
            var parser = NativeJSONParser(data)
            guard let fields = try parser.parse().objectValue else { throw NativeFault("invalid_owner", "Invalid native root ownership record") }
            try fields.requireKeys(["version", "product", "root", "rootId", "uid"])
            let owner = try JSONDecoder().decode(NativeRootOwner.self, from: data)
            guard owner.version == 1, owner.product == "QAutraGuestHost", owner.root == root,
                  owner.uid == getuid(), nativeUUID(owner.rootId) else {
                throw NativeFault("invalid_owner", "Native root ownership does not match this adapter and root")
            }
            rootId = owner.rootId
        } else {
            guard errno == ENOENT,
                  Set(try FileManager.default.contentsOfDirectory(atPath: root)).isSubset(of: ["runtime"]) else {
                throw NativeFault("unowned_root", "Refusing to adopt a nonempty root without native ownership metadata")
            }
            let identifier = UUID().uuidString.lowercased()
            let owner = NativeRootOwner(version: 1, product: "QAutraGuestHost", root: root, rootId: identifier, uid: getuid())
            try NativeFiles.writeNew(JSONEncoder().encode(owner), to: path)
            try NativeFiles.syncDirectory(root)
            rootId = identifier
        }
    }

    func assertRoot() throws {
        try NativeFiles.canonicalRoot(root)
        var info = stat()
        guard lstat(root, &info) == 0, NativeFiles.identity(info) == rootIdentity else {
            throw NativeFault("root_changed", "Private native root identity changed")
        }
        try NativeFiles.directory(runtime)
    }

    func directory(_ id: String) throws -> String {
        try assertRoot()
        guard nativeUUID(id) else { throw NativeFault("invalid_instance", "Invalid machine UUID") }
        let result = root + "/" + id
        try NativeFiles.directory(result)
        return result
    }

    func load() throws -> [NativeMetadata] {
        try assertRoot()
        let names = try FileManager.default.contentsOfDirectory(atPath: root)
        var result: [NativeMetadata] = []
        for id in names.sorted() where id != "runtime" && id != ".native-owner.json" {
            guard nativeUUID(id), result.count < 256 else {
                throw NativeFault("unowned_artifact", "Unexpected root entry or native machine limit exceeded")
            }
            let path = try directory(id)
            let data = try NativeFiles.read(path + "/native.json", maximum: 65536)
            var parser = NativeJSONParser(data)
            guard let fields = try parser.parse().objectValue else { throw NativeFault("invalid_metadata", "Invalid native machine metadata") }
            try fields.requireKeys(["version", "owner", "root", "rootId", "id", "name", "platform", "cpuCount", "memoryMiB", "diskGiB", "state", "phase", "installed"], optional: ["progress", "error", "artifacts"])
            var metadata = try JSONDecoder().decode(NativeMetadata.self, from: data)
            guard metadata.version == 1, metadata.owner == "QAutraGuestHost", metadata.root == root,
                  metadata.rootId == rootId, metadata.id == id,
                  ["desktop-safari", "desktop-chrome"].contains(metadata.platform),
                  !metadata.name.isEmpty, metadata.name.utf8.count <= 320,
                  (1...1024).contains(metadata.cpuCount), (1...16777216).contains(metadata.memoryMiB),
                  (64...512).contains(metadata.diskGiB),
                  ["preparing", "installing", "installed", "starting", "running", "stopping", "stopped", "unknown", "error"].contains(metadata.state),
                  ["preparing", "installing", "idle", "active", "failed", "unknown"].contains(metadata.phase),
                  metadata.progress.map({ $0.isFinite && (0...1).contains($0) }) ?? true,
                  !metadata.installed || metadata.artifacts != nil else {
                throw NativeFault("invalid_metadata", "Native metadata identity or values do not match this owned machine")
            }
            if ["preparing", "installing", "active", "unknown"].contains(metadata.phase) {
                metadata.phase = "unknown"
                metadata.state = "unknown"
                metadata.progress = nil
                metadata.error = "Previous ownership ended without a confirmed terminal state; automatic adoption and restart are refused"
            }
            if metadata.installed { try verifyArtifacts(metadata) }
            result.append(metadata)
        }
        return result
    }

    func create(id: String, options: NativeCreateOptions) throws -> (NativeMetadata, NativeFileLease) {
        try assertRoot()
        guard nativeUUID(id) else { throw NativeFault("invalid_instance", "Invalid machine UUID") }
        let path = root + "/" + id
        var existing = stat()
        guard lstat(path, &existing) != 0, errno == ENOENT else {
            throw NativeFault("instance_conflict", "Machine identity already exists; create never overwrites or repeats installation")
        }
        try NativeFiles.makeDirectory(path, exclusive: true)
        do {
            let lease = try NativeFileLease(path + "/owner.lock")
            let metadata = NativeMetadata(root: root, rootId: rootId, id: id, name: options.name,
                platform: options.platform, cpuCount: options.cpuCount, memoryMiB: options.memoryMiB,
                diskGiB: options.diskGiB, state: "preparing", progress: nil, error: nil,
                phase: "preparing", installed: false, artifacts: nil)
            try save(metadata)
            try NativeFiles.syncDirectory(root)
            return (metadata, lease)
        } catch {
            throw NativeFault("create_incomplete", "Fresh machine creation did not finish durably; its directory is preserved for diagnosis", effect: "unknown")
        }
    }

    func save(_ metadata: NativeMetadata) throws {
        guard metadata.root == root, metadata.rootId == rootId else { throw NativeFault("invalid_owner", "Refusing foreign native metadata") }
        let path = try directory(metadata.id)
        try NativeFiles.atomic(JSONEncoder().encode(metadata), to: path + "/native.json")
    }

    func machineLease(_ id: String) throws -> NativeFileLease {
        try NativeFileLease(directory(id) + "/owner.lock")
    }

    func diskLease(_ path: String) throws -> NativeFileLease {
        let info = try NativeFiles.inspect(path)
        // VZ locks the disk image itself; flock must pin its inode through a separate owned sidecar.
        return try NativeFileLease(runtime + "/disk-\(NativeFiles.identity(info)).lock")
    }

    func verifyArtifacts(_ metadata: NativeMetadata) throws {
        guard let artifacts = metadata.artifacts else { throw NativeFault("incomplete_machine", "Installed machine artifact identities are missing") }
        let path = try directory(metadata.id)
        let disk = try NativeFiles.inspect(path + "/disk.img")
        let auxiliary = try NativeFiles.inspect(path + "/auxiliary-storage")
        guard NativeFiles.identity(disk) == artifacts.diskIdentity,
              NativeFiles.identity(auxiliary) == artifacts.auxiliaryIdentity,
              disk.st_size == Int64(metadata.diskGiB) * 1024 * 1024 * 1024,
              NativeFiles.hash(try NativeFiles.read(path + "/hardware-model.bin", maximum: 1048576)) == artifacts.hardwareHash,
              NativeFiles.hash(try NativeFiles.read(path + "/machine-identifier.bin", maximum: 1048576)) == artifacts.machineHash,
              metadata.cpuCount >= artifacts.minimumCPUCount, metadata.memoryMiB >= artifacts.minimumMemoryMiB else {
            throw NativeFault("artifact_identity_changed", "The hardware, machine identifier, auxiliary storage, and disk no longer form the recorded owned unit")
        }
    }

    func verifyBootShares(_ metadata: NativeMetadata) throws {
        let path = try directory(metadata.id)
        try NativeFiles.verifyShareTree(path + "/kit", maximumEntries: 8192, maximumBytes: 512 * 1024 * 1024)
        // A retained recorder owns up to 1 GiB here; its video is additional to the boot/status metadata allowance.
        try NativeFiles.verifyShareTree(path + "/status", maximumEntries: 128, maximumBytes: 1024 * 1024 * 1024 + 16 * 1024 * 1024)
        var parser = NativeJSONParser(try NativeFiles.read(path + "/kit/instance.json", maximum: 4096))
        guard let fields = try parser.parse().objectValue else { throw NativeFault("invalid_boot_config", "Guest boot configuration must be an object") }
        try fields.requireKeys(["version", "instanceId", "epoch", "bootToken", "platform"])
        _ = try fields.integer("version", range: 1...1)
        guard try fields.text("instanceId") == metadata.id,
              try fields.text("platform") == metadata.platform else {
            throw NativeFault("invalid_boot_config", "Guest boot configuration belongs to another physical machine or platform")
        }
        let token = try fields.text("bootToken")
        let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_")
        guard (32...256).contains(token.utf8.count), token.unicodeScalars.allSatisfy({ allowed.contains($0) }) else {
            throw NativeFault("invalid_boot_token", "Guest boot token must be a private bounded base64url or hexadecimal value")
        }
        switch fields["epoch"] {
        case .string(let value):
            guard (1...128).contains(value.utf8.count), value.unicodeScalars.allSatisfy({ allowed.contains($0) }) else {
                throw NativeFault("invalid_boot_epoch", "Guest boot epoch is invalid")
            }
        case .number(let value):
            guard value.isFinite, value.rounded() == value, (1...9007199254740991).contains(value) else {
                throw NativeFault("invalid_boot_epoch", "Guest boot epoch is invalid")
            }
        default: throw NativeFault("invalid_boot_epoch", "Guest boot epoch is missing or invalid")
        }
    }
}
