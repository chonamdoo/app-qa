import SwiftUI

struct ProductConnectionsView: View {
    @Environment(Workspace.self) private var workspace
    @Environment(ProductCatalog.self) private var catalog
    @State private var showingEngineSettings = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                HStack {
                    ProductPageHeading(title: "설정 및 연결", subtitle: "프로젝트·실행 권한·증거 정책과 선택적 AI 작성 도구를 구분합니다.")
                    Spacer()
                    Button("새로고침", systemImage: "arrow.clockwise") {
                        Task { await catalog.refresh(api: workspace.api) }
                    }.buttonStyle(ProductButtonStyle()).disabled(catalog.loading || catalog.mutationPending)
                    Button("엔진 설정", systemImage: "gearshape") { showingEngineSettings = true }
                        .buttonStyle(ProductButtonStyle())
                }
                if catalog.loading { ProgressView("설정 불러오는 중") }
                if let error = catalog.error { ProductNotice(error, tone: .error) }
                if let message = catalog.mutationMessage { ProductNotice(message, tone: .warning) }
                if workspace.api == nil {
                    ProductNotice("엔진 연결이 없습니다. 설정 편집과 저장은 실제 API 연결 후 가능합니다.", tone: .warning)
                    ProductPanel(title: "엔진 연결") {
                        VStack(alignment: .leading, spacing: 12) {
                            Text(engineState)
                            Text(workspace.engine.root?.path ?? workspace.engine.bakedRoot ?? "프로젝트 루트 미설정")
                                .font(.caption.monospaced()).textSelection(.enabled)
                            if let lastExit = workspace.engine.lastExit { Text(lastExit).font(.caption) }
                            Button("프로젝트·node·포트 설정") { showingEngineSettings = true }
                                .buttonStyle(ProductButtonStyle())
                        }.frame(maxWidth: .infinity, alignment: .leading)
                    }
                } else if let snapshot = catalog.snapshot {
                    ConnectionsCatalogEditor(settings: snapshot.settings, revision: snapshot.revision)
                        .id(snapshot.revision)
                } else if !catalog.loading {
                    ProductPanel {
                        ContentUnavailableView("설정 미조회", systemImage: "gearshape.2",
                            description: Text("새로고침으로 엔진의 저장된 설정을 조회하세요. 기본값을 저장된 값처럼 표시하지 않습니다."))
                    }
                }
            }.padding(.horizontal, 40).padding(.vertical, 32)
        }.background(ProductDesign.canvas)
        .task(id: ProductReadIdentity(api: workspace.api)) { await catalog.refresh(api: workspace.api) }
        .sheet(isPresented: $showingEngineSettings) {
            VStack(spacing: 0) {
                HStack {
                    Text("엔진 설정").font(.headline)
                    Spacer()
                    Button("닫기") { showingEngineSettings = false }.buttonStyle(ProductButtonStyle())
                }.padding(20)
                SettingsView()
            }
        }
    }

    private var engineState: String {
        switch workspace.engine.phase {
        case .idle: return "엔진 대기 중"
        case .starting(let message): return message
        case .connected: return "실제 엔진 API 연결됨"
        case .failed(let message): return "엔진 연결 실패: \(message)"
        }
    }
}

private struct ConnectionsCatalogEditor: View {
    @Environment(Workspace.self) private var workspace
    @Environment(ProductCatalog.self) private var catalog
    @State private var draft: ProductSettings
    @State private var showingEngineSettings = false
    let revision: Int

    init(settings: ProductSettings, revision: Int) {
        _draft = State(initialValue: settings)
        self.revision = revision
    }
    private var valid: Bool {
        [draft.webLimit, draft.androidLimit, draft.iosLimit, draft.totalLimit].allSatisfy { (1...12).contains($0) }
            && [7, 14, 30].contains(draft.retentionDays)
    }
    private var canSave: Bool {
        valid && workspace.api != nil && !catalog.mutationPending && !catalog.needsReconciliation && catalog.snapshot?.revision == revision
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            HStack(alignment: .top, spacing: 24) {
                VStack(spacing: 20) { providerPanel; projectPanel }
                    .frame(maxWidth: .infinity, alignment: .topLeading)
                VStack(spacing: 20) { evidencePanel; policyPanel; limitsPanel }
                    .frame(maxWidth: .infinity, alignment: .topLeading)
            }
            HStack {
                Text("카탈로그 revision \(revision) · 저장·새로고침 시 최신 엔진 값으로 다시 표시합니다.")
                    .font(.caption).foregroundStyle(ProductDesign.muted)
                Spacer()
                Button(catalog.mutationPending ? "저장 중…" : "설정 저장") {
                    Task { _ = await catalog.saveSettings(api: workspace.api, settings: draft) }
                }.buttonStyle(ProductButtonStyle(kind: .primary)).disabled(!canSave)
            }
        }
        .disabled(catalog.mutationPending)
        .sheet(isPresented: $showingEngineSettings) {
            VStack(spacing: 0) {
                HStack { Spacer(); Button("닫기") { showingEngineSettings = false }.buttonStyle(ProductButtonStyle()) }.padding(16)
                SettingsView()
            }
        }
    }

    private var providerPanel: some View {
        ProductPanel(title: "선택적 AI 도구 선호 · 실행 판정과 분리") {
            VStack(alignment: .leading, spacing: 20) {
                providerRow("Codex", enabled: $draft.codexEnabled)
                providerRow("Claude Code · 구독", enabled: $draft.claudeEnabled)
                ProductNotice("토글은 저장할 CLI 제공자 사용 선호이며 현재 QA 실행 정책에는 영향을 주지 않습니다. 활성 MCP 연결·CLI 인증·모델 응답 성공을 뜻하지 않습니다. AI 초안·분석 결과는 검토·발행 승인을 대신하지 않습니다.")
                Text("Claude는 구독 계정으로 로그인한 로컬 Claude Code CLI만 사용합니다. API key·Console·외부 제공자 연결은 지원하지 않습니다. 원문 전송은 요청마다 동의가 필요합니다.")
                    .font(.caption).foregroundStyle(ProductDesign.muted)
            }.frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func providerRow(_ name: String, enabled: Binding<Bool>) -> some View {
        HStack(alignment: .center, spacing: 12) {
            Image(systemName: "terminal").foregroundStyle(ProductDesign.muted)
            VStack(alignment: .leading, spacing: 6) {
                Text(name).font(ProductDesign.bodyFont(16).weight(.semibold))
                Text("연결 상태 미확인 · runtime 판정 권한 없음")
                    .font(.caption).foregroundStyle(ProductDesign.muted)
            }
            Spacer()
            Toggle(name + " 사용 선호", isOn: enabled).labelsHidden().toggleStyle(.switch)
                .accessibilityLabel(name + " CLI 제공자 사용 선호, 활성 MCP 연결 아님")
        }
    }

    private var projectPanel: some View {
        ProductPanel(title: "프로젝트 연결") {
            VStack(alignment: .leading, spacing: 14) {
                TextField("프런트 URL", text: $draft.frontendURL, prompt: Text("선택한 개발 프런트 주소"))
                    .textFieldStyle(.roundedBorder)
                TextField("대상 API URL", text: $draft.apiURL, prompt: Text("선택한 개발 API 주소"))
                    .textFieldStyle(.roundedBorder)
                Text("위 URL은 프로젝트 설정이며 도달 가능성·빌드 고정·준비 데이터 승인을 증명하지 않습니다.")
                    .font(.caption).foregroundStyle(ProductDesign.muted)
                Divider()
                projectValue("실제 엔진 API", workspace.api?.base.absoluteString ?? "연결 없음")
                projectValue("프로젝트 루트", workspace.engine.root?.path ?? "미확인")
                projectValue("앱 빌드", Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "미제공")
                projectValue("선택 앱", workspace.selectedApp ?? "미선택")
                projectValue("이벤트 스트림", workspace.streamLive ? "실제 SSE 연결됨" : "미연결 또는 재연결 중")
                projectValue("엔진 소유", workspace.engine.owned ? "이 앱이 시작한 엔진" : "외부 엔진에 연결")
                Button("프로젝트·node·포트 수정") { showingEngineSettings = true }
                    .buttonStyle(ProductButtonStyle())
            }.frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func projectValue(_ label: String, _ value: String) -> some View {
        HStack(alignment: .top, spacing: 16) {
            Text(label).font(.caption).foregroundStyle(ProductDesign.muted).frame(width: 95, alignment: .leading)
            Text(value).font(.caption.monospaced()).textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var evidencePanel: some View {
        ProductPanel(title: "증거와 개인정보") {
            VStack(alignment: .leading, spacing: 16) {
                HStack {
                    Label("필수 개인정보 정제", systemImage: "lock.shield")
                    Spacer()
                    Text("항상 적용").font(.caption.weight(.semibold)).foregroundStyle(ProductDesign.green)
                }
                ProductNotice("관찰된 보안 입력·환경변수 확장 값·프로필 redact 규칙·민감 URL 값은 텍스트/이벤트/로그 기록 전에 필수 정제합니다. 이 정책을 끄는 설정은 없습니다.")
                Text("화면 이미지 전체의 민감정보가 자동으로 제거된다고 보장하지 않습니다. 증거 수집·열람 범위를 실제 실행과 조직 정책에서 확인하세요.")
                    .font(.caption).foregroundStyle(ProductDesign.muted)
                Picker("증거 보존 기간", selection: $draft.retentionDays) {
                    ForEach([7, 14, 30], id: \.self) { Text("\($0)일").tag($0) }
                }
                Text("보존 기간은 저장만 됩니다. 자동 삭제는 현재 적용되지 않습니다.")
                    .font(.caption).foregroundStyle(ProductDesign.muted)
            }.frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var policyPanel: some View {
        ProductPanel(title: "실행 권한") {
            VStack(alignment: .leading, spacing: 14) {
                policyRow("위험 동작", "엔진의 결정적 정책과 신선한 대상 검사를 따릅니다. 명시적 허용 없는 위험 행동을 UI 설정으로 우회하지 않습니다.")
                Divider()
                policyRow("결과 미확인", "uncertain 행동을 자동 재시도하거나 성공으로 바꾸지 않습니다. unknown 자원은 확인 없이 재사용하지 않습니다.")
                Divider()
                policyRow("실제 소유권", "한 기기의 입력 소유자는 엔진이 관리합니다. 사용 중인 스크립트의 중지와 세션 닫기는 직접 세션 관리에서 보호 절차를 거칩니다.")
                Divider()
                policyRow("판정", "스크립트 종료·작업 완료는 PASS가 아닙니다. 해당 실행의 실제 assertion과 증거가 필요합니다.")
                Divider()
                policyRow("증거 조회", "리플레이는 저장된 관찰의 읽기 전용 열람입니다. 재실행은 원래 기록을 보존한 별도 작업입니다.")
            }.frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func policyRow(_ title: String, _ description: String) -> some View {
        HStack(alignment: .top, spacing: 16) {
            Text(title).font(.caption.weight(.semibold)).frame(width: 80, alignment: .leading)
            Text(description).font(.caption).foregroundStyle(ProductDesign.muted)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var limitsPanel: some View {
        ProductPanel(title: "현재 집행 정책 · 편집 불가") {
            VStack(alignment: .leading, spacing: 12) {
                Text("로컬 사용자 전체 독립 흐름 1개 · 순차").font(.headline)
                Text("준비·실행·필수 영상 최종화·정리까지 점유합니다. 더 높은 ceiling은 현재 지원하지 않습니다.")
                Text("이전 저장 선호(미집행): Web \(draft.webLimit), Android \(draft.androidLimit), iOS \(draft.iosLimit), 전체 \(draft.totalLimit)")
                    .foregroundStyle(ProductDesign.muted)
            }.frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}
