import AppKit
import SwiftUI

private enum ProductShellSection: String, CaseIterable, Identifiable {
    case runs, scenarios, requirements, environments, reports, evidence, connections

    var id: String { rawValue }

    var title: String {
        switch self {
        case .runs: "실행 현황"
        case .scenarios: "시나리오"
        case .requirements: "요구사항 추적"
        case .environments: "환경 및 기기"
        case .reports: "리포트"
        case .evidence: "증거 보관함"
        case .connections: "설정 및 연결"
        }
    }

    var symbol: String {
        switch self {
        case .runs: "waveform.path.ecg"
        case .scenarios: "list.bullet.rectangle"
        case .requirements: "point.3.connected.trianglepath.dotted"
        case .environments: "desktopcomputer"
        case .reports: "chart.bar"
        case .evidence: "folder"
        case .connections: "gearshape"
        }
    }
}

private enum ProductShellRoute {
    case section(ProductShellSection)
    case detail(RunListItem)
    case regression(String)
    case console
}

private enum ProductShellDialog: String, Identifiable {
    case search, notifications, newRun
    var id: String { rawValue }
}

struct ProductShellView: View {
    private static let navigationSections = ProductShellSection.allCases.filter { $0 != .connections }

    @Environment(Workspace.self) private var workspace
    @Environment(ProductCatalog.self) private var catalog
    @State private var section: ProductShellSection = .runs
    @State private var route: ProductShellRoute = .section(.runs)
    @State private var consoleReturn: RunListItem?
    @State private var dialog: ProductShellDialog?
    @State private var query = ""
    @FocusState private var searchFocused: Bool

    var body: some View {
        GeometryReader { geometry in
            HStack(spacing: 0) {
                sidebar
                    .frame(width: (geometry.size.width <= 1100 ? 196 : 228) - 1, height: geometry.size.height)
                Rectangle().fill(ProductDesign.line).frame(width: 1)
                VStack(spacing: 0) {
                    topbar
                    VStack(alignment: .leading, spacing: 16) {
                        if let banner = workspace.banner {
                            HStack(alignment: .top, spacing: 8) {
                                ProductNotice(banner, tone: .error)
                                Button {
                                    workspace.banner = nil
                                } label: {
                                    Image(systemName: "xmark")
                                }
                                .buttonStyle(ProductButtonStyle(kind: .ghost))
                                .accessibilityLabel("오류 알림 닫기")
                            }
                        }
                        routedContent
                            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                    .background(ProductDesign.background)
                }
            }
            .frame(width: geometry.size.width, height: geometry.size.height, alignment: .topLeading)
        }
        .font(ProductDesign.bodyFont())
        .foregroundStyle(ProductDesign.ink)
        .background(ProductDesign.background)
        .ignoresSafeArea(.container, edges: .top)
        .preferredColorScheme(.light)
        .navigationTitle("QAutra")
        .sheet(item: $dialog) { selected in
            switch selected {
            case .search: searchDialog
            case .notifications: notificationsDialog
            case .newRun:
                ProductNewRunView {
                    dialog = nil
                }
                .environment(workspace)
                .environment(catalog)
            }
        }
        .task(id: connectionIdentity) {
            await catalog.refresh(api: workspace.api)
            workspace.regression.bind(workspace.api)
            await workspace.regression.refresh(api: workspace.api)
        }
        .onChange(of: workspace.regression.requestedID) { _, value in
            if let value {
                section = .runs
                route = .regression(value)
                workspace.regression.requestedID = nil
            }
        }
        .onChange(of: workspace.requestedRunID, initial: true) { _, id in
            guard id != nil else { return }
            resolveRequestedRun()
            Task { await workspace.loadRuns() }
        }
        .onChange(of: workspace.runs) { _, _ in
            resolveRequestedRun()
        }
        .onChange(of: workspace.requestedReplayConsoleID, initial: true) { _, id in
            guard let id, let replay = workspace.replay, replay.run.runId == id else { return }
            workspace.requestedRunID = nil
            section = .runs
            consoleReturn = replay.run
            route = .console
            workspace.requestedReplayConsoleID = nil
        }
    }

    private var connectionIdentity: ObjectIdentifier? {
        workspace.api.map { ObjectIdentifier($0.session) }
    }

    private var sidebar: some View {
        VStack(alignment: .leading, spacing: 0) {
            Color.clear
                .frame(height: 52)
                .accessibilityHidden(true)
            HStack(spacing: 12) {
                Image(nsImage: NSWorkspace.shared.icon(forFile: Bundle.main.bundlePath))
                    .resizable()
                    .frame(width: 40, height: 40)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 4) {
                    Text("QAutra")
                        .font(ProductDesign.displayFont(23).weight(.bold))
                        .tracking(-1.15)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(height: 27.6, alignment: .leading)
                    Text("QA AUTOMATION WORKSPACE")
                        .font(ProductDesign.bodyFont(9))
                        .tracking(0.54)
                        .foregroundStyle(ProductDesign.muted)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(minHeight: 29.7, alignment: .topLeading)
                }
            }
            .padding(.horizontal, 24)
            .padding(.top, 12)
            .padding(.bottom, 24)

            HStack(spacing: 12) {
                Image(systemName: "square.3.layers.3d")
                    .font(.system(size: 22))
                    .frame(width: 22, height: 22)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 0) {
                    profilePicker
                    Text("프로젝트 / 앱")
                        .font(ProductDesign.bodyFont(10))
                        .frame(minHeight: 16.5, alignment: .leading)
                        .foregroundStyle(ProductDesign.muted)
                }
            }
            .padding(13)
            .frame(maxWidth: .infinity, minHeight: 63.95, alignment: .leading)
            .background(ProductDesign.background)
            .clipShape(RoundedRectangle(cornerRadius: ProductDesign.controlRadius))
            .overlay {
                RoundedRectangle(cornerRadius: ProductDesign.controlRadius)
                    .strokeBorder(ProductDesign.line, lineWidth: 1)
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 24)

            Text("WORKSPACE")
                .font(ProductDesign.bodyFont(10).weight(.semibold))
                .foregroundStyle(ProductDesign.muted)
                .frame(minHeight: 16.5, alignment: .leading)
                .padding(.horizontal, 28)
                .padding(.vertical, 12)

            ViewThatFits(in: .vertical) {
                navigationItems
                ScrollView(.vertical) {
                    navigationItems
                }
                .scrollIndicators(.visible, axes: .vertical)
            }
            .padding(.horizontal, 16)

            Spacer(minLength: 24)

            navigationButton(.connections)
                .padding(.horizontal, 16)
                .padding(.top, 32)
                .padding(.bottom, 16)

            VStack(alignment: .leading, spacing: 10) {
                Text(workspace.api == nil ? "엔진 연결 안 됨" : (workspace.streamLive ? "엔진 이벤트 연결됨" : "이벤트 연결 확인 중"))
                    .font(ProductDesign.bodyFont(11))
                    .foregroundStyle(ProductDesign.muted)
                Text("실제 집행 · 전체 독립 흐름 1개 순차")
                    .font(ProductDesign.bodyFont(11))
                    .foregroundStyle(ProductDesign.muted)
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(ProductDesign.background)
            .clipShape(RoundedRectangle(cornerRadius: ProductDesign.controlRadius))
            .overlay {
                RoundedRectangle(cornerRadius: ProductDesign.controlRadius)
                    .strokeBorder(ProductDesign.line, lineWidth: 1)
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 16)
        }
        .frame(maxWidth: .infinity)
        .background(ProductDesign.sidebar)
    }

    private var navigationItems: some View {
        VStack(spacing: 4) {
            ForEach(Self.navigationSections) { item in
                navigationButton(item)
            }
        }
    }

    private var profilePicker: some View {
        @Bindable var workspace = workspace
        return Group {
            if workspace.profiles.isEmpty {
                Text("앱 프로필 없음")
            } else {
                Picker("프로젝트 / 앱", selection: $workspace.selectedApp) {
                    Text("앱 선택").tag(nil as String?)
                    ForEach(workspace.profiles) { profile in
                        Text(profile.name).tag(Optional(profile.id))
                    }
                }
            }
        }
        .labelsHidden()
        .pickerStyle(.menu)
        .controlSize(.small)
        .font(ProductDesign.bodyFont(13))
        .frame(maxWidth: .infinity)
        .frame(height: 21.45)
        .disabled(workspace.profiles.isEmpty)
        .accessibilityLabel("프로젝트 또는 앱 선택")
    }

    private func navigationButton(_ item: ProductShellSection) -> some View {
        Button {
            select(item)
        } label: {
            HStack(spacing: 12) {
                Image(systemName: item.symbol)
                    .frame(width: 20)
                    .accessibilityHidden(true)
                Text(item.title)
                Spacer(minLength: 0)
                if item == .runs, workspace.api != nil {
                    let count = workspace.regression.runs.filter { !$0.terminal }.count
                    if count > 0 {
                        Text("\(count)")
                            .font(ProductDesign.bodyFont(11).weight(.semibold))
                            .padding(.horizontal, 7)
                            .padding(.vertical, 3)
                            .background(ProductDesign.background, in: Capsule())
                            .accessibilityLabel("활성 작업 \(count)개")
                    }
                }
            }
            .font(ProductDesign.bodyFont(13).weight(section == item ? .semibold : .regular))
            .foregroundStyle(section == item ? ProductDesign.blue : ProductDesign.muted)
            .frame(minHeight: 21.45)
            .padding(.horizontal, 12)
            .padding(.vertical, 12)
            .background(section == item ? ProductDesign.blueSoft : Color.clear)
            .clipShape(RoundedRectangle(cornerRadius: 8))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(section == item ? [.isSelected] : [])
    }

    private var topbar: some View {
        HStack(spacing: 16) {
            if showsBack {
                Button(action: goBack) {
                    Image(systemName: "chevron.left")
                }
                .buttonStyle(ProductButtonStyle(kind: .ghost))
                .accessibilityLabel("뒤로")
            }
            if let project = workspace.selectedProfile?.name {
                Text(project)
                    .font(ProductDesign.bodyFont(13))
                    .foregroundStyle(ProductDesign.muted)
                    .lineLimit(1)
                Text("/")
                    .font(ProductDesign.bodyFont(13))
                    .foregroundStyle(ProductDesign.muted)
                    .accessibilityHidden(true)
            }
            Text(routeTitle)
                .font(ProductDesign.bodyFont(13).weight(.semibold))
            Spacer()
            Button {
                query = ""
                dialog = .search
            } label: {
                Image(systemName: "magnifyingglass")
            }
            .buttonStyle(ProductButtonStyle(kind: .ghost))
            .accessibilityLabel("실행 검색")
            .keyboardShortcut("f", modifiers: .command)
            Button {
                dialog = .notifications
            } label: {
                Image(systemName: "bell")
            }
            .buttonStyle(ProductButtonStyle(kind: .ghost))
            .accessibilityLabel("작업 및 오류 알림")
        }
        .padding(.horizontal, 32)
        .frame(height: ProductDesign.topbarHeight)
        .background(ProductDesign.background)
        .overlay(alignment: .bottom) {
            Rectangle().fill(ProductDesign.line).frame(height: 1)
        }
    }

    @ViewBuilder private var routedContent: some View {
        switch route {
        case .section(let destination):
            switch destination {
            case .runs:
                ProductRunsView(onNewRun: { dialog = .newRun }, onOpenRun: openRun, onOpenRegression: { route = .regression($0) })
            case .scenarios: ProductScenariosView()
            case .requirements: ProductRequirementsView()
            case .environments: ProductEnvironmentsView()
            case .reports: ProductReportsView(onOpenRun: openRun, onOpenRegression: { route = .regression($0) })
            case .evidence: ProductEvidenceLibraryView(onOpenRun: openRun)
            case .connections: ProductConnectionsView()
            }
        case .detail(let run):
            ProductRunDetailView(run: run)
                .id(ProductReadIdentity(api: workspace.api, runID: run.id))
        case .regression(let requestID):
            RegressionRunDetailView(requestID: requestID, onClose: goBack)
                .id(ProductReadIdentity(api: workspace.api, runID: requestID))
        case .console:
            WorkspaceView()
        }
    }

    private var routeTitle: String {
        switch route {
        case .section(let destination): destination.title
        case .detail(let run): "실행 상세 · \(DisplayDate.text(run.startedAt))"
        case .regression: "실행 상세 · attempt·검증·영상"
        case .console: workspace.replay == nil ? "실행 콘솔" : "읽기 전용 리플레이"
        }
    }

    private var showsBack: Bool {
        switch route {
        case .section: false
        case .detail, .regression, .console: true
        }
    }

    private func select(_ destination: ProductShellSection) {
        workspace.replay = nil
        workspace.testFilter = nil
        workspace.requestedRunID = nil
        consoleReturn = nil
        section = destination
        route = .section(destination)
    }

    private func openRun(_ run: RunListItem) {
        workspace.replay = nil
        workspace.testFilter = nil
        workspace.requestedRunID = nil
        consoleReturn = nil
        route = .detail(run)
    }


    private func goBack() {
        workspace.replay = nil
        workspace.testFilter = nil
        if case .console = route, let run = consoleReturn {
            consoleReturn = nil
            route = .detail(run)
        } else {
            consoleReturn = nil
            route = .section(section)
        }
    }

    private func resolveRequestedRun() {
        guard let requested = workspace.requestedRunID else { return }
        section = .runs
        if let run = workspace.runs.first(where: { $0.runId == requested }) {
            openRun(run)
        } else {
            route = .section(.runs)
        }
    }

    private var matchingRuns: [RunListItem] {
        let term = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !term.isEmpty else { return workspace.runs }
        return workspace.runs.filter { run in
            run.runId.localizedCaseInsensitiveContains(term)
                || run.tests.contains { $0.name.localizedCaseInsensitiveContains(term) || $0.id.localizedCaseInsensitiveContains(term) }
                || run.devices.contains { $0.platform.localizedCaseInsensitiveContains(term) }
        }
    }

    private var searchDialog: some View {
        VStack(alignment: .leading, spacing: 20) {
            dialogHeading("실행 검색")
            TextField("실행 ID, 시나리오 또는 플랫폼 검색", text: $query)
                .textFieldStyle(.roundedBorder)
                .focused($searchFocused)
                .accessibilityLabel("실행 검색어")
            if let error = workspace.runsError {
                ProductNotice(error, tone: .error)
            }
            if workspace.runsLoading {
                ProgressView("실행 기록 조회 중")
            }
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 8) {
                    ForEach(workspace.regression.runs.filter { query.isEmpty || ($0.name + " " + $0.id).localizedCaseInsensitiveContains(query) }) { run in
                        Button { dialog = nil; route = .regression(run.id) } label: {
                            VStack(alignment: .leading, spacing: 6) {
                                Text(run.name).font(.headline)
                                Text(DisplayDate.text(run.createdAt))
                                Text(run.id).font(.caption.monospaced()).foregroundStyle(ProductDesign.muted)
                            }.frame(maxWidth: .infinity, alignment: .leading)
                        }.buttonStyle(ProductButtonStyle())
                    }
                    ForEach(matchingRuns) { run in
                        Button {
                            dialog = nil
                            openRun(run)
                        } label: {
                            VStack(alignment: .leading, spacing: 6) {
                                Text(run.displayTitle).font(ProductDesign.bodyFont().weight(.semibold)).help("실행 ID: \(run.runId)")
                                Text(run.tests.map(\.name).joined(separator: " · "))
                                    .foregroundStyle(ProductDesign.muted)
                                Text(run.displaySummary).font(ProductDesign.bodyFont(11)).foregroundStyle(ProductDesign.muted)
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(14)
                            .background(ProductDesign.canvas, in: RoundedRectangle(cornerRadius: 8))
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("실행 \(run.displayTitle) 상세 열기")
                    }
                    if matchingRuns.isEmpty && !workspace.runsLoading {
                        ProductNotice(query.isEmpty ? "조회된 실행 기록이 없습니다." : "검색 조건에 맞는 실행이 없습니다.")
                    }
                }
            }
        }
        .padding(24)
        .frame(width: 640, height: 500)
        .font(ProductDesign.bodyFont())
        .task {
            searchFocused = true
            await workspace.loadRuns()
            await workspace.regression.refresh(api: workspace.api)
        }
    }

    private var notificationsDialog: some View {
        VStack(alignment: .leading, spacing: 20) {
            dialogHeading("작업 및 오류 알림")
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    if workspace.api == nil {
                        ProductNotice("엔진 연결이 없어 작업 상태의 최신 여부를 확인할 수 없습니다.", tone: .warning)
                    }
                    if let banner = workspace.banner { ProductNotice(banner, tone: .error) }
                    if let error = workspace.runsError { ProductNotice(error, tone: .error) }
                    if let error = workspace.devicesError { ProductNotice(error, tone: .error) }
                    if let error = workspace.directError { ProductNotice(error, tone: .error) }
                    if let error = catalog.error { ProductNotice(error, tone: .error) }
                    ForEach(workspace.profileErrors, id: \.self) { error in
                        ProductNotice("\(error.file): \(error.error)", tone: .error)
                    }
                    ForEach(workspace.regression.runs) { run in
                        VStack(alignment: .leading, spacing: 8) {
                            HStack { Text(run.name).font(.headline); Spacer(); ProductStatusBadge(status: run.state) }
                            Text(DisplayDate.text(run.updatedAt)).font(.callout)
                            if let message = run.message { Text(message).textSelection(.enabled) }
                            Button("실행 상태 확인") { dialog = nil; route = .regression(run.id) }.buttonStyle(ProductButtonStyle())
                        }.padding(16).frame(maxWidth: .infinity, alignment: .leading)
                            .background(ProductDesign.canvas, in: RoundedRectangle(cornerRadius: 8))
                    }
                    if workspace.regression.runs.isEmpty && !hasNotificationErrors {
                        ProductNotice("조회된 작업이나 오류가 없습니다.")
                    }
                }
            }
        }
        .padding(24)
        .frame(width: 640, height: 500)
        .font(ProductDesign.bodyFont())
    }

    private var hasNotificationErrors: Bool {
        workspace.banner != nil || workspace.runsError != nil || workspace.devicesError != nil
            || workspace.directError != nil || catalog.error != nil || !workspace.profileErrors.isEmpty
    }

    private func dialogHeading(_ title: String) -> some View {
        HStack {
            Text(title)
                .font(ProductDesign.displayFont(22).weight(.semibold))
                .accessibilityAddTraits(.isHeader)
            Spacer()
            Button("닫기") { dialog = nil }
                .buttonStyle(ProductButtonStyle(kind: .ghost))
                .keyboardShortcut(.cancelAction)
        }
    }
}
