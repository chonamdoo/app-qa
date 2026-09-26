// Shared visual vocabulary: verdict colors/badges, source badges, probability bars, card chrome.
import SwiftUI

enum Palette {
    static func verdict(_ verdict: String) -> Color {
        switch verdict {
        case "PASS": .green
        case "FAIL": .red
        case "INCONCLUSIVE": .orange
        case "ERROR": .purple
        case "SKIPPED": .gray
        default: .secondary
        }
    }

    static func jobState(_ state: String) -> Color {
        switch state {
        case "succeeded": .green
        case "failed": .red
        case "cancelled": .gray
        case "running": .accentColor
        default: .secondary
        }
    }

    static let verdictLabel: [String: String] = [
        "PASS": "통과", "FAIL": "실패", "INCONCLUSIVE": "판정 불가", "ERROR": "오류", "SKIPPED": "건너뜀",
    ]

    static let sourceLabel: [String: String] = [
        "selector": "selector", "fast_path": "fast path", "jev": "Jev", "deterministic": "결정적", "none": "없음",
    ]

    static let platformLabel: [String: String] = ["android": "Android", "ios": "iOS"]
}

struct VerdictBadge: View {
    let verdict: String

    var body: some View {
        Text(verdict)
            .font(.caption2.weight(.bold).monospaced())
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .foregroundStyle(Palette.verdict(verdict))
            .background(Palette.verdict(verdict).opacity(0.14), in: Capsule())
            .overlay(Capsule().strokeBorder(Palette.verdict(verdict).opacity(0.35)))
            .accessibilityLabel("판정 \(Palette.verdictLabel[verdict] ?? verdict)")
    }
}

struct Tag: View {
    let text: String
    var color: Color = .secondary

    var body: some View {
        Text(text)
            .font(.caption2.weight(.medium))
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .foregroundStyle(color)
            .background(color.opacity(0.12), in: Capsule())
    }
}

/// Status glyph used by the checklist and the queue.
struct StatusIcon: View {
    let status: LiveStatus?

    var body: some View {
        Group {
            switch status {
            case .none:
                Image(systemName: "square").foregroundStyle(.tertiary)
            case .running:
                ProgressView().controlSize(.mini)
            case .verdict(let verdict):
                Image(systemName: verdict == "PASS" ? "checkmark.square.fill" : verdict == "SKIPPED" ? "minus.square" : "xmark.square.fill")
                    .foregroundStyle(Palette.verdict(verdict))
            }
        }
        .frame(width: 16, height: 16)
        .accessibilityLabel(accessibility)
    }

    private var accessibility: String {
        switch status {
        case .none: "대기"
        case .running: "진행 중"
        case .verdict(let verdict): Palette.verdictLabel[verdict] ?? verdict
        }
    }
}

struct ProbabilityBars: View {
    let probabilities: [String: Double]
    let chosen: String?
    var names: [String: String] = [:]
    var limit = 3

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            ForEach(probabilities.sorted { $0.value > $1.value }.prefix(limit), id: \.key) { key, value in
                HStack(spacing: 6) {
                    Text(names[key].map { "\(key) · \($0)" } ?? key)
                        .font(.caption.monospaced())
                        .lineLimit(1)
                        .frame(width: 140, alignment: .leading)
                    GeometryReader { geo in
                        ZStack(alignment: .leading) {
                            Capsule().fill(.quaternary)
                            Capsule().fill(key == chosen ? Color.accentColor : Color.secondary.opacity(0.6))
                                .frame(width: max(2, geo.size.width * value))
                        }
                    }
                    .frame(height: 6)
                    Text(value.formatted(.percent.precision(.fractionLength(1))))
                        .font(.caption.monospacedDigit())
                        .frame(width: 48, alignment: .trailing)
                }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("\(names[key] ?? key) 확률 \(Int((value * 100).rounded()))퍼센트")
            }
        }
    }
}

/// Rounded card chrome in the style of the artemis activity stream.
struct Card<Content: View>: View {
    var tint: Color = .secondary
    var emphasized = false
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 6) { content }
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.background.secondary, in: RoundedRectangle(cornerRadius: 10))
            .overlay(
                RoundedRectangle(cornerRadius: 10)
                    .strokeBorder(emphasized ? tint.opacity(0.6) : Color.primary.opacity(0.08), lineWidth: emphasized ? 1.2 : 1))
    }
}

extension Point {
    var label: String { "(\(Int(x.rounded())), \(Int(y.rounded())))" }
}

/// Body of a `decision` event. Grounding shows intent → target; claim-like judgments (claim/check/commit) have no
/// target and show the statement with p(yes); `which` shows its option distribution.
struct DecisionContent: View {
    let kind: String
    let intent: String
    let verdict: String
    let source: String
    let probabilities: [String: Double]?
    let target: DecisionTarget?
    let model: String?
    let requestId: String?
    let latencyMs: Double?
    let reason: String
    var names: [String: String] = [:]
    var barLimit = 3

    private static let kindLabel: [String: String] = [
        "grounding": "대상 찾기", "claim": "화면 주장", "check": "확인", "commit": "되돌릴 수 없는 동작 여부", "which": "화면 분기",
    ]

    private var pYes: Double? {
        guard let probabilities else { return nil }
        return probabilities["yes"] ?? probabilities["noul"] ?? (probabilities.count == 1 ? probabilities.values.first : nil)
    }

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "brain").foregroundStyle(Color.accentColor)
            Text("판단 · \(Self.kindLabel[kind] ?? kind)").font(.headline)
            Tag(text: Palette.sourceLabel[source] ?? source, color: source == "jev" ? .purple : .blue)
            Spacer()
            Tag(text: verdict, color: verdict == "pass" ? .green : .orange)
        }
        switch kind {
        case "claim", "check", "commit":
            Text("“\(intent)”").font(.callout).textSelection(.enabled)
            if let pYes {
                ProbabilityBars(probabilities: ["p(yes)": pYes], chosen: verdict == "pass" ? "p(yes)" : nil)
            }
        case "which":
            Text(intent).font(.callout).textSelection(.enabled)
            if let probabilities, !probabilities.isEmpty {
                ProbabilityBars(probabilities: probabilities, chosen: probabilities.max { $0.value < $1.value }?.key, limit: barLimit)
            }
        default:
            HStack(spacing: 4) {
                Text(intent).fontWeight(.medium)
                Image(systemName: "arrow.right").foregroundStyle(.secondary)
                Text(target.map { "\($0.name) [\($0.key) · \($0.role)] \($0.tapPoint.label)" } ?? "찾지 못함")
                    .foregroundStyle(target == nil ? .secondary : .primary)
            }
            .font(.callout)
            .textSelection(.enabled)
            if let probabilities, !probabilities.isEmpty {
                ProbabilityBars(
                    probabilities: probabilities, chosen: target?.key,
                    names: names.merging(target.map { [$0.key: $0.name] } ?? [:]) { current, _ in current }, limit: barLimit)
            }
        }
        Text(
            [reason.isEmpty ? nil : "게이트: \(reason)", latencyMs.map { "\(Int($0))ms" }, model, requestId.map { "request \($0)" }]
                .compactMap { $0 }.joined(separator: " · ")
        )
        .font(.caption)
        .foregroundStyle(.secondary)
        .lineLimit(3)
        .textSelection(.enabled)
    }
}
