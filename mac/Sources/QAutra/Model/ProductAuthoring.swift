import Foundation
import Observation

struct ProductAuthoringCapability: Decodable, Sendable {
    let provider: String
    let model: String
    let available: Bool
    let reason: String
    let version: String?
}
struct ProductAuthoringJob: Decodable, Sendable {
    enum Status: String, Decodable, Sendable {
        case prepared, sending, proposed, failed, cancelled, uncertain, applying, applied
    }
    let requestID: String
    let generation: String
    let createdAt: String
    let status: Status
    let payload: ProductJSON
    let transmittedPayload: String
    let payloadDigest: String
    let consent: ProductJSON?
    let proposal: ProductJSON?
    let problem: String?
    let scenarioID: String?
}
struct ProductAuthoringJobSummary: Decodable, Identifiable, Sendable {
    let requestID: String
    let generation: String
    let createdAt: String
    let status: ProductAuthoringJob.Status
    let problem: String?
    var id: String { requestID }
}
private struct ProductAuthoringHistory: Decodable, Sendable { let jobs: [ProductAuthoringJobSummary] }

@MainActor @Observable
final class ProductAuthoringState {
    private(set) var capability: ProductAuthoringCapability?
    private(set) var job: ProductAuthoringJob?
    private(set) var history: [ProductAuthoringJobSummary] = []
    private(set) var pending = false
    private(set) var error: String?
    private(set) var requestID = ""
    @ObservationIgnored private var connection: URLSession?
    @ObservationIgnored private var generation = 0

    private func bind(_ api: APIClient?) -> Int {
        if connection !== api?.session {
            connection = api?.session
            generation += 1
            capability = nil; job = nil; history = []; requestID = ""; pending = false; error = nil
        }
        return generation
    }
    func refresh(api: APIClient?) async {
        let epoch = bind(api)
        guard let api, !pending else { return }
        pending = true
        defer { if epoch == generation { pending = false } }
        do {
            let available: ProductAuthoringCapability = try await api.productAction(section: "authoring", body: .object(["action": .string("capabilities")]), humanReview: true)
            let records: ProductAuthoringHistory = try await api.productAction(section: "authoring", body: .object(["action": .string("list")]), humanReview: true)
            guard epoch == generation, !Task.isCancelled else { return }
            capability = available; history = records.jobs; error = nil
        } catch {
            guard epoch == generation, !Task.isCancelled else { return }
            self.error = "해석 연결·기록을 조회하지 못했습니다. 원문은 전송하지 않았습니다."
        }
    }
    func prepare(api: APIClient?, revision: Int, app: String, platforms: [String], documents: [String]) async {
        _ = bind(api)
        requestID = UUID().uuidString.lowercased()
        await perform(api: api, fields: ["action": .string("prepare"), "requestID": .string(requestID), "selection": .object([
            "revision": .number(Double(revision)), "app": .string(app), "platforms": .array(platforms.map(ProductJSON.string)),
            "documentIDs": .array(documents.map(ProductJSON.string))
        ])])
    }
    func load(api: APIClient?, id: String) async {
        _ = bind(api)
        requestID = id
        await perform(api: api, fields: ["action": .string("status"), "requestID": .string(id)])
    }
    func act(api: APIClient?, action: String) async {
        guard connection === api?.session else {
            _ = bind(api)
            error = "엔진 연결이 바뀌었습니다. 현재 요청 기록과 payload를 다시 조회하고 동의하세요."
            return
        }
        guard let job else { return }
        var fields: [String: ProductJSON] = ["action": .string(action), "requestID": .string(job.requestID)]
        if action == "start" || action == "apply" {
            fields["generation"] = .string(job.generation); fields["payloadDigest"] = .string(job.payloadDigest)
        }
        if action == "start" {
            fields["consent"] = .bool(true); fields["provider"] = .string("claude-cli"); fields["model"] = .string("sonnet")
        }
        await perform(api: api, fields: fields)
    }
    private func perform(api: APIClient?, fields: [String: ProductJSON]) async {
        let epoch = bind(api)
        guard let api, !pending else { return }
        pending = true; error = nil
        defer { if epoch == generation { pending = false } }
        do {
            let result: ProductAuthoringJob = try await api.productAction(section: "authoring", body: .object(fields), humanReview: true)
            guard epoch == generation, !Task.isCancelled else { return }
            job = result; requestID = result.requestID
        } catch {
            guard epoch == generation, !Task.isCancelled else { return }
            if let rejected = error as? APIError, (400..<500).contains(rejected.status) { self.error = rejected.localizedDescription }
            else { self.error = "요청 결과가 미확인입니다. 아래 requestID로 상태·catalog를 대조하세요. 전송·초안 저장을 자동 재시도하지 않습니다." }
        }
    }
}
