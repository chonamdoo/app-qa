import AppKit
import SwiftUI

struct AttemptSpaceView: View {
    let attempt: RegressionAttempt
    @Environment(Workspace.self) private var workspace
    @State private var image: NSImage?
    @State private var observation: QaEvent?
    @State private var currentStep: QaEvent?
    @State private var receivedAt: Date?
    @State private var error: String?
    @State private var loading = false
    private var identity: ProductReadIdentity { ProductReadIdentity(api: workspace.api, runID: attempt.runId, artifact: attempt.id + ":" + attempt.state) }
    var body: some View {
        ProductPanel(title: "선택 Space · 실제 저장 관측", subtitle: "\(attempt.target.platform) · \(attempt.target.deviceId) · \(attempt.id)") {
            VStack(alignment: .leading, spacing: 12) {
                if let currentStep, case .stepStarted(let label) = currentStep.body {
                    Text("최근 시작 단계: \(label)").font(.headline)
                    Text("단계 이벤트 \(DisplayDate.text(currentStep.ts))").font(.callout)
                } else { Text("이 attempt의 시작 단계 관측 없음") }
                if let image {
                    Image(nsImage: image).resizable().aspectRatio(contentMode: .fit).frame(maxHeight: 480).accessibilityLabel("선택 attempt의 저장된 관측 화면")
                } else if loading { ProgressView("선택 attempt 관측 조회 중") }
                else { ContentUnavailableView("이 attempt의 화면 관측 없음", systemImage: "rectangle.dashed", description: Text("미배정·미실행·관측 실패를 다른 화면으로 채우지 않습니다.")) }
                if let observation {
                    Text("관측 사건 시각 \(DisplayDate.text(observation.ts)) · 이벤트 sequence \(observation.seq)")
                    Text("화면 수신 \(receivedAt.map { DisplayDate.text($0) } ?? "미수신")").font(.callout)
                    Text("화면 관측 단계: \((observation.index ?? -1) + 1)\(observation.index == currentStep?.index ? "" : " · 최근 시작 단계와 다른 저장 화면")")
                }
                ProductNotice("저장된 PNG 관측입니다. 연속 실시간 영상이나 capture heartbeat를 보장하지 않습니다. 필수 recorder 상태는 아래 영상 receipt와 별도로 확인하세요.")
                if let error { ProductNotice(error, tone: .warning) }
            }
        }
        .task(id: identity) {
            image = nil; observation = nil; currentStep = nil; receivedAt = nil; error = nil
            guard let api = workspace.api, let runID = attempt.runId else { return }
            let original = identity
            var lastSequence: Int?
            loading = true
            defer { if original == identity { loading = false } }
            do {
                let manifestBytes = try await api.data(for: api.runFileRequest(runId: runID, runDir: nil, path: "attempt-manifest.json"))
                let manifest = try JSONDecoder().decode(ProductJSON.self, from: manifestBytes)
                guard manifest["attemptId"]?.string == attempt.id, manifest["revisionId"]?.string == attempt.revisionId, manifest["testId"]?.string == attempt.testId,
                      manifest["target"]?["deviceId"]?.string == attempt.target.deviceId, manifest["target"]?["platform"]?.string == attempt.target.platform else { throw APIError(status: 0, message: "선택 attempt와 관측 manifest가 일치하지 않습니다") }
                while !Task.isCancelled, original == identity {
                    do {
                        let bytes = try await api.data(for: api.request("/api/runs/\(APIClient.segment(runID))/events"))
                        let events = try bytes.split(separator: 10).map { try JSONDecoder().decode(QaEvent.self, from: Data($0)) }
                        guard events.allSatisfy({ $0.runId == runID || $0.runId == nil && $0.type == "log" }) else { throw APIError(status: 0, message: "다른 run의 관측 이벤트가 포함되어 있습니다") }
                        let selected = events.filter { $0.testId == attempt.testId && $0.platform == attempt.target.platform }
                        let step = selected.last { if case .stepStarted = $0.body { return true }; return false }
                        let frames = selected.compactMap { event -> (QaEvent, String)? in
                            switch event.body {
                            case .observe(let file?, _, _, _, _), .settle(_, _, _, let file?): return (event, file)
                            default: return nil
                            }
                        }
                        guard original == identity, !Task.isCancelled else { return }
                        currentStep = step
                        if let (event, path) = frames.last, event.seq != lastSequence {
                            let runDirectory = events.compactMap { event -> String? in if case .runStarted(_, let directory, _, _) = event.body { return directory }; return nil }.first
                            let data = try await api.data(for: api.runFileRequest(runId: runID, runDir: runDirectory, path: path))
                            guard let decoded = NSImage(data: data) else { throw APIError(status: 0, message: "관측 PNG를 해석할 수 없습니다") }
                            guard original == identity, !Task.isCancelled else { return }
                            image = decoded; observation = event; receivedAt = Date(); lastSequence = event.seq
                        }
                        error = nil; loading = false
                    } catch {
                        guard original == identity, !Task.isCancelled else { return }
                        image = nil; observation = nil; receivedAt = nil; lastSequence = nil; loading = false
                        self.error = "관측 조회 실패·지연: \(error.localizedDescription). 필수 recorder 상실로 단정하거나 이전 화면을 live로 표시하지 않습니다."
                    }
                    if ["finished", "cancelled", "blocked", "unknown"].contains(attempt.state) { return }
                    try await Task.sleep(for: .seconds(2))
                }
            } catch {
                guard original == identity, !Task.isCancelled else { return }
                self.error = error.localizedDescription
            }
        }
    }
}
