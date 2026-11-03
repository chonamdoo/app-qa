import Foundation

struct AttemptVideoReceipt: Decodable, Sendable {
    struct Binding: Decodable, Sendable { let attemptId: String; let runId: String; let platform: String; let deviceId: String }
    struct Segment: Decodable, Sendable {
        let file: String
        let sha256: String
        let bytes: Int
        let frames: Int
        let durationSeconds: Double
        let startedAt: String
        let endedAt: String
        let source: String
    }
    struct Gap: Decodable, Sendable { let from: String; let to: String?; let reason: String }
    let schema: String
    let binding: Binding
    let state: String
    let cleanup: String
    let segments: [Segment]
    let gaps: [Gap]
    let code: String?
}

struct ExecutionResourceRecovery: Decodable, Sendable {
    struct Admission: Decodable, Sendable {
        let state: String
        let ownerId: String?
        let resources: [String]
        let ownership: String
    }
    struct Scope: Decodable, Sendable { let ownerId: String; let generation: String; let resources: [String] }
    struct Context: Decodable, Sendable {
        struct Target: Decodable, Sendable { let platform: String; let deviceId: String }
        let attemptId: String
        let runId: String
        let revisionId: String
        let testId: String
        let ownerId: String
        let target: Target
    }
    struct Check: Decodable, Identifiable, Sendable {
        let kind: String
        let status: String
        let code: String?
        var id: String { kind }
        var title: String {
            switch kind {
            case "binding": "원 실행·자원 세대"
            case "native-stop": "실제 Chrome·driver 종료"
            case "evidence": "영상·진단 증거 확정"
            case "fixture": "원 fixture 복원"
            case "late-effects": "지연 효과·권한 회수"
            default: "알 수 없는 확인 축"
            }
        }
        var label: String { status == "verified" ? "확인됨" : status == "blocked" ? "미확인 · 재사용 차단" : "관측 안 됨" }
    }
    struct Source: Decodable, Identifiable, Sendable {
        struct Reference: Decodable, Sendable {
            let kind: String; let id: String; let root: String?; let bindingSha256: String
            var valid: Bool {
                switch kind {
                case "owned-chrome": root == nil
                case "macos-guest": root.map { $0.hasPrefix("/") && $0.count <= 4096 } ?? false
                default: false
                }
            }
        }
        let reference: Reference
        let context: Context?
        let native: ProductJSON?
        let evidenceSha256: String?
        let video: String
        let segments: [AttemptVideoReceipt.Segment]
        let fixture: ProductJSON?
        let checks: [Check]
        var id: String { reference.id }
    }
    struct Observation: Decodable, Sendable {
        let schema: String
        let kind: String
        let scope: Scope
        let observedAt: String
        let state: String
        let sources: [Source]
        let problems: [String]
    }
    struct Instances: Decodable, Sendable {
        struct Blocked: Decodable, Sendable { let instanceId: String; let code: String }
        let recovered: [String]
        let blocked: [Blocked]
    }
    let kind: String
    let admission: Admission
    let observation: Observation?
    let instances: Instances?
    let originalOutcomePreserved: Bool

    func validate(attempt: RegressionAttempt? = nil) throws {
        guard kind == "resource-verification-only", originalOutcomePreserved,
              ["idle", "active", "unknown"].contains(admission.state) else { throw APIError(status: 0, message: "자원 복구 응답 종류·현재 점유 상태 불일치") }
        guard let observation else { return }
        guard observation.schema == "qautra/resource-recovery-observation/v1", observation.kind == kind,
              ["verified", "blocked"].contains(observation.state), !observation.scope.resources.isEmpty,
              Set(observation.sources.map(\.id)).count == observation.sources.count else { throw APIError(status: 0, message: "원 자원 복구 기록의 범위·종류 불일치") }
        if let attempt, observation.scope.ownerId != "attempt:\(attempt.id)" { throw APIError(status: 0, message: "다른 attempt의 복구 기록을 표시하지 않습니다") }
        for source in observation.sources {
            guard source.reference.valid, source.checks.count == 5,
                  Set(source.checks.map(\.kind)) == Set(["binding", "native-stop", "evidence", "fixture", "late-effects"]),
                  source.checks.allSatisfy({ ["verified", "blocked", "unobserved"].contains($0.status) }) else { throw APIError(status: 0, message: "필수 자원 복구 확인 축 누락·중복") }
            if let context = source.context {
                guard context.ownerId == observation.scope.ownerId else { throw APIError(status: 0, message: "원 자원 소유권 불일치") }
                if let attempt {
                    guard context.attemptId == attempt.id, context.runId == attempt.runId, context.revisionId == attempt.revisionId,
                          context.testId == attempt.testId, context.target.platform == attempt.target.platform,
                          context.target.deviceId == attempt.target.deviceId else { throw APIError(status: 0, message: "선택 attempt·대상과 복구 증거 불일치") }
                }
            }
        }
        if observation.state == "verified" && (observation.sources.isEmpty || !observation.problems.isEmpty || observation.sources.contains(where: { $0.checks.contains(where: { $0.status != "verified" }) })) { throw APIError(status: 0, message: "모든 축이 확인되지 않은 복구 완료 응답") }
    }
}
