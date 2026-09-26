// Step evidence sheet: before/after screenshots, candidate table (elements.json), Jev decisions with probabilities.
import AppKit
import SwiftUI

struct EvidenceView: View {
    @Environment(Workspace.self) private var workspace
    @Environment(\.dismiss) private var dismiss
    let request: EvidenceRequest

    @State private var before: DeviceScreenView.Frame?
    @State private var after: DeviceScreenView.Frame?
    @State private var candidates: [CandidateRow] = []
    @State private var loadError: String?

    private var finished: (verdict: String, reason: String, dir: String)? {
        for event in request.events.reversed() {
            if case .stepFinished(let verdict, let reason, let dir) = event.body { return (verdict, reason, dir) }
        }
        return nil
    }

    private var label: String {
        for event in request.events {
            if case .stepStarted(let label) = event.body { return label }
        }
        return "스텝 \(request.key.index + 1)"
    }

    /// The step's target and pointer action, drawn on the "before" screenshot.
    private var marks: StepMarks { StepMarks(events: request.events) }

    private var names: [String: String] { Dictionary(candidates.map { ($0.key, $0.name) }, uniquingKeysWith: { first, _ in first }) }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                if let finished { VerdictBadge(verdict: finished.verdict) }
                VStack(alignment: .leading, spacing: 2) {
                    Text(label).font(.title3.weight(.semibold))
                    Text("\(workspace.label(platform: request.key.platform)) · \(request.key.testId) · \(request.key.runId)")
                        .font(.caption).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                }
                Spacer()
                if let dir = finished?.dir {
                    Button("증거 폴더 열기") {
                        let absolute = dir.hasPrefix("/") ? dir : "\(request.runDir ?? "")/\(dir)"
                        workspace.open(path: absolute)
                    }
                    .accessibilityIdentifier("evidence.openFolder")
                    .accessibilityLabel("증거 폴더 Finder에서 열기")
                }
                Button("닫기") { dismiss() }
                    .keyboardShortcut(.cancelAction)
                    .accessibilityIdentifier("evidence.close")
                    .accessibilityLabel("증거 창 닫기")
            }
            .padding(14)
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if let finished { Text(finished.reason).font(.callout).textSelection(.enabled) }
                    if let loadError { Text(loadError).font(.caption).foregroundStyle(.orange) }
                    HStack(alignment: .top, spacing: 16) {
                        shot(title: "행동 전", frame: before, marks: marks, id: "evidence.before")
                        shot(title: "행동 후", frame: after, marks: nil, id: "evidence.after")
                    }
                    decisions
                    if !candidates.isEmpty { candidateTable }
                }
                .padding(14)
            }
        }
        .frame(minWidth: 820, idealWidth: 960, minHeight: 620, idealHeight: 760)
        .task { await load() }
        .accessibilityIdentifier("evidence.sheet")
    }

    private func shot(title: String, frame: DeviceScreenView.Frame?, marks: StepMarks?, id: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.headline)
            Group {
                if let frame {
                    Image(nsImage: frame.image).resizable().aspectRatio(contentMode: .fit)
                        .clipShape(RoundedRectangle(cornerRadius: 10))
                        .overlay {
                            TapOverlay(
                                marks: marks, platform: request.key.platform, pixelWidth: frame.pixelWidth, pixelHeight: frame.pixelHeight,
                                viewportWidth: workspace.selectedProfile?.web?.viewport.width)
                        }
                } else {
                    RoundedRectangle(cornerRadius: 10).fill(.quaternary)
                        .overlay(Text("스크린샷 없음").foregroundStyle(.secondary))
                        .aspectRatio(0.46, contentMode: .fit)
                }
            }
            .frame(maxHeight: 420)
            .accessibilityLabel("\(title) 스크린샷")
            .accessibilityIdentifier(id)
        }
        .frame(maxWidth: .infinity)
    }

    @ViewBuilder private var decisions: some View {
        let items: [QaEvent] = request.events.filter { if case .decision = $0.body { true } else { false } }
        if !items.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                Text("판단 근거").font(.headline)
                ForEach(items) { event in
                    if case .decision(let kind, let intent, let verdict, let source, let probabilities, let target, let model, let requestId, let latencyMs, let reason) = event.body {
                        Card {
                            DecisionContent(
                                kind: kind, intent: intent, verdict: verdict, source: source, probabilities: probabilities, target: target,
                                model: model, requestId: requestId, latencyMs: latencyMs, reason: reason, names: names, barLimit: 8)
                        }
                    }
                }
            }
            .accessibilityIdentifier("evidence.decisions")
        }
    }

    private var candidateTable: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("후보 (\(candidates.count))").font(.headline)
            Table(candidates) {
                TableColumn("키", value: \.key).width(44)
                TableColumn("역할", value: \.role).width(80)
                TableColumn("이름", value: \.name)
                TableColumn("값") { Text($0.value ?? "") }
                TableColumn("상태") { Text(($0.state ?? []).joined(separator: ", ")) }
                TableColumn("탭 지점") { Text($0.tapPoint?.label ?? "—").monospacedDigit() }.width(90)
            }
            .frame(minHeight: 220)
            .accessibilityIdentifier("evidence.candidates")
        }
    }

    private func load() async {
        guard let api = workspace.api else { return }
        var beforePath: String?
        var afterPath: String?
        if let dir = finished?.dir {
            beforePath = "\(dir)/before.png"
            afterPath = "\(dir)/after.png"
        } else {
            // Step still running: fall back to the screenshots named by observe/settle events.
            for event in request.events {
                if case .observe(let shot?, _, _, _, _) = event.body, beforePath == nil { beforePath = shot }
                if case .settle(_, _, _, let shot?) = event.body { afterPath = shot }
            }
        }
        func image(_ path: String?) async -> DeviceScreenView.Frame? {
            guard let path, let data = try? await api.data(for: api.runFileRequest(runId: request.key.runId, runDir: request.runDir, path: path)) else { return nil }
            return DeviceScreenView.decode(data)
        }
        before = await image(beforePath)
        after = await image(afterPath)
        if let dir = finished?.dir {
            do {
                let data = try await api.data(for: api.runFileRequest(runId: request.key.runId, runDir: request.runDir, path: "\(dir)/elements.json"))
                struct Wrapped: Decodable { let candidates: [CandidateRow] }
                if let rows = try? JSONDecoder().decode([CandidateRow].self, from: data) {
                    candidates = rows
                } else {
                    candidates = try JSONDecoder().decode(Wrapped.self, from: data).candidates
                }
            } catch {
                loadError = "elements.json을 읽지 못했습니다: \(error.localizedDescription)"
            }
        }
    }
}
