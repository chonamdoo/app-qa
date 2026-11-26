import Foundation
import Darwin

private final class NativeResponseBox: @unchecked Sendable {
    private let lock = NSLock()
    private let semaphore = DispatchSemaphore(value: 0)
    private var started = false
    private var expired = false
    private var response: NativeJSON?

    func begin() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard !expired else { return false }
        started = true
        return true
    }

    func finish(_ value: NativeJSON) {
        lock.lock()
        guard !expired && response == nil else { lock.unlock(); return }
        response = value
        lock.unlock()
        semaphore.signal()
    }

    func wait() -> NativeJSON? {
        guard semaphore.wait(timeout: .now() + 60) == .success else { return nil }
        lock.lock()
        defer { lock.unlock() }
        return response
    }

    func expire() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        expired = true
        return started
    }
}

// Private UNIX socket, same-UID peer checks, and main-loop dispatch are adapted from E2EVM; see LICENSE.e2evm.
final class NativeControlServer: @unchecked Sendable {
    typealias Handler = @MainActor @Sendable (NativeRequest, @escaping @Sendable (NativeJSON) -> Void) -> Void
    private let listener: Int32
    private let handler: Handler
    private let slots = DispatchSemaphore(value: 16)
    private let acceptQueue = DispatchQueue(label: "QAutraGuestHost.control.accept")

    init(runtime: String, handler: @escaping Handler) throws {
        try NativeFiles.directory(runtime)
        let path = runtime + "/control.sock"
        let workingDirectory = FileManager.default.currentDirectoryPath
        let prefix = workingDirectory == "/" ? "/" : workingDirectory + "/"
        let bindPath = path.hasPrefix(prefix) ? String(path.dropFirst(prefix.count)) : path
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        let capacity = MemoryLayout.size(ofValue: address.sun_path)
        guard bindPath.utf8.count < capacity else {
            throw NativeFault("socket_path_too_long", "Private project control socket exceeds macOS AF_UNIX sun_path")
        }
        var old = stat()
        if lstat(path, &old) == 0 {
            guard old.st_mode & S_IFMT == S_IFSOCK, old.st_uid == getuid(), old.st_mode & 0o077 == 0 else {
                throw NativeFault("unsafe_socket", "Existing control socket is not private and owned")
            }
            guard unlink(path) == 0 else { throw NativeFault("socket_unavailable", "Cannot remove the stale socket while holding native ownership") }
        } else if errno != ENOENT { throw NativeFault("socket_unavailable", "Cannot inspect private control socket") }
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw NativeFault("socket_unavailable", "Cannot create private UNIX control socket") }
        var bound = false
        do {
            guard fcntl(fd, F_SETFD, FD_CLOEXEC) == 0 else { throw NativeFault("socket_unavailable", "Cannot protect control socket inheritance") }
            withUnsafeMutablePointer(to: &address.sun_path) { pointer in
                pointer.withMemoryRebound(to: CChar.self, capacity: capacity) { destination in
                    _ = bindPath.withCString { strlcpy(destination, $0, capacity) }
                }
            }
            let result = withUnsafePointer(to: &address) { pointer in
                pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                    Darwin.bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
                }
            }
            guard result == 0 else { throw NativeFault("socket_unavailable", "Cannot bind private UNIX control socket") }
            bound = true
            guard chmod(path, 0o600) == 0, listen(fd, 16) == 0 else {
                throw NativeFault("socket_unavailable", "Cannot protect or listen on private UNIX control socket")
            }
        } catch {
            close(fd)
            if bound { unlink(path) }
            throw error
        }
        listener = fd
        self.handler = handler
    }

    func start() {
        acceptQueue.async { [self] in
            while true {
                let client = accept(listener, nil, nil)
                if client < 0 {
                    if errno == EINTR { continue }
                    return
                }
                guard slots.wait(timeout: .now()) == .success else { close(client); continue }
                DispatchQueue.global(qos: .userInitiated).async { [self] in
                    defer { close(client); slots.signal() }
                    serve(client)
                }
            }
        }
    }

    private static func wait(_ fd: Int32, events: Int16, deadline: UInt64) -> Bool {
        while true {
            let now = DispatchTime.now().uptimeNanoseconds
            guard now < deadline else { return false }
            let milliseconds = Int32(min(1000, max(1, (deadline - now + 999999) / 1000000)))
            var descriptor = pollfd(fd: fd, events: events, revents: 0)
            let result = poll(&descriptor, 1, milliseconds)
            if result < 0 && errno == EINTR { continue }
            if result < 0 { return false }
            if result == 0 { continue }
            if descriptor.revents & events != 0 { return true }
            return false
        }
    }

    private func serve(_ client: Int32) {
        var uid: uid_t = 0
        var gid: gid_t = 0
        guard getpeereid(client, &uid, &gid) == 0, uid == getuid(),
              fcntl(client, F_SETFD, FD_CLOEXEC) == 0 else { return }
        let flags = fcntl(client, F_GETFL)
        guard flags >= 0, fcntl(client, F_SETFL, flags | O_NONBLOCK) == 0 else { return }
        var noSignal: Int32 = 1
        guard setsockopt(client, SOL_SOCKET, SO_NOSIGPIPE, &noSignal, socklen_t(MemoryLayout<Int32>.size)) == 0 else { return }
        let readDeadline = DispatchTime.now().uptimeNanoseconds + 10_000_000_000
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while data.firstIndex(of: 10) == nil {
            guard Self.wait(client, events: Int16(POLLIN), deadline: readDeadline) else { return }
            let count = Darwin.read(client, &buffer, buffer.count)
            if count < 0 && (errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK) { continue }
            guard count > 0, data.count + count <= 65537 else { return }
            data.append(contentsOf: buffer[0..<count])
        }
        guard let newline = data.firstIndex(of: 10), newline == data.count - 1, newline <= 65536 else { return }
        var parser = NativeJSONParser(Data(data[..<newline]))
        guard let parsed = try? parser.parse(), let object = parsed.objectValue,
              case .string(let requestID)? = object["id"], nativeUUID(requestID) else { return }
        let request: NativeRequest
        do { request = try NativeRequest(object) }
        catch let error as NativeFault { send(client, nativeFailure(requestID, error)); return }
        catch { send(client, nativeFailure(requestID, NativeFault("invalid_request", "Invalid native request"))); return }
        let box = NativeResponseBox()
        Task { @MainActor [handler] in
            guard box.begin() else { return }
            handler(request) { value in box.finish(value) }
        }
        if let response = box.wait() { send(client, response) }
        else {
            let dispatched = box.expire()
            send(client, nativeFailure(request.id, NativeFault("native_deadline", dispatched
                ? "Native reply deadline expired after dispatch; outcome is unknown. Query status and do not replay mutations"
                : "Native reply deadline expired before dispatch; no native action was started", effect: dispatched ? "unknown" : "not_started")))
        }
    }

    private func send(_ client: Int32, _ response: NativeJSON) {
        guard var data = try? JSONEncoder().encode(response), data.count <= 2 * 1024 * 1024 else { return }
        data.append(10)
        let deadline = DispatchTime.now().uptimeNanoseconds + 10_000_000_000
        data.withUnsafeBytes { bytes in
            var offset = 0
            while offset < bytes.count {
                guard Self.wait(client, events: Int16(POLLOUT), deadline: deadline) else { return }
                let count = Darwin.write(client, bytes.baseAddress!.advanced(by: offset), bytes.count - offset)
                if count < 0 && (errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK) { continue }
                guard count > 0 else { return }
                offset += count
            }
        }
    }
}
