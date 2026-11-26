import CryptoKit
import Foundation
import Observation
import Darwin

indirect enum ProductJSON: Codable, Sendable, Equatable {
    case object([String: ProductJSON]), array([ProductJSON]), string(String), number(Double), bool(Bool), null

    init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer()
        if value.decodeNil() { self = .null }
        else if let v = try? value.decode(Bool.self) { self = .bool(v) }
        else if let v = try? value.decode(String.self) { self = .string(v) }
        else if let v = try? value.decode(Double.self) { self = .number(v) }
        else if let v = try? value.decode([String: ProductJSON].self) { self = .object(v) }
        else { self = .array(try value.decode([ProductJSON].self)) }
    }
    func encode(to encoder: Encoder) throws {
        var value = encoder.singleValueContainer()
        switch self {
        case .object(let v): try value.encode(v)
        case .array(let v): try value.encode(v)
        case .string(let v): try value.encode(v)
        case .number(let v): try value.encode(v)
        case .bool(let v): try value.encode(v)
        case .null: try value.encodeNil()
        }
    }
    subscript(_ key: String) -> ProductJSON? { if case .object(let v) = self { v[key] } else { nil } }
    var string: String? { if case .string(let v) = self { v } else { nil } }
    var values: [ProductJSON] { if case .array(let v) = self { v } else { [] } }
    var readable: String {
        if case .string(let v) = self { return v }
        let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        return (try? encoder.encode(self)).map { String(decoding: $0, as: UTF8.self) } ?? "표시할 수 없는 값"
    }
}

struct RegressionTarget: Codable, Hashable, Sendable {
    let platform: String
    let deviceId: String
}
struct RegressionAuthorization: Codable, Sendable {
    let appId: String
    let target: RegressionTarget
    let grantId: String
    let subjectSha256: String
}
struct RegressionGrant: Decodable, Identifiable, Sendable {
    let grantId: String
    let subjectSha256: String
    let appId: String
    let target: RegressionTarget
    let environment: String
    let tenant: String
    let policyVersion: String
    let expiresAt: String
    let revoked: Bool
    var id: String { grantId + ":" + subjectSha256 }
}
struct RegressionCheck: Decodable, Identifiable, Sendable {
    let id: String
    let testId: String
    let path: String
    let kind: String
    let description: String
    let scope: String
    let platforms: [String]
}
struct RegressionProblem: Decodable, Sendable {
    let code: String
    let path: String
    let message: String
}
struct RegressionExecutionChain: Codable, Identifiable, Sendable, Equatable {
    let id: String
    var members: [String]
}
struct RegressionSourceOrigin: Decodable, Sendable {
    let schema: String
    let scenarioID: String
    let digest: String
    let source: ProductScenarioSource
    let documents: [ProductDocument]
    let review: ProductJSON?
}
struct RegressionSourceSnapshot: Decodable, Sendable {
    enum Availability: String, Decodable, Sendable { case verified, notCaptured = "not-captured" }
    let schema: String
    let revisionId: String
    let testId: String
    let availability: Availability
    let manifestSha256: String?
    let manifest: RegressionSourceOrigin?
}
struct RegressionDefinition: Decodable, Sendable {
    struct Test: Decodable, Identifiable, Sendable {
        let id: String
        let file: String
        let spec: ProductJSON
        let profile: ProductJSON
        let sourceManifest: String?
        var appID: String { spec["app"]?.string ?? profile["id"]?.string ?? "" }
        var name: String { spec["name"]?.string ?? id }
    }
    struct Source: Decodable, Sendable {
        let path: String
        let sha256: String
        let bytes: Int
        let kind: String
    }
    let schema: String
    let tests: [Test]
    let sources: [Source]
    let checks: [RegressionCheck]
    let chains: [RegressionExecutionChain]?
}
struct RegressionCandidate: Decodable, Sendable {
    let candidateId: String
    let createdAt: String
    let digest: String
    let definition: RegressionDefinition
    let problems: [RegressionProblem]
}
struct RegressionRevision: Decodable, Identifiable, Sendable {
    let revisionId: String
    let publishedAt: String
    let definition: RegressionDefinition
    var id: String { revisionId }
    var name: String { definition.tests.map(\.name).joined(separator: " · ") }
    var executable: Bool { definition.schema == "qautra/scenario-definition/v4" }
}
struct RegressionAttempt: Decodable, Identifiable, Sendable {
    let attemptId: String
    let revisionId: String
    let testId: String
    let chain: RegressionExecutionChain?
    let target: RegressionTarget
    let state: String
    let runId: String?
    let business: String
    let evidence: String
    let cleanup: String
    let requiredChecks: [String]
    let completedChecks: [String]
    let code: String?
    let message: String?
    var id: String { attemptId }
}
struct RegressionRun: Decodable, Identifiable, Sendable {
    let requestId: String
    let name: String
    let createdAt: String
    let updatedAt: String
    let state: String
    let revisionIds: [String]
    let targets: [RegressionTarget]
    let authorizations: [RegressionAuthorization]?
    let attempts: [RegressionAttempt]
    let stopRequested: Bool
    let code: String?
    let message: String?
    var id: String { requestId }
    var terminal: Bool { ["finished", "cancelled", "blocked", "unknown"].contains(state) }
    var complete: Bool {
        state == "finished" && !attempts.isEmpty && attempts.allSatisfy {
            $0.business == "PASS" && $0.state == "finished" && $0.evidence == "ready" && $0.cleanup == "confirmed"
                && !$0.requiredChecks.isEmpty && Set($0.requiredChecks) == Set($0.completedChecks)
        }
    }
}
struct RegressionPreflight: Decodable, Sendable {
    struct Check: Decodable, Sendable {
        let category: String
        let target: RegressionTarget?
        let status: String
        let code: String?
        let message: String
    }
    let canQueue: Bool
    let checks: [Check]
}
struct RegressionComparison: Decodable, Sendable {
    struct Item: Decodable, Sendable {
        let attemptId: String
        let beforeAttemptId: String?
        let comparable: Bool
        let classification: String
        let reason: String
        let before: ProductJSON?
        let after: ProductJSON
    }
    let before: String
    let after: String
    let readOnly: Bool
    let comparisons: [Item]
}
struct RegressionCommand: Encodable, Sendable {
    let method: String
    var paths: [String]? = nil
    var chains: [RegressionExecutionChain]? = nil
    var candidateId: String? = nil
    var digest: String? = nil
    var reviewedChecks: [String]? = nil
    var revisionId: String? = nil
    var testId: String? = nil
    var revisionIds: [String]? = nil
    var targets: [RegressionTarget]? = nil
    var authorizations: [RegressionAuthorization]? = nil
    var evidence: String? = nil
    var requestId: String? = nil
    var name: String? = nil
    var before: String? = nil
    var after: String? = nil
}
struct RegressionIntent: Codable, Identifiable, Sendable {
    let requestID: String
    let endpoint: String
    let engineDigest: String
    let name: String
    let revisionIDs: [String]
    let targets: [RegressionTarget]
    let authorizations: [RegressionAuthorization]
    var attempted: Bool
    var projectRoot: String? = nil
    var id: String { requestID }
    func belongs(to api: APIClient) -> Bool {
        if let projectRoot, let currentRoot = api.projectRoot { return projectRoot == currentRoot }
        return endpoint == api.base.absoluteString && engineDigest == Self.digest(api.token)
    }
    static func digest(_ token: String) -> String { SHA256.hash(data: Data(token.utf8)).map { String(format: "%02x", $0) }.joined() }
}

@MainActor @Observable
final class ProductRegression {
    var revisions: [RegressionRevision] = []
    var grants: [RegressionGrant] = []
    var runs: [RegressionRun] = []
    var intents: [RegressionIntent] = []
    var loading = false
    var draining = false
    var error: String?
    var requestedID: String?
    private var identity = ProductReadIdentity(api: nil)
    private var sequence = 0
    private let persistenceURL = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/QAutra/submissions.json")
    private var persistenceFailure: String?

    init() {
        if FileManager.default.fileExists(atPath: persistenceURL.path) {
            do { intents = try JSONDecoder().decode([RegressionIntent].self, from: Data(contentsOf: persistenceURL)) }
            catch { persistenceFailure = "보존한 요청 기록을 읽지 못했습니다: \(error.localizedDescription). 새 실행 전 복구가 필요합니다."; self.error = persistenceFailure }
        }
    }
    private func persist() throws {
        if let persistenceFailure { throw APIError(status: 0, message: persistenceFailure) }
        let directory = persistenceURL.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)
        // A first save creates the directory; its entry in the parent must be durable before any request is dispatched.
        let parentDescriptor = open(directory.deletingLastPathComponent().path, O_RDONLY | O_DIRECTORY | O_CLOEXEC)
        guard parentDescriptor >= 0 else { throw APIError(status: 0, message: "요청 보존 상위 디렉터리를 열지 못했습니다") }
        defer { close(parentDescriptor) }
        guard fsync(parentDescriptor) == 0 else { throw APIError(status: 0, message: "요청 보존 디렉터리 생성을 동기화하지 못했습니다") }
        let data = try JSONEncoder().encode(intents)
        let directoryDescriptor = open(directory.path, O_RDONLY | O_DIRECTORY | O_CLOEXEC)
        guard directoryDescriptor >= 0 else { throw APIError(status: 0, message: "요청 보존 디렉터리를 열지 못했습니다") }
        defer { close(directoryDescriptor) }
        let temporary = ".submissions-\(UUID().uuidString).json"
        let descriptor = openat(directoryDescriptor, temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard descriptor >= 0 else { throw APIError(status: 0, message: "요청 보존 임시 파일을 만들지 못했습니다") }
        var renamed = false
        defer {
            close(descriptor)
            if !renamed { unlinkat(directoryDescriptor, temporary, 0) }
        }
        let written = data.withUnsafeBytes { buffer -> Bool in
            var offset = 0
            while offset < buffer.count {
                let count = write(descriptor, buffer.baseAddress! + offset, buffer.count - offset)
                if count < 0 && errno == EINTR { continue }
                guard count > 0 else { return false }
                offset += count
            }
            return true
        }
        guard written, fsync(descriptor) == 0 else { throw APIError(status: 0, message: "요청 기록을 동기화하지 못했습니다") }
        guard renameat(directoryDescriptor, temporary, directoryDescriptor, persistenceURL.lastPathComponent) == 0 else { throw APIError(status: 0, message: "요청 기록을 원자적으로 교체하지 못했습니다") }
        renamed = true
        guard fsync(directoryDescriptor) == 0 else { throw APIError(status: 0, message: "요청 보존 디렉터리의 동기화를 확인하지 못했습니다") }
    }
    func bind(_ api: APIClient?) {
        let next = ProductReadIdentity(api: api)
        guard next != identity else { return }
        identity = next; sequence += 1; revisions = []; grants = []; runs = []; error = persistenceFailure; loading = false
    }
    func refresh(api: APIClient?) async {
        bind(api)
        guard let api else { return }
        let current = identity
        sequence += 1; let ticket = sequence
        loading = true
        defer { if identity == current && sequence == ticket { loading = false } }
        var problems = [String]()
        if let persistenceFailure { problems.append(persistenceFailure) }
        do {
            let values: [RegressionRun] = try await api.regression(RegressionCommand(method: "regression.list"))
            guard !Task.isCancelled, current == identity, ticket == sequence else { return }
            runs = values
        } catch {
            guard !Task.isCancelled, current == identity, ticket == sequence else { return }
            problems.append("실행 기록 조회 실패: \(error.localizedDescription). 이전 조회값은 최신 상태가 아닐 수 있습니다.")
        }
        do {
            let values: [RegressionRevision] = try await api.regression(RegressionCommand(method: "scenario.list"))
            guard !Task.isCancelled, current == identity, ticket == sequence else { return }
            revisions = values
        } catch {
            guard !Task.isCancelled, current == identity, ticket == sequence else { return }
            revisions = []
            problems.append("발행본 목록 조회 실패: \(error.localizedDescription)")
        }
        do {
            let values: [RegressionGrant] = try await api.regression(RegressionCommand(method: "regression.grants"))
            guard !Task.isCancelled, current == identity, ticket == sequence else { return }
            grants = values
        } catch {
            guard !Task.isCancelled, current == identity, ticket == sequence else { return }
            grants = []
            problems.append("현재 실행 권한 조회 실패: \(error.localizedDescription). 과거 실행 기록은 별도로 조회합니다. 새 실행에는 유효한 권한이 필요합니다.")
        }
        self.error = problems.isEmpty ? nil : problems.joined(separator: "\n")
    }
    func prepare(api: APIClient, name: String, revisions: [String], targets: [RegressionTarget], authorizations: [RegressionAuthorization]) throws -> RegressionIntent {
        let intent = RegressionIntent(requestID: UUID().uuidString.lowercased(), endpoint: api.base.absoluteString,
            engineDigest: RegressionIntent.digest(api.token), name: name, revisionIDs: revisions,
            targets: targets, authorizations: authorizations, attempted: false, projectRoot: api.projectRoot)
        intents.append(intent)
        try persist()
        return intent
    }
    func submit(api: APIClient, intent: RegressionIntent) async throws -> RegressionRun {
        guard !draining, intent.belongs(to: api), let index = intents.firstIndex(where: { $0.id == intent.id }), !intents[index].attempted else {
            throw APIError(status: 0, message: "이미 전송했거나 다른 엔진의 요청입니다. 같은 요청 ID로 상태만 조회하세요.")
        }
        intents[index].attempted = true
        try persist()
        return try await api.regression(RegressionCommand(method: "regression.submit", revisionIds: intent.revisionIDs,
            targets: intent.targets, authorizations: intent.authorizations, evidence: "required-video", requestId: intent.requestID, name: intent.name))
    }
}
