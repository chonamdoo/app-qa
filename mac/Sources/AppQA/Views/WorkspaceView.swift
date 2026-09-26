// Main window (artemis Workspace layout): toolbar, activity | device | queue/plan, composer.
import SwiftUI

struct WorkspaceView: View {
    @Environment(Workspace.self) private var workspace
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        @Bindable var workspace = workspace
        VStack(spacing: 0) {
            if let banner = workspace.banner {
                HStack {
                    Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                    Text(banner).lineLimit(2).textSelection(.enabled)
                    Spacer()
                    Button("닫기") { workspace.banner = nil }
                        .accessibilityIdentifier("banner.dismiss")
                        .accessibilityLabel("알림 닫기")
                }
                .font(.callout)
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .background(Color.orange.opacity(0.12))
                .accessibilityIdentifier("banner")
            }
            // Panes take all the height the composer leaves, even when their lists are empty.
            HSplitView {
                ActivityView()
                    .frame(minWidth: 380, idealWidth: 560, maxWidth: .infinity, maxHeight: .infinity)
                    .accessibilityIdentifier("pane.activity")
                DeviceScreenView()
                    .frame(minWidth: 260, idealWidth: 330, maxWidth: 520, maxHeight: .infinity)
                    .accessibilityIdentifier("pane.device")
                SidePanelView()
                    .frame(minWidth: 300, idealWidth: 380, maxWidth: 560, maxHeight: .infinity)
                    .accessibilityIdentifier("pane.side")
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            Divider()
            ComposerView()
        }
        .toolbar { toolbar }
        .navigationTitle(workspace.selectedProfile.map { "App QA · \($0.name)" } ?? "App QA")
        .sheet(item: $workspace.evidence) { request in
            EvidenceView(request: request)
                .environment(workspace)
        }
    }

    @ToolbarContentBuilder private var toolbar: some ToolbarContent {
        @Bindable var workspace = workspace
        ToolbarItemGroup(placement: .navigation) {
            Picker("앱", selection: $workspace.selectedApp) {
                if workspace.profiles.isEmpty { Text("앱 프로필 없음").tag(String?.none) }
                ForEach(workspace.profiles) { profile in
                    Text(profile.name).tag(Optional(profile.id))
                }
            }
            .frame(width: 140)
            .help("앱 프로필 (apps/*.yaml)")
            .accessibilityIdentifier("toolbar.app")
            .accessibilityLabel("앱 프로필")
        }
        ToolbarItemGroup(placement: .principal) {
            if workspace.isWebApp {
                // A website can run on up to four browsers: one compact pull-down instead of a wide segmented control.
                Picker("플랫폼", selection: $workspace.platform) {
                    ForEach(workspace.platformChoices) { choice in
                        Text(choice.label(web: true)).tag(choice)
                    }
                }
                .pickerStyle(.menu)
                .frame(width: 170)
                .help("실행할 브라우저")
                .accessibilityIdentifier("toolbar.platform")
                .accessibilityLabel("플랫폼")
            } else {
                Picker("플랫폼", selection: $workspace.platform) {
                    ForEach(workspace.platformChoices) { choice in
                        Text(choice.label(web: false)).tag(choice)
                    }
                }
                .pickerStyle(.segmented)
                .frame(width: 210)
                .accessibilityIdentifier("toolbar.platform")
                .accessibilityLabel("플랫폼")
            }
            DeviceMenu()
            Picker("LLM", selection: $workspace.llm) {
                ForEach(LLMChoice.allCases) { choice in
                    Text(choice.label).tag(choice)
                }
            }
            .frame(width: 100)
            .help("계획 생성에 쓸 LLM")
            .accessibilityIdentifier("toolbar.llm")
            .accessibilityLabel("LLM 선택")
        }
        ToolbarItemGroup(placement: .primaryAction) {
            Button {
                Task { await workspace.toggleRecording() }
            } label: {
                Label(workspace.anyRecording ? "녹화 중…" : "녹화", systemImage: workspace.anyRecording ? "record.circle.fill" : "record.circle")
                    .foregroundStyle(workspace.anyRecording ? .red : .primary)
            }
            .labelStyle(.titleAndIcon)
            .disabled(workspace.api == nil || workspace.recordablePlatforms.allSatisfy { workspace.selectedDevice[$0] == nil })
            .help(workspace.anyRecording ? "녹화 중지" : "선택한 디바이스 화면 녹화")
            .accessibilityIdentifier("toolbar.record")
            .accessibilityLabel(workspace.anyRecording ? "녹화 중지" : "녹화 시작")
            Button {
                if let path = workspace.lastReportPath { workspace.open(path: path) }
            } label: {
                Label("리포트 열기", systemImage: "doc.richtext")
            }
            .labelStyle(.titleAndIcon)
            .disabled(workspace.lastReportPath == nil)
            .help(workspace.lastReportPath ?? "아직 리포트가 없습니다")
            .accessibilityIdentifier("toolbar.report")
            .accessibilityLabel("최근 리포트 열기")
            Button {
                openWindow(id: "runs")
            } label: {
                Label("실행 기록", systemImage: "clock.arrow.circlepath")
            }
            .help("과거 실행 기록과 재생")
            .accessibilityIdentifier("toolbar.runs")
            .accessibilityLabel("실행 기록 열기")
            EngineStatusButton()
        }
    }
}

private struct DeviceMenu: View {
    @Environment(Workspace.self) private var workspace

    private var title: String {
        let names = workspace.activePlatforms.map { platform in
            workspace.devices.first { $0.platform == platform && $0.id == workspace.selectedDevice[platform] }?.name
                ?? "\(workspace.label(platform: platform)) 없음"
        }
        return names.joined(separator: " · ")
    }

    /// This Mac's browser window when every active target is a desktop browser, otherwise a phone.
    private var icon: String {
        workspace.activePlatforms.allSatisfy { Palette.desktopPlatforms.contains($0) } ? "macwindow" : "iphone.gen3"
    }

    var body: some View {
        Menu {
            ForEach(workspace.activePlatforms, id: \.self) { platform in
                Section(workspace.label(platform: platform)) {
                    let devices = workspace.devices(for: platform)
                    if devices.isEmpty { Text("디바이스 없음") }
                    ForEach(devices) { device in
                        Button {
                            workspace.selectedDevice[platform] = device.id
                        } label: {
                            if workspace.selectedDevice[platform] == device.id {
                                Label("\(device.name) · \(device.osVersion) · \(device.state)", systemImage: "checkmark")
                            } else {
                                Text("\(device.name) · \(device.osVersion) · \(device.state)")
                            }
                        }
                        .accessibilityIdentifier("toolbar.device.\(device.id)")
                    }
                }
            }
            Divider()
            Button("디바이스 새로고침") { Task { await workspace.loadDevices() } }
                .accessibilityIdentifier("toolbar.device.refresh")
            if let error = workspace.devicesError { Text(error) }
        } label: {
            Label(title, systemImage: icon)
                .labelStyle(.iconOnly)
        }
        .help("실행할 디바이스: \(title)")
        .accessibilityIdentifier("toolbar.device")
        .accessibilityLabel("디바이스 선택")
    }
}

private struct EngineStatusButton: View {
    @Environment(Workspace.self) private var workspace
    @State private var showing = false

    private var color: Color {
        switch workspace.engine.phase {
        case .connected: workspace.streamLive ? .green : .orange
        case .starting: .orange
        case .failed: .red
        case .idle: .gray
        }
    }

    private var summary: String {
        switch workspace.engine.phase {
        case .connected: workspace.streamLive ? "엔진 연결됨" : "재연결 중"
        case .starting(let message): message
        case .failed(let message): message
        case .idle: "엔진 정지"
        }
    }

    var body: some View {
        Button {
            showing.toggle()
        } label: {
            HStack(spacing: 5) {
                Circle().fill(color).frame(width: 8, height: 8)
                Text(workspace.engine.phase == .connected ? "엔진" : "엔진 확인")
            }
        }
        .help(summary)
        .accessibilityIdentifier("toolbar.engine")
        .accessibilityLabel("엔진 상태: \(summary)")
        .popover(isPresented: $showing, arrowEdge: .bottom) {
            VStack(alignment: .leading, spacing: 8) {
                Label(summary, systemImage: "circle.fill").foregroundStyle(color).font(.headline)
                Grid(alignment: .leading, horizontalSpacing: 10, verticalSpacing: 4) {
                    GridRow {
                        Text("프로젝트").foregroundStyle(.secondary)
                        Text(workspace.engine.root?.path ?? "—").textSelection(.enabled)
                    }
                    GridRow {
                        Text("주소").foregroundStyle(.secondary)
                        Text(workspace.engine.info.map { "127.0.0.1:\($0.port) · pid \($0.pid)" } ?? "—")
                    }
                    GridRow {
                        Text("소유").foregroundStyle(.secondary)
                        Text(workspace.engine.owned ? "이 앱이 실행한 엔진" : "외부에서 실행된 엔진")
                    }
                    GridRow {
                        Text("node").foregroundStyle(.secondary)
                        Text(workspace.engine.nodePath ?? "—")
                    }
                    if let exit = workspace.engine.lastExit {
                        GridRow {
                            Text("마지막 종료").foregroundStyle(.secondary)
                            Text(exit)
                        }
                    }
                }
                .font(.callout)
                HStack {
                    Button("엔진 다시 시작") { Task { await workspace.engine.restart() } }
                        .accessibilityIdentifier("engine.restart")
                        .accessibilityLabel("엔진 다시 시작")
                    if let log = workspace.engine.logURL {
                        Button("로그 열기") { workspace.open(path: log.path) }
                            .accessibilityIdentifier("engine.openLog")
                            .accessibilityLabel("엔진 로그 열기")
                    }
                    Button("새로고침") { Task { await workspace.refreshAll() } }
                        .accessibilityIdentifier("engine.refresh")
                        .accessibilityLabel("목록 새로고침")
                }
            }
            .padding(14)
            .frame(width: 420)
        }
    }
}
