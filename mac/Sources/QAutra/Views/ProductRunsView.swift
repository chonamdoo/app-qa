import SwiftUI

struct ProductRunsView: View {
    @Environment(Workspace.self) private var workspace
    let onNewRun: () -> Void
    let onOpenRun: (RunListItem) -> Void
    let onOpenRegression: (String) -> Void
    @State private var query = ""
    @State private var state = "all"
    private var store: ProductRegression { workspace.regression }
    private var filtered: [RegressionRun] {
        store.runs.filter { (query.isEmpty || ($0.name + " " + $0.id).localizedCaseInsensitiveContains(query)) && (state == "all" || (state == "active" ? !$0.terminal : $0.terminal)) }.sorted { $0.createdAt > $1.createdAt }
    }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                HStack {
                    ProductPageHeading(title: "실행 현황", subtitle: "발행본 실행 · 실제 대상 · 검증·영상·정리를 함께 확인합니다.")
                    Spacer()
                    Button("새 실행", systemImage: "plus", action: onNewRun).buttonStyle(ProductButtonStyle(kind: .primary)).disabled(workspace.api == nil)
                }
                ProductNotice("현재 집행 정책: 로컬 사용자 전체 활성 독립 흐름 1개 · 순차. Space 수·등록 환경 수·저장한 상한은 동시 실행 수가 아닙니다.")
                if workspace.api == nil { ProductNotice("엔진 연결이 없습니다. 이전 연결의 실행 상태를 현재 상태로 표시하지 않습니다.", tone: .warning) }
                if let error = store.error { ProductNotice(error, tone: .error) }
                if store.loading { ProgressView("durable 실행 기록 조회 중") }
                ProductPanel {
                    HStack(alignment: .top, spacing: 0) {
                        metric("진행 중", store.runs.filter { !$0.terminal && $0.state != "queued" }.count)
                        Rectangle().fill(ProductDesign.line).frame(width: 1, height: 64)
                        metric("대기", store.runs.filter { $0.state == "queued" }.count)
                        Rectangle().fill(ProductDesign.line).frame(width: 1, height: 64)
                        metric("원 결과 미확인", store.runs.filter { $0.state == "unknown" }.count)
                        Rectangle().fill(ProductDesign.line).frame(width: 1, height: 64)
                        metric("원 FAIL attempt", store.runs.flatMap(\.attempts).filter { $0.business == "FAIL" }.count)
                    }
                }
                HStack {
                    ProductSearchField("실행 이름 또는 요청 ID 검색", text: $query)
                    Picker("실행 상태", selection: $state) { Text("전체").tag("all"); Text("진행·대기").tag("active"); Text("종료·차단·unknown").tag("terminal") }.frame(width: 220)
                    Button("상태 새로고침") { Task { await store.refresh(api: workspace.api) } }.buttonStyle(ProductButtonStyle())
                }
                ProductPanel(title: "요청·실행 기록", subtitle: "같은 조작은 같은 request UUID로 조회합니다. 응답 유실 뒤 새 UUID를 자동 전송하지 않습니다.") {
                    VStack(alignment: .leading, spacing: 14) {
                        ForEach(filtered) { run in
                            Button { onOpenRegression(run.id) } label: {
                                HStack(alignment: .top, spacing: 16) {
                                    VStack(alignment: .leading, spacing: 6) {
                                        Text(run.name).font(.headline)
                                        Text(DisplayDate.text(run.createdAt)).font(.callout)
                                        Text(run.targets.map { "\($0.platform) · \($0.deviceId)" }.joined(separator: " / ")).font(.caption)
                                        if let message = run.message { Text(message).font(.callout) }
                                        Text(run.id).font(.caption.monospaced()).foregroundStyle(ProductDesign.muted)
                                    }
                                    Spacer()
                                    VStack(alignment: .trailing, spacing: 8) {
                                        ProductStatusBadge(status: run.state)
                                        Text("attempt \(run.attempts.count) · 필수 검증 \(run.attempts.reduce(0) { $0 + $1.completedChecks.count })/\(run.attempts.reduce(0) { $0 + $1.requiredChecks.count })")
                                        if run.attempts.contains(where: { $0.business == "FAIL" }) { ProductStatusBadge(status: "FAIL") }
                                        else if run.complete { ProductStatusBadge(status: "PASS") }
                                        else { Text("업무·증거·정리 개별 확인").font(.caption) }
                                    }
                                }.frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
                            }.buttonStyle(.plain)
                            Divider()
                        }
                        if filtered.isEmpty && !store.loading { ContentUnavailableView("표시할 실행이 없습니다", systemImage: "tray", description: Text("발행본으로 새 실행을 시작하거나 필터를 변경하세요. 샘플 결과를 채우지 않습니다.")) }
                    }
                }
                ProductPanel(title: "보존된 요청 · 읽기 전용 대조") {
                    VStack(alignment: .leading, spacing: 12) {
                        ForEach(store.intents.filter(\.attempted)) { intent in
                            HStack(alignment: .top) {
                                VStack(alignment: .leading, spacing: 5) {
                                    Text(intent.name)
                                    Text("\(intent.requestID) · \(intent.endpoint)").font(.caption.monospaced()).textSelection(.enabled)
                                    Text(workspace.api.map { intent.belongs(to: $0) } == true ? "현재 엔진의 같은 요청 상태를 조회할 수 있습니다." : "원래 인증 엔진에 연결해야 조회할 수 있습니다.").font(.caption)
                                }
                                Spacer()
                                Button("같은 요청 조회") { onOpenRegression(intent.id) }.buttonStyle(ProductButtonStyle()).disabled(workspace.api.map { !intent.belongs(to: $0) } ?? true)
                            }
                        }
                        if store.intents.filter(\.attempted).isEmpty { Text("이 앱에서 보존한 전송 요청이 없습니다.") }
                    }
                }
                DisclosureGroup("과거 실행 기록 · 읽기 전용") {
                    VStack(alignment: .leading, spacing: 12) {
                        ProductNotice("legacy 기록은 현재 발행본의 PASS나 정식 재실행 자격으로 승계하지 않습니다.", tone: .warning)
                        ForEach(workspace.runs.filter { legacy in !store.runs.flatMap(\.attempts).contains { $0.runId == legacy.runId } }) { run in
                            Button { onOpenRun(run) } label: {
                                HStack {
                                    VStack(alignment: .leading, spacing: 4) {
                                        Text(run.displayTitle)
                                        if let journal = run.eventJournal, !journal.usable { Text(journal.problem).font(.caption).foregroundStyle(ProductDesign.amber) }
                                    }
                                    Spacer()
                                    Text(DisplayDate.text(run.startedAt)).font(.caption)
                                }
                            }.buttonStyle(ProductButtonStyle())
                        }
                    }.padding(.top, 12)
                }
            }.padding(.horizontal, 40).padding(.vertical, 32)
        }.background(ProductDesign.canvas)
        .task(id: ProductReadIdentity(api: workspace.api)) {
            await workspace.loadRuns()
            while !Task.isCancelled {
                await store.refresh(api: workspace.api)
                do { try await Task.sleep(for: .seconds(3)) } catch { break }
            }
        }
    }
    private func metric(_ title: String, _ value: Int) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title).font(ProductDesign.bodyFont(13)).foregroundStyle(ProductDesign.muted)
            Text(value, format: .number).font(ProductDesign.displayFont(32).weight(.semibold)).foregroundStyle(ProductDesign.ink)
        }
        .padding(.horizontal, 24)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}
