import Foundation
import Observation

@MainActor @Observable
final class ProductCatalog {
    private(set) var snapshot: ProductSnapshot?
    private(set) var loading = false
    private(set) var error: String?
    private(set) var mutationPending = false
    private(set) var mutationMessage: String?
    private(set) var needsReconciliation = false

    @ObservationIgnored private var connection: URLSession?
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var refreshID = 0

    init() {}

    private func bind(_ api: APIClient?) -> Int? {
        guard let api else {
            if connection != nil { generation += 1 }
            connection = nil
            snapshot = nil
            loading = false
            mutationPending = false
            mutationMessage = nil
            needsReconciliation = false
            return nil
        }
        if connection !== api.session {
            generation += 1
            connection = api.session
            snapshot = nil
            error = nil
            mutationPending = false
            mutationMessage = nil
            needsReconciliation = false
        }
        return generation
    }

    func refresh(api: APIClient?) async {
        guard let epoch = bind(api), let api else { return }
        refreshID += 1
        let requestID = refreshID
        loading = true
        defer {
            if epoch == generation && requestID == refreshID { loading = false }
        }
        do {
            let result: ProductSnapshot = try await api.get("/api/product")
            guard epoch == generation, requestID == refreshID, !Task.isCancelled else { return }
            if snapshot == nil || result.revision >= snapshot!.revision { snapshot = result }
            error = nil
            if needsReconciliation {
                needsReconciliation = false
                mutationMessage = "최신 기록을 조회했어요. 이전 변경의 반영 여부를 확인하세요. 저장 요청은 자동으로 재전송하지 않아요."
            }
        } catch {
            guard epoch == generation, requestID == refreshID, !Task.isCancelled else { return }
            self.error = "작업 공간을 불러오지 못했어요. 연결을 확인하고 새로고침하세요: \(error.localizedDescription)"
            snapshot = nil
        }
    }

    private func mutate<Body: Encodable & Sendable>(
        api: APIClient?, path: String, message: String, humanReview: Bool = false, body: (Int) -> Body
    ) async -> Bool {
        guard !mutationPending else { return false }
        guard let epoch = bind(api), let api, let state = snapshot else {
            error = "엔진에 연결한 뒤 작업 공간을 새로고침하세요."
            return false
        }
        guard !needsReconciliation else {
            error = "이전 저장 결과가 미확인이에요. 먼저 새로고침해서 실제 기록을 확인하세요."
            return false
        }
        mutationPending = true
        mutationMessage = nil
        error = nil
        defer { if epoch == generation { mutationPending = false } }
        do {
            let result: ProductSnapshot = try await api.post(path, json: body(state.revision), humanReview: humanReview)
            guard epoch == generation, !Task.isCancelled else { return false }
            if snapshot == nil || result.revision >= snapshot!.revision { snapshot = result }
            mutationMessage = message
            return true
        } catch {
            guard epoch == generation, !Task.isCancelled else { return false }
            if let rejected = error as? APIError, (400..<500).contains(rejected.status) {
                self.error = rejected.localizedDescription
                if rejected.status == 409 { needsReconciliation = true }
            } else {
                needsReconciliation = true
                self.error = "저장 결과 미확인: \(error.localizedDescription). 기록을 새로고침하세요. 요청을 재전송하지 않아요."
            }
            return false
        }
    }

    func addScenario(api: APIClient?, definition: ProductJSON, source: ProductScenarioSource, id: String? = nil) async -> Bool {
        await mutate(api: api, path: "/api/product/scenarios", message: "검토한 원문 대응과 실행 정의를 저장했습니다. 발행은 별도 단계입니다.", humanReview: source.reviewed) {
            ProductScenarioRequest(revision: $0, definition: definition, source: source, id: id)
        }
    }

    func connectDocument(api: APIClient?, name: String, upload: UploadResult) async -> Bool {
        await mutate(api: api, path: "/api/product/documents", message: "문서 원본 bytes와 구간 목록을 보존했어요. 시나리오 발행·QA 실행은 별도 검토가 필요해요.") {
            ProductDocumentRequest(revision: $0, name: name, path: upload.path)
        }
    }

    func splitDocumentRows(api: APIClient?, documentID: String) async -> Bool {
        await mutate(api: api, path: "/api/product/document-rows", message: "전체 객체행을 각각 검토할 원문으로 보존했어요. 원 TC ID·기대값·과거 Result는 변환하지 않았고, 시나리오 생성·발행·실행도 하지 않았어요.") {
            ProductDocumentRowsRequest(revision: $0, documentID: documentID)
        }
    }

    func addEnvironment(api: APIClient?, name: String, platform: String, deviceID: String?) async -> Bool {
        await mutate(api: api, path: "/api/product/environments", message: "환경 프로필을 저장했어요. 등록은 인스턴스 준비나 세션 시작을 뜻하지 않아요.") {
            ProductEnvironmentRequest(revision: $0, name: name, platform: platform, deviceID: deviceID)
        }
    }

    func saveSettings(api: APIClient?, settings: ProductSettings) async -> Bool {
        await mutate(api: api, path: "/api/product/settings", message: "작업 공간 설정을 저장했어요.") {
            ProductSettingsRequest(revision: $0, settings: settings)
        }
    }
}
