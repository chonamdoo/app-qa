import CryptoKit
import Darwin
import Foundation

struct NativeExportIdentity: Codable, Equatable, Sendable {
    let device: String
    let inode: String
    let uid: UInt32

    init(_ value: stat) {
        device = String(UInt32(bitPattern: value.st_dev))
        inode = String(value.st_ino)
        uid = value.st_uid
    }
}

struct NativeExportLease: Decodable, Sendable {
    let id: String
    let exportID: String
    let directory: String
    let path: String
    let secret: String
    let identity: NativeExportIdentity
    let bytes: Int64
    let sha256: String
    let scopeDigest: String
    let policyDigest: String
    let retired: Bool?
}

struct NativeExportPending: Decodable, Sendable {
    let root: String
    let records: [NativeExportLease]
}

final class NativeExportCancellation: @unchecked Sendable {
    private let lock = NSLock()
    private var cancelled = false
    private var task: URLSessionTask?

    func cancel() {
        lock.lock()
        cancelled = true
        let current = task
        lock.unlock()
        current?.cancel()
    }

    func check() throws {
        lock.lock()
        let value = cancelled
        lock.unlock()
        if value { throw CancellationError() }
    }

    func attach(_ next: URLSessionTask?) {
        lock.lock()
        task = next
        let value = cancelled
        lock.unlock()
        if value { next?.cancel() }
    }
}

private func cacheFailure(_ message: String) -> APIError {
    APIError(status: 0, message: "Native 임시 내보내기 정리 확인 필요: \(message)")
}

private func exportDigestHex(_ digest: SHA256.Digest) -> String {
    String(unsafeUninitializedCapacity: 64) { buffer in
        var offset = 0
        for byte in digest {
            let high = byte >> 4, low = byte & 15
            buffer[offset] = high < 10 ? high + 48 : high + 87
            buffer[offset + 1] = low < 10 ? low + 48 : low + 87
            offset += 2
        }
        return offset
    }
}

private final class ExportDescriptor {
    private(set) var value: Int32
    init(_ value: Int32) throws {
        guard value >= 0 else { throw cacheFailure(String(cString: strerror(errno))) }
        self.value = value
    }
    func close() throws {
        guard value >= 0 else { return }
        let owned = value
        value = -1
        guard Darwin.close(owned) == 0 else { throw cacheFailure("소유한 파일 닫기를 확인하지 못했습니다.") }
    }
    deinit { if value >= 0 { _ = Darwin.close(value) } }
}

private struct NativeLocalSave: Codable {
    let schema: String
    let id: String
    let secret: String
    let directory: String
    let directoryIdentity: NativeExportIdentity
    let staging: String
    let destination: String
    let identity: NativeExportIdentity
    var state: String
}

private struct NativeCleanupReceipt: Codable {
    let schema: String
    let id: String
    let secret: String
    let identity: NativeExportIdentity
    let payloadRemoved: Bool
    let localStaging: String
    let closedAt: String
}

private struct NativeRetiredFence: Decodable {
    let schema: String
    let id: String
    let secret: String
    let retiredAt: String
}

private final class ExportDirectory {
    let lease: NativeExportLease
    let rootPath: String
    let root: ExportDescriptor
    let directory: ExportDescriptor
    private let rootIdentity: NativeExportIdentity
    private let directoryIdentity: NativeExportIdentity

    init(root path: String, lease: NativeExportLease) throws {
        guard UUID(uuidString: lease.id) != nil, UUID(uuidString: lease.exportID) != nil,
              lease.secret.count == 64, Self.hex(lease.secret),
              lease.bytes > 0, lease.bytes <= NativeExportCache.maximum,
              [lease.sha256, lease.scopeDigest, lease.policyDigest].allSatisfy({ $0.count == 64 && Self.hex($0) }),
              lease.identity.uid == getuid(),
              Self.canonical(path), URL(fileURLWithPath: path).lastPathComponent == "native-downloads",
              lease.directory == path + "/" + lease.id,
              lease.path == lease.directory + "/payload.tar" else {
            throw cacheFailure("예약 경로·크기·원래 identity가 올바르지 않습니다.")
        }
        self.lease = lease
        rootPath = path
        root = try Self.openDirectory(path)
        let rootStat = try Self.status(root.value)
        try Self.privateDirectory(rootStat)
        rootIdentity = NativeExportIdentity(rootStat)
        directory = try ExportDescriptor(openat(root.value, lease.id, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC))
        let directoryStat = try Self.status(directory.value)
        try Self.privateDirectory(directoryStat)
        directoryIdentity = NativeExportIdentity(directoryStat)
        try assertNamed()
    }

    private static func hex(_ text: String) -> Bool {
        text.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
    }

    static func canonical(_ path: String) -> Bool {
        path.hasPrefix("/") && path != "/" && !path.hasSuffix("/") &&
            !path.split(separator: "/", omittingEmptySubsequences: false).dropFirst().contains(where: { $0.isEmpty || $0 == "." || $0 == ".." }) && !path.utf8.contains(0)
    }

    static func openDirectory(_ path: String) throws -> ExportDescriptor {
        guard canonical(path) else { throw cacheFailure("절대 디렉터리 경로가 올바르지 않습니다.") }
        var current = try ExportDescriptor(open("/", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC))
        for part in path.split(separator: "/") {
            let next = try ExportDescriptor(openat(current.value, String(part), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC))
            try current.close()
            current = next
        }
        return current
    }

    static func status(_ descriptor: Int32) throws -> stat {
        var value = stat()
        guard fstat(descriptor, &value) == 0 else { throw cacheFailure("열린 파일 identity를 확인하지 못했습니다.") }
        return value
    }

    static func named(_ descriptor: Int32, _ name: String) throws -> stat? {
        var value = stat()
        if fstatat(descriptor, name, &value, AT_SYMLINK_NOFOLLOW) == 0 { return value }
        guard errno == ENOENT else { throw cacheFailure("파일 이름의 identity를 확인하지 못했습니다.") }
        return nil
    }

    static func privateDirectory(_ value: stat) throws {
        guard value.st_mode & S_IFMT == S_IFDIR, value.st_uid == getuid(), value.st_mode & 0o777 == 0o700 else {
            throw cacheFailure("사용자 전용 디렉터리가 아닙니다.")
        }
    }

    static func privateFile(_ value: stat, identity: NativeExportIdentity? = nil) throws {
        guard value.st_mode & S_IFMT == S_IFREG, value.st_uid == getuid(), value.st_mode & 0o777 == 0o600,
              value.st_nlink == 1, identity == nil || NativeExportIdentity(value) == identity else {
            throw cacheFailure("원래 private regular 파일 identity가 다릅니다.")
        }
    }

    func assertNamed() throws {
        var namedRoot = stat()
        guard lstat(rootPath, &namedRoot) == 0, NativeExportIdentity(namedRoot) == rootIdentity,
              let namedDirectory = try Self.named(root.value, lease.id), NativeExportIdentity(namedDirectory) == directoryIdentity else {
            throw cacheFailure("예약 디렉터리의 이름이 바뀌었습니다.")
        }
        try Self.privateDirectory(namedRoot)
        try Self.privateDirectory(namedDirectory)
    }

    func assertPayload(_ descriptor: Int32) throws {
        try assertNamed()
        try Self.privateFile(Self.status(descriptor), identity: lease.identity)
        guard let named = try Self.named(directory.value, "payload.tar") else { throw cacheFailure("원래 payload 이름이 사라졌습니다.") }
        try Self.privateFile(named, identity: lease.identity)
    }

    func assertPendingPayload(_ descriptor: Int32) throws {
        try assertPayload(descriptor)
        guard try Self.named(directory.value, "cleanup.json") == nil,
              try Self.named(directory.value, "closed.json") == nil else {
            throw cacheFailure("완료 기록과 payload가 함께 남아 있어 재사용·제거할 수 없습니다: \(lease.id)")
        }
    }

    func assertFence(retired: Bool) throws {
        if !retired {
            guard try Self.named(directory.value, "retired.json") == nil else { throw cacheFailure("철회된 다운로드입니다.") }
            return
        }
        let fence: NativeRetiredFence? = try readJSON("retired.json", maximum: 4096)
        if let fence {
            guard fence.schema == "qautra/native-export-retired/v1", fence.id == lease.id, fence.secret == lease.secret,
                  ISO8601DateFormatter().date(from: fence.retiredAt) != nil || ISO8601DateFormatter.fractional.date(from: fence.retiredAt) != nil else {
                throw cacheFailure("철회 fence의 원래 identity가 다릅니다.")
            }
        }
        guard (fence != nil) == retired else { throw cacheFailure(retired ? "철회 fence가 없습니다." : "철회된 다운로드입니다.") }
    }

    func readJSON<T: Decodable>(_ name: String, maximum: Int = 65536) throws -> T? {
        try assertNamed()
        guard let named = try Self.named(directory.value, name) else { return nil }
        try Self.privateFile(named)
        guard named.st_size > 0, named.st_size <= maximum else { throw cacheFailure("관리 기록의 크기가 올바르지 않습니다.") }
        let fd = try ExportDescriptor(openat(directory.value, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC))
        let original = try Self.status(fd.value)
        try Self.privateFile(original, identity: NativeExportIdentity(named))
        var data = Data(count: Int(original.st_size))
        try data.withUnsafeMutableBytes { buffer in
            var offset = 0
            while offset < buffer.count {
                let count = Darwin.read(fd.value, buffer.baseAddress!.advanced(by: offset), buffer.count - offset)
                if count < 0 && errno == EINTR { continue }
                guard count > 0 else { throw cacheFailure("관리 기록을 완전히 읽지 못했습니다.") }
                offset += count
            }
        }
        let after = try Self.status(fd.value)
        guard NativeExportIdentity(after) == NativeExportIdentity(original), after.st_size == original.st_size,
              after.st_mtimespec.tv_sec == original.st_mtimespec.tv_sec, after.st_mtimespec.tv_nsec == original.st_mtimespec.tv_nsec,
              let stillNamed = try Self.named(directory.value, name), NativeExportIdentity(stillNamed) == NativeExportIdentity(original) else {
            throw cacheFailure("관리 기록이 읽는 도중 바뀌었습니다.")
        }
        try fd.close()
        return try JSONDecoder().decode(T.self, from: data)
    }

    func writeJSON<T: Encodable>(_ value: T, name: String) throws {
        try assertNamed()
        let temporary = ".native-\(UUID().uuidString).json"
        let fd = try ExportDescriptor(openat(directory.value, temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600))
        let original = NativeExportIdentity(try Self.status(fd.value))
        defer {
            if let named = try? Self.named(directory.value, temporary), NativeExportIdentity(named) == original {
                _ = unlinkat(directory.value, temporary, 0)
            }
        }
        let data = try JSONEncoder().encode(value)
        try Self.write(data, to: fd.value)
        guard fsync(fd.value) == 0 else { throw cacheFailure("관리 기록을 동기화하지 못했습니다.") }
        try Self.privateFile(Self.status(fd.value), identity: original)
        try assertNamed()
        guard let named = try Self.named(directory.value, temporary), NativeExportIdentity(named) == original,
              renameat(directory.value, temporary, directory.value, name) == 0,
              fsync(directory.value) == 0 else { throw cacheFailure("관리 기록을 원자적으로 보존하지 못했습니다.") }
        try fd.close()
    }

    static func write(_ data: Data, to descriptor: Int32) throws {
        try data.withUnsafeBytes { buffer in
            var offset = 0
            while offset < buffer.count {
                let count = Darwin.write(descriptor, buffer.baseAddress!.advanced(by: offset), buffer.count - offset)
                if count < 0 && errno == EINTR { continue }
                guard count > 0 else { throw cacheFailure("파일 쓰기를 완료하지 못했습니다.") }
                offset += count
            }
        }
    }

    func close() throws {
        try directory.close()
        try root.close()
    }
}

private extension ISO8601DateFormatter {
    static var fractional: ISO8601DateFormatter {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }
}

final class NativeExportCache: @unchecked Sendable {
    static let maximum: Int64 = 2 * 1024 * 1024 * 1024
    private static let activity = NativeExportActivity()
    private let directory: ExportDirectory
    private let payload: ExportDescriptor
    private var received: Int64 = 0
    private var hash = SHA256()

    static func claim(_ id: String) { activity.claim(id) }
    static func release(_ id: String) { activity.release(id) }
    static func isActive(_ id: String) -> Bool { activity.contains(id) }

    init(lease: NativeExportLease) throws {
        directory = try ExportDirectory(root: URL(fileURLWithPath: lease.directory).deletingLastPathComponent().path, lease: lease)
        payload = try ExportDescriptor(openat(directory.directory.value, "payload.tar", O_RDWR | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC))
        try directory.assertPendingPayload(payload.value)
        guard flock(payload.value, LOCK_EX | LOCK_NB) == 0 else { throw cacheFailure("payload가 다른 읽기·쓰기에서 사용 중입니다.") }
        try directory.assertPendingPayload(payload.value)
        try directory.assertFence(retired: false)
        guard try ExportDirectory.status(payload.value).st_size == 0 else { throw cacheFailure("예약된 빈 파일이 아닙니다.") }
    }

    func append(_ data: Data, cancellation: NativeExportCancellation) throws {
        try cancellation.check()
        try directory.assertPayload(payload.value)
        try directory.assertFence(retired: false)
        guard Int64(data.count) <= directory.lease.bytes - received else { throw cacheFailure("예약한 다운로드 크기를 초과했습니다.") }
        try ExportDirectory.write(data, to: payload.value)
        hash.update(data: data)
        received += Int64(data.count)
    }

    func finish(cancellation: NativeExportCancellation) throws {
        try cancellation.check()
        try directory.assertPayload(payload.value)
        try directory.assertFence(retired: false)
        let digest = exportDigestHex(hash.finalize())
        guard received == directory.lease.bytes, digest == directory.lease.sha256,
              try ExportDirectory.status(payload.value).st_size == received else { throw cacheFailure("증거 묶음의 정확한 크기·SHA-256이 다릅니다.") }
        guard fsync(payload.value) == 0 else { throw cacheFailure("다운로드 파일을 동기화하지 못했습니다.") }
    }

    func save(to destination: URL, cancellation: NativeExportCancellation) throws {
        let access = destination.startAccessingSecurityScopedResource()
        defer { if access { destination.stopAccessingSecurityScopedResource() } }
        try cancellation.check()
        try directory.assertPayload(payload.value)
        try directory.assertFence(retired: false)
        guard destination.isFileURL else { throw cacheFailure("OS에서 선택한 파일 저장 위치가 아닙니다.") }
        let parentPath = destination.deletingLastPathComponent().resolvingSymlinksInPath().path
        let parent = try ExportDirectory.openDirectory(parentPath)
        let parentStatus = try ExportDirectory.status(parent.value)
        guard parentStatus.st_uid == getuid() else { throw cacheFailure("저장 디렉터리의 사용자가 다릅니다.") }
        let name = destination.lastPathComponent
        guard !name.isEmpty, name != ".", name != "..", !name.contains("/"), !name.utf8.contains(0) else { throw cacheFailure("저장 파일 이름이 올바르지 않습니다.") }
        let staging = ".qautra-export-\(directory.lease.id)-\(UUID().uuidString).tar"
        let output = try ExportDescriptor(openat(parent.value, staging, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600))
        let original = NativeExportIdentity(try ExportDirectory.status(output.value))
        try ExportDirectory.privateFile(ExportDirectory.status(output.value), identity: original)
        guard flock(output.value, LOCK_EX | LOCK_NB) == 0, fsync(output.value) == 0, fsync(parent.value) == 0 else { throw cacheFailure("private 저장 staging을 잠그고 보존하지 못했습니다.") }
        var record = NativeLocalSave(schema: "qautra/native-export-local-save/v1", id: directory.lease.id, secret: directory.lease.secret,
                                     directory: parentPath, directoryIdentity: NativeExportIdentity(parentStatus), staging: staging,
                                     destination: name, identity: original, state: "staging")
        do {
            try directory.writeJSON(record, name: "local-save.json")
        } catch {
            if let named = try ExportDirectory.named(parent.value, staging), NativeExportIdentity(named) == original {
                guard unlinkat(parent.value, staging, 0) == 0, fsync(parent.value) == 0 else { throw cacheFailure("빈 저장 staging 정리가 미확인입니다.") }
            }
            throw error
        }
        var buffer = Data(count: 128 * 1024)
        var copied: Int64 = 0
        var copiedHash = SHA256()
        while copied < directory.lease.bytes {
            try cancellation.check()
            try directory.assertPayload(payload.value)
            try directory.assertFence(retired: false)
            try Self.assertStaging(record, parent: parent.value, descriptor: output.value)
            let count = try buffer.withUnsafeMutableBytes { bytes -> Int in
                let result = pread(payload.value, bytes.baseAddress!, min(bytes.count, Int(directory.lease.bytes - copied)), off_t(copied))
                if result < 0 { if errno == EINTR { return 0 }; throw cacheFailure("다운로드 읽기를 완료하지 못했습니다.") }
                guard result > 0 else { throw cacheFailure("다운로드 파일이 짧아졌습니다.") }
                return result
            }
            if count == 0 { continue }
            try buffer.withUnsafeBytes { bytes in
                var offset = 0
                while offset < count {
                    let written = Darwin.write(output.value, bytes.baseAddress!.advanced(by: offset), count - offset)
                    if written < 0 && errno == EINTR { continue }
                    guard written > 0 else { throw cacheFailure("저장 staging 쓰기를 완료하지 못했습니다.") }
                    offset += written
                }
                copiedHash.update(bufferPointer: UnsafeRawBufferPointer(start: bytes.baseAddress, count: count))
            }
            copied += Int64(count)
        }
        guard exportDigestHex(copiedHash.finalize()) == directory.lease.sha256,
              try ExportDirectory.status(output.value).st_size == directory.lease.bytes,
              fsync(output.value) == 0 else { throw cacheFailure("저장 staging의 정확한 크기·hash·동기화를 확인하지 못했습니다.") }
        try cancellation.check()
        try directory.assertPayload(payload.value)
        try directory.assertFence(retired: false)
        try Self.assertStaging(record, parent: parent.value, descriptor: output.value)
        guard renameat(parent.value, staging, parent.value, name) == 0, fsync(parent.value) == 0 else { throw cacheFailure("선택한 저장 파일의 원자적 승격이 미확인입니다.") }
        record.state = "promoted"
        try directory.writeJSON(record, name: "local-save.json")
        try output.close()
        try parent.close()
    }

    func close() throws {
        try payload.close()
        try directory.close()
    }

    private static func validate(_ record: NativeLocalSave, lease: NativeExportLease) throws {
        guard record.schema == "qautra/native-export-local-save/v1", record.id == lease.id, record.secret == lease.secret,
              ExportDirectory.canonical(record.directory), record.directoryIdentity.uid == getuid(), record.identity.uid == getuid(),
              record.staging.hasPrefix(".qautra-export-\(lease.id)-"), record.staging.hasSuffix(".tar"),
              UUID(uuidString: String(record.staging.dropFirst((".qautra-export-" + lease.id + "-").count).dropLast(4))) != nil,
              !record.staging.contains("/"), !record.staging.utf8.contains(0),
              !record.destination.isEmpty, record.destination != ".", record.destination != "..",
              !record.destination.contains("/"), !record.destination.utf8.contains(0), record.destination != record.staging,
              ["staging", "removed", "promoted"].contains(record.state) else { throw cacheFailure("Native가 보존한 OS 저장 staging 기록이 올바르지 않습니다.") }
    }

    private static func assertStaging(_ record: NativeLocalSave, parent: Int32, descriptor: Int32) throws {
        guard NativeExportIdentity(try ExportDirectory.status(parent)) == record.directoryIdentity,
              let named = try ExportDirectory.named(parent, record.staging) else { throw cacheFailure("원래 저장 staging 이름이 없습니다.") }
        try ExportDirectory.privateFile(named, identity: record.identity)
        try ExportDirectory.privateFile(ExportDirectory.status(descriptor), identity: record.identity)
    }

    private static func cleanLocalSave(_ directory: ExportDirectory) throws -> String {
        guard var record: NativeLocalSave = try directory.readJSON("local-save.json") else { return "none" }
        try validate(record, lease: directory.lease)
        if record.state == "promoted" || record.state == "removed" {
            let parent = try ExportDirectory.openDirectory(record.directory)
            guard NativeExportIdentity(try ExportDirectory.status(parent.value)) == record.directoryIdentity,
                  try ExportDirectory.named(parent.value, record.staging) == nil else { throw cacheFailure("완료된 저장 staging 이름이 다시 나타났습니다.") }
            try parent.close()
            return record.state
        }
        let parent = try ExportDirectory.openDirectory(record.directory)
        guard NativeExportIdentity(try ExportDirectory.status(parent.value)) == record.directoryIdentity else { throw cacheFailure("OS 저장 디렉터리 identity가 바뀌었습니다.") }
        if try ExportDirectory.named(parent.value, record.staging) == nil {
            guard let final = try ExportDirectory.named(parent.value, record.destination), NativeExportIdentity(final) == record.identity else {
                throw cacheFailure("저장 staging이 없지만 제거·승격의 원래 증거가 없습니다.")
            }
            let promoted = try ExportDescriptor(openat(parent.value, record.destination, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC))
            try ExportDirectory.privateFile(ExportDirectory.status(promoted.value), identity: record.identity)
            guard flock(promoted.value, LOCK_EX | LOCK_NB) == 0,
                  let named = try ExportDirectory.named(parent.value, record.destination), NativeExportIdentity(named) == record.identity,
                  try ExportDirectory.named(parent.value, record.staging) == nil else { throw cacheFailure("승격된 원래 저장 파일의 독점 잠금을 확인하지 못했습니다.") }
            try promoted.close()
            record.state = "promoted"
        } else {
            let staging = try ExportDescriptor(openat(parent.value, record.staging, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC))
            try assertStaging(record, parent: parent.value, descriptor: staging.value)
            guard flock(staging.value, LOCK_EX | LOCK_NB) == 0 else { throw cacheFailure("저장 staging이 사용 중입니다.") }
            try assertStaging(record, parent: parent.value, descriptor: staging.value)
            try directory.assertFence(retired: true)
            guard unlinkat(parent.value, record.staging, 0) == 0, fsync(parent.value) == 0 else { throw cacheFailure("원래 저장 staging 제거가 미확인입니다.") }
            try staging.close()
            record.state = "removed"
        }
        try parent.close()
        try directory.writeJSON(record, name: "local-save.json")
        return record.state
    }

    static func reap(root: String, lease: NativeExportLease, retire: @Sendable () async throws -> Void) async throws {
        let directory = try ExportDirectory(root: root, lease: lease)
        if try ExportDirectory.named(directory.directory.value, "payload.tar") == nil {
            try await retire()
            try directory.assertFence(retired: true)
            guard let receipt: NativeCleanupReceipt = try directory.readJSON("cleanup.json", maximum: 4096),
                  receipt.schema == "qautra/native-export-cleanup/v1", receipt.id == lease.id, receipt.secret == lease.secret,
                  receipt.identity == lease.identity, receipt.payloadRemoved,
                  ["none", "removed", "promoted"].contains(receipt.localStaging),
                  ISO8601DateFormatter().date(from: receipt.closedAt) != nil || ISO8601DateFormatter.fractional.date(from: receipt.closedAt) != nil else {
                throw cacheFailure("payload가 없지만 원래 잠금·제거·닫기 receipt가 없습니다: \(lease.id)")
            }
            let localState = try cleanLocalSave(directory)
            guard localState == receipt.localStaging else { throw cacheFailure("원래 정리 receipt와 저장 staging 상태가 다릅니다.") }
            try directory.close()
            return
        }
        let payload = try ExportDescriptor(openat(directory.directory.value, "payload.tar", O_RDWR | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC))
        try directory.assertPendingPayload(payload.value)
        guard flock(payload.value, LOCK_EX | LOCK_NB) == 0 else { throw cacheFailure("payload가 아직 사용 중입니다: \(lease.id)") }
        try directory.assertPendingPayload(payload.value)
        try await retire()
        try directory.assertFence(retired: true)
        let localState = try cleanLocalSave(directory)
        try directory.assertPendingPayload(payload.value)
        try directory.assertFence(retired: true)
        guard unlinkat(directory.directory.value, "payload.tar", 0) == 0,
              fsync(directory.directory.value) == 0 else { throw cacheFailure("원래 payload의 제거·동기화가 미확인입니다.") }
        try payload.close()
        let receipt = NativeCleanupReceipt(schema: "qautra/native-export-cleanup/v1", id: lease.id, secret: lease.secret,
                                           identity: lease.identity, payloadRemoved: true, localStaging: localState,
                                           closedAt: ISO8601DateFormatter.fractional.string(from: Date()))
        try directory.writeJSON(receipt, name: "cleanup.json")
        try directory.close()
    }
}

private final class NativeExportActivity: @unchecked Sendable {
    private let lock = NSLock()
    private var ids: Set<String> = []
    func claim(_ id: String) { lock.lock(); ids.insert(id); lock.unlock() }
    func release(_ id: String) { lock.lock(); ids.remove(id); lock.unlock() }
    func contains(_ id: String) -> Bool { lock.lock(); defer { lock.unlock() }; return ids.contains(id) }
}

final class NativeExportStream: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    private let cache: NativeExportCache
    private let cancellation: NativeExportCancellation
    private let bytes: Int64
    private var continuation: CheckedContinuation<Void, any Error>?
    private var failure: (any Error)?
    private var accepted = false

    init(cache: NativeExportCache, cancellation: NativeExportCancellation, bytes: Int64) {
        self.cache = cache
        self.cancellation = cancellation
        self.bytes = bytes
    }

    func download(_ request: URLRequest) async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.urlCache = nil
        configuration.httpCookieStorage = nil
        configuration.urlCredentialStorage = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.timeoutIntervalForRequest = 120
        configuration.timeoutIntervalForResource = 120
        let queue = OperationQueue()
        queue.maxConcurrentOperationCount = 1
        let session = URLSession(configuration: configuration, delegate: self, delegateQueue: queue)
        defer { session.finishTasksAndInvalidate() }
        try await withTaskCancellationHandler {
            try cancellation.check()
            try await withCheckedThrowingContinuation { continuation in
                self.continuation = continuation
                let task = session.dataTask(with: request)
                cancellation.attach(task)
                task.resume()
            }
        } onCancel: {
            self.cancellation.cancel()
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
        failure = cacheFailure("다운로드 redirect를 거부했습니다.")
        completionHandler(nil)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping @Sendable (URLSession.ResponseDisposition) -> Void) {
        do {
            try cancellation.check()
            guard let response = response as? HTTPURLResponse, response.statusCode == 200,
                  response.expectedContentLength == bytes,
                  response.value(forHTTPHeaderField: "Content-Encoding") == nil else {
                throw cacheFailure("다운로드 응답·정확한 크기를 확인하지 못했습니다.")
            }
            accepted = true
            completionHandler(.allow)
        } catch {
            failure = error
            completionHandler(.cancel)
        }
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        guard failure == nil, accepted else { dataTask.cancel(); return }
        do { try cache.append(data, cancellation: cancellation) }
        catch { failure = error; dataTask.cancel() }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: (any Error)?) {
        cancellation.attach(nil)
        do {
            if let failure { throw failure }
            if let error { throw error }
            guard accepted else { throw cacheFailure("다운로드가 허용되지 않았습니다.") }
            try cache.finish(cancellation: cancellation)
            continuation?.resume()
        } catch { continuation?.resume(throwing: error) }
        continuation = nil
    }
}
