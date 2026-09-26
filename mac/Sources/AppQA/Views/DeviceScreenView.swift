// Center pane: live device screen (~2 fps while visible) with the current step's target/tap overlaid; while replaying a
// past run, the focused step's evidence screenshot instead (live polling stops until replay ends).
import AppKit
import SwiftUI

struct DeviceScreenView: View {
    @Environment(Workspace.self) private var workspace
    @Environment(\.scenePhase) private var scenePhase
    @State private var frame: Frame?
    @State private var error: String?
    @State private var paused = false
    /// Replay only: whether the shown evidence is the pre-action screenshot (marks are drawn only on that one).
    @State private var replayShowsBefore = false

    struct Frame: Equatable {
        let image: NSImage
        let pixelWidth: Int
        let pixelHeight: Int
    }

    private var platform: String { workspace.platform == .all ? workspace.devicePane : workspace.platform.rawValue }
    private var deviceId: String? { workspace.selectedDevice[platform] }
    private var device: DeviceInfo? { workspace.devices.first { $0.platform == platform && $0.id == deviceId } }
    private var replayFocus: StepKey? { workspace.replay?.focus }

    private var marks: StepMarks? {
        let marks: StepMarks?
        if let replay = workspace.replay {
            guard let focus = replay.focus, replayShowsBefore else { return nil }
            marks = StepMarks(events: replay.items.lazy.compactMap(\.event).filter { $0.stepKey == focus })
        } else {
            marks = workspace.marks[platform]
        }
        return marks?.isEmpty == false ? marks : nil
    }

    var body: some View {
        @Bindable var workspace = workspace
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Label("디바이스", systemImage: "iphone").font(.headline)
                if workspace.replay != nil {
                    Tag(text: "재생", color: .accentColor)
                } else if workspace.platform == .all {
                    Picker("표시할 플랫폼", selection: $workspace.devicePane) {
                        Text("Android").tag("android")
                        Text("iOS").tag("ios")
                    }
                    .pickerStyle(.segmented)
                    .labelsHidden()
                    .frame(width: 130)
                    .accessibilityIdentifier("device.platformPane")
                    .accessibilityLabel("표시할 디바이스 플랫폼")
                }
                Spacer()
                if workspace.replay == nil {
                    Toggle(isOn: $paused) { Image(systemName: paused ? "play.fill" : "pause.fill") }
                        .toggleStyle(.button)
                        .help(paused ? "화면 갱신 재개" : "화면 갱신 일시정지")
                        .accessibilityIdentifier("device.pause")
                        .accessibilityLabel(paused ? "화면 갱신 재개" : "화면 갱신 일시정지")
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            Divider()
            screen
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .padding(12)
            Divider()
            footer
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
        }
        .task(id: liveKey) { await pollLive() }
        .task(id: replayKey) { await loadReplayFrame() }
    }

    @ViewBuilder private var screen: some View {
        if let frame {
            Image(nsImage: frame.image)
                .resizable()
                .interpolation(.high)
                .aspectRatio(contentMode: .fit)
                .clipShape(RoundedRectangle(cornerRadius: 14))
                .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(workspace.replay == nil ? Color.primary.opacity(0.15) : Color.accentColor, lineWidth: workspace.replay == nil ? 1 : 2))
                .overlay {
                    TapOverlay(marks: marks, platform: replayFocus?.platform ?? platform, pixelWidth: frame.pixelWidth, pixelHeight: frame.pixelHeight)
                }
                .overlay(alignment: .topLeading) { badge }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(workspace.replay == nil ? "\(device?.name ?? "디바이스") 실시간 화면" : "재생: \(replayCaption)")
                .accessibilityIdentifier("device.screen")
        } else {
            ContentUnavailableView {
                Label(workspace.replay != nil ? "증거 화면 없음" : deviceId == nil ? "디바이스 없음" : "화면 대기 중", systemImage: "iphone.slash")
            } description: {
                Text(error ?? (workspace.replay != nil ? "스텝 카드를 눌러 증거 화면을 고르세요" : deviceId == nil ? "툴바에서 디바이스를 선택하세요" : "화면을 가져오는 중…"))
            }
            .accessibilityIdentifier("device.placeholder")
        }
    }

    @ViewBuilder private var badge: some View {
        if workspace.replay != nil {
            Label(replayCaption, systemImage: "clock.arrow.circlepath")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.white)
                .padding(.horizontal, 8).padding(.vertical, 4)
                .background(Color.accentColor, in: Capsule())
                .padding(8)
                .accessibilityIdentifier("device.replayBadge")
        } else if workspace.isRecording(platform: platform) {
            Label("녹화 중", systemImage: "record.circle")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.white)
                .padding(.horizontal, 8).padding(.vertical, 4)
                .background(.red, in: Capsule())
                .padding(8)
                .accessibilityIdentifier("device.recordingIndicator")
        }
    }

    private var replayCaption: String {
        guard let focus = replayFocus else { return "재생 · 증거 화면 없음" }
        return "재생 · 스텝 \(focus.index + 1) · \(replayShowsBefore ? "행동 전" : "행동 후") 화면"
    }

    private var footer: some View {
        HStack(spacing: 8) {
            if let replay = workspace.replay {
                Image(systemName: "clock.arrow.circlepath")
                Text(replay.focus.map { "기록된 증거 · \(Palette.platformLabel[$0.platform] ?? $0.platform) · \($0.testId) · 스텝 \($0.index + 1)" } ?? "기록된 증거 화면 없음")
                    .lineLimit(1)
            } else {
                Circle().fill(error == nil && frame != nil ? Color.green : Color.orange).frame(width: 7, height: 7)
                Text(device.map { "실시간 · \($0.name) · \($0.osVersion)" } ?? "—").lineLimit(1)
            }
            Spacer()
            if let marks {
                Text(
                    [marks.target.map { "대상 \($0.name) \($0.tapPoint.label)" }, marks.action.map { "\($0.kind) \($0.point.label)" }]
                        .compactMap { $0 }.joined(separator: " · ")
                )
                .lineLimit(1)
                .monospacedDigit()
            }
        }
        .font(.caption)
        .foregroundStyle(.secondary)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("device.status")
    }

    private var liveKey: String {
        "\(workspace.replay == nil)|\(platform)|\(deviceId ?? "-")|\(paused)|\(scenePhase == .background)|\(workspace.api?.base.absoluteString ?? "-")"
    }

    private var replayKey: String {
        guard let replay = workspace.replay, let focus = replay.focus else { return "none" }
        return "\(replay.run.runId)|\(focus.testId)|\(focus.platform)|\(focus.index)"
    }

    private func pollLive() async {
        guard workspace.replay == nil else { return }
        // Never keep showing another device's (or a replayed run's) image.
        frame = nil
        error = paused ? "화면 갱신이 일시정지되었습니다" : nil
        guard !paused, scenePhase != .background, let api = workspace.api, let deviceId else { return }
        let request = api.request("/api/devices/\(platform)/\(APIClient.segment(deviceId))/screen")
        while !Task.isCancelled {
            let started = ContinuousClock.now
            do {
                let data = try await api.data(for: request)
                if let next = Self.decode(data) {
                    frame = next
                    error = nil
                }
            } catch is CancellationError {
                return
            } catch {
                self.error = error.localizedDescription
            }
            // ~2 fps: sleep whatever is left of 500 ms after the fetch.
            let elapsed = ContinuousClock.now - started
            try? await Task.sleep(for: max(.milliseconds(100), .milliseconds(500) - elapsed))
        }
    }

    /// Pre-action screenshot (observe event, else `<evidenceDir>/before.png`) so target/tap marks line up with the screen
    /// they were resolved on; falls back to the post-action (settle) screenshot without marks.
    private func loadReplayFrame() async {
        guard let replay = workspace.replay else { return }
        frame = nil
        error = nil
        guard let focus = replay.focus, let api = workspace.api else {
            error = "이 실행에는 스크린샷이 있는 스텝이 없습니다"
            return
        }
        var before: String?
        var after: String?
        for item in replay.items {
            guard let event = item.event, event.stepKey == focus else { continue }
            switch event.body {
            case .observe(let shot?, _, _, _, _): before = before ?? shot
            case .settle(_, _, _, let shot?): after = shot
            case .stepFinished(_, _, let dir): before = before ?? "\(dir)/before.png"
            default: break
            }
        }
        for (path, isBefore) in [(before, true), (after, false)] {
            guard let path, let data = try? await api.data(for: api.runFileRequest(runId: replay.run.runId, runDir: replay.run.runDir, path: path)),
                let decoded = Self.decode(data)
            else { continue }
            replayShowsBefore = isBefore
            frame = decoded
            return
        }
        error = "이 스텝의 스크린샷을 불러오지 못했습니다"
    }

    static func decode(_ data: Data) -> Frame? {
        guard let rep = NSBitmapImageRep(data: data) else { return nil }
        let image = NSImage(size: NSSize(width: rep.pixelsWide, height: rep.pixelsHigh))
        image.addRepresentation(rep)
        return Frame(image: image, pixelWidth: rep.pixelsWide, pixelHeight: rep.pixelsHigh)
    }
}

/// Draws a step's resolved target (dashed ring + name) and its pointer action (solid ring, swipe path) over a screenshot.
/// Event points are in tap coordinates; the screenshot is in pixels.
struct TapOverlay: View {
    let marks: StepMarks?
    let platform: String
    let pixelWidth: Int
    let pixelHeight: Int

    /// Pixels per tap unit: Android taps are pixels; iOS taps are points (@3x iPhone, @2x iPad/SE), inferred from the
    /// short side because the event contract carries no screen size.
    private var scale: Double {
        guard platform == "ios" else { return 1 }
        let short = Double(min(pixelWidth, pixelHeight))
        if (320...440).contains(short / 3) { return 3 }
        if (320...1100).contains(short / 2) { return 2 }
        return 1
    }

    var body: some View {
        GeometryReader { geo in
            if let marks, pixelWidth > 0 {
                let factor = geo.size.width / Double(pixelWidth) * scale
                ZStack {
                    if let target = marks.target {
                        let p = CGPoint(x: target.tapPoint.x * factor, y: target.tapPoint.y * factor)
                        Circle()
                            .strokeBorder(Color.orange, style: StrokeStyle(lineWidth: 2, dash: [4, 3]))
                            .frame(width: 40, height: 40)
                            .position(p)
                        Text(target.name)
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(.white)
                            .padding(.horizontal, 5).padding(.vertical, 2)
                            .background(Color.orange, in: Capsule())
                            .fixedSize()
                            .position(x: p.x, y: max(10, p.y - 30))
                    }
                    if let action = marks.action {
                        let start = CGPoint(x: action.point.x * factor, y: action.point.y * factor)
                        if let to = action.to {
                            let end = CGPoint(x: to.x * factor, y: to.y * factor)
                            Path { path in
                                path.move(to: start)
                                path.addLine(to: end)
                            }
                            .stroke(Color.accentColor, style: StrokeStyle(lineWidth: 3, lineCap: .round, dash: [6, 4]))
                            Circle().fill(Color.accentColor).frame(width: 10, height: 10).position(end)
                        }
                        Circle()
                            .strokeBorder(Color.accentColor, lineWidth: 3)
                            .background(Circle().fill(Color.accentColor.opacity(0.25)))
                            .frame(width: 30, height: 30)
                            .position(start)
                        Circle().fill(Color.accentColor).frame(width: 6, height: 6).position(start)
                    }
                }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(
                    [marks.target.map { "대상 \($0.name) \($0.tapPoint.label)" }, marks.action.map { "\($0.kind) 위치 \($0.point.label)" }]
                        .compactMap { $0 }.joined(separator: ", "))
                .accessibilityIdentifier("device.tapOverlay")
            }
        }
        .allowsHitTesting(false)
    }
}
