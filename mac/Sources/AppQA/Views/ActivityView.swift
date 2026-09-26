// Left pane: live activity stream (steps, decisions with probability bars, actions, health, verdicts, jobs, logs).
import SwiftUI

struct ActivityView: View {
    @Environment(Workspace.self) private var workspace

    var body: some View {
        @Bindable var workspace = workspace
        VStack(spacing: 0) {
            header
            if let replay = workspace.replay {
                HStack(spacing: 8) {
                    Image(systemName: "clock.arrow.circlepath")
                    Text("재생 중 · \(replay.run.runId) · 이벤트 \(replay.items.count)개")
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Spacer()
                    Button("실시간으로 돌아가기") { workspace.replay = nil }
                        .accessibilityIdentifier("activity.replay.exit")
                        .accessibilityLabel("재생 종료하고 실시간 활동으로 돌아가기")
                }
                .font(.callout)
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .background(Color.accentColor.opacity(0.12))
                .accessibilityIdentifier("activity.replay.banner")
            }
            Divider()
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 8) {
                        ForEach(workspace.visibleActivity) { item in
                            ActivityRow(item: item)
                                .id(item.id)
                        }
                    }
                    .padding(12)
                }
                .defaultScrollAnchor(.bottom)
                .onChange(of: workspace.visibleActivity.last?.id) { _, last in
                    guard workspace.autoScroll, let last else { return }
                    withAnimation(.easeOut(duration: 0.15)) { proxy.scrollTo(last, anchor: .bottom) }
                }
                .overlay {
                    if workspace.visibleActivity.isEmpty {
                        ContentUnavailableView(
                            "활동 없음", systemImage: "waveform.path.ecg",
                            description: Text("작업을 시작하면 스텝·판단·행동이 여기에 실시간으로 표시됩니다"))
                    }
                }
            }
            .accessibilityIdentifier("activity.list")
        }
    }

    private var header: some View {
        @Bindable var workspace = workspace
        return HStack(spacing: 10) {
            Label("활동", systemImage: "list.bullet.rectangle")
                .font(.headline)
            Spacer()
            Picker("테스트 필터", selection: $workspace.testFilter) {
                Text("모든 테스트").tag(String?.none)
                ForEach(workspace.filterableTests, id: \.id) { test in
                    Text(test.name).tag(Optional(test.id))
                }
            }
            .labelsHidden()
            .frame(maxWidth: 200)
            .accessibilityIdentifier("activity.filter")
            .accessibilityLabel("테스트로 활동 필터")
            Toggle(isOn: $workspace.autoScroll) {
                Image(systemName: "arrow.down.to.line")
            }
            .toggleStyle(.button)
            .help("자동 스크롤")
            .accessibilityIdentifier("activity.autoscroll")
            .accessibilityLabel("자동 스크롤")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }
}

struct ActivityRow: View {
    @Environment(Workspace.self) private var workspace
    let item: ActivityItem

    var body: some View {
        switch item.content {
        case .note(let text, let level):
            Line(icon: level == "warn" ? "exclamationmark.triangle" : "info.circle", color: level == "warn" ? .orange : .secondary, text: text)
        case .event(let event):
            EventRow(event: event)
                .contentShape(Rectangle())
                .onTapGesture { workspace.showEvidence(for: event) }
                .accessibilityAddTraits(event.stepKey != nil ? .isButton : [])
                .accessibilityIdentifier("activity.event.\(event.seq)")
        }
    }
}

/// Minor stream entry: a dot/icon and one line of secondary text.
private struct Line: View {
    let icon: String
    var color: Color = .secondary
    let text: String

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: icon).foregroundStyle(color).frame(width: 14)
            Text(text).foregroundStyle(.secondary).textSelection(.enabled)
        }
        .font(.callout)
        .padding(.leading, 4)
        .accessibilityElement(children: .combine)
    }
}

private struct EventRow: View {
    @Environment(Workspace.self) private var workspace
    let event: QaEvent

    private var stepPrefix: String {
        guard let index = event.index, let platform = event.platform else { return "" }
        return "\(Palette.platformLabel[platform] ?? platform) · 스텝 \(index + 1) · "
    }

    var body: some View {
        switch event.body {
        case .jobQueued(_, let kind, let title):
            Line(icon: "tray.and.arrow.down", text: "대기열에 추가 · \(title) (\(kind))")
        case .jobStarted(let jobId, let kind):
            Line(icon: "play.circle", color: .accentColor, text: "작업 시작 · \(workspace.jobs.first { $0.id == jobId }?.title ?? kind)")
        case .jobFinished(let jobId, _, let ok, let message, let resultPath):
            Card(tint: ok ? .green : .red, emphasized: !ok) {
                HStack {
                    Image(systemName: ok ? "checkmark.circle.fill" : "exclamationmark.circle.fill").foregroundStyle(ok ? .green : .red)
                    Text(workspace.jobs.first { $0.id == jobId }?.title ?? "작업").font(.headline)
                    Spacer()
                    Tag(text: ok ? "완료" : "실패", color: ok ? .green : .red)
                }
                Text(message).font(.callout).textSelection(.enabled)
                if let resultPath {
                    Button("결과 열기") { workspace.open(path: resultPath) }
                        .buttonStyle(.link)
                        .accessibilityIdentifier("activity.job.openResult.\(event.seq)")
                        .accessibilityLabel("작업 결과 열기")
                }
            }
        case .runStarted(let runId, _, let tests, let devices):
            Card(tint: .accentColor) {
                HStack {
                    Image(systemName: "play.rectangle.fill").foregroundStyle(Color.accentColor)
                    Text("실행 시작").font(.headline)
                    Spacer()
                    Text(runId).font(.caption.monospaced()).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                }
                Text("테스트 \(tests.count)개 · " + devices.map { "\(Palette.platformLabel[$0.platform] ?? $0.platform) \($0.name)" }.joined(separator: ", "))
                    .font(.callout).foregroundStyle(.secondary)
            }
        case .testStarted(let name):
            HStack(spacing: 8) {
                Image(systemName: "chevron.right.circle.fill").foregroundStyle(Color.accentColor)
                Text(name).font(.subheadline.weight(.semibold))
                if let platform = event.platform { Tag(text: Palette.platformLabel[platform] ?? platform) }
            }
            .padding(.top, 6)
            .accessibilityElement(children: .combine)
        case .stepStarted(let label):
            Line(icon: "circle.dotted", color: .accentColor, text: stepPrefix + label)
        case .observe(_, let candidates, let sparse, let overflow, let ocr):
            Line(
                icon: "eye", text: "화면 관찰 · 후보 \(candidates)개" + (sparse ? " · 희소" : "") + (overflow ? " · 254개 초과" : "") + (ocr ? " · OCR" : ""))
        case .decision(let kind, let intent, let verdict, let source, let probabilities, let target, let model, let requestId, let latencyMs, let reason):
            Card(tint: verdict == "pass" ? .accentColor : .orange, emphasized: verdict != "pass") {
                DecisionContent(
                    kind: kind, intent: intent, verdict: verdict, source: source, probabilities: probabilities, target: target,
                    model: model, requestId: requestId, latencyMs: latencyMs, reason: reason)
            }
        case .policy(let risky, let blocked, let reasons):
            if risky || blocked {
                Card(tint: .orange, emphasized: true) {
                    Label(blocked ? "위험 동작 차단" : "위험 동작 감지", systemImage: "hand.raised.fill")
                        .font(.headline).foregroundStyle(.orange)
                    Text(reasons.joined(separator: " · ")).font(.callout)
                }
            } else {
                Line(icon: "checkmark.shield", text: stepPrefix + "위험 정책 통과")
            }
        case .action(let kind, let point, let to, let text, let status, let ms):
            Card(tint: status == "completed" ? .secondary : .red, emphasized: status != "completed") {
                HStack {
                    Image(systemName: actionIcon(kind))
                    Text(actionTitle(kind)).font(.headline)
                    Spacer()
                    Tag(text: status == "completed" ? "완료" : status == "uncertain" ? "불확실" : "거부", color: status == "completed" ? .green : .red)
                }
                HStack(spacing: 6) {
                    Text("좌표:").foregroundStyle(.secondary)
                    Text(coordinates(point, to)).font(.callout.monospaced())
                        .padding(.horizontal, 6).padding(.vertical, 2)
                        .background(.quaternary, in: RoundedRectangle(cornerRadius: 4))
                    if let text { Text("입력: \(text)").font(.callout) }
                    Spacer()
                    Text("\(Int(ms))ms").font(.caption).foregroundStyle(.secondary)
                }
            }
        case .settle(let changed, let settled, let ms, _):
            Line(
                icon: settled ? "checkmark.circle" : "hourglass", color: changed ? .secondary : .orange,
                text: "안정화 · " + (changed ? "화면 변화" : "변화 없음") + (settled ? "" : " · 안정 실패") + " · \(Int(ms))ms")
        case .health(let findings):
            if !findings.isEmpty {
                Card(tint: .red, emphasized: true) {
                    Label("앱 상태 이상", systemImage: "cross.case.fill").font(.headline).foregroundStyle(.red)
                    ForEach(findings, id: \.self) { finding in
                        HStack(alignment: .top) {
                            Tag(text: finding.severity == "fail" ? "FAIL" : "WARN", color: finding.severity == "fail" ? .red : .orange)
                            Text("\(finding.kind): \(finding.evidence)").font(.callout).textSelection(.enabled)
                        }
                    }
                }
            }
        case .stepFinished(let verdict, let reason, _):
            HStack(spacing: 8) {
                VerdictBadge(verdict: verdict)
                Text(stepPrefix + reason).font(.callout).foregroundStyle(.secondary).lineLimit(2)
                Spacer()
                Image(systemName: "photo.on.rectangle").foregroundStyle(.tertiary).help("증거 보기")
            }
            .padding(.leading, 4)
            .accessibilityElement(children: .combine)
            .accessibilityHint("증거 보기")
        case .testFinished(let verdict, let reason, let durationMs):
            Card(tint: Palette.verdict(verdict), emphasized: verdict != "PASS") {
                HStack {
                    VerdictBadge(verdict: verdict)
                    Text(workspace.testNames[event.testId ?? ""] ?? event.testId ?? "테스트").font(.headline)
                    Spacer()
                    Text(Duration.milliseconds(Int(durationMs)).formatted(.units(allowed: [.minutes, .seconds], width: .abbreviated)))
                        .font(.caption).foregroundStyle(.secondary)
                }
                Text(reason).font(.callout).foregroundStyle(.secondary)
            }
        case .runFinished(_, let counts, let reportPath, _):
            Card(tint: .accentColor) {
                HStack {
                    Image(systemName: "flag.checkered")
                    Text("실행 종료").font(.headline)
                    Spacer()
                    ForEach(["PASS", "FAIL", "INCONCLUSIVE", "ERROR", "SKIPPED"], id: \.self) { verdict in
                        if let count = counts[verdict], count > 0 { Tag(text: "\(verdict) \(count)", color: Palette.verdict(verdict)) }
                    }
                }
                Button("리포트 열기") { workspace.open(path: reportPath) }
                    .buttonStyle(.link)
                    .accessibilityIdentifier("activity.run.openReport.\(event.seq)")
                    .accessibilityLabel("리포트 열기")
            }
        case .planStarted(_, let app, let docs):
            Line(icon: "doc.text.magnifyingglass", color: .accentColor, text: "계획 생성 시작 · \(app) · 문서 \(docs.count)개")
        case .planProgress(_, let phase, let message):
            Line(icon: "gearshape.2", text: "계획 · \(phase) · \(message)")
        case .planFinished(_, _, let requirements, let tests, let untestable, let ok, let message):
            Card(tint: ok ? .green : .red, emphasized: !ok) {
                Label(ok ? "계획 생성 완료" : "계획 생성 실패", systemImage: ok ? "checklist" : "exclamationmark.triangle")
                    .font(.headline)
                Text("요구사항 \(requirements) · 테스트 \(tests) · 테스트 불가 \(untestable)").font(.callout)
                Text(message).font(.caption).foregroundStyle(.secondary)
            }
        case .log(let level, let source, let message):
            if level == "error" {
                Card(tint: .red, emphasized: true) {
                    HStack {
                        Image(systemName: "exclamationmark.circle").foregroundStyle(.red)
                        Text("오류 · \(source)").font(.headline)
                        Spacer()
                        Tag(text: "실패", color: .red)
                    }
                    Text(message).font(.callout).textSelection(.enabled)
                }
            } else {
                Line(icon: level == "warn" ? "exclamationmark.triangle" : "text.bubble", color: level == "warn" ? .orange : .secondary, text: "\(source) · \(message)")
            }
        case .unknown(let type):
            Line(icon: "questionmark.circle", text: "알 수 없는 이벤트 · \(type)")
        }
    }

    private func actionTitle(_ kind: String) -> String {
        let titles: [String: String] = [
            "tap": "화면 탭", "type": "텍스트 입력", "swipe": "화면 스와이프", "scroll": "스크롤", "back": "뒤로 가기",
            "launch": "앱 실행", "terminate": "앱 종료", "reset": "앱 초기화",
        ]
        return titles[kind] ?? kind
    }

    private func actionIcon(_ kind: String) -> String {
        let icons: [String: String] = [
            "tap": "hand.tap", "type": "keyboard", "swipe": "hand.draw", "scroll": "scroll", "back": "arrow.uturn.backward",
            "launch": "power", "terminate": "stop.circle", "reset": "arrow.counterclockwise",
        ]
        return icons[kind] ?? "bolt"
    }

    private func coordinates(_ point: Point?, _ to: Point?) -> String {
        switch (point, to) {
        case (let p?, let t?): "\(p.label) → \(t.label)"
        case (let p?, nil): p.label
        default: "—"
        }
    }
}
