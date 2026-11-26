import SwiftUI

struct GuestInstancesView: View {
    @Environment(Workspace.self) private var workspace
    @State private var guide = false
    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            if let api = workspace.api { RuntimeInventoryView(state: workspace.guestInstanceUIState(for: api)).id(ProductReadIdentity(api: api)) }
            else { ProductNotice("엔진 연결 뒤 소유 Chrome과 실제 Safari guest 자원을 조회하세요. 개인 호스트 브라우저를 자동 채택하지 않습니다.", tone: .warning) }
            ForEach(workspace.guestInstanceUIStates.values.filter { $0.identity != ProductReadIdentity(api: workspace.api) && $0.creation?.blocksNewRequest == true }.sorted { $0.endpoint < $1.endpoint }, id: \.identity) { state in
                if let creation = state.creation {
                    ProductPanel(title: "이전 엔진의 미확인 생성 요청", subtitle: state.endpoint) { InstanceCreationReceipt(creation: creation) }
                }
            }
            DisclosureGroup("관리자용 실제 macOS guest 준비 안내") {
                ProductNotice("실제 Safari는 준비된 macOS guest의 Safari를 사용합니다. Apple 라이선스·계정·Safari 권한은 guest 안에서만 준비하며 호스트 전역 입력으로 우회하지 않습니다.")
                Button("guest 준비 안내 열기") { guide = true }.buttonStyle(ProductButtonStyle())
            }
        }.sheet(isPresented: $guide) { GuestSetupGuideView() }
    }
}

private struct RuntimeInventoryView: View {
    @Bindable var state: GuestInstanceUIState
    @Environment(Workspace.self) private var workspace
    @State private var creating = false
    @State private var selectedID: String?
    @State private var stoppingID: String?
    @State private var confirmRecovery = false
    private var current: Bool { state.identity == ProductReadIdentity(api: workspace.api) }
    private var pending: Bool { state.pendingAction != nil || state.creation?.phase == .pending }
    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            HStack {
                VStack(alignment: .leading, spacing: 6) {
                    Text("실제 브라우저 자원").font(ProductDesign.bodyFont(18).weight(.semibold))
                    Text("소유 headless Chrome과 실제 macOS guest Safari를 구분합니다.").foregroundStyle(ProductDesign.muted)
                }
                Spacer()
                Button("상태 조회") { Task { await workspace.refreshGuestInstances(in: state) } }.buttonStyle(ProductButtonStyle()).disabled(!current)
            }
            ProductNotice("자원 등록·adapter 가용·브라우저 준비·첫 영상 프레임은 서로 다른 상태입니다. Space는 실행 attempt 관측이며 인스턴스를 늘리는 런처가 아닙니다.")
            ResourceRecoveryPanel(snapshot: state.recovery, readError: state.recoveryReadError, actionError: state.recoveryActionError,
                busy: state.recoveryPending, canReconcile: current && !pending && state.recoveryReadError == nil
                    && (state.recovery?.admission.state == "unknown" || state.recovery?.admission.state == "idle" && state.listing?.instances.contains(where: { $0.isOwnedChrome && $0.state == "unknown" }) == true),
                onRefresh: { Task { await workspace.refreshExecutionRecovery(in: state) } },
                onReconcile: { confirmRecovery = true })
            if state.loading && state.listing == nil { ProgressView("실제 runtime 목록 조회 중") }
            if let error = state.listError { ProductNotice(error, tone: .error) }
            ForEach(state.actionErrors.keys.sorted(), id: \.self) { key in if let error = state.actionErrors[key] { ProductNotice(error, tone: .warning) } }
            if let listing = state.listing {
                ForEach(Array((listing.runtimes ?? []).enumerated()), id: \.offset) { _, runtime in
                    ProductPanel(title: "\(runtime.platform) · \(runtime.runtime)") {
                        VStack(alignment: .leading, spacing: 8) {
                            Text("\(runtime.available ? "adapter/worker 정보 가용" : "준비 필요·미지원") · \(runtime.readiness) · capture \(runtime.capture)")
                            Text("녹화 readiness: \(runtime.recordingReady ? "확인됨" : "실행 lease에서 확인 필요") · 호스트 전역 입력 \(runtime.hostGlobalInput ? "사용 · 실행 차단 필요" : "미사용")")
                            if let reason = runtime.reason { Text(reason) }
                        }
                    }
                }
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 330), spacing: 20)], spacing: 20) {
                    ForEach(listing.instances) { instance in
                        ProductPanel(title: instance.name, subtitle: "\(instance.browserName) · \(instance.isOwnedChrome ? "소유 headless context/profile" : instance.isGuest ? "실제 macOS guest" : "runtime 미확인")") {
                            VStack(alignment: .leading, spacing: 12) {
                                ProductStatusBadge(status: instance.state)
                                Text(instance.label)
                                Text("OS \(instance.osVersion ?? "미확인") · 브라우저 \(instance.browserVersion ?? "실행 lease 이전 미확인")")
                                Text(instance.resourceDescription)
                                Text("등록 \(DisplayDate.text(instance.createdAt))").font(.callout)
                                Text("\(instance.deviceID) · generation \(instance.generation)").font(.caption.monospaced()).textSelection(.enabled)
                                if let machineID = instance.machineId { Text("실제 VM \(machineID)").font(.caption.monospaced()) }
                                if let reason = instance.reason { Text(reason).font(.callout) }
                                if instance.state == "unknown" { ProductNotice("효과·소유권 복구 필요 · 시간 경과나 프로세스 종료만으로 재사용하지 않습니다.", tone: .warning) }
                                HStack {
                                    if instance.canStart { Button(instance.isOwnedChrome ? "Chrome 자원 활성화" : "guest 시작") { perform(.start, instance) }.buttonStyle(ProductButtonStyle()) }
                                    if instance.canPrepare { Button("준비 점검") { perform(.prepare, instance) }.buttonStyle(ProductButtonStyle()) }
                                    Spacer()
                                    Button("자원 상세") { selectedID = instance.id }.buttonStyle(ProductButtonStyle())
                                }.disabled(pending || !current)
                                if instance.hasActiveLease { Text("진행 중 실행은 실행 상세에서 중지·영상·정리를 확인하세요. 자원 전원 끄기를 일반 중지로 사용하지 않습니다.").font(.callout) }
                            }
                        }
                    }
                }
                if listing.instances.isEmpty { ContentUnavailableView("등록된 브라우저 자원 없음", systemImage: "globe", description: Text("환경 책임자가 신뢰된 프로필로 자원을 준비하세요. Safari를 WebKit이나 호스트 Safari로 대체하지 않습니다.")) }
                DisclosureGroup("환경 관리자 · 자원 등록·중지") {
                    VStack(alignment: .leading, spacing: 14) {
                        ProductNotice("이 구분은 업무 책임 안내입니다. 다중 사용자 RBAC나 권한 전환 스위치가 아닙니다.")
                        Button(state.creation == nil ? "신뢰된 프로필로 자원 등록" : "생성 요청 대조") { creating = true }.buttonStyle(ProductButtonStyle()).disabled(pending || !current || listing.profiles.isEmpty || workspace.hasUnresolvedGuestCreation(excluding: state))
                        if let capability = listing.capabilities { Text("실제 guest host 한도: VM \(capability.maximumMachines)개 · 가용 메모리 \(capability.availableMemoryMiB) MiB. 독립 흐름 집행 상한은 별도로 1개입니다.") }
                        else { Text("guest host 자원을 조회하지 않았거나 지원하지 않습니다. Chrome에 VM CPU·RAM·disk를 꾸며 넣지 않습니다.") }
                    }.padding(.top, 12)
                }
            }
            if let creation = state.creation { InstanceCreationReceipt(creation: creation) }
        }
        .task(id: state.identity) {
            while current && !Task.isCancelled { await workspace.refreshGuestInstances(in: state); do { try await Task.sleep(for: .seconds(3)) } catch { break } }
        }
        .confirmationDialog("원 실행의 자원·증거 복구를 확인할까요?", isPresented: $confirmRecovery, titleVisibility: .visible) {
            Button("원 authority로 복구 확인") { Task { await workspace.reconcileExecution(in: state) } }
            Button("취소", role: .cancel) {}
        } message: { Text("테스트나 변경 동작을 다시 보내지 않습니다. 실제 종료·증거·원 fixture·지연 효과가 모두 확인된 예약만 정리하며 원 업무 판정을 유지합니다. 근거가 없으면 재사용 차단을 유지합니다.") }
        .sheet(isPresented: $creating) { RuntimeCreateView(state: state) { creating = false } }
        .sheet(isPresented: Binding(get: { selectedID != nil }, set: { if !$0 { selectedID = nil } })) {
            VStack(alignment: .leading, spacing: 18) {
                HStack { Text("실제 자원 상세").font(.title2); Spacer(); Button("닫기") { selectedID = nil }.buttonStyle(ProductButtonStyle()) }
                if let instance = state.listing?.instances.first(where: { $0.id == selectedID }) {
                    Text(instance.name).font(.headline)
                    Text(instance.resourceDescription)
                    Text("\(instance.deviceID) · runtime \(instance.runtime ?? "미기록") · generation \(instance.generation)").font(.caption.monospaced()).textSelection(.enabled)
                    Text("상태 \(instance.label) · 호스트 전역 입력 \(instance.hostGlobalInput ? "사용" : "미사용")")
                    if instance.isOwnedChrome { ProductNotice("실행 시 새 소유 headless profile/context와 필수 page 영상을 준비합니다. VM·guest 설정 창·개인 Chrome profile을 사용하지 않습니다.") }
                    if let runID = instance.activeRunId { Text("이 자원이 소유한 run \(runID)").font(.caption.monospaced()); Text("실제 단계·영상은 실행 상세의 해당 attempt Space에서 확인하세요.") }
                    if let reason = instance.reason { ProductNotice(reason, tone: .warning) }
                    HStack {
                        if instance.canShow {
                            Button("guest 설정 창 열기") { perform(.show, instance) }.buttonStyle(ProductButtonStyle())
                            Button("guest 창 숨기기") { perform(.hide, instance) }.buttonStyle(ProductButtonStyle())
                        }
                        if instance.hasKnownRuntime && !instance.hasActiveLease && instance.state != "unknown" { Button("자원 중지") { stoppingID = instance.id }.buttonStyle(ProductButtonStyle(kind: .danger)) }
                    }.disabled(pending || !current)
                    if instance.state == "unknown" { ProductNotice("복구 상태 확인은 목록 조회만 수행합니다. 강제 종료를 외부 효과 rollback·원 unknown 해소로 표시하지 않습니다. 환경 책임자가 원래 journal·native 소유권·데이터 효과를 대조해야 합니다.", tone: .warning) }
                } else { ProductNotice("현재 연결에서 이 자원을 확인할 수 없습니다.", tone: .warning) }
            }.padding(28).frame(minWidth: 700, minHeight: 500)
            .confirmationDialog("이 유휴 소유 자원을 중지할까요?", isPresented: Binding(get: { stoppingID != nil }, set: { if !$0 { stoppingID = nil } }), titleVisibility: .visible) {
                if let instance = state.listing?.instances.first(where: { $0.id == stoppingID }) { Button("중지 후 정리", role: .destructive) { perform(.stop, instance); stoppingID = nil } }
                Button("취소", role: .cancel) { stoppingID = nil }
            } message: { Text("중지 응답은 원래 실행의 업무 판정이나 외부 효과를 변경하지 않습니다.") }
        }
    }
    private func perform(_ action: GuestInstanceAction, _ instance: GuestBrowserInstance) { Task { await workspace.performGuestInstance(action, instance: instance, in: state) } }
}

private struct InstanceCreationReceipt: View {
    let creation: GuestInstanceCreation
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(creation.phase == .pending ? "등록 응답 대기 중" : creation.phase == .unknown ? "등록 결과 미확인 · 재전송 금지" : creation.phase == .notStarted ? "변경 시작 전 거부됨" : "등록 응답 확인 · 실행 준비 별도").font(.headline)
            Text("\(creation.profileName) · \(creation.name)\n요청 \(creation.requestID)").font(.caption.monospaced()).textSelection(.enabled)
            if let resources = creation.resources { Text("요청 guest CPU \(resources.cpuCount) · 메모리 \(resources.memoryMiB) MiB · 디스크 \(resources.diskGiB) GiB") }
            else { Text("owned-chrome · VM 자원 요청 없음") }
            if let error = creation.error { ProductNotice(error, tone: .warning) }
            Text(creation.reconciliation)
            if let instance = creation.matched { Text("대조 기록: \(instance.label) · \(instance.resourceDescription)") }
        }
    }
}

private struct RuntimeCreateView: View {
    @Bindable var state: GuestInstanceUIState
    let onCreated: () -> Void
    @Environment(Workspace.self) private var workspace
    @Environment(\.dismiss) private var dismiss
    private var profile: GuestInstanceProfile? { state.listing?.profiles.first { $0.id == state.profileID } }
    private var current: Bool { state.identity == ProductReadIdentity(api: workspace.api) }
    private var canCreate: Bool {
        current && state.creation == nil && state.pendingAction == nil && !workspace.hasUnresolvedGuestCreation(excluding: state)
            && profile != nil && !state.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && state.name.utf16.count <= 80
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            ProductPageHeading(title: "실행 자원 등록", subtitle: "Chrome metadata 등록과 실제 guest 설치를 구분합니다.")
            Picker("신뢰된 환경 프로필", selection: $state.profileID) { Text("선택하세요").tag(""); ForEach(state.listing?.profiles ?? []) { Text("\($0.name) · \($0.usesOwnedChrome ? "owned Chrome" : "실제 macOS guest")").tag($0.id) } }.disabled(state.creation != nil)
            TextField("자원 이름 · 80자 이하", text: $state.name).textFieldStyle(.roundedBorder).disabled(state.creation != nil)
            if profile?.usesOwnedChrome == true { ProductNotice("VM CPU·RAM·disk를 요청하지 않습니다. 새 headless profile·실제 Chrome 버전·영상 준비는 실행 lease에서 점검합니다.") }
            else if profile != nil {
                Stepper("guest CPU \(state.cpu)", value: $state.cpu, in: 2...16).disabled(state.creation != nil)
                Stepper("guest 메모리 \(state.memory) MiB", value: $state.memory, in: 4096...65536, step: 1024).disabled(state.creation != nil)
                ProductNotice("실제 macOS guest는 Apple OS 이미지·라이선스·최초 계정·Safari 자동화 준비가 필요합니다. 등록만으로 준비됨이나 실행 PASS가 되지 않습니다.", tone: .warning)
            }
            if let creation = state.creation {
                InstanceCreationReceipt(creation: creation)
                Button("같은 UUID 읽기 전용 대조") { Task { await workspace.refreshGuestInstances(in: state) } }.buttonStyle(ProductButtonStyle())
                if creation.phase == .notStarted { Button("거부된 요청과 구분하여 새 요청 작성") { state.creation = nil }.buttonStyle(ProductButtonStyle()) }
            }
            HStack {
                Button("닫기") { dismiss() }.buttonStyle(ProductButtonStyle()).disabled(state.creation?.phase == .pending)
                Spacer()
                Button("등록") { Task { if let profile, await workspace.createGuestInstance(in: state, profile: profile) != nil { onCreated() } } }.buttonStyle(ProductButtonStyle(kind: .primary)).disabled(!canCreate)
            }
        }.padding(28).frame(minWidth: 680, minHeight: 560)
        .interactiveDismissDisabled(state.creation?.phase == .pending)
        .onAppear { if !state.draftInitialized { state.draftInitialized = true; state.profileID = state.listing?.profiles.first?.id ?? ""; state.name = state.listing?.profiles.first?.name ?? "" } }
    }
}

struct GuestSetupGuideView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var text: String?
    @State private var error: String?
    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack {
                ProductPageHeading(title: "실제 macOS guest 준비 안내", subtitle: "Safari 준비 담당자를 위한 안내 · 사용자 호스트 설정과 구분")
                Spacer()
                Button("닫기") { dismiss() }.buttonStyle(ProductButtonStyle())
            }
            ProductNotice("Apple 라이선스·로컬 계정·Safari 원격 자동화와 guest agent는 소유한 guest 안에서 준비합니다. Chrome headless 자원에는 이 VM 설치 절차를 적용하지 않습니다.")
            ScrollView {
                if let text { Text(text).font(.callout.monospaced()).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }
                if let error { ProductNotice(error, tone: .warning) }
            }
        }.padding(28).frame(minWidth: 760, minHeight: 620)
        .task {
            guard let base = Bundle.main.resourceURL else { error = "앱 리소스 경로를 찾지 못했습니다. 환경 책임자가 설치 묶음을 확인해야 합니다."; return }
            do { text = try String(contentsOf: base.appendingPathComponent("GuestRuntime/GuestSetup.txt"), encoding: .utf8) }
            catch { self.error = "이 설치 묶음에서 실제 GuestSetup.txt를 읽지 못했습니다: \(error.localizedDescription). guest 준비 완료로 표시하지 않습니다." }
        }
    }
}
