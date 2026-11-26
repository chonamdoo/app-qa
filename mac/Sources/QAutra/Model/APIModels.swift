import Foundation

struct ServerInfo: Decodable, Equatable, Sendable {
    let port: Int
    let token: String
    let pid: Int32
    let startedAt: String
}

struct HealthInfo: Decodable, Sendable {
    let ok: Bool
    let pid: Int32
    let startedAt: String
    let root: String
    let productProtocol: String?
}

struct JobView: Decodable, Identifiable, Equatable, Sendable {
    let id: String
    let kind: String
    let title: String
    let state: String
    let devices: [String]
    let parentId: String?
    let cancelRequested: Bool
    let createdAt: String
    let startedAt: String?
    let finishedAt: String?
    let message: String?
    let resultPath: String?

    var isActive: Bool { state == "queued" || state == "running" }
}

struct JobsResponse: Decodable, Sendable { let jobs: [JobView] }

struct DeviceInfo: Decodable, Identifiable, Hashable, Sendable {
    let platform: String
    let id: String
    let name: String
    let osVersion: String
    let state: String
    let kind: String
}

struct DevicesResponse: Decodable, Sendable { let devices: [DeviceInfo] }

struct AppProfile: Decodable, Identifiable, Hashable, Sendable {
    struct Android: Decodable, Hashable, Sendable { let package: String }
    struct IOS: Decodable, Hashable, Sendable { let bundleId: String }
    struct Web: Decodable, Hashable, Sendable {
        struct Viewport: Decodable, Hashable, Sendable {
            let width: Int
            let height: Int
        }
        let url: String
        let origins: [String]?
        /// Desktop browser viewport in CSS px (= tap units of desktop events).
        let viewport: Viewport
    }
    let id: String
    let name: String
    let android: Android?
    let ios: IOS?
    let web: Web?
    /// Platforms the profile runs on, in display order (engine-derived: app → configured android/ios, web → its browsers).
    let platforms: [String]
    let docs: [String]
}

struct AppProfilesResponse: Decodable, Sendable {
    struct LoadError: Decodable, Hashable, Sendable {
        let file: String
        let error: String
    }
    let profiles: [AppProfile]
    let errors: [LoadError]
}

struct EventJournalInfo: Decodable, Hashable, Sendable {
    let state: String
    let code: String?
    let error: String?
    var usable: Bool { state == "valid" }
    var problem: String { "실행 journal \(state) · \(code ?? "미기록") · \(error ?? "완료·PASS 근거로 사용할 수 없습니다.")" }
}

struct RunListItem: Decodable, Identifiable, Hashable, Sendable {
    struct Test: Decodable, Hashable, Sendable {
        let id: String
        let name: String
        let platforms: [String]
    }
    let runId: String
    let runDir: String
    let startedAt: String
    let finished: Bool
    let originJobID: String?
    let counts: [String: Int]?
    let tests: [Test]
    let devices: [RunDeviceInfo]
    let reportPath: String?
    let hasEvents: Bool
    let eventJournal: EventJournalInfo?

    var id: String { runId }
    var displayTitle: String { tests.isEmpty ? DisplayDate.text(startedAt) : tests.lazy.map(\.name).joined(separator: " · ") }
    var displaySummary: String {
        let identity = "실행 ID · \(runId.suffix(6))"
        return tests.isEmpty ? identity : "\(DisplayDate.text(startedAt)) · \(identity)"
    }
}

struct RunsResponse: Decodable, Sendable { let runs: [RunListItem] }

struct Requirement: Decodable, Identifiable, Hashable, Sendable {
    let id: String
    let doc: String
    let section: [String]
    let text: String
    let digest: String
}

struct PlanTestEntry: Decodable, Hashable, Sendable {
    struct Review: Decodable, Hashable, Sendable {
        let addressesRequirement: Double?
        let unrelatedSteps: Double?
        let needsClarification: Double?
        let issues: [String]
    }
    let file: String
    let covers: [String]
    let status: String
    let review: Review
}

struct Untestable: Decodable, Hashable, Sendable {
    let requirement: String
    let reason: String
}

struct PlanFile: Decodable, Hashable, Sendable {
    struct LLM: Decodable, Hashable, Sendable {
        let provider: String
        let model: String?
    }
    struct Doc: Decodable, Hashable, Sendable {
        let path: String
        let sha256: String
        let kind: String
    }
    let app: String
    let createdAt: String
    let llm: LLM
    let docs: [Doc]
    let requirements: [Requirement]
    let tests: [PlanTestEntry]
    let untestable: [Untestable]
}

struct PlanTestView: Decodable, Identifiable, Hashable, Sendable {
    struct Result: Decodable, Hashable, Sendable {
        let platform: String
        let verdict: String
        let runId: String
        let ts: String
    }
    let file: String
    let path: String
    let id: String
    let name: String?
    let platforms: [String]
    let steps: [String]
    let error: String?
    let results: [Result]
}

struct PlanView: Decodable, Hashable, Sendable {
    struct DocState: Decodable, Hashable, Sendable {
        let path: String
        let kind: String
        let state: String
    }
    struct JournalError: Decodable, Hashable, Sendable {
        let runId: String
        let journal: EventJournalInfo
    }
    let app: String
    let planPath: String
    let plan: PlanFile
    let docs: [DocState]
    let tests: [PlanTestView]
    let eventJournalErrors: [JournalError]?
}

struct UploadResult: Decodable, Sendable {
    let path: String
    let name: String
    let bytes: Int
}

struct RecordingInfo: Decodable, Hashable, Sendable {
    let platform: String
    let deviceId: String
    let file: String
    let startedAt: String
}

struct RecordingsResponse: Decodable, Sendable { let recordings: [RecordingInfo] }

/// elements.json rows (runner writes candidates with masked values).
struct CandidateRow: Decodable, Identifiable, Hashable, Sendable {
    let key: String
    let role: String
    let name: String
    let value: String?
    let state: [String]?
    let rect: Rect?
    let tapPoint: Point?
    let actionable: Bool?

    var id: String { key }
}



struct AgentMeta: Decodable, Sendable {
    let requestId: String
    let at: String
    let runId: String?
    let jobId: String?
    let sessionId: String?
    let revision: Int?
    let workerId: String?
    let instanceId: String?
}

struct AgentError: Decodable, Sendable {
    let code: String
    let message: String
    let effect: String
    let fixtureEffect: String?
}

struct AgentRemoteError: LocalizedError, Sendable {
    let detail: AgentError
    let meta: AgentMeta

    var errorDescription: String? {
        "\(detail.code): \(detail.message) · effect=\(detail.effect)" + (detail.fixtureEffect.map { " · fixtureEffect=\($0)" } ?? "")
    }
}

struct AgentReply<Value: Decodable & Sendable>: Decodable, Sendable {
    let value: Value
    let meta: AgentMeta

    private enum CodingKeys: String, CodingKey { case ok, result, error, meta }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        meta = try container.decode(AgentMeta.self, forKey: .meta)
        guard try container.decode(Bool.self, forKey: .ok) else {
            throw AgentRemoteError(detail: try container.decode(AgentError.self, forKey: .error), meta: meta)
        }
        value = try container.decode(Value.self, forKey: .result)
    }
}

enum AgentManagementRequest: Encodable, Sendable {
    case list
    case status(String)
    case close(String)
    case scriptStatus(String)
    case scriptCancel(String)
    case instances
    case createInstance(requestID: String, profileID: String, name: String, resources: GuestInstanceResources?)
    case instance(GuestInstanceAction, String, cancelActive: Bool = false, force: Bool = false)
    case executionStatus(attemptID: String? = nil)
    case reconcileExecution

    private enum CodingKeys: String, CodingKey {
        case method, sessionId, scriptId, requestId, profileId, name, resources, instanceId, cancelActive, force, attemptId
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .list:
            try container.encode("session.list", forKey: .method)
        case .status(let id):
            try container.encode("session.status", forKey: .method)
            try container.encode(id, forKey: .sessionId)
        case .close(let id):
            try container.encode("session.close", forKey: .method)
            try container.encode(id, forKey: .sessionId)
        case .scriptStatus(let id):
            try container.encode("script.status", forKey: .method)
            try container.encode(id, forKey: .scriptId)
        case .scriptCancel(let id):
            try container.encode("script.cancel", forKey: .method)
            try container.encode(id, forKey: .scriptId)
        case .instances:
            try container.encode("instance.list", forKey: .method)
        case .executionStatus(let attemptID):
            try container.encode("execution.status", forKey: .method)
            try container.encodeIfPresent(attemptID, forKey: .attemptId)
        case .reconcileExecution:
            try container.encode("execution.reconcile", forKey: .method)
        case .createInstance(let requestID, let profileID, let name, let resources):
            try container.encode("instance.create", forKey: .method)
            try container.encode(requestID, forKey: .requestId)
            try container.encode(profileID, forKey: .profileId)
            try container.encode(name, forKey: .name)
            try container.encodeIfPresent(resources, forKey: .resources)
        case .instance(let action, let id, let cancelActive, let force):
            try container.encode(action.rawValue, forKey: .method)
            try container.encode(id, forKey: .instanceId)
            if action == .stop {
                try container.encode(cancelActive, forKey: .cancelActive)
                try container.encode(force, forKey: .force)
            }
        }
    }
}

struct AgentSessionView: Decodable, Identifiable, Sendable {
    struct Capabilities: Decodable, Sendable {
        let semantic: Bool
        let coordinates: Bool
        let coordinateSpace: String
        let hostGlobalInput: Bool
        let webview: Bool
        let recording: Bool
        let mutationKinds: [String]
        let modelRequired: Bool
        let isolation: String
    }
    struct LatestFrame: Decodable, Sendable {
        struct Screenshot: Decodable, Sendable {
            let path: String
            let sha256: String
            let width: Int
            let height: Int
            let privacy: String
        }
        let revision: Int
        let at: String
        let screenshot: Screenshot
    }

    let sessionId: String
    let runId: String
    let workerId: String
    let instanceId: String
    let app: String
    let platform: String
    let surface: String
    let deviceId: String
    let version: String?
    let state: String
    let revision: Int
    let createdAt: String
    let capabilities: Capabilities
    let stopReason: String?
    let evidenceDir: String
    let activeScriptId: String?
    let latestFrame: LatestFrame?

    var id: String { sessionId }
    var canClose: Bool { activeScriptId == nil && (state == "ready" || state == "stopped") }

    private enum CodingKeys: String, CodingKey {
        case sessionId, runId, workerId, instanceId, app, platform, surface, deviceId, version
        case state, revision, createdAt, capabilities, stopReason, evidenceDir, activeScriptId
        case latestFrame
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        sessionId = try container.decode(String.self, forKey: .sessionId)
        runId = try container.decode(String.self, forKey: .runId)
        workerId = try container.decode(String.self, forKey: .workerId)
        instanceId = try container.decode(String.self, forKey: .instanceId)
        app = try container.decode(String.self, forKey: .app)
        platform = try container.decode(String.self, forKey: .platform)
        surface = try container.decode(String.self, forKey: .surface)
        deviceId = try container.decode(String.self, forKey: .deviceId)
        version = try container.decode(String?.self, forKey: .version)
        state = try container.decode(String.self, forKey: .state)
        revision = try container.decode(Int.self, forKey: .revision)
        createdAt = try container.decode(String.self, forKey: .createdAt)
        capabilities = try container.decode(Capabilities.self, forKey: .capabilities)
        stopReason = try container.decode(String?.self, forKey: .stopReason)
        evidenceDir = try container.decode(String.self, forKey: .evidenceDir)
        // A missing ownership field is not evidence that the session is idle.
        activeScriptId = try container.decode(String?.self, forKey: .activeScriptId)
        latestFrame = try container.decodeIfPresent(LatestFrame.self, forKey: .latestFrame)
    }
}

struct AgentScriptView: Decodable, Sendable {
    let scriptId: String
    let sessionIds: [String]
    let state: String
    let startedAt: String
    let endedAt: String?
    let stdout: String
    let stderr: String
    let error: AgentError?
    let trustBoundary: String
}
