// Swift mirror of src/core/events.ts (QaEvent). Unknown event types decode as `.unknown` so newer engines stay readable.
import Foundation

struct Point: Codable, Hashable, Sendable {
    let x: Double
    let y: Double
}

struct Rect: Codable, Hashable, Sendable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double
}

/// Identifies one step of one test on one platform within a run.
struct StepKey: Hashable, Sendable {
    let runId: String
    let testId: String
    let platform: String
    let index: Int
}

struct RunTestInfo: Decodable, Hashable, Sendable {
    let id: String
    let name: String
    let platforms: [String]
    let steps: [String]
}

struct RunDeviceInfo: Decodable, Hashable, Sendable {
    let platform: String
    let id: String
    let name: String
}

struct DecisionTarget: Decodable, Hashable, Sendable {
    let key: String
    let name: String
    let role: String
    let tapPoint: Point
}

struct HealthFinding: Decodable, Hashable, Sendable {
    let kind: String
    let severity: String
    let evidence: String
}

struct QaEvent: Decodable, Identifiable, Sendable {
    enum Body: Sendable {
        case jobQueued(jobId: String, kind: String, title: String)
        case jobStarted(jobId: String, kind: String)
        case jobFinished(jobId: String, kind: String, ok: Bool, message: String, resultPath: String?)
        case runStarted(runId: String, runDir: String, tests: [RunTestInfo], devices: [RunDeviceInfo])
        case testStarted(name: String)
        case stepStarted(label: String)
        case observe(screenshot: String?, candidates: Int, sparse: Bool, overflow: Bool, ocr: Bool)
        case decision(kind: String, intent: String, verdict: String, source: String, probabilities: [String: Double]?, target: DecisionTarget?, model: String?, requestId: String?, latencyMs: Double?, reason: String)
        case policy(risky: Bool, blocked: Bool, reasons: [String])
        case action(kind: String, point: Point?, to: Point?, text: String?, status: String, ms: Double)
        case settle(changed: Bool, settled: Bool, ms: Double, screenshot: String?)
        case health(findings: [HealthFinding])
        case stepFinished(verdict: String, reason: String, evidenceDir: String)
        case testFinished(verdict: String, reason: String, durationMs: Double)
        case runFinished(runId: String, counts: [String: Int], reportPath: String, junitPath: String?)
        case planStarted(planId: String, app: String, docs: [String])
        case planProgress(planId: String, phase: String, message: String)
        case planFinished(planId: String, planPath: String, requirements: Int, tests: Int, untestable: Int, ok: Bool, message: String)
        case log(level: String, source: String, message: String)
        case unknown(type: String)
    }

    let seq: Int
    let ts: String
    let type: String
    /// Present on test/step events.
    let runId: String?
    let testId: String?
    let platform: String?
    let index: Int?
    let body: Body

    var id: Int { seq }

    var stepKey: StepKey? {
        guard let runId, let testId, let platform, let index else { return nil }
        return StepKey(runId: runId, testId: testId, platform: platform, index: index)
    }

    var date: Date? { try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(ts) }

    private enum K: String, CodingKey {
        case seq, ts, type, runId, testId, platform, index
        case jobId, kind, title, ok, message, resultPath
        case runDir, tests, devices, name, label
        case screenshot, candidates, sparse, overflow, ocr
        case intent, verdict, source, probabilities, target, model, requestId, latencyMs, reason
        case risky, blocked, reasons, point, to, text, status, ms
        case changed, settled, findings, evidenceDir, durationMs
        case counts, reportPath, junitPath, planId, app, docs, phase, planPath, requirements, untestable, level
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        seq = try c.decode(Int.self, forKey: .seq)
        ts = try c.decode(String.self, forKey: .ts)
        type = try c.decode(String.self, forKey: .type)
        runId = try c.decodeIfPresent(String.self, forKey: .runId)
        testId = try c.decodeIfPresent(String.self, forKey: .testId)
        platform = try c.decodeIfPresent(String.self, forKey: .platform)
        index = (try c.decodeIfPresent(Double.self, forKey: .index)).map { Int($0) }
        func s(_ key: K) throws -> String { try c.decode(String.self, forKey: key) }
        func os(_ key: K) throws -> String? { try c.decodeIfPresent(String.self, forKey: key) }
        func b(_ key: K) throws -> Bool { try c.decode(Bool.self, forKey: key) }
        func d(_ key: K) throws -> Double { try c.decode(Double.self, forKey: key) }
        func i(_ key: K) throws -> Int { try c.decode(Int.self, forKey: key) }
        switch type {
        case "job.queued": body = .jobQueued(jobId: try s(.jobId), kind: try s(.kind), title: try s(.title))
        case "job.started": body = .jobStarted(jobId: try s(.jobId), kind: try s(.kind))
        case "job.finished":
            body = .jobFinished(jobId: try s(.jobId), kind: try s(.kind), ok: try b(.ok), message: try s(.message), resultPath: try os(.resultPath))
        case "run.started":
            body = .runStarted(runId: try s(.runId), runDir: try s(.runDir), tests: try c.decode([RunTestInfo].self, forKey: .tests), devices: try c.decode([RunDeviceInfo].self, forKey: .devices))
        case "test.started": body = .testStarted(name: try s(.name))
        case "step.started": body = .stepStarted(label: try s(.label))
        case "observe":
            body = .observe(screenshot: try os(.screenshot), candidates: try i(.candidates), sparse: try b(.sparse), overflow: try b(.overflow), ocr: try b(.ocr))
        case "decision":
            body = .decision(
                kind: try s(.kind), intent: try s(.intent), verdict: try s(.verdict), source: try s(.source),
                probabilities: try c.decodeIfPresent([String: Double].self, forKey: .probabilities),
                target: try c.decodeIfPresent(DecisionTarget.self, forKey: .target),
                model: try os(.model), requestId: try os(.requestId),
                latencyMs: try c.decodeIfPresent(Double.self, forKey: .latencyMs), reason: try s(.reason))
        case "policy": body = .policy(risky: try b(.risky), blocked: try b(.blocked), reasons: try c.decode([String].self, forKey: .reasons))
        case "action":
            body = .action(
                kind: try s(.kind), point: try c.decodeIfPresent(Point.self, forKey: .point), to: try c.decodeIfPresent(Point.self, forKey: .to),
                text: try os(.text), status: try s(.status), ms: try d(.ms))
        case "settle": body = .settle(changed: try b(.changed), settled: try b(.settled), ms: try d(.ms), screenshot: try os(.screenshot))
        case "health": body = .health(findings: try c.decode([HealthFinding].self, forKey: .findings))
        case "step.finished": body = .stepFinished(verdict: try s(.verdict), reason: try s(.reason), evidenceDir: try s(.evidenceDir))
        case "test.finished": body = .testFinished(verdict: try s(.verdict), reason: try s(.reason), durationMs: try d(.durationMs))
        case "run.finished":
            body = .runFinished(runId: try s(.runId), counts: try c.decode([String: Int].self, forKey: .counts), reportPath: try s(.reportPath), junitPath: try os(.junitPath))
        case "plan.started": body = .planStarted(planId: try s(.planId), app: try s(.app), docs: try c.decode([String].self, forKey: .docs))
        case "plan.progress": body = .planProgress(planId: try s(.planId), phase: try s(.phase), message: try s(.message))
        case "plan.finished":
            body = .planFinished(
                planId: try s(.planId), planPath: try s(.planPath), requirements: try i(.requirements), tests: try i(.tests),
                untestable: try i(.untestable), ok: try b(.ok), message: try s(.message))
        case "log": body = .log(level: try s(.level), source: try s(.source), message: try s(.message))
        default: body = .unknown(type: type)
        }
    }
}
