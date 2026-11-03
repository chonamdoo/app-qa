import Foundation

struct APIError: LocalizedError, Sendable {
    let status: Int
    let message: String

    var errorDescription: String? { status == 0 ? message : "HTTP \(status): \(message)" }
}

struct APIClient: Sendable {
    let base: URL
    let token: String
    let session: URLSession
    let projectRoot: String?
    private let reviewToken: String?

    init(port: Int, token: String, reviewToken: String? = nil, projectRoot: String? = nil) {
        base = URL(string: "http://127.0.0.1:\(port)")!
        self.token = token
        self.reviewToken = reviewToken
        self.projectRoot = projectRoot
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 30
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        session = URLSession(configuration: config)
    }

    /// Percent-encodes one path segment (device ids may contain `:`; run ids and files keep their dots).
    static func segment(_ raw: String) -> String {
        var allowed = CharacterSet.urlPathAllowed
        allowed.remove(charactersIn: "/:?#")
        return raw.addingPercentEncoding(withAllowedCharacters: allowed) ?? raw
    }

    func request(_ path: String, query: [URLQueryItem] = [], method: String = "GET") -> URLRequest {
        var components = URLComponents(url: base, resolvingAgainstBaseURL: false)!
        components.percentEncodedPath = path
        if !query.isEmpty { components.queryItems = query }
        var request = URLRequest(url: components.url!)
        request.httpMethod = method
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        return request
    }

    func data(for request: URLRequest) async throws -> Data {
        let (data, response) = try await session.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            struct ErrorBody: Decodable { let error: String }
            let message = (try? JSONDecoder().decode(ErrorBody.self, from: data))?.error ?? String(decoding: data, as: UTF8.self)
            throw APIError(status: status, message: message)
        }
        return data
    }

    func get<T: Decodable>(_ path: String, query: [URLQueryItem] = [], as type: T.Type = T.self) async throws -> T {
        try JSONDecoder().decode(T.self, from: try await data(for: request(path, query: query)))
    }

    func post<Body: Encodable, T: Decodable>(_ path: String, json body: Body, humanReview: Bool = false, as type: T.Type = T.self) async throws -> T {
        var req = request(path, method: "POST")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if humanReview {
            guard let reviewToken, !reviewToken.isEmpty else {
                throw APIError(status: 0, message: "로컬 검토 권한이 없습니다. 이 엔진의 로컬 앱 연결을 확인하세요.")
            }
            req.setValue(reviewToken, forHTTPHeaderField: "X-QAutra-Review-Token")
        }
        req.httpBody = try JSONEncoder().encode(body)
        return try JSONDecoder().decode(T.self, from: try await data(for: req))
    }

    func agent<Value: Decodable & Sendable>(
        _ body: AgentManagementRequest, as type: Value.Type = Value.self, timeout: TimeInterval = 30
    ) async throws -> AgentReply<Value> {
        var req = request("/api/agent", method: "POST")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        switch body {
        case .createInstance, .instance, .reconcileExecution:
            guard let reviewToken, !reviewToken.isEmpty else {
                throw APIError(status: 0, message: "로컬 QA 앱의 환경 관리 권한이 없습니다. 현재 엔진 연결을 확인하세요.")
            }
            req.setValue(reviewToken, forHTTPHeaderField: "X-QAutra-Review-Token")
        default: break
        }
        req.httpBody = try JSONEncoder().encode(body)
        req.timeoutInterval = timeout
        return try JSONDecoder().decode(AgentReply<Value>.self, from: try await data(for: req))
    }

    func regression<Body: Encodable, Value: Decodable & Sendable>(
        _ body: Body, humanReview: Bool = false, as type: Value.Type = Value.self
    ) async throws -> Value {
        let reply: AgentReply<Value> = try await post("/api/agent", json: body, humanReview: humanReview)
        return reply.value
    }

    func productAction<Value: Decodable>(
        section: String, body: ProductJSON, humanReview: Bool = false
    ) async throws -> Value {
        guard section == "authoring" || section == "evidence" else {
            throw APIError(status: 0, message: "지원하지 않는 제품 작업입니다.")
        }
        return try await post("/api/product/\(section)", json: body, humanReview: humanReview)
    }

    func productEvidenceSave(exportID: String, to destination: URL, cancellation: NativeExportCancellation) async throws {
        guard UUID(uuidString: exportID) != nil, let reviewToken, !reviewToken.isEmpty else {
            throw APIError(status: 0, message: "선택한 내보내기와 현재 로컬 검토 권한이 필요합니다.")
        }
        try cancellation.check()
        let lease: NativeExportLease = try await productAction(section: "evidence", body: .object([
            "method": .string("native-download.reserve"), "exportID": .string(exportID)
        ]), humanReview: true)
        NativeExportCache.claim(lease.id)
        var cache: NativeExportCache?
        var failure: (any Error)?
        do {
            try cancellation.check()
            let owned = try NativeExportCache(lease: lease)
            cache = owned
            var req = request("/api/product/evidence/exports/\(Self.segment(exportID))")
            req.setValue(reviewToken, forHTTPHeaderField: "X-QAutra-Review-Token")
            req.timeoutInterval = 120
            try await NativeExportStream(cache: owned, cancellation: cancellation, bytes: lease.bytes).download(req)
            try await Task.detached {
                try owned.save(to: destination, cancellation: cancellation)
            }.value
        } catch { failure = error }
        do { try cache?.close() } catch { failure = failure ?? error }
        NativeExportCache.release(lease.id)
        do {
            try await cleanNativeExport(root: String(lease.directory.dropLast(lease.id.count + 1)), lease: lease)
        } catch {
            let original = failure.map { "원 작업: \($0.localizedDescription). " } ?? ""
            throw APIError(status: 0, message: "\(original)Native 임시 내보내기 정리 확인 필요: \(error.localizedDescription)")
        }
        if let failure { throw failure }
    }

    func recoverProductEvidenceDownloads() async throws {
        let pending: NativeExportPending = try await productAction(section: "evidence", body: .object([
            "method": .string("native-download.pending")
        ]), humanReview: true)
        var problems: [String] = []
        for lease in pending.records where !NativeExportCache.isActive(lease.id) {
            do { try await cleanNativeExport(root: pending.root, lease: lease) }
            catch { problems.append("\(lease.id): \(error.localizedDescription)") }
        }
        if !problems.isEmpty {
            throw APIError(status: 0, message: "Native 임시 내보내기 정리 확인 필요: \(problems.joined(separator: "; "))")
        }
    }

    private func cleanNativeExport(root: String, lease: NativeExportLease) async throws {
        try await NativeExportCache.reap(root: root, lease: lease) {
            let value: NativeExportRetired = try await productAction(section: "evidence", body: .object([
                "method": .string("native-download.retire"), "id": .string(lease.id), "secret": .string(lease.secret)
            ]), humanReview: true)
            guard value.retired else { throw APIError(status: 0, message: "원 Native 다운로드 철회 fence를 확인하지 못했습니다.") }
        }
        let value: NativeExportClosed = try await productAction(section: "evidence", body: .object([
            "method": .string("native-download.acknowledge"), "id": .string(lease.id), "secret": .string(lease.secret)
        ]), humanReview: true)
        guard value.closed else { throw APIError(status: 0, message: "원 Native 임시 사본의 정리 인정을 확인하지 못했습니다.") }
    }

    func postEmpty(_ path: String) async throws {
        _ = try await data(for: request(path, method: "POST"))
    }

    func health() async throws -> HealthInfo {
        var req = request("/api/health")
        req.timeoutInterval = 2
        return try JSONDecoder().decode(HealthInfo.self, from: try await data(for: req))
    }

    func upload(fileURL: URL) async throws -> UploadResult {
        var req = request("/api/docs", method: "POST")
        req.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
        // Headers must stay ASCII: encode everything but RFC 3986 unreserved characters (Hangul included).
        let unreserved = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")
        let name = fileURL.lastPathComponent.addingPercentEncoding(withAllowedCharacters: unreserved) ?? "document"
        req.setValue(name, forHTTPHeaderField: "X-Filename")
        req.timeoutInterval = 120
        let (data, response) = try await session.upload(for: req, fromFile: fileURL)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            struct ErrorBody: Decodable { let error: String }
            throw APIError(status: status, message: (try? JSONDecoder().decode(ErrorBody.self, from: data))?.error ?? "업로드 실패")
        }
        return try JSONDecoder().decode(UploadResult.self, from: data)
    }

    /// `/api/runs/<id>/files/<relative path>`; `path` may be absolute (inside `runDir`) or run-relative.
    func runFileRequest(runId: String, runDir: String?, path: String) -> URLRequest {
        var relative = path
        if let runDir, relative.hasPrefix(runDir + "/") { relative = String(relative.dropFirst(runDir.count + 1)) }
        let encoded = relative.split(separator: "/").map { Self.segment(String($0)) }.joined(separator: "/")
        return request("/api/runs/\(Self.segment(runId))/files/\(encoded)")
    }
}

private struct NativeExportRetired: Decodable { let retired: Bool }
private struct NativeExportClosed: Decodable { let closed: Bool }
