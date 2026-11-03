import Foundation
import Darwin
import CryptoKit

private struct NativeRecoveryFile {
    let descriptor: Int32
    let before: stat
    let parents: [(String, String)]

    init(_ path: String, maximum: Int64) throws {
        guard path.hasPrefix("/"), URL(fileURLWithPath: path).standardizedFileURL.path == path else { throw NativeFault("guest_recovery_path_invalid", "Recovery paths must be absolute and canonical") }
        var parent = open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC)
        guard parent >= 0 else { throw NativeFault("guest_recovery_path_invalid", "Cannot open recovery root") }
        var observed: [(String, String)] = []
        var current = ""
        defer { close(parent) }
        let parts = path.split(separator: "/").map(String.init)
        for part in parts.dropLast() {
            let next = openat(parent, part, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
            guard next >= 0 else { throw NativeFault("guest_recovery_path_invalid", "Recovery parent is not a directory without symlinks") }
            close(parent); parent = next; current += "/" + part
            var info = stat()
            guard fstat(parent, &info) == 0 else { throw NativeFault("guest_recovery_path_invalid", "Cannot identify recovery parent") }
            observed.append((current, NativeFiles.identity(info)))
        }
        var directory = stat()
        guard fstat(parent, &directory) == 0, directory.st_uid == getuid(), directory.st_mode & 0o077 == 0,
              let name = parts.last else { throw NativeFault("guest_recovery_path_invalid", "Recovery directory must be private and owned") }
        let fd = openat(parent, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
        guard fd >= 0 else { throw NativeFault(errno == ENOENT ? "guest_recovery_file_missing" : "guest_recovery_file_unsafe", "Cannot open original recovery artifact") }
        var info = stat()
        guard fstat(fd, &info) == 0, info.st_mode & S_IFMT == S_IFREG, info.st_uid == getuid(), info.st_nlink == 1,
              info.st_mode & 0o077 == 0, info.st_size >= 0, info.st_size <= maximum else {
            close(fd); throw NativeFault("guest_recovery_file_unsafe", "Recovery artifact ownership, size, permissions or type is invalid")
        }
        descriptor = fd; before = info; parents = observed
    }

    func finish(_ path: String) throws {
        var after = stat(); var named = stat()
        guard fstat(descriptor, &after) == 0, lstat(path, &named) == 0,
              NativeFiles.identity(before) == NativeFiles.identity(after), NativeFiles.identity(after) == NativeFiles.identity(named),
              after.st_size == before.st_size, named.st_size == after.st_size, named.st_mode & S_IFMT == S_IFREG, named.st_nlink == 1,
              after.st_mtimespec.tv_sec == before.st_mtimespec.tv_sec, after.st_mtimespec.tv_nsec == before.st_mtimespec.tv_nsec,
              after.st_ctimespec.tv_sec == before.st_ctimespec.tv_sec, after.st_ctimespec.tv_nsec == before.st_ctimespec.tv_nsec else {
            throw NativeFault("guest_recovery_file_changed", "Original recovery artifact changed during inspection")
        }
        for (path, identity) in parents {
            var info = stat()
            guard lstat(path, &info) == 0, info.st_mode & S_IFMT == S_IFDIR, NativeFiles.identity(info) == identity else {
                throw NativeFault("guest_recovery_path_changed", "Original recovery parent changed during inspection")
            }
        }
    }
}

private enum NativeRecoveryFiles {
    static func read(_ path: String, maximum: Int = 65536) throws -> Data {
        let file = try NativeRecoveryFile(path, maximum: Int64(maximum)); defer { close(file.descriptor) }
        var data = Data(count: Int(file.before.st_size))
        try data.withUnsafeMutableBytes { bytes in
            var offset = 0
            while offset < bytes.count {
                let count = Darwin.read(file.descriptor, bytes.baseAddress!.advanced(by: offset), bytes.count - offset)
                if count < 0 && errno == EINTR { continue }
                guard count > 0 else { throw NativeFault("guest_recovery_read_unknown", "Original recovery artifact read is incomplete") }
                offset += count
            }
        }
        try file.finish(path)
        return data
    }

    static func inventory(_ path: String, name: String, location: String, maximum: Int64) throws -> NativeJSON {
        let file = try NativeRecoveryFile(path, maximum: maximum); defer { close(file.descriptor) }
        guard fsync(file.descriptor) == 0 else { throw NativeFault("guest_recovery_sync_unknown", "Original recorder artifact could not be synced") }
        var hash = SHA256(); var total: Int64 = 0
        var buffer = [UInt8](repeating: 0, count: min(1024 * 1024, max(1, Int(file.before.st_size))))
        while total < file.before.st_size {
            let count = Darwin.read(file.descriptor, &buffer, min(buffer.count, Int(file.before.st_size - total)))
            if count < 0 && errno == EINTR { continue }
            guard count > 0 else { throw NativeFault("guest_recovery_read_unknown", "Original recorder artifact read is incomplete") }
            buffer.withUnsafeBytes { hash.update(bufferPointer: UnsafeRawBufferPointer(rebasing: $0[..<count])) }
            total += Int64(count)
        }
        try file.finish(path)
        return .object(["name":.string(name), "location":.string(location), "identity":.string(NativeFiles.identity(file.before)), "bytes":.number(Double(total)), "sha256":.string(hash.finalize().map { String(format: "%02x", $0) }.joined())])
    }
}

final class NativeGuestAttempt {
    let directory: String
    let generation: String
    let recorderId: String
    let binding: [String: NativeJSON]
    let source: NativeJSON
    private let key: SymmetricKey
    private let bindingSha256: String

    private static func encoded(_ value: NativeJSON) throws -> Data {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return try encoder.encode(value)
    }
    private static func object(_ value: NativeJSON?) throws -> [String: NativeJSON] {
        guard let result = value?.objectValue else { throw NativeFault("guest_recovery_fields_invalid", "Expected original recovery object") }
        return result
    }
    private static func stamp() -> String {
        let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: Date())
    }
    private static func signed(_ body: NativeJSON, name: String, key: SymmetricKey) throws -> Data {
        let bytes = try encoded(body)
        let signature = HMAC<SHA256>.authenticationCode(for: Data("qautra/guest-\(name)/v1\0".utf8) + bytes, using: key).map { String(format: "%02x", $0) }.joined()
        return try encoded(.object(["body":.string(bytes.base64EncodedString()), "signature":.string(signature)]))
    }
    private static func parsed(_ path: String, maximum: Int = 65536) throws -> [String: NativeJSON] {
        var parser = NativeJSONParser(try NativeRecoveryFiles.read(path, maximum: maximum))
        return try object(parser.parse())
    }
    private static func descendant(_ path: String, of root: String) -> Bool {
        path.hasPrefix(root + "/") && URL(fileURLWithPath: path).standardizedFileURL.path == path
    }
    private static func artifactName(_ value: NativeJSON) -> String? {
        guard let fields = value.objectValue else { return nil }
        return try? fields.text("name")
    }

    @MainActor
    init(payload: [String: NativeJSON], metadata: NativeMetadata, store: NativeStore, generation: String) throws {
        try payload.requireKeys(["context", "execution", "identity", "evidenceFile"])
        let context = try Self.object(payload["context"]), execution = try Self.object(payload["execution"]), identity = try Self.object(payload["identity"])
        try context.requireKeys(["root","runDir","runId","attemptId","revisionId","testId","ownerId","fixtureSeedId","grantId","grantSha256","subjectSha256","target"])
        try execution.requireKeys(["ownerId","generation","resources"])
        try identity.requireKeys(["machineId","contextId","generation","epoch","guestPid","recorderId","attemptId","runId"])
        for name in ["machineId","contextId","recorderId"] { guard nativeUUID(try identity.text(name)) else { throw NativeFault("guest_recovery_identity_invalid", "Original guest UUID is invalid") } }
        let attemptId = try context.text("attemptId"), runId = try context.text("runId"), root = try context.text("root"), runDir = try context.text("runDir")
        let ownerId = try execution.text("ownerId"), epoch = try identity.integer("epoch", range: 1...9007199254740991)
        let contextId = try identity.text("contextId"), contextGeneration = try identity.integer("generation", range: 1...9007199254740991)
        let guestPid = try identity.integer("guestPid", range: 1...2147483647)
        let target = try Self.object(context["target"]); try target.requireKeys(["platform","deviceId"])
        let deviceId = try target.text("deviceId")
        guard root + "/.qa/instances/machines" == store.root, Self.descendant(runDir, of: root),
              Self.descendant(try payload.text("evidenceFile"), of: runDir), try target.text("platform") == metadata.platform,
              try identity.text("machineId") == metadata.id, try identity.text("attemptId") == attemptId, try identity.text("runId") == runId,
              try context.text("ownerId") == ownerId, ownerId == "attempt:" + attemptId,
              case .array(let resources)? = execution["resources"], !resources.isEmpty, resources.count <= 128,
              resources.contains(where: { if case .string(let value) = $0 { return value == "target:" + deviceId }; return false }),
              let artifacts = metadata.artifacts else { throw NativeFault("guest_recovery_binding_mismatch", "Original guest attempt, execution resource or evidence path is invalid") }
        _ = try execution.text("generation")
        let machineDirectory = try store.directory(metadata.id)
        let boot = try Self.parsed(machineDirectory + "/kit/instance.json"), hello = try Self.parsed(machineDirectory + "/status/hello.json")
        let bootHash = NativeFiles.hash(Data(try boot.text("bootToken").utf8))
        guard try boot.text("instanceId") == metadata.id, try boot.integer("epoch", range: 1...9007199254740991) == epoch,
              try hello.text("instanceId") == metadata.id, try hello.integer("epoch", range: 1...9007199254740991) == epoch,
              try hello.integer("guestPid", range: 1...2147483647) == guestPid, try hello.text("bootTokenHash") == bootHash else {
            throw NativeFault("guest_recovery_worker_mismatch", "Original guest bootstrap and worker do not match")
        }
        let transport = try Self.parsed(root + "/.qa/instances/transport/" + metadata.id + ".json", maximum: 262144)
        guard try transport.text("machineId") == metadata.id, try transport.integer("epoch", range: 1...9007199254740991) == epoch,
              try transport.text("bootToken") == boot.text("bootToken"), case .array(let contexts)? = transport["contexts"],
              contexts.contains(where: { value in
                  guard let fence = value.objectValue else { return false }
                  return (try? fence.text("contextId")) == contextId && (try? fence.integer("generation", range: 1...9007199254740991)) == contextGeneration && (try? fence.text("state")) == "idle"
              }), case .null? = transport["recording"], case .array(let inFlight)? = transport["inFlight"], inFlight.isEmpty else {
            throw NativeFault("guest_recovery_fence_mismatch", "Registration must precede recorder and browser dispatch on the original context fence")
        }
        let id = try identity.text("recorderId")
        let archive = root + "/.qa/instances/guest-attempts"
        try NativeFiles.makeDirectory(archive, exclusive: false)
        let attemptDirectory = archive + "/" + id
        try NativeFiles.makeDirectory(attemptDirectory, exclusive: true)
        let signingKey = SymmetricKey(size: .bits256)
        let keyData = signingKey.withUnsafeBytes { Data($0) }
        try NativeFiles.writeNew(keyData, to: attemptDirectory + "/key")
        var body = payload
        body["schema"] = .string("qautra/guest-attempt-binding/v1")
        body["native"] = .object(["directory":.string(attemptDirectory),"machineId":.string(metadata.id),"nativeGeneration":.string(generation),"recorderId":.string(id)])
        body["workerId"] = .string("guest:\(metadata.id):\(guestPid):\(epoch)")
        body["machinesRoot"] = .string(store.root); body["rootId"] = .string(store.rootId); body["bootTokenSha256"] = .string(bootHash)
        body["artifacts"] = .object(["diskIdentity":.string(artifacts.diskIdentity),"auxiliaryIdentity":.string(artifacts.auxiliaryIdentity),"hardwareHash":.string(artifacts.hardwareHash),"machineHash":.string(artifacts.machineHash)])
        let bytes = try Self.signed(.object(body), name: "binding", key: signingKey)
        let digest = NativeFiles.hash(bytes)
        try NativeFiles.writeNew(bytes, to: attemptDirectory + "/binding.json")
        try NativeFiles.syncDirectory(attemptDirectory); try NativeFiles.syncDirectory(archive)
        self.generation = generation; recorderId = id; directory = attemptDirectory; key = signingKey; binding = body; bindingSha256 = digest
        source = .object(["kind":.string("macos-guest"),"id":.string(id),"root":.string(root),"bindingSha256":.string(digest)])
    }

    var registration: NativeJSON { .object(["source":source,"binding":.object(binding)]) }

    func sealStopped(observation: String) throws {
        guard ["vz-stop-completion","vz-delegate-stop","vz-delegate-error","vz-start-failure"].contains(observation) else { throw NativeFault("guest_original_terminal_unobserved", "An original VZ stop observation is required") }
        let identity = try Self.object(binding["identity"]), native = try Self.object(binding["native"])
        let stopped: NativeJSON = .object(["schema":.string("qautra/guest-native-stop/v1"),"recorderId":.string(recorderId),"bindingSha256":.string(bindingSha256),"nativeGeneration":.string(generation),"observedAt":.string(Self.stamp()),"observation":.string(observation)])
        try NativeFiles.writeNew(try Self.signed(stopped, name: "stop", key: key), to: directory + "/stop.json")
        try NativeFiles.syncDirectory(directory)
        let spool = try binding.text("machinesRoot") + "/" + native.text("machineId") + "/status/recordings/" + identity.text("contextId") + "/" + recorderId
        var artifacts: [NativeJSON] = []; var problems: [NativeJSON] = []
        var status: NativeJSON = .null; var final: NativeJSON = .null
        var encoder = "unknown", media = "unavailable", video = "unavailable"
        for name in ["status.json","final.json","video.mov","recovered.json"] {
            do {
                let item = try NativeRecoveryFiles.inventory(spool + "/" + name, name: name, location: "spool", maximum: name == "video.mov" ? 1073741824 : 65536)
                artifacts.append(item)
                if name != "video.mov" {
                    let body = try Self.parsed(spool + "/" + name)
                    guard body["identity"] == NativeJSON.object(identity) else { throw NativeFault("guest_recovery_recorder_mismatch", "Original recorder descriptor identity changed") }
                    if name == "status.json" { status = .object(body); encoder = (try? body.text("encoder")) ?? "unknown" }
                    else if name == "final.json" { final = .object(body) }
                    else {
                        guard let completed = final.objectValue, let digest = try? completed.text("sha256"),
                              try body.text("sha256") == digest else { throw NativeFault("guest_recovery_release_mismatch", "Original spool release does not match the finalized recorder") }
                    }
                }
            } catch let error as NativeFault {
                if name != "video.mov" && name != "recovered.json" || error.code != "guest_recovery_file_missing" { problems.append(.string(name.replacingOccurrences(of: ".", with: "_") + "_" + error.code)) }
            } catch { problems.append(.string("guest_recorder_inventory_unknown")) }
        }
        do {
            var parent = URL(fileURLWithPath: spool)
            for _ in 0..<3 {
                try NativeFiles.syncDirectory(parent.path)
                parent.deleteLastPathComponent()
            }
        } catch { problems.append(.string("guest_recorder_spool_sync_unknown")) }
        if !artifacts.contains(where: { Self.artifactName($0) == "video.mov" }) {
            do {
                artifacts.append(try NativeRecoveryFiles.inventory(try binding.text("evidenceFile"), name: "video.mov", location: "evidence", maximum: 1073741824))
                try NativeFiles.syncDirectory(URL(fileURLWithPath: try binding.text("evidenceFile")).deletingLastPathComponent().path)
            } catch { problems.append(.string("guest_original_video_unavailable")) }
        }
        if let descriptor = final.objectValue, let recorded = artifacts.first(where: { Self.artifactName($0) == "video.mov" })?.objectValue {
            video = "incomplete"; media = "partial"
            if (try? descriptor.text("state")) == "finalized", ["valid","invalid"].contains((try? descriptor.text("media")) ?? ""),
               (try? descriptor.text("sha256")) == (try? recorded.text("sha256")),
               (try? descriptor.integer("bytes", range: 1...1073741824)) == (try? recorded.integer("bytes", range: 1...1073741824)), encoder == "finalized" {
                media = try descriptor.text("media")
                if media == "valid" && problems.isEmpty { video = "ready" }
            }
        } else if artifacts.contains(where: { Self.artifactName($0) == "video.mov" }) { video = "incomplete"; media = "partial" }
        if !["finalized","failed","unknown"].contains(encoder) { encoder = "unknown" }
        let inventory: NativeJSON = .object(["schema":.string("qautra/guest-recorder-inventory/v1"),"recorderId":.string(recorderId),"bindingSha256":.string(bindingSha256),"nativeGeneration":.string(generation),"sealedAt":.string(Self.stamp()),"capture":.string("closed"),"encoder":.string(encoder),"media":.string(media),"video":.string(video),"artifacts":.array(artifacts),"status":status,"final":final,"problems":.array(problems)])
        try NativeFiles.writeNew(try Self.signed(inventory, name: "inventory", key: key), to: directory + "/inventory.json")
        try NativeFiles.syncDirectory(directory)
    }

    @MainActor
    static func observe(payload: [String: NativeJSON], machineId: String, store: NativeStore) throws -> NativeJSON {
        try payload.requireKeys(["recorderId","nativeGeneration"])
        let recorder = try payload.text("recorderId"), generation = try payload.text("nativeGeneration")
        guard nativeUUID(recorder), nativeUUID(generation) else { throw NativeFault("guest_recovery_identity_invalid", "Original recovery UUID is invalid") }
        let archive = URL(fileURLWithPath: store.root).deletingLastPathComponent().path + "/guest-attempts/" + recorder
        let envelope = try parsed(archive + "/binding.json", maximum: 1048576)
        let keyBytes = try NativeRecoveryFiles.read(archive + "/key", maximum: 32)
        guard keyBytes.count == 32, let bytes = Data(base64Encoded: try envelope.text("body")) else { throw NativeFault("guest_recovery_signature_invalid", "Original binding key or body is invalid") }
        let key = SymmetricKey(data: keyBytes)
        let expected = HMAC<SHA256>.authenticationCode(for: Data("qautra/guest-binding/v1\0".utf8) + bytes, using: key).map { String(format: "%02x", $0) }.joined()
        guard expected == (try envelope.text("signature")) else { throw NativeFault("guest_recovery_signature_invalid", "Original binding signature is invalid") }
        var parser = NativeJSONParser(bytes); let body = try object(parser.parse()), native = try object(body["native"])
        guard try native.text("machineId") == machineId, try native.text("nativeGeneration") == generation,
              try native.text("recorderId") == recorder, try native.text("directory") == archive else { throw NativeFault("guest_recovery_binding_mismatch", "Another original native generation cannot be adopted") }
        return .object(["registered":.bool(true)])
    }
}
