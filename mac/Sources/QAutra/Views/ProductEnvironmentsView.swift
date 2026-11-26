import SwiftUI

struct ProductEnvironmentsView: View {
    @Environment(Workspace.self) private var workspace
    @Environment(ProductCatalog.self) private var catalog
    @State private var filter = "all"
    @State private var adding = false
    @State private var selected: EnvironmentCatalogCard?
    @State private var showingSessions = false

    private var devices: [DeviceInfo] {
        workspace.api != nil && workspace.devicesError == nil ? workspace.devices.filter { !$0.platform.hasPrefix("desktop-") } : []
    }
    private var cards: [EnvironmentCatalogCard] {
        var rows = devices.map { EnvironmentCatalogCard(id: "device:\($0.platform):\($0.id)", name: $0.name,
            platform: $0.platform, deviceID: $0.id, registered: false, createdAt: nil) }
        rows += (catalog.snapshot?.environments ?? []).map {
            EnvironmentCatalogCard(id: "template:\($0.id)", name: $0.name, platform: $0.platform,
                deviceID: $0.deviceID, registered: true, createdAt: $0.createdAt)
        }
        return rows.filter { filter == "all" || (filter == "web" ? $0.platform.hasPrefix("desktop-") : $0.platform == filter) }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                HStack {
                    ProductPageHeading(title: "환경 및 기기", subtitle: "프로필과 인스턴스를 구분하고, 필요한 만큼만 사용해요.")
                    Spacer()
                    Button("새로고침", systemImage: "arrow.clockwise") { Task { await refresh() } }
                        .buttonStyle(ProductButtonStyle())
                    Button("프로필 추가", systemImage: "plus") { adding = true }
                        .buttonStyle(ProductButtonStyle(kind: .primary))
                        .disabled(workspace.api == nil || catalog.snapshot == nil || catalog.mutationPending)
                }
                if catalog.loading { ProgressView("환경 불러오는 중") }
                if let error = catalog.error { ProductNotice(error, tone: .error) }
                if let message = catalog.mutationMessage { ProductNotice(message) }
                if let error = workspace.devicesError { ProductNotice("기기 조회 실패: \(error)", tone: .error) }
                if let error = workspace.directError { ProductNotice("현재 세션 소유권 미확인: \(error)", tone: .warning) }
                if workspace.api == nil {
                    ProductNotice("엔진 연결이 필요합니다. 이전 기기를 현재 가용 자원으로 표시하지 않습니다.", tone: .warning)
                }
                HStack(spacing: 24) {
                    filterButton("전체 프로필", value: "all")
                    filterButton("웹 브라우저", value: "web")
                    filterButton("Android", value: "android")
                    filterButton("iOS", value: "ios")
                    Spacer()
                }.overlay(alignment: .bottom) { Rectangle().fill(ProductDesign.line).frame(height: 1) }
                if filter == "all" || filter == "web" { GuestInstancesView() }
                Text("프로필 및 모바일 기기").font(ProductDesign.bodyFont(18).weight(.semibold))
                if cards.isEmpty {
                    ProductPanel {
                        ContentUnavailableView("표시할 환경 없음", systemImage: "desktopcomputer",
                            description: Text("기기를 새로 조회하거나 준비 전 템플릿을 등록하세요. 프로필 등록만으로 기기·VM이 생성되지는 않습니다."))
                    }
                } else {
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 285), spacing: 24)], spacing: 24) {
                        ForEach(cards) { card in
                            EnvironmentCatalogCardView(card: card) { selected = card }
                        }
                    }
                }
                ProductPanel(title: "실제 집행 정책", subtitle: "설정 선호·등록 자원 수와 실제 실행 점유량은 다릅니다.") {
                    VStack(alignment: .leading, spacing: 14) {
                        Text("로컬 사용자 전체 독립 흐름 1개 · 순차 실행").font(.headline)
                        Text("준비부터 필수 영상 확정·정리까지 점유합니다. 더 높은 동시 상한은 현재 지원하지 않아 편집할 수 없습니다.")
                        if let settings = catalog.snapshot?.settings {
                            Text("이전 저장 선호(미집행): Web \(settings.webLimit), Android \(settings.androidLimit), iOS \(settings.iosLimit), 전체 \(settings.totalLimit)")
                                .foregroundStyle(ProductDesign.muted)
                        }
                        DisclosureGroup("고급 직접 세션 관리 · 일반 회귀 실행과 별도") {
                            Button("직접 세션 조회") { showingSessions = true }.buttonStyle(ProductButtonStyle()).disabled(workspace.api == nil)
                            Text("실제 Safari는 준비된 guest에서만, Chrome은 소유 headless context/profile에서 실행합니다. 개인 host 입력 경로로 대체하지 않습니다.")
                        }
                    }.frame(maxWidth: .infinity, alignment: .leading)
                }
            }.padding(.horizontal, 40).padding(.vertical, 32)
        }.background(ProductDesign.background)
        .foregroundStyle(ProductDesign.ink)
        .task(id: ProductReadIdentity(api: workspace.api)) { await refresh() }
        .sheet(isPresented: $adding) { EnvironmentCatalogAddForm() }
        .sheet(item: $selected) { EnvironmentCatalogDetail(card: $0) }
        .sheet(isPresented: $showingSessions) {
            VStack(spacing: 0) {
                HStack { Spacer(); Button("닫기") { showingSessions = false }.buttonStyle(ProductButtonStyle()) }.padding(16)
                DirectSessionsView()
            }.frame(width: 860, height: 720)
            .background(ProductDesign.background)
            .foregroundStyle(ProductDesign.ink)
        }
    }

    private func filterButton(_ title: String, value: String) -> some View {
        Button { filter = value } label: {
            Text(title).font(ProductDesign.bodyFont(13).weight(filter == value ? .semibold : .regular))
                .foregroundStyle(filter == value ? ProductDesign.blue : ProductDesign.muted)
                .frame(height: 21.445)
                .padding(.vertical, 12)
                .padding(.bottom, 2)
                .overlay(alignment: .bottom) {
                    Rectangle().fill(filter == value ? ProductDesign.blue : .clear).frame(height: 2)
                }
        }.buttonStyle(.plain).accessibilityAddTraits(filter == value ? .isSelected : [])
    }
    private func refresh() async {
        await catalog.refresh(api: workspace.api)
        guard workspace.api != nil else { return }
        await workspace.loadDevices()
        workspace.refreshDirectSessions()
    }
}

private struct EnvironmentCatalogCard: Identifiable {
    let id: String
    let name: String
    let platform: String
    let deviceID: String?
    let registered: Bool
    let createdAt: String?
}

private struct EnvironmentCatalogCardView: View {
    let card: EnvironmentCatalogCard
    let onDetail: () -> Void
    @Environment(Workspace.self) private var workspace

    private var device: DeviceInfo? {
        guard workspace.api != nil, workspace.devicesError == nil else { return nil }
        return workspace.devices.first { $0.id == card.deviceID && $0.platform == card.platform }
    }
    private var sessions: [AgentSessionView] {
        guard workspace.api != nil, workspace.directUpdatedAt != nil, workspace.directError == nil else { return [] }
        return workspace.directSessions.filter { $0.platform == card.platform && $0.deviceId == card.deviceID && $0.state != "closed" }
    }
    private var status: String {
        if workspace.api == nil { return "연결 없음" }
        if card.deviceID == nil { return "준비 필요 · 미연결" }
        if workspace.devicesError != nil { return "기기 상태 미확인" }
        if device == nil { return "준비 필요 · 미발견" }
        if workspace.directError != nil || workspace.directUpdatedAt == nil { return "소유권 미확인" }
        if !sessions.isEmpty { return "직접 세션 소유" }
        return "발견됨 · 실행 준비 미확인"
    }

    var body: some View {
        ProductPanel {
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 12) {
                    Image(systemName: card.platform.hasPrefix("desktop-") ? "globe" : "iphone")
                        .font(.system(size: 27)).foregroundStyle(ProductDesign.muted)
                        .frame(width: 48, height: 48)
                        .background(ProductDesign.sidebar)
                        .clipShape(RoundedRectangle(cornerRadius: ProductDesign.controlRadius))
                    Spacer()
                    Text(status).font(ProductDesign.bodyFont(11)).foregroundStyle(ProductDesign.muted)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(minHeight: 18.7, alignment: .leading)
                }
                VStack(alignment: .leading, spacing: 0) {
                    Text(card.name).font(ProductDesign.bodyFont(16).weight(.semibold))
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(minHeight: 26.4, alignment: .leading)
                    Text(card.platform).font(ProductDesign.bodyFont(13)).foregroundStyle(ProductDesign.muted)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(minHeight: 23.4, alignment: .leading)
                }
                Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 16) {
                    GridRow { field("출처", card.registered ? "등록 템플릿" : "엔진 기기 발견"); field("실행 종류", device?.kind ?? "미확인") }
                    GridRow { field("OS (발견 정보)", device?.osVersion ?? "미확인"); field("기기 상태", device?.state ?? "미확인") }
                    GridRow { field("Worker", sessions.first?.workerId ?? "미확인"); field("직접 세션", "\(sessions.count)개 관측") }
                }.padding(.vertical, 24)
                Text(card.deviceID ?? "실제 기기 미연결")
                    .font(ProductDesign.bodyFont(12).monospaced()).foregroundStyle(ProductDesign.muted)
                    .lineLimit(2).frame(minHeight: 19.8, alignment: .leading)
                    .padding(.bottom, 16)
                HStack(spacing: 12) {
                    Text("브라우저·입력 준비는 별도 검사")
                        .font(ProductDesign.bodyFont(10)).foregroundStyle(ProductDesign.muted)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(minHeight: 16.5, alignment: .leading)
                    Spacer()
                    Button("상세", action: onDetail).buttonStyle(ProductButtonStyle(size: .small))
                }
            }.frame(maxWidth: .infinity, alignment: .topLeading)
        }
    }
    private func field(_ title: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(ProductDesign.bodyFont(10)).foregroundStyle(ProductDesign.muted)
                .fixedSize(horizontal: false, vertical: true)
                .frame(minHeight: 16.5, alignment: .leading)
            Text(value).font(ProductDesign.bodyFont(12)).textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
                .frame(minHeight: 19.8, alignment: .leading)
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct EnvironmentCatalogAddForm: View {
    @Environment(Workspace.self) private var workspace
    @Environment(ProductCatalog.self) private var catalog
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var platform = "android"
    @State private var deviceID = ""

    private var devices: [DeviceInfo] {
        guard workspace.api != nil, workspace.devicesError == nil else { return [] }
        return workspace.devices.filter { $0.platform == platform }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            ProductPageHeading(title: "환경 프로필 추가", subtitle: "영속 템플릿 등록이며 기기·VM 생성이나 부팅이 아닙니다.")
            Form {
                TextField("프로필 이름", text: $name)
                Picker("플랫폼", selection: $platform) {
                    ForEach(PlatformChoice.platformIds, id: \.self) { Text($0).tag($0) }
                }
                Picker("실제 기기 연결", selection: $deviceID) {
                    Text("미연결 · 준비 필요 템플릿").tag("")
                    ForEach(devices) { Text("\($0.name) · \($0.id) · \($0.state)").tag($0.id) }
                }
            }.formStyle(.grouped)
            ProductNotice(deviceID.isEmpty
                ? "연결 기기가 없어 준비 필요로 저장합니다. 부팅된 인스턴스나 사용 가능한 Worker로 표시하지 않습니다."
                : "발견된 기기 ID에 템플릿을 연결합니다. 실행 준비·소유권·격리 보장은 실제 세션과 엔진 검사에서 확인해야 합니다.")
            if let error = workspace.devicesError { ProductNotice(error, tone: .error) }
            if let message = catalog.mutationMessage { ProductNotice(message, tone: .warning) }
            if let error = catalog.error { ProductNotice(error, tone: .error) }
            if catalog.needsReconciliation {
                Button("반영 여부 조회") { Task { await catalog.refresh(api: workspace.api) } }
                    .buttonStyle(ProductButtonStyle()).disabled(catalog.mutationPending)
            }
            HStack {
                Button("기기 새로고침") { Task { await workspace.loadDevices() } }.buttonStyle(ProductButtonStyle())
                Spacer()
                Button("취소") { dismiss() }.buttonStyle(ProductButtonStyle())
                Button("프로필 저장") {
                    Task {
                        if await catalog.addEnvironment(api: workspace.api,
                            name: name.trimmingCharacters(in: .whitespacesAndNewlines), platform: platform,
                            deviceID: deviceID.isEmpty ? nil : deviceID) { dismiss() }
                    }
                }.buttonStyle(ProductButtonStyle(kind: .primary))
                    .disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || catalog.mutationPending
                        || catalog.needsReconciliation || workspace.api == nil || (!deviceID.isEmpty && !devices.contains { $0.id == deviceID }))
            }
        }.padding(28).frame(width: 640, height: 460)
        .background(ProductDesign.background)
        .foregroundStyle(ProductDesign.ink)
        .interactiveDismissDisabled(catalog.mutationPending)
        .onChange(of: platform) { _, _ in deviceID = "" }
        .task { await workspace.loadDevices() }
    }
}

private struct EnvironmentCatalogDetail: View {
    let card: EnvironmentCatalogCard
    @Environment(Workspace.self) private var workspace
    @Environment(\.dismiss) private var dismiss
    @State private var selectedDeviceID = ""
    @State private var showingSessions = false
    @State private var message: String?

    private var devices: [DeviceInfo] {
        guard workspace.api != nil, workspace.devicesError == nil else { return [] }
        return workspace.devices.filter { $0.platform == card.platform }
    }
    private var selectedDevice: DeviceInfo? { devices.first { $0.id == selectedDeviceID } }
    private var sessions: [AgentSessionView] {
        guard workspace.api != nil, workspace.directUpdatedAt != nil, workspace.directError == nil else { return [] }
        return workspace.directSessions.filter { $0.platform == card.platform && $0.deviceId == selectedDeviceID }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack {
                ProductPageHeading(title: card.name, subtitle: card.registered ? "등록된 템플릿 · \(card.platform)" : "실제 발견 기기 · \(card.platform)")
                Spacer()
                Button("닫기") { dismiss() }.buttonStyle(ProductButtonStyle())
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if let createdAt = card.createdAt { Text("등록 \(DisplayDate.text(createdAt))").font(.caption) }
                    Text("템플릿 연결 ID: \(card.deviceID ?? "미연결 · 준비 필요")").font(.caption.monospaced()).textSelection(.enabled)
                    Picker("조회할 실제 기기", selection: $selectedDeviceID) {
                        Text("기기 선택").tag("")
                        ForEach(devices) { Text("\($0.name) · \($0.id)").tag($0.id) }
                    }
                    if let selectedDevice {
                        ProductPanel(title: "발견 정보") {
                            VStack(alignment: .leading, spacing: 8) {
                                Text("기기 ID: \(selectedDevice.id)").textSelection(.enabled)
                                Text("OS: \(selectedDevice.osVersion) · 종류: \(selectedDevice.kind)")
                                Text("발견 상태: \(selectedDevice.state)")
                                Text("브라우저 버전·viewport·VM 부팅·격리 여부는 이 응답에서 제공하지 않습니다.")
                                    .font(.caption).foregroundStyle(ProductDesign.muted)
                            }.frame(maxWidth: .infinity, alignment: .leading)
                        }
                        Button("콘솔의 실행 기기로 선택") {
                            workspace.selectedDevice[card.platform] = selectedDevice.id
                            message = "\(card.platform)의 콘솔 실행 기기를 \(selectedDevice.id)로 선택했습니다. 템플릿 연결 변경이나 새 세션 생성은 수행하지 않았습니다."
                        }.buttonStyle(ProductButtonStyle())
                    }
                    if let error = workspace.devicesError { ProductNotice(error, tone: .error) }
                    if let error = workspace.directError { ProductNotice(error, tone: .warning) }
                    if let message { ProductNotice(message) }
                    ProductPanel(title: "실제 직접 세션 소유권", subtitle: "자동 갱신이 아닙니다. 마지막 조회 상태이며 입력 가능 보장은 아닙니다.") {
                        VStack(alignment: .leading, spacing: 12) {
                            if let updatedAt = workspace.directUpdatedAt {
                                Text("조회 \(DisplayDate.text(updatedAt))").font(.caption)
                            }
                            if sessions.isEmpty {
                                Text(workspace.directUpdatedAt == nil || workspace.directError != nil
                                    ? "현재 소유권을 확인하지 못했습니다."
                                    : "선택 기기에 대응하는 직접 세션이 없습니다. 다른 프로세스의 잠금 없음이나 준비 완료를 뜻하지 않습니다.")
                            }
                            ForEach(sessions) { session in
                                VStack(alignment: .leading, spacing: 6) {
                                    Text("\(session.sessionId) · \(session.state)").font(.caption.monospaced()).textSelection(.enabled)
                                    Text("worker \(session.workerId) · instance \(session.instanceId)").font(.caption.monospaced()).textSelection(.enabled)
                                    Text("실행 \(session.runId) · revision \(session.revision)").font(.caption)
                                    Text("스크립트 소유: \(session.activeScriptId ?? "없음 (응답 기준)")").font(.caption)
                                    Text("격리 응답: \(session.capabilities.isolation) · 입력 종류: \(session.capabilities.mutationKinds.joined(separator: ", "))")
                                        .font(.caption).textSelection(.enabled)
                                    Text("semantic \(session.capabilities.semantic ? "지원" : "미지원") · 좌표 \(session.capabilities.coordinates ? "지원" : "미지원") · host 입력 \(session.capabilities.hostGlobalInput ? "사용" : "미사용")")
                                        .font(.caption)
                                    Button("이 세션 관리") {
                                        workspace.selectDirectSession(session.sessionId)
                                        showingSessions = true
                                    }.buttonStyle(ProductButtonStyle()).disabled(workspace.directOperation != nil)
                                }
                                Divider()
                            }
                        }.frame(maxWidth: .infinity, alignment: .leading)
                    }
                    HStack {
                        Button("기기·소유권 새로고침") {
                            Task { await workspace.loadDevices(); workspace.refreshDirectSessions() }
                        }.buttonStyle(ProductButtonStyle()).disabled(workspace.api == nil)
                        Button("직접 세션 관리") { showingSessions = true }.buttonStyle(ProductButtonStyle())
                            .disabled(workspace.api == nil)
                    }
                    ProductNotice("실제 중지·닫기는 기존 관리 화면에서 최신 상태를 확인한 뒤 요청합니다. 사용 중인 스크립트가 있거나 결과가 불확실하면 자동 재시도·자원 재사용을 하지 않습니다.")
                }
            }
        }.padding(28).frame(width: 780, height: 720)
        .background(ProductDesign.background)
        .foregroundStyle(ProductDesign.ink)
        .onAppear { selectedDeviceID = card.deviceID ?? "" }
        .sheet(isPresented: $showingSessions) {
            VStack(spacing: 0) {
                HStack { Spacer(); Button("닫기") { showingSessions = false }.buttonStyle(ProductButtonStyle()) }.padding(16)
                DirectSessionsView()
            }.frame(width: 860, height: 720)
            .background(ProductDesign.background)
            .foregroundStyle(ProductDesign.ink)
        }
    }
}

