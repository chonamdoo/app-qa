// Bearer-authenticated REST client for the engine server.
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

    init(port: Int, token: String) {
        base = URL(string: "http://127.0.0.1:\(port)")!
        self.token = token
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

    func post<Body: Encodable, T: Decodable>(_ path: String, json body: Body, as type: T.Type = T.self) async throws -> T {
        var req = request(path, method: "POST")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONEncoder().encode(body)
        return try JSONDecoder().decode(T.self, from: try await data(for: req))
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
