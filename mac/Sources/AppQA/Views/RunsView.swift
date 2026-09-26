// Runs history window: past runs with counts, replay (events.jsonl), report and evidence folder.
import SwiftUI

struct RunsView: View {
    @Environment(Workspace.self) private var workspace
    @Environment(\.openWindow) private var openWindow
    @State private var selection: RunListItem.ID?

    private var selected: RunListItem? { workspace.runs.first { $0.id == selection } }

    var body: some View {
        NavigationSplitView {
            List(workspace.runs, selection: $selection) { run in
                VStack(alignment: .leading, spacing: 3) {
                    Text(Self.date(run.startedAt)).font(.callout.weight(.medium))
                    HStack(spacing: 4) {
                        if !run.finished { Tag(text: "진행 중/중단", color: .orange) }
                        ForEach(["PASS", "FAIL", "INCONCLUSIVE", "ERROR", "SKIPPED"], id: \.self) { verdict in
                            if let count = run.counts?[verdict], count > 0 { Tag(text: "\(verdict) \(count)", color: Palette.verdict(verdict)) }
                        }
                    }
                    Text(run.tests.map(\.name).joined(separator: ", ")).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
                .padding(.vertical, 2)
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("runs.row.\(run.runId)")
            }
            .navigationSplitViewColumnWidth(min: 260, ideal: 320)
            .overlay {
                if workspace.runs.isEmpty {
                    ContentUnavailableView("실행 기록 없음", systemImage: "clock", description: Text(workspace.runsError ?? "테스트를 실행하면 여기에 기록됩니다"))
                }
            }
            .accessibilityIdentifier("runs.list")
            .toolbar {
                Button {
                    Task { await workspace.loadRuns() }
                } label: {
                    Label("새로고침", systemImage: "arrow.clockwise")
                }
                .accessibilityIdentifier("runs.refresh")
                .accessibilityLabel("실행 기록 새로고침")
            }
        } detail: {
            if let run = selected {
                RunDetail(run: run) {
                    Task {
                        await workspace.startReplay(run)
                        openWindow(id: "workspace")
                    }
                }
            } else {
                ContentUnavailableView("실행을 선택하세요", systemImage: "sidebar.left")
            }
        }
        .frame(minWidth: 760, minHeight: 460)
        .task { await workspace.loadRuns() }
        // The detail never sits empty while runs exist: keep a valid selection, defaulting to the newest run.
        .onChange(of: workspace.runs.map(\.id), initial: true) { _, ids in
            if selection.map({ !ids.contains($0) }) ?? true { selection = ids.first }
        }
    }

    static func date(_ iso: String) -> String {
        guard let date = (try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(iso)) ?? (try? Date.ISO8601FormatStyle().parse(iso)) else { return iso }
        return date.formatted(date: .abbreviated, time: .standard)
    }
}

private struct RunDetail: View {
    @Environment(Workspace.self) private var workspace
    let run: RunListItem
    let replay: () -> Void

    var body: some View {
        Form {
            Section("실행") {
                LabeledContent("ID", value: run.runId)
                LabeledContent("시작", value: RunsView.date(run.startedAt))
                LabeledContent("디바이스", value: run.devices.map { "\(Palette.platformLabel[$0.platform] ?? $0.platform) \($0.name)" }.joined(separator: ", "))
                LabeledContent("상태", value: run.finished ? "종료" : "진행 중 또는 중단")
            }
            Section("테스트 \(run.tests.count)개") {
                ForEach(run.tests, id: \.id) { test in
                    LabeledContent(test.name, value: test.platforms.map { Palette.platformLabel[$0] ?? $0 }.joined(separator: ", "))
                }
            }
            Section {
                HStack {
                    Button("활동 재생", systemImage: "play.circle", action: replay)
                        .disabled(!run.hasEvents)
                        .accessibilityIdentifier("runs.replay")
                        .accessibilityLabel("이 실행의 활동 재생")
                    Button("리포트 열기", systemImage: "doc.richtext") {
                        if let path = run.reportPath { workspace.open(path: path) }
                    }
                    .disabled(run.reportPath == nil)
                    .accessibilityIdentifier("runs.openReport")
                    .accessibilityLabel("리포트 열기")
                    Button("증거 폴더 열기", systemImage: "folder") { workspace.open(path: run.runDir) }
                        .accessibilityIdentifier("runs.openFolder")
                        .accessibilityLabel("증거 폴더 열기")
                }
            }
        }
        .formStyle(.grouped)
        .accessibilityIdentifier("runs.detail")
    }
}
