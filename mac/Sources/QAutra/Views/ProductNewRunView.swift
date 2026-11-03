import SwiftUI

struct ProductNewRunView: View {
    @Environment(Workspace.self) private var workspace
    @Environment(\.dismiss) private var dismiss
    let onStarted: () -> Void
    var repeatRun: RegressionRun? = nil
    @State private var name = ""
    @State private var revisionIDs = Set<String>()
    @State private var grantIDs = Set<String>()
    @State private var preflight: RegressionPreflight?
    @State private var intent: RegressionIntent?
    @State private var busy = false
    @State private var message: String?
    @State private var confirming = false
    @State private var engineIdentity = ProductReadIdentity(api: nil)

    private var store: ProductRegression { workspace.regression }
    private var revisions: [RegressionRevision] { store.revisions.filter { revisionIDs.contains($0.id) } }
    private var apps: Set<String> { Set(revisions.flatMap { $0.definition.tests.map(\.appID) }) }
    private var grants: [RegressionGrant] { store.grants.filter { grantIDs.contains($0.id) } }
    private var targets: [RegressionTarget] { Array(Set(grants.map(\.target))).sorted { ($0.platform, $0.deviceId) < ($1.platform, $1.deviceId) } }
    private var authorizations: [RegressionAuthorization] { grants.map { RegressionAuthorization(appId: $0.appId, target: $0.target, grantId: $0.grantId, subjectSha256: $0.subjectSha256) } }
    private var valid: Bool { !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && name.count <= 200 && !revisions.isEmpty && revisions.allSatisfy(\.executable) && !targets.isEmpty && apps.isSubset(of: Set(grants.map(\.appId))) }
    private var signature: String { name + revisionIDs.sorted().joined() + grantIDs.sorted().joined() }
    private var attempted: Bool { intent.map { value in store.intents.first { $0.id == value.id }?.attempted == true } ?? false }

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            HStack {
                ProductPageHeading(title: repeatRun == nil ? "새 실행" : "별도 새 attempt", subtitle: "발행한 revision과 실제 권한 범위를 고정합니다. AI 연결은 필요하지 않습니다.")
                Spacer()
                Button("닫기") { dismiss() }.buttonStyle(ProductButtonStyle()).disabled(busy)
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    ProductNotice("현재 집행 정책: 로컬 사용자 전체 독립 흐름 1개 · 순차 실행. 준비부터 영상 확정·정리까지 점유합니다.")
                    if let repeatRun { ProductNotice("원 실행 \(repeatRun.name)의 결과와 영상은 보존합니다. 동일 초기 조건은 새 사전 점검만으로 보장되지 않습니다.", tone: .warning) }
                    if let error = store.error { ProductNotice(error, tone: .error) }
                    if store.loading { ProgressView("발행본·권한·실행 기록 조회 중") }
                    if let message { ProductNotice(message, tone: .warning) }
                    TextField("실행 이름", text: $name).textFieldStyle(.roundedBorder)
                    ProductPanel(title: "1. 발행된 시나리오 revision") {
                        VStack(alignment: .leading, spacing: 12) {
                            ForEach(store.revisions) { revision in
                                Toggle(isOn: membership(revision.id, in: $revisionIDs)) {
                                    VStack(alignment: .leading, spacing: 4) {
                                        Text(revision.name)
                                        Text("발행 \(DisplayDate.text(revision.publishedAt)) · 필수 검증 \(revision.definition.checks.count)개").font(.caption)
                                        Text(revision.id).font(.caption.monospaced()).foregroundStyle(ProductDesign.muted).textSelection(.enabled)
                                        if !revision.executable { Text("이전 계약 · 읽기 전용. 현재 후보를 검토·발행해야 새 실행이 가능합니다.").font(.caption).foregroundStyle(ProductDesign.muted) }
                                    }
                                }.disabled(!revision.executable && !revisionIDs.contains(revision.id))
                            }
                            if store.revisions.isEmpty { Text("발행본이 없습니다. 시나리오에서 원문 대응과 지원 범위를 검토한 뒤 발행하세요.") }
                        }
                    }
                    ProductPanel(title: "2. 실제 대상·환경 권한", subtitle: "grant는 환경 책임자가 별도로 준비합니다. 발행이나 체크박스가 권한을 만들지 않습니다.") {
                        VStack(alignment: .leading, spacing: 12) {
                            ForEach(store.grants.filter { apps.contains($0.appId) }) { grant in
                                Toggle(isOn: membership(grant.id, in: $grantIDs)) {
                                    VStack(alignment: .leading, spacing: 4) {
                                        Text("\(grant.appId) · \(grant.target.platform) · \(grant.environment) / \(grant.tenant)")
                                        Text("기기 \(grant.target.deviceId) · 정책 \(grant.policyVersion)").font(.caption)
                                        Text("만료 \(DisplayDate.text(grant.expiresAt)) · \(grant.revoked ? "철회됨" : "현재 유효성은 엔진 점검 필요")").font(.caption)
                                    }
                                }.disabled(grant.revoked)
                            }
                            if apps.isEmpty { Text("먼저 발행본을 선택하세요.") }
                            else if store.grants.filter({ apps.contains($0.appId) }).isEmpty { ProductNotice("선택한 앱의 프로젝트 grant가 없습니다. 환경 책임자가 대상·초기 상태·효과 범위를 준비해야 합니다.", tone: .warning) }
                        }
                    }
                    ProductPanel(title: "3. 실행 사전 점검", subtitle: "정의 · 권한 · 실제 대상 · 첫 유효 영상 · 전체 용량") {
                        VStack(alignment: .leading, spacing: 12) {
                            Button("선택한 범위 사전 점검") { Task { await check() } }.buttonStyle(ProductButtonStyle()).disabled(!valid || busy || attempted)
                            if let preflight {
                                ForEach(Array(preflight.checks.enumerated()), id: \.offset) { _, check in
                                    VStack(alignment: .leading, spacing: 4) {
                                        HStack { Text(check.category); ProductStatusBadge(status: check.status) }
                                        Text(check.message)
                                        if let target = check.target { Text("\(target.platform) · \(target.deviceId)").font(.caption) }
                                        if let code = check.code { Text(code).font(.caption.monospaced()) }
                                    }
                                }
                                if !preflight.canQueue { ProductNotice("차단·미확인 항목을 해결한 뒤 다시 점검하세요. 미지원 대상을 다른 브라우저로 대체하지 않습니다.", tone: .warning) }
                            }
                            if let intent {
                                Text("보존된 요청 ID: \(intent.requestID)").font(.caption.monospaced()).textSelection(.enabled)
                            }
                        }
                    }
                }.disabled(busy || attempted)
            }
            HStack {
                if busy { ProgressView() }
                if attempted, let intent {
                    Button("같은 요청 상태 조회 · 재전송 없음") { Task { await reconcile(intent) } }.buttonStyle(ProductButtonStyle()).disabled(busy)
                }
                Spacer()
                Button("실행 시작") { confirming = true }.buttonStyle(ProductButtonStyle(kind: .primary))
                    .disabled(store.draining || busy || attempted || preflight?.canQueue != true || intent == nil || workspace.api == nil)
            }
        }
        .padding(28).frame(minWidth: 720, idealWidth: 850, minHeight: 680)
        .interactiveDismissDisabled(busy)
        .task(id: ProductReadIdentity(api: workspace.api)) {
            engineIdentity = ProductReadIdentity(api: workspace.api)
            preflight = nil
            await store.refresh(api: workspace.api)
            if let repeatRun, name.isEmpty {
                name = repeatRun.name + " · 새 시도"
                revisionIDs = Set(repeatRun.revisionIds)
                grantIDs = Set(store.grants.filter { grant in repeatRun.authorizations?.contains { $0.grantId == grant.grantId && $0.subjectSha256 == grant.subjectSha256 } == true }.map(\.id))
            }
        }
        .onChange(of: signature) { _, _ in
            if !attempted { preflight = nil; intent = nil }
        }
        .confirmationDialog("고정한 범위로 실제 입력을 시작할까요?", isPresented: $confirming, titleVisibility: .visible) {
            Button("실행 시작") { Task { await submit() } }
            Button("돌아가기", role: .cancel) {}
        } message: { Text("기존 결과는 변경되지 않습니다. 첫 변경 전 영상 준비와 매 dispatch 권한 검사는 실행 엔진이 다시 집행합니다.") }
    }
    private func membership(_ value: String, in selection: Binding<Set<String>>) -> Binding<Bool> {
        Binding(get: { selection.wrappedValue.contains(value) }, set: { if $0 { selection.wrappedValue.insert(value) } else { selection.wrappedValue.remove(value) } })
    }
    private func check() async {
        guard !store.draining, valid, !busy, let api = workspace.api else { return }
        let identity = ProductReadIdentity(api: api), draft = signature
        busy = true; message = nil; preflight = nil; intent = nil
        defer { busy = false }
        do {
            let value: RegressionPreflight = try await api.regression(RegressionCommand(method: "regression.preflight", revisionIds: revisionIDs.sorted(), targets: targets, authorizations: authorizations, evidence: "required-video"))
            guard identity == ProductReadIdentity(api: workspace.api), signature == draft, !Task.isCancelled else { return }
            preflight = value
            if value.canQueue { intent = try store.prepare(api: api, name: name.trimmingCharacters(in: .whitespacesAndNewlines), revisions: revisionIDs.sorted(), targets: targets, authorizations: authorizations) }
        } catch {
            guard identity == ProductReadIdentity(api: workspace.api), signature == draft else { return }
            message = error.localizedDescription
        }
    }
    private func submit() async {
        guard !store.draining, !busy, !attempted, preflight?.canQueue == true, let intent, let api = workspace.api, engineIdentity == ProductReadIdentity(api: api) else { return }
        busy = true
        defer { busy = false }
        do {
            let run = try await store.submit(api: api, intent: intent)
            guard engineIdentity == ProductReadIdentity(api: workspace.api), run.requestId == intent.requestID else { return }
            store.requestedID = run.id
            await store.refresh(api: workspace.api)
            onStarted()
        } catch {
            guard engineIdentity == ProductReadIdentity(api: workspace.api) else { return }
            message = "등록 응답 미확인: \(error.localizedDescription). 요청 ID를 보존했습니다. 상태만 조회하며 새 UUID로 자동 재전송하지 않습니다."
        }
    }
    private func reconcile(_ intent: RegressionIntent) async {
        guard !busy, let api = workspace.api, intent.belongs(to: api) else { message = "원래 엔진에 연결해야 이 요청을 조회할 수 있습니다."; return }
        let identity = ProductReadIdentity(api: api)
        busy = true
        defer { busy = false }
        do {
            let run: RegressionRun = try await api.regression(RegressionCommand(method: "regression.status", requestId: intent.requestID))
            guard identity == ProductReadIdentity(api: workspace.api), run.id == intent.id else { return }
            store.requestedID = run.id
            await store.refresh(api: workspace.api)
            onStarted()
        } catch { if identity == ProductReadIdentity(api: workspace.api) { message = "상태 조회 실패: \(error.localizedDescription). 미등록 증거가 아니며 재전송하지 않습니다." } }
    }
}
