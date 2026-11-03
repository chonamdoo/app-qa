import Foundation
import Darwin
@preconcurrency import Virtualization

struct NativeRestoreInfo: Sendable {
    let url: URL
    let hardwareData: Data
    let minimumCPUCount: Int
    let minimumMemorySize: UInt64
}

enum NativeRestoreLookup {
    private static func convert(_ result: Result<VZMacOSRestoreImage, Error>) -> Result<NativeRestoreInfo, NativeFault> {
        do {
            let image = try result.get()
            guard let requirements = image.mostFeaturefulSupportedConfiguration, requirements.hardwareModel.isSupported else {
                throw NativeFault("restore_unsupported", "Apple has no compatible macOS restore configuration for this host")
            }
            return .success(NativeRestoreInfo(url: image.url, hardwareData: requirements.hardwareModel.dataRepresentation,
                minimumCPUCount: requirements.minimumSupportedCPUCount,
                minimumMemorySize: requirements.minimumSupportedMemorySize))
        } catch let error as NativeFault { return .failure(error) }
        catch { return .failure(NativeFault("restore_lookup_failed", "Apple restore-image lookup or compatibility loading failed")) }
    }

    @MainActor
    static func latest(_ completion: @escaping @MainActor @Sendable (Result<NativeRestoreInfo, NativeFault>) -> Void) {
        VZMacOSRestoreImage.fetchLatestSupported { result in
            let converted = convert(result)
            Task { @MainActor in completion(converted) }
        }
    }

    @MainActor
    static func load(_ url: URL, completion: @escaping @MainActor @Sendable (Result<NativeRestoreInfo, NativeFault>) -> Void) {
        VZMacOSRestoreImage.load(from: url) { result in
            let converted = convert(result)
            Task { @MainActor in completion(converted) }
        }
    }
}

// The Apple URL allowlist and ephemeral-download policy are adapted from E2EVM; see LICENSE.e2evm.
final class NativeAppleDownload: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    private static let maximumBytes: Int64 = 64 * 1024 * 1024 * 1024
    private let url: URL
    private let destination: URL
    private let descriptor: Int32
    private let progress: @MainActor @Sendable (Double?) -> Void
    private let completion: @MainActor @Sendable (Result<URL, NativeFault>) -> Void
    private var session: URLSession?
    private var expected: Int64 = -1
    private var received: Int64 = 0
    private var redirects = 0
    private var finished = false
    private var acceptedResponse = false
    private var failure: NativeFault?
    private var lastProgressTime: UInt64 = 0

    static func allowed(_ url: URL) -> Bool {
        guard url.scheme?.lowercased() == "https", url.user == nil, url.password == nil,
              url.fragment == nil, url.port == nil || url.port == 443,
              let host = url.host?.lowercased() else { return false }
        return host == "apple.com" || host.hasSuffix(".apple.com") || host == "cdn-apple.com" || host.hasSuffix(".cdn-apple.com")
    }

    init(url: URL, destination: URL,
         progress: @escaping @MainActor @Sendable (Double?) -> Void,
         completion: @escaping @MainActor @Sendable (Result<URL, NativeFault>) -> Void) throws {
        guard Self.allowed(url) else { throw NativeFault("restore_url_rejected", "Apple returned an unexpected restore-image URL") }
        self.url = url
        self.destination = destination
        self.progress = progress
        self.completion = completion
        let fd = open(destination.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard fd >= 0 else { throw NativeFault("restore_conflict", "Restore download requires a fresh private destination") }
        descriptor = fd
        super.init()
    }

    // After start, mutable download state is confined to this single delegate queue.
    func start() {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.httpCookieAcceptPolicy = .never
        configuration.urlCredentialStorage = nil
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.timeoutIntervalForRequest = 120
        configuration.timeoutIntervalForResource = 4 * 60 * 60
        let queue = OperationQueue()
        queue.name = "QAutraGuestHost.restore"
        queue.maxConcurrentOperationCount = 1
        let session = URLSession(configuration: configuration, delegate: self, delegateQueue: queue)
        self.session = session
        var request = URLRequest(url: url)
        request.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
        session.dataTask(with: request).resume()
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        redirects += 1
        guard redirects <= 8, request.url.map(Self.allowed) == true else {
            failure = NativeFault("restore_redirect_rejected", "Restore download redirected outside the bounded Apple HTTPS policy")
            completionHandler(nil)
            task.cancel()
            return
        }
        completionHandler(request)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        guard let response = response as? HTTPURLResponse, response.statusCode == 200,
              response.url.map(Self.allowed) == true,
              response.expectedContentLength <= Self.maximumBytes else {
            failure = NativeFault("restore_response_rejected", "Apple restore download returned an invalid response or exceeded its resource bound")
            completionHandler(.cancel)
            return
        }
        expected = response.expectedContentLength
        acceptedResponse = true
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        guard !finished, failure == nil, acceptedResponse else { dataTask.cancel(); return }
        guard Int64(data.count) <= Self.maximumBytes - received else {
            failure = NativeFault("restore_too_large", "Restore image exceeded the 64 GiB download bound")
            dataTask.cancel()
            return
        }
        do {
            try data.withUnsafeBytes { bytes in
                var offset = 0
                while offset < bytes.count {
                    let count = Darwin.write(descriptor, bytes.baseAddress!.advanced(by: offset), bytes.count - offset)
                    if count < 0 && errno == EINTR { continue }
                    guard count > 0 else { throw NativeFault("restore_write_failed", "Cannot write the private restore image") }
                    offset += count
                }
            }
            received += Int64(data.count)
            let now = DispatchTime.now().uptimeNanoseconds
            if lastProgressTime == 0 || now - lastProgressTime >= 1_000_000_000 {
                lastProgressTime = now
                let value: Double? = expected > 0 ? min(1, Double(received) / Double(expected)) : nil
                Task { @MainActor [progress] in progress(value) }
            }
        } catch let error as NativeFault { failure = error; dataTask.cancel() }
        catch { failure = NativeFault("restore_write_failed", "Cannot write the private restore image"); dataTask.cancel() }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard !finished else { return }
        finished = true
        var outcome: Result<URL, NativeFault>
        if let failure { outcome = .failure(failure) }
        else if error != nil || !acceptedResponse || received == 0 || (expected >= 0 && received != expected) {
            outcome = .failure(NativeFault("restore_download_failed", "Apple restore download did not finish completely; partial artifacts were preserved"))
        } else if fsync(descriptor) != 0 {
            outcome = .failure(NativeFault("restore_sync_failed", "Restore image could not be durably synced"))
        } else {
            do {
                let info = try NativeFiles.inspect(destination.path)
                guard info.st_size == received else { throw NativeFault("restore_changed", "Private restore image size changed") }
                try NativeFiles.syncDirectory(destination.deletingLastPathComponent().path)
                outcome = .success(destination)
            } catch { outcome = .failure(NativeFault("restore_sync_failed", "Restore image ownership or durability could not be confirmed")) }
        }
        close(descriptor)
        session.finishTasksAndInvalidate()
        let result = outcome
        Task { @MainActor [completion] in completion(result) }
    }
}
