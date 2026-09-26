// Right pane: 작업 큐 (jobs with state + cancel) and 계획 (requirement → tests → steps checklist with live status).
import SwiftUI

struct SidePanelView: View {
    @Environment(Workspace.self) private var workspace

    var body: some View {
        let tab = workspace.sideTab
        VStack(spacing: 0) {
            HStack(spacing: 6) {
                ForEach(SideTab.allCases) { item in
                    Button {
                        workspace.sideTab = item
                    } label: {
                        Label(item.label, systemImage: item.icon)
                            .font(.callout.weight(tab == item ? .semibold : .regular))
                            .padding(.horizontal, 12)
                            .padding(.vertical, 6)
                            .foregroundStyle(tab == item ? Color.accentColor : .secondary)
                            .background(tab == item ? Color.accentColor.opacity(0.14) : .clear, in: Capsule())
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("side.tab.\(item.rawValue)")
                    .accessibilityLabel(item.label)
                    .accessibilityAddTraits(tab == item ? .isSelected : [])
                }
                Spacer()
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            Divider()
            switch tab {
            case .queue: QueueView()
            case .plan: PlanChecklistView()
            }
        }
    }
}

struct QueueView: View {
    @Environment(Workspace.self) private var workspace

    var body: some View {
        let jobs = workspace.jobs.reversed()
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 8) {
                ForEach(Array(jobs)) { job in
                    JobRow(job: job)
                }
            }
            .padding(10)
        }
        .overlay {
            if jobs.isEmpty {
                ContentUnavailableView("대기 중인 작업 없음", systemImage: "tray", description: Text("아래 입력창에서 계획 생성·스모크·테스트 실행을 시작하세요"))
            }
        }
        .accessibilityIdentifier("queue.list")
    }
}

private struct JobRow: View {
    @Environment(Workspace.self) private var workspace
    let job: JobView

    private static let stateLabel: [String: String] = [
        "queued": "대기", "running": "실행 중", "succeeded": "완료", "failed": "실패", "cancelled": "취소됨",
    ]

    var body: some View {
        Card(tint: Palette.jobState(job.state), emphasized: job.state == "running" || job.state == "failed") {
            HStack(spacing: 8) {
                icon
                Text(job.title).font(.callout.weight(.semibold)).lineLimit(2)
                Spacer()
                Tag(text: job.cancelRequested && job.isActive ? "취소 중" : Self.stateLabel[job.state] ?? job.state, color: Palette.jobState(job.state))
            }
            if !job.devices.isEmpty {
                Text(job.devices.joined(separator: ", ")).font(.caption.monospaced()).foregroundStyle(.secondary)
            }
            if let message = job.message {
                Text(message).font(.caption).foregroundStyle(.secondary).textSelection(.enabled).lineLimit(4)
            }
            HStack {
                if job.isActive {
                    Button("취소", role: .destructive) { Task { await workspace.cancel(job) } }
                        .disabled(job.cancelRequested)
                        .accessibilityIdentifier("queue.cancel.\(job.id)")
                        .accessibilityLabel("\(job.title) 작업 취소")
                }
                if let resultPath = job.resultPath {
                    Button("결과 열기") { workspace.open(path: resultPath) }
                        .accessibilityIdentifier("queue.openResult.\(job.id)")
                        .accessibilityLabel("\(job.title) 결과 열기")
                }
            }
            .controlSize(.small)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("queue.job.\(job.id)")
    }

    @ViewBuilder private var icon: some View {
        switch job.state {
        case "running": ProgressView().controlSize(.small)
        case "queued": Image(systemName: "clock").foregroundStyle(.secondary)
        case "succeeded": Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
        case "failed": Image(systemName: "xmark.octagon.fill").foregroundStyle(.red)
        default: Image(systemName: "slash.circle").foregroundStyle(.secondary)
        }
    }
}

struct PlanChecklistView: View {
    @Environment(Workspace.self) private var workspace

    var body: some View {
        if let view = workspace.plan {
            // Header stays outside the scroll view so the document chips are never clipped by the tab bar.
            PlanHeader(view: view)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    let testsByFile = Dictionary(view.tests.map { ($0.file, $0) }, uniquingKeysWith: { first, _ in first })
                    let untestable = Dictionary(view.plan.untestable.map { ($0.requirement, $0.reason) }, uniquingKeysWith: { first, _ in first })
                    let changedDocs = Set(view.docs.filter { $0.state == "changed" }.map(\.path))
                    ForEach(view.plan.requirements) { requirement in
                        RequirementRow(
                            requirement: requirement,
                            entries: view.plan.tests.filter { $0.covers.contains(requirement.id) },
                            testsByFile: testsByFile,
                            untestableReason: untestable[requirement.id],
                            stale: changedDocs.contains(requirement.doc))
                    }
                    if !view.plan.untestable.isEmpty {
                        VStack(alignment: .leading, spacing: 6) {
                            Label("테스트 불가 (\(view.plan.untestable.count))", systemImage: "nosign").font(.headline)
                            ForEach(view.plan.untestable, id: \.self) { item in
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(item.requirement).font(.caption.monospaced())
                                    Text(item.reason).font(.callout).foregroundStyle(.secondary)
                                }
                                .accessibilityElement(children: .combine)
                            }
                        }
                        .accessibilityIdentifier("plan.untestable")
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(12)
            }
            .accessibilityIdentifier("plan.checklist")
        } else {
            ContentUnavailableView {
                Label("계획 없음", systemImage: "checklist")
            } description: {
                Text(workspace.planMessage ?? "앱 프로필을 선택하세요")
            }
            .accessibilityIdentifier("plan.empty")
        }
    }
}

private struct PlanHeader: View {
    @Environment(Workspace.self) private var workspace
    let view: PlanView

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ForEach(view.docs, id: \.path) { doc in
                        Button {
                            workspace.reveal(path: (doc.path as NSString).expandingTildeInPath)
                        } label: {
                            HStack(spacing: 4) {
                                Image(systemName: "doc.text")
                                Text((doc.path as NSString).lastPathComponent).lineLimit(1)
                                if doc.state == "changed" { Tag(text: "변경됨", color: .orange) }
                                if doc.state == "missing" { Tag(text: "없음", color: .red) }
                            }
                            .font(.caption)
                            .padding(.horizontal, 8)
                            .padding(.vertical, 4)
                            .background(.quaternary, in: Capsule())
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("plan.doc.\((doc.path as NSString).lastPathComponent)")
                        .accessibilityLabel("문서 \((doc.path as NSString).lastPathComponent) Finder에서 보기")
                    }
                }
                .padding(.vertical, 2)
            }
            .fixedSize(horizontal: false, vertical: true)
            Text("요구사항 \(view.plan.requirements.count) · 테스트 \(view.plan.tests.count) · \(view.plan.llm.provider)\(view.plan.llm.model.map { " \($0)" } ?? "")")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }
}

private struct RequirementRow: View {
    @Environment(Workspace.self) private var workspace
    let requirement: Requirement
    let entries: [PlanTestEntry]
    let testsByFile: [String: PlanTestView]
    let untestableReason: String?
    let stale: Bool

    private var status: LiveStatus? {
        LiveStatus.combine(entries.compactMap { testsByFile[$0.file].flatMap(workspace.status(test:)) })
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .top, spacing: 8) {
                StatusIcon(status: untestableReason == nil ? status : nil)
                VStack(alignment: .leading, spacing: 3) {
                    if !requirement.section.isEmpty {
                        Text(requirement.section.joined(separator: " › ")).font(.caption).foregroundStyle(.secondary)
                    }
                    Text(requirement.text).font(.callout).fixedSize(horizontal: false, vertical: true)
                    HStack(spacing: 4) {
                        Text(requirement.id).font(.caption2.monospaced()).foregroundStyle(.tertiary)
                        if stale { Tag(text: "stale", color: .orange) }
                        if untestableReason != nil { Tag(text: "테스트 불가", color: .gray) }
                        if entries.isEmpty && untestableReason == nil { Tag(text: "커버 안 됨", color: .red) }
                    }
                }
            }
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("plan.requirement.\(requirement.id)")
            ForEach(entries, id: \.file) { entry in
                if let test = testsByFile[entry.file] {
                    TestRow(entry: entry, test: test)
                        .padding(.leading, 24)
                }
            }
        }
    }
}

private struct TestRow: View {
    @Environment(Workspace.self) private var workspace
    let entry: PlanTestEntry
    let test: PlanTestView
    @State private var expanded = true

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Button {
                    expanded.toggle()
                } label: {
                    Image(systemName: expanded ? "chevron.down" : "chevron.right").frame(width: 12)
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("plan.test.toggle.\(test.id)")
                .accessibilityLabel(expanded ? "\(test.name ?? test.id) 스텝 접기" : "\(test.name ?? test.id) 스텝 펼치기")
                StatusIcon(status: workspace.status(test: test))
                Text(test.name ?? test.id).font(.callout.weight(.medium)).lineLimit(2)
                if entry.status == "draft" { Tag(text: "draft", color: .orange) }
                if entry.status == "rejected" { Tag(text: "rejected", color: .red) }
                ForEach(test.platforms, id: \.self) { Tag(text: Palette.platformLabel[$0] ?? $0) }
            }
            .accessibilityIdentifier("plan.test.\(test.id)")
            if let error = test.error {
                Text(error).font(.caption).foregroundStyle(.red).padding(.leading, 18)
            }
            if !entry.review.issues.isEmpty {
                Text(entry.review.issues.joined(separator: " · ")).font(.caption).foregroundStyle(.orange).padding(.leading, 18)
            }
            if expanded {
                ForEach(Array(workspace.steps(for: test).enumerated()), id: \.offset) { index, label in
                    HStack(alignment: .top, spacing: 6) {
                        StatusIcon(status: workspace.status(test: test, step: index))
                        Text(label)
                            .font(.callout)
                            .foregroundStyle(workspace.status(test: test, step: index) == .verdict("PASS") ? .secondary : .primary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .padding(.leading, 18)
                    .accessibilityElement(children: .combine)
                    .accessibilityIdentifier("plan.step.\(test.id).\(index)")
                }
            }
        }
    }
}
