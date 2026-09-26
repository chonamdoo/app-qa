// Response/request shapes of the engine server (src/server/*).
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
    let counts: [String: Int]?
    let tests: [Test]
    let devices: [RunDeviceInfo]
    let reportPath: String?
    let hasEvents: Bool

    var id: String { runId }
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
    let app: String
    let planPath: String
    let plan: PlanFile
    let docs: [DocState]
    let tests: [PlanTestView]
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

// MARK: - job requests (mirror of src/server/jobs.ts zod schemas)

/// Device id per platform (`desktop-*` → the platform id itself); keys are platform ids, as the engine's partial record.
typealias DeviceIds = [String: String]

struct RunJobParams: Encodable, Sendable {
    var paths: [String]
    var platform: String
    var deviceIds: DeviceIds
}

struct SmokeJobParams: Encodable, Sendable {
    var app: String
    var platform: String
    var deviceIds: DeviceIds
}

struct PlanJobParams: Encodable, Sendable {
    struct FollowUp: Encodable, Sendable {
        var platform: String
        var deviceIds: DeviceIds
    }
    var app: String
    var docs: [String]
    var text: String?
    var llm: String
    var run: FollowUp?
}

struct JobRequest<Params: Encodable & Sendable>: Encodable, Sendable {
    let kind: String
    let params: Params
}

struct RecordingToggle: Encodable, Sendable { let on: Bool }
