import SwiftUI

struct ProductAuthoringView: View {
    @Environment(Workspace.self) private var workspace
    @Environment(ProductCatalog.self) private var catalog
    @Environment(\.dismiss) private var dismiss
    @State private var state = ProductAuthoringState()
    @State private var app = ""
    @State private var platforms = Set<String>()
    @State private var documents = Set<String>()
    @State private var consent = false
    @State private var recoveryID = ""
    @State private var documentQuery = ""
    @State private var documentPage = 0
    private var availablePlatforms: [String] { workspace.profiles.first { $0.id == app }?.platforms ?? [] }

    var body: some View {
        let allDocuments = catalog.snapshot?.documents ?? []
        let matchingDocuments = documentQuery.isEmpty ? allDocuments : allDocuments.filter { $0.name.localizedStandardContains(documentQuery) }
        let start = min(documentPage * 40, max(0, matchingDocuments.count - 1))
        let end = min(start + 40, matchingDocuments.count)
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                ProductPageHeading(title: "선택적 원문 해석", subtitle: "AI는 미검토 초안만 제안합니다. 수동 작성·발행·실행에는 연결이 필요하지 않습니다.")
                Spacer()
                Button("닫기") { dismiss() }.buttonStyle(ProductButtonStyle())
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    ProductNotice("원문 bytes·구간·경고가 선택한 공급자로 전송됩니다. 취소·동의 철회는 이미 보낸 bytes를 회수하지 못합니다. AI는 검토·발행·실행·N/A·판정·위험 권한·실행 순서를 확정할 수 없습니다.", tone: .warning)
                    if let capability = state.capability {
                        Text("공급자 \(capability.provider) · 모델 요청값 \(capability.model) · CLI \(capability.version ?? "미확인")").font(.headline)
                        Text(capability.reason).textSelection(.enabled)
                        Text("sonnet은 공급자의 모델 alias입니다. 이 화면은 실제 backend 모델 revision을 고정했다고 주장하지 않습니다.").font(.caption)
                    }
                    if let error = state.error { ProductNotice(error, tone: .error) }
                    if state.pending { ProgressView("요청 기록 확인 중") }
                    ProductPanel(title: "1. 원문과 앱 선택", subtitle: "TC와 별도 가이드를 함께 선택합니다. 한도 초과 시 일부를 잘라 보내지 않습니다.") {
                        VStack(alignment: .leading, spacing: 10) {
                            Picker("등록 앱", selection: $app) { Text("선택").tag(""); ForEach(workspace.profiles) { Text($0.name).tag($0.id) } }
                            HStack { ForEach(availablePlatforms, id: \.self) { value in Toggle(value, isOn: membership(value, in: $platforms)) } }
                            TextField("문서 이름 검색", text: $documentQuery).textFieldStyle(.roundedBorder)
                            HStack {
                                Text("선택 \(documents.count)개 · 검색 \(matchingDocuments.count)개")
                                Button("이전 문서") { documentPage = max(0, documentPage - 1) }.disabled(documentPage == 0)
                                Button("다음 문서") { documentPage += 1 }.disabled(end >= matchingDocuments.count)
                            }
                            ForEach(matchingDocuments[start..<end]) { document in
                                Toggle(isOn: membership(document.id, in: $documents)) {
                                    VStack(alignment: .leading) {
                                        Text(document.name)
                                        Text("\(document.id) · \(document.sha256)").font(.caption.monospaced()).textSelection(.enabled)
                                        if !(document.issues ?? []).isEmpty { Text("원문 경고 \((document.issues ?? []).count)개 · 해석 후에도 검토 필요").foregroundStyle(ProductDesign.muted) }
                                    }
                                }
                            }
                            if (catalog.snapshot?.documents ?? []).isEmpty { Text("먼저 요구사항 화면에서 원문을 등록하세요.") }
                            Button("전송하지 않고 정확한 payload 준비") {
                                consent = false
                                Task { if let revision = catalog.snapshot?.revision {
                                    await state.prepare(api: workspace.api, revision: revision, app: app, platforms: platforms.sorted(), documents: documents.sorted())
                                } }
                            }.buttonStyle(ProductButtonStyle()).disabled(state.pending || app.isEmpty || platforms.isEmpty || documents.isEmpty || documents.count > 30 || workspace.api == nil)
                        }
                    }
                    if !state.requestID.isEmpty { Text("requestID: \(state.requestID)").font(.caption.monospaced()).textSelection(.enabled) }
                    if let job = state.job {
                        ProductPanel(title: "2. 정확한 전송 내용 · \(job.status.rawValue)", subtitle: "이 payload의 UTF-8 bytes만 stdin으로 전달합니다. 원문 base64와 전체 구간·경고·출력 계약이 포함됩니다.") {
                            VStack(alignment: .leading, spacing: 10) {
                                Text("generation: \(job.generation)\nSHA-256: \(job.payloadDigest)").font(.caption.monospaced()).textSelection(.enabled)
                                Text("이 요청에 고정된 선택").font(.headline)
                                Text(job.payload["selection"]?.readable ?? "선택 기록 없음").font(.caption.monospaced()).textSelection(.enabled)
                                DisclosureGroup("전송 payload 전체 펼치기") {
                                    ScrollView([.vertical, .horizontal]) { Text(job.transmittedPayload).font(.caption.monospaced()).textSelection(.enabled).padding(8) }.frame(height: 260)
                                }
                                if let problem = job.problem { ProductNotice(problem, tone: .warning) }
                                if job.status == .prepared {
                                    Toggle("현재 표시된 정확한 payload를 구독 로그인한 Claude Code CLI / sonnet으로 이번 한 번 전송하는 데 동의합니다. 과거 수집·촬영 동의와 별개입니다.", isOn: $consent)
                                    Button("동의한 payload 전송·해석 시작") {
                                        consent = false
                                        Task { await state.act(api: workspace.api, action: "start") }
                                    }.buttonStyle(ProductButtonStyle(kind: .primary)).disabled(!consent || state.pending || state.capability?.available != true)
                                }
                                HStack {
                                    Button("상태 대조 · 재전송 없음") { consent = false; Task { await state.load(api: workspace.api, id: job.requestID) } }.buttonStyle(ProductButtonStyle())
                                    Button("취소·추가 전송 동의 철회") { consent = false; Task { await state.act(api: workspace.api, action: "revoke") } }.buttonStyle(ProductButtonStyle()).disabled(job.status == .applied)
                                }.disabled(state.pending)
                                if let proposal = job.proposal {
                                    Text("제안 전체 · 원문 기대값·충돌·미지원은 사람이 대조해야 합니다.").font(.headline)
                                    Text(proposal.readable).font(.caption.monospaced()).textSelection(.enabled)
                                }
                                if job.status == .proposed || job.status == .applying {
                                    ProductNotice("가져오기는 새 UNREVIEWED 초안만 저장합니다. 모든 원문 구간의 대응은 미검토이며, 제안의 기대값과 경고는 원문 메모에 보존합니다. 자동 검토·발행·실행하지 않습니다.", tone: .warning)
                                    Button(job.status == .applying ? "초안 반영 결과 대조 · 다시 저장하지 않음" : "이 제안을 미검토 초안으로 가져오기") {
                                        Task { await state.act(api: workspace.api, action: "apply"); await catalog.refresh(api: workspace.api) }
                                    }.buttonStyle(ProductButtonStyle(kind: .primary)).disabled(state.pending)
                                }
                                if let scenarioID = job.scenarioID { Text("저장한 초안: \(scenarioID). 이 창을 닫고 목록에서 원문·각 기대값·실행 정의를 편집·검토하세요.").textSelection(.enabled) }
                            }
                        }
                    }
                    ProductPanel(title: "3. durable 요청 기록·복구", subtitle: "재시작·연결 손실 뒤 자동 전송하지 않습니다. 진행 여부가 불명확하면 미확인 상태로 남습니다.") {
                        VStack(alignment: .leading, spacing: 10) {
                            HStack {
                                TextField("대조할 requestID", text: $recoveryID).textFieldStyle(.roundedBorder)
                                Button("기록 조회") { consent = false; Task { await state.load(api: workspace.api, id: recoveryID) } }.disabled(UUID(uuidString: recoveryID) == nil || state.pending)
                                Button("연결·목록 조회") { Task { await state.refresh(api: workspace.api) } }.disabled(state.pending)
                            }
                            ForEach(state.history) { record in
                                Button("\(DisplayDate.text(record.createdAt)) · \(record.status.rawValue) · \(record.requestID)") {
                                    consent = false; Task { await state.load(api: workspace.api, id: record.requestID) }
                                }.buttonStyle(.plain).disabled(state.pending)
                            }
                            if state.history.isEmpty { Text("조회한 해석 요청 기록이 없습니다.") }
                        }
                    }
                }
            }
        }.padding(28).frame(minWidth: 850, idealWidth: 1000, minHeight: 750).background(ProductDesign.canvas).preferredColorScheme(.light)
        .task(id: ProductReadIdentity(api: workspace.api)) { consent = false; await state.refresh(api: workspace.api) }
        .onChange(of: app) { _, _ in platforms = Set(availablePlatforms); consent = false }
        .onChange(of: documents) { _, _ in consent = false }
        .onChange(of: platforms) { _, _ in consent = false }
        .onChange(of: documentQuery) { _, _ in documentPage = 0 }
    }
    private func membership(_ value: String, in values: Binding<Set<String>>) -> Binding<Bool> {
        Binding(get: { values.wrappedValue.contains(value) }, set: { selected in
            if selected { values.wrappedValue.insert(value) } else { values.wrappedValue.remove(value) }
        })
    }
}
