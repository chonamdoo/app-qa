import SwiftUI

struct ProductReportsView: View {
    @Environment(Workspace.self) private var workspace
    let onOpenRun: (RunListItem) -> Void
    let onOpenRegression: (String) -> Void
    @State private var model = ProductEvidenceModel()
    @State private var query = ""
    @State private var selected = Set<String>()
    private var rows: [ProductEvidenceReportRow] {
        (model.reports?.rows ?? []).filter { query.isEmpty || ($0.runName + " " + $0.testID + " " + $0.requestID).localizedCaseInsensitiveContains(query) }
    }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                HStack {
                    ProductPageHeading(title: "리포트", subtitle: "원 발행본·필수 검증·실제 receipt의 결과와 재현 조건을 표시합니다.")
                    Spacer()
                    Button("선택 결과 내보내기") {
                        Task { await model.prepare(api: workspace.api, operation: "export", requestIDs: Array(selected), artifactIDs: []) }
                    }.buttonStyle(ProductButtonStyle()).disabled(selected.isEmpty || model.operating || workspace.api == nil)
                    Button("새로고침") { Task { await model.refresh(api: workspace.api) } }.buttonStyle(ProductButtonStyle()).disabled(model.operating)
                }
                ProductNotice("증상 묶음은 동일 revision·대상·필수 검증·확인된 조건·실제 실패 기록의 결정적 일치입니다. 의미상 원인이나 결함의 동일성을 AI로 추정하지 않습니다. 원 FAIL/unknown은 보존합니다.")
                ProductSearchField("실행 이름·원 TC ID·요청 ID 검색", text: $query)
                if workspace.api == nil { ProductNotice("엔진 연결이 필요합니다.", tone: .warning) }
                if let error = model.error { ProductNotice(error, tone: .error) }
                if model.loading || model.operating { ProgressView("실제 결과·동의 범위 조회 중") }
                if let outcome = model.outcome { ProductEvidenceOutcomeView(outcome: outcome) }
                ForEach(rows) { row in
                    ProductPanel(title: row.runName + " · " + row.testID, subtitle: DisplayDate.text(row.createdAt)) {
                        VStack(alignment: .leading, spacing: 12) {
                            HStack {
                                Toggle("이 실행 결과 선택", isOn: Binding(get: { selected.contains(row.requestID) }, set: { if $0 { selected.insert(row.requestID) } else { selected.remove(row.requestID) } }))
                                Spacer()
                                ProductStatusBadge(status: row.business)
                                Button("실행 상세") { onOpenRegression(row.requestID) }.buttonStyle(ProductButtonStyle())
                            }
                            Text("업무 \(row.business) · 실행 \(row.execution) · 증거 \(row.evidence) · 정리 \(row.cleanup)")
                            Text("원 TC ID · \((row.originalCaseIDs ?? []).isEmpty ? "발행본에 미포착" : (row.originalCaseIDs ?? []).joined(separator: ", "))").textSelection(.enabled)
                            Text("\(row.target.platform) · \(row.target.deviceId) · 필수 receipt \(row.completedChecks.count)/\(row.requiredChecks.count)")
                            Text("revision \(row.revisionID)\nattempt \(row.attemptID)").font(.caption.monospaced()).textSelection(.enabled)
                            ForEach(row.expected) { check in
                                VStack(alignment: .leading, spacing: 4) {
                                    Text("기대값 · \(check.description)")
                                    Text("\(check.path) · \(check.scope) · \(row.completedChecks.contains(check.id) ? "receipt 기록 있음 (개별 실제 결과 확인)" : "필수 receipt 미기록")")
                                    Text(check.id).font(.caption.monospaced()).textSelection(.enabled)
                                }
                            }
                            DisclosureGroup("실제 결과·실패 단계·검증 근거") { Text(row.actual.readable).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }
                            DisclosureGroup("실행 시점 조건·환경·build·fixture") { Text(row.conditions?.readable ?? "조건 receipt 없음 · 비교 불가").textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }
                            ForEach(row.limitations, id: \.self) { ProductNotice($0, tone: .warning) }
                        }
                    }
                }
                ProductPanel(title: "결함·증상 묶음", subtitle: "제품 FAIL / infra / unknown / 미실행 / 증거 / 정리는 별도 축입니다.") {
                    VStack(alignment: .leading, spacing: 14) {
                        ForEach(model.reports?.groups ?? []) { group in
                            DisclosureGroup("\(group.category) · \(group.testID) · \(group.target.platform) · \(group.attemptIDs.count)회") {
                                Text("revision \(group.revisionID)\n대상 \(group.target.deviceId)\n필수 검증 \(group.requiredChecks.joined(separator: ", "))\n시도 \(group.attemptIDs.joined(separator: ", "))\n증상 \(group.symptom)").textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                            }
                        }
                    }
                }
                if rows.isEmpty && !model.loading { ContentUnavailableView("조회된 리포트 없음", systemImage: "doc.text", description: Text("실제 발행본 실행 또는 검색 조건을 확인하세요. 최신 정의로 과거의 누락을 채우지 않습니다.")) }
                DisclosureGroup("legacy 원본 리포트 · 새 발행 자격 아님") {
                    ForEach(workspace.runs) { run in Button(run.displayTitle) { onOpenRun(run) }.buttonStyle(ProductButtonStyle()) }
                }
            }.padding(.horizontal, 40).padding(.vertical, 32)
        }.background(ProductDesign.canvas)
        .task(id: ProductReadIdentity(api: workspace.api)) {
            selected = []; model.bind(workspace.api)
            await model.refresh(api: workspace.api); await workspace.loadRuns()
        }
        .sheet(item: $model.preview) { preview in
            ProductEvidenceOperationView(preview: preview) { Task { await model.confirm(api: workspace.api, preview: preview) } }
        }
    }
}
