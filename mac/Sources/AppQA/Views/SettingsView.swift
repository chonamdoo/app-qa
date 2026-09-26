// Settings: project root / node path / engine port overrides.
import AppKit
import SwiftUI

struct SettingsView: View {
    @Environment(Workspace.self) private var workspace
    @AppStorage(EngineController.rootKey) private var rootOverride = ""
    @AppStorage(EngineController.nodeKey) private var nodeOverride = ""
    @AppStorage(EngineController.portKey) private var port = 0

    var body: some View {
        Form {
            Section("엔진") {
                HStack {
                    TextField("프로젝트 루트", text: $rootOverride, prompt: Text(workspace.engine.bakedRoot ?? "app-qa 폴더"))
                        .accessibilityIdentifier("settings.root")
                        .accessibilityLabel("프로젝트 루트 경로")
                    Button("선택…") {
                        let panel = NSOpenPanel()
                        panel.canChooseDirectories = true
                        panel.canChooseFiles = false
                        panel.prompt = "선택"
                        if panel.runModal() == .OK, let url = panel.url { rootOverride = url.path }
                    }
                    .accessibilityIdentifier("settings.root.choose")
                    .accessibilityLabel("프로젝트 루트 폴더 선택")
                }
                Text("비워 두면 빌드할 때 기록된 경로를 씁니다: \(workspace.engine.bakedRoot ?? "없음")")
                    .font(.caption).foregroundStyle(.secondary)
                TextField("node 경로", text: $nodeOverride, prompt: Text("자동 (zsh -lc 'command -v node')"))
                    .accessibilityIdentifier("settings.node")
                    .accessibilityLabel("node 실행 파일 경로")
                TextField("엔진 포트", value: $port, format: .number.grouping(.never), prompt: Text("0 = 자동"))
                    .accessibilityIdentifier("settings.port")
                    .accessibilityLabel("엔진 포트, 0이면 자동")
            }
            Section {
                Button("적용하고 엔진 다시 시작") { Task { await workspace.engine.restart() } }
                    .accessibilityIdentifier("settings.apply")
                    .accessibilityLabel("설정 적용하고 엔진 다시 시작")
            }
        }
        .formStyle(.grouped)
        .frame(width: 520)
        .padding(.vertical, 8)
    }
}
