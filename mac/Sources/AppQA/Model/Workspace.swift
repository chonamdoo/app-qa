// Central UI state: engine connection, selections, activity stream, jobs, plan checklist state, replay, composer.
import AppKit
import Foundation
import Observation
import UserNotifications

enum PlatformChoice: String, CaseIterable, Identifiable, Sendable {
    case android, ios, all

    var id: String { rawValue }
    var label: String {
        switch self {
        case .android: "Android"
        case .ios: "iOS"
        case .all: "둘 다"
        }
    }
    var platforms: [String] { self == .all ? ["android", "ios"] : [rawValue] }
}

enum LLMChoice: String, CaseIterable, Identifiable, Sendable {
    case claude = "claude-cli"
    case codex = "codex-cli"

    var id: String { rawValue }
    var label: String { self == .claude ? "Claude" : "Codex" }
}

/// Live status of a step/test in the checklist: running, or a final verdict (PASS/FAIL/INCONCLUSIVE/ERROR/SKIPPED).
enum LiveStatus: Equatable, Sendable {
    case running
    case verdict(String)

    static let severity: [String: Int] = ["PASS": 0, "SKIPPED": 1, "INCONCLUSIVE": 2, "FAIL": 3, "ERROR": 4]

    /// Running wins (work in progress), otherwise the worst verdict.
    static func combine(_ statuses: [LiveStatus]) -> LiveStatus? {
        if statuses.contains(.running) { return .running }
        return statuses.max { lhs, rhs in
            guard case .verdict(let l) = lhs, case .verdict(let r) = rhs else { return false }
            return (severity[l] ?? 5) < (severity[r] ?? 5)
        }
    }
}

struct ActivityItem: Identifiable, Sendable {
    enum Content: Sendable {
        case event(QaEvent)
        case note(String, level: String)
    }
    let id: Int
    let content: Content
    let date: Date

    var event: QaEvent? {
        if case .event(let e) = content { return e }
        return nil
    }
}

struct Attachment: Identifiable, Sendable {
    enum State: Sendable {
        case uploading
        case ready(String)
        case failed(String)
    }
    let id = UUID()
    let name: String
    var state: State
}

/// What the device overlay draws for one step: the target the step resolved to and the pointer action it dispatched.
struct StepMarks: Equatable, Sendable {
    struct Action: Equatable, Sendable {
        let kind: String
        let point: Point
        let to: Point?
    }

    var target: DecisionTarget?
    var action: Action?

    init() {}

    init(events: some Sequence<QaEvent>) {
        for event in events { apply(event) }
    }

    mutating func apply(_ event: QaEvent) {
        switch event.body {
        case .decision(_, _, _, _, _, let target?, _, _, _, _): self.target = target
        case .action(let kind, let point?, let to, _, _, _): action = Action(kind: kind, point: point, to: to)
        default: break
        }
    }

    var isEmpty: Bool { target == nil && action == nil }
}

struct ReplayState: Sendable {
    let run: RunListItem
    var items: [ActivityItem]
    /// Step whose evidence the device pane shows (defaults to the last step with a screenshot).
    var focus: StepKey?
}

enum SideTab: String, CaseIterable, Identifiable, Sendable {
    case queue, plan

    var id: String { rawValue }
    var label: String { self == .queue ? "작업 큐" : "계획" }
    var icon: String { self == .queue ? "list.bullet.rectangle.portrait" : "checklist" }
}

struct EvidenceRequest: Identifiable, Sendable {
    let id = UUID()
    let key: StepKey
    let runDir: String?
    let events: [QaEvent]
}

@MainActor @Observable
final class Workspace {
    static let shared = Workspace()

    let engine = EngineController()
    private(set) var api: APIClient?
    private(set) var streamLive = false

    // Toolbar selections (persisted).
    private(set) var profiles: [AppProfile] = []
    private(set) var profileErrors: [AppProfilesResponse.LoadError] = []
    var selectedApp: String? {
        didSet {
            guard selectedApp != oldValue else { return }
            UserDefaults.standard.set(selectedApp, forKey: "selectedApp")
            Task { await loadPlan() }
        }
    }
    var platform: PlatformChoice = .android {
        didSet { UserDefaults.standard.set(platform.rawValue, forKey: "platform") }
    }
    var llm: LLMChoice = .claude {
        didSet { UserDefaults.standard.set(llm.rawValue, forKey: "llm") }
    }
    private(set) var devices: [DeviceInfo] = []
    private(set) var devicesError: String?
    var selectedDevice: [String: String] = [:] {
        didSet { UserDefaults.standard.set(selectedDevice, forKey: "selectedDevice") }
    }

    // Activity.
    private(set) var live: [ActivityItem] = []
    var replay: ReplayState?
    var testFilter: String?
    var autoScroll = true
    private var nextItemId = 0
    private(set) var runDirs: [String: String] = [:]
    private(set) var testNames: [String: String] = [:]

    // Jobs.
    private(set) var jobs: [JobView] = []
    private var jobTitles: [String: String] = [:]
    private var jobsRefreshPending = false

    // Plan checklist.
    private(set) var plan: PlanView?
    private(set) var planMessage: String?
    private(set) var runSteps: [String: [String]] = [:]
    private(set) var stepStatus: [String: LiveStatus] = [:]
    private(set) var testStatus: [String: LiveStatus] = [:]

    // Device pane.
    /// Overlay marks of the step currently running on each platform (cleared when the next step starts).
    private(set) var marks: [String: StepMarks] = [:]
    private(set) var recordings: [RecordingInfo] = []
    var devicePane: String = "android"
    private(set) var lastReportPath: String?

    // Runs history.
    private(set) var runs: [RunListItem] = []
    private(set) var runsError: String?

    var sideTab: SideTab = .plan

    // Composer.
    var composerText = ""
    var attachments: [Attachment] = []
    var evidence: EvidenceRequest?
    var banner: String?

    @ObservationIgnored private var streamTask: Task<Void, Never>?
    @ObservationIgnored private var disconnects = 0
    @ObservationIgnored private var booted = false

    private init() {
        let defaults = UserDefaults.standard
        selectedApp = defaults.string(forKey: "selectedApp")
        platform = defaults.string(forKey: "platform").flatMap(PlatformChoice.init(rawValue:)) ?? .android
        llm = defaults.string(forKey: "llm").flatMap(LLMChoice.init(rawValue:)) ?? .claude
        selectedDevice = (defaults.dictionary(forKey: "selectedDevice") as? [String: String]) ?? [:]
        devicePane = platform == .ios ? "ios" : "android"
    }

    // MARK: - lifecycle

    func boot() async {
        guard !booted else { return }
        booted = true
        _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound])
        engine.onConnect = { [weak self] api, _ in self?.connected(api) }
        await engine.start()
    }

    private func connected(_ api: APIClient) {
        self.api = api
        streamTask?.cancel()
        disconnects = 0
        note("엔진에 연결됨 · 127.0.0.1:\(api.base.port ?? 0)", level: "info")
        streamTask = Task { [weak self] in
            for await message in EventStream.messages(api: api, startAfter: 0) {
                guard let self else { return }
                self.handle(message)
            }
        }
        Task { await refreshAll() }
    }

    func refreshAll() async {
        async let profiles: Void = loadProfiles()
        async let devices: Void = loadDevices()
        async let jobs: Void = loadJobs()
        async let runs: Void = loadRuns()
        async let recordings: Void = loadRecordings()
        _ = await (profiles, devices, jobs, runs, recordings)
        await loadPlan()
    }

    private func handle(_ message: StreamMessage) {
        switch message {
        case .connected:
            streamLive = true
            disconnects = 0
        case .event(let event):
            ingest(event)
        case .reset:
            note("엔진이 다시 시작되어 이벤트를 처음부터 다시 받습니다", level: "warn")
        case .gap:
            note("일부 이벤트가 엔진 버퍼에서 밀려나 표시되지 않았습니다", level: "warn")
        case .disconnected(let reason):
            streamLive = false
            disconnects += 1
            if disconnects == 1 { note("이벤트 스트림 끊김 — 재연결 중 (\(reason))", level: "warn") }
            if disconnects == 3 { Task { await engine.recover() } }
        }
    }

    // MARK: - events

    private func note(_ text: String, level: String) {
        append(.note(text, level: level))
    }

    private func append(_ content: ActivityItem.Content) {
        nextItemId += 1
        live.append(ActivityItem(id: nextItemId, content: content, date: Date()))
        if live.count > 4000 { live.removeFirst(500) }
    }

    func ingest(_ event: QaEvent) {
        append(.event(event))
        applyLiveState(event)
        switch event.body {
        case .jobQueued(let jobId, _, let title):
            jobTitles[jobId] = title
            scheduleJobsRefresh()
        case .jobStarted:
            scheduleJobsRefresh()
        case .jobFinished(let jobId, let kind, let ok, let message, let resultPath):
            scheduleJobsRefresh()
            if let resultPath, resultPath.hasSuffix(".html") { lastReportPath = resultPath }
            if kind == "plan" { Task { await loadPlan() } }
            // Replayed history (older than a minute) must not re-notify.
            if let date = event.date, Date().timeIntervalSince(date) < 60 {
                notify(title: jobTitles[jobId] ?? jobs.first { $0.id == jobId }?.title ?? kind, ok: ok, message: message)
            }
        case .runFinished(_, _, let reportPath, _):
            lastReportPath = reportPath
            Task { await loadRuns() }
        case .planFinished:
            Task { await loadPlan() }
        default:
            break
        }
    }

    private func applyLiveState(_ event: QaEvent) {
        switch event.body {
        case .runStarted(let runId, let runDir, let tests, _):
            runDirs[runId] = runDir
            for test in tests {
                runSteps[test.id] = test.steps
                testNames[test.id] = test.name
                stepStatus = stepStatus.filter { !$0.key.hasPrefix("\(test.id)|") }
                testStatus = testStatus.filter { !$0.key.hasPrefix("\(test.id)|") }
            }
        case .testStarted(let name):
            if let testId = event.testId, let platform = event.platform {
                testNames[testId] = name
                testStatus["\(testId)|\(platform)"] = .running
            }
        case .testFinished(let verdict, _, _):
            if let testId = event.testId, let platform = event.platform { testStatus["\(testId)|\(platform)"] = .verdict(verdict) }
        case .stepStarted:
            if let key = event.stepKey {
                stepStatus["\(key.testId)|\(key.platform)|\(key.index)"] = .running
                marks[key.platform] = StepMarks()
            }
        case .stepFinished(let verdict, _, _):
            if let key = event.stepKey { stepStatus["\(key.testId)|\(key.platform)|\(key.index)"] = .verdict(verdict) }
        case .decision, .action:
            if let platform = event.platform { marks[platform, default: StepMarks()].apply(event) }
        default:
            break
        }
    }

    private func notify(title: String, ok: Bool, message: String) {
        let content = UNMutableNotificationContent()
        content.title = ok ? "작업 완료 · \(title)" : "작업 실패 · \(title)"
        content.body = message
        content.sound = .default
        let request = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
        Task { try? await UNUserNotificationCenter.current().add(request) }
    }

    // MARK: - derived views

    var activity: [ActivityItem] { replay?.items ?? live }

    var visibleActivity: [ActivityItem] {
        guard let filter = testFilter else { return activity }
        return activity.filter { item in
            guard let event = item.event else { return false }
            if event.testId != nil { return event.testId == filter }
            if case .runStarted = event.body { return true }
            if case .runFinished = event.body { return true }
            return false
        }
    }

    /// Tests seen in the displayed stream, for the activity filter.
    var filterableTests: [(id: String, name: String)] {
        var seen: [String: String] = [:]
        var order: [String] = []
        for item in activity {
            guard let event = item.event, case .runStarted(_, _, let tests, _) = event.body else { continue }
            for test in tests where seen[test.id] == nil {
                seen[test.id] = test.name
                order.append(test.id)
            }
        }
        return order.map { ($0, seen[$0]!) }
    }

    func runDir(for runId: String?) -> String? {
        guard let runId else { return nil }
        if let replay, replay.run.runId == runId { return replay.run.runDir }
        return runDirs[runId] ?? runs.first { $0.runId == runId }?.runDir
    }

    func steps(for test: PlanTestView) -> [String] { runSteps[test.id] ?? test.steps }

    func status(test: PlanTestView, step index: Int) -> LiveStatus? {
        LiveStatus.combine(test.platforms.compactMap { stepStatus["\(test.id)|\($0)|\(index)"] })
    }

    /// Live status when this session has seen the test run, otherwise the latest recorded verdicts.
    func status(test: PlanTestView) -> LiveStatus? {
        let live = test.platforms.compactMap { testStatus["\(test.id)|\($0)"] }
        if !live.isEmpty { return LiveStatus.combine(live) }
        return LiveStatus.combine(test.results.map { .verdict($0.verdict) })
    }

    func devices(for platform: String) -> [DeviceInfo] { devices.filter { $0.platform == platform } }

    var deviceIds: DeviceIds {
        DeviceIds(
            android: platform.platforms.contains("android") ? selectedDevice["android"] : nil,
            ios: platform.platforms.contains("ios") ? selectedDevice["ios"] : nil)
    }

    func isRecording(platform: String) -> Bool {
        guard let id = selectedDevice[platform] else { return false }
        return recordings.contains { $0.platform == platform && $0.deviceId == id }
    }

    var anyRecording: Bool { platform.platforms.contains { isRecording(platform: $0) } }

    var uploadsPending: Bool { attachments.contains { if case .uploading = $0.state { true } else { false } } }

    var readyDocs: [String] { attachments.compactMap { if case .ready(let path) = $0.state { path } else { nil } } }

    // MARK: - loading

    func loadProfiles() async {
        guard let api else { return }
        do {
            let response: AppProfilesResponse = try await api.get("/api/app-profiles")
            profiles = response.profiles
            profileErrors = response.errors
            if selectedApp == nil || !profiles.contains(where: { $0.id == selectedApp }) { selectedApp = profiles.first?.id }
        } catch {
            banner = "앱 프로필을 불러오지 못했습니다: \(error.localizedDescription)"
        }
    }

    func loadDevices() async {
        guard let api else { return }
        do {
            let response: DevicesResponse = try await api.get("/api/devices")
            devices = response.devices
            devicesError = nil
            for platform in ["android", "ios"] {
                let candidates = devices(for: platform)
                if let current = selectedDevice[platform], candidates.contains(where: { $0.id == current }) { continue }
                selectedDevice[platform] = (candidates.first { $0.state == "booted" } ?? candidates.first)?.id
            }
        } catch {
            devicesError = error.localizedDescription
        }
    }

    func loadJobs() async {
        guard let api else { return }
        if let response: JobsResponse = try? await api.get("/api/jobs") { jobs = response.jobs }
    }

    private func scheduleJobsRefresh() {
        guard !jobsRefreshPending else { return }
        jobsRefreshPending = true
        Task {
            try? await Task.sleep(for: .milliseconds(150))
            jobsRefreshPending = false
            await loadJobs()
        }
    }

    func loadRuns() async {
        guard let api else { return }
        do {
            runs = (try await api.get("/api/runs", as: RunsResponse.self)).runs
            runsError = nil
            if lastReportPath == nil { lastReportPath = runs.first { $0.reportPath != nil }?.reportPath }
        } catch {
            runsError = error.localizedDescription
        }
    }

    func loadRecordings() async {
        guard let api else { return }
        if let response: RecordingsResponse = try? await api.get("/api/recordings") { recordings = response.recordings }
    }

    func loadPlan() async {
        guard let api, let app = selectedApp else {
            plan = nil
            return
        }
        do {
            plan = try await api.get("/api/plans/\(APIClient.segment(app))")
            planMessage = nil
        } catch let error as APIError where error.status == 404 {
            plan = nil
            planMessage = "이 앱의 계획이 아직 없습니다 — 기획서를 끌어다 놓고 ‘계획 생성’을 누르세요"
        } catch {
            plan = nil
            planMessage = error.localizedDescription
        }
    }

    // MARK: - actions

    private func submit<P: Encodable & Sendable>(_ kind: String, _ params: P) async -> Bool {
        guard let api else {
            banner = "엔진에 연결되지 않았습니다"
            return false
        }
        do {
            let job: JobView = try await api.post("/api/jobs", json: JobRequest(kind: kind, params: params))
            jobTitles[job.id] = job.title
            sideTab = .queue
            await loadJobs()
            return true
        } catch {
            banner = "작업을 등록하지 못했습니다: \(error.localizedDescription)"
            return false
        }
    }

    func submitPlan(thenRun: Bool) async {
        guard let app = selectedApp else {
            banner = "앱 프로필을 먼저 선택하세요"
            return
        }
        let text = composerText.trimmingCharacters(in: .whitespacesAndNewlines)
        let params = PlanJobParams(
            app: app, docs: readyDocs, text: text.isEmpty ? nil : text, llm: llm.rawValue,
            run: thenRun ? .init(platform: platform.rawValue, deviceIds: deviceIds) : nil)
        if await submit("plan", params) {
            composerText = ""
            attachments.removeAll()
        }
    }

    func submitSmoke() async {
        guard let app = selectedApp else {
            banner = "앱 프로필을 먼저 선택하세요"
            return
        }
        _ = await submit("smoke", SmokeJobParams(app: app, platform: platform.rawValue, deviceIds: deviceIds))
    }

    /// Runs the selected app's planned tests (or the runner's default paths when there is no plan).
    func submitRun() async {
        let paths = plan?.tests.filter { $0.error == nil }.map(\.path) ?? []
        _ = await submit("run", RunJobParams(paths: paths, platform: platform.rawValue, deviceIds: deviceIds))
    }

    func cancel(_ job: JobView) async {
        guard let api else { return }
        do {
            try await api.postEmpty("/api/jobs/\(APIClient.segment(job.id))/cancel")
            await loadJobs()
        } catch {
            banner = "취소하지 못했습니다: \(error.localizedDescription)"
        }
    }

    func toggleRecording() async {
        guard let api else { return }
        let turnOn = !anyRecording
        for platform in platform.platforms {
            guard let deviceId = selectedDevice[platform], isRecording(platform: platform) != turnOn else { continue }
            do {
                let _: RecordingInfo = try await api.post(
                    "/api/devices/\(platform)/\(APIClient.segment(deviceId))/recording", json: RecordingToggle(on: turnOn))
            } catch {
                banner = "녹화 \(turnOn ? "시작" : "중지") 실패: \(error.localizedDescription)"
            }
        }
        await loadRecordings()
    }

    func attach(_ urls: [URL]) {
        guard let api else {
            banner = "엔진에 연결된 뒤 문서를 올릴 수 있습니다"
            return
        }
        for url in urls {
            let attachment = Attachment(name: url.lastPathComponent, state: .uploading)
            attachments.append(attachment)
            Task {
                let state: Attachment.State
                do {
                    state = .ready(try await api.upload(fileURL: url).path)
                } catch {
                    state = .failed(error.localizedDescription)
                }
                if let index = attachments.firstIndex(where: { $0.id == attachment.id }) { attachments[index].state = state }
            }
        }
    }

    func startReplay(_ run: RunListItem) async {
        guard let api else { return }
        do {
            let data = try await api.data(for: api.request("/api/runs/\(APIClient.segment(run.runId))/events"))
            let decoder = JSONDecoder()
            var items: [ActivityItem] = []
            for line in data.split(separator: UInt8(ascii: "\n")) {
                guard let event = try? decoder.decode(QaEvent.self, from: Data(line)) else { continue }
                items.append(ActivityItem(id: items.count + 1, content: .event(event), date: event.date ?? Date()))
            }
            let focus = items.last { item in
                guard let event = item.event else { return false }
                if case .settle(_, _, _, let shot) = event.body { return shot != nil }
                if case .observe(let shot, _, _, _, _) = event.body { return shot != nil }
                return false
            }?.event?.stepKey
            testFilter = nil
            replay = ReplayState(run: run, items: items, focus: focus)
        } catch {
            banner = "실행 기록을 불러오지 못했습니다: \(error.localizedDescription)"
        }
    }

    func focusReplay(_ key: StepKey) {
        replay?.focus = key
    }

    func showEvidence(for event: QaEvent) {
        guard let key = event.stepKey else { return }
        let related = activity.compactMap(\.event).filter { $0.stepKey == key }
        evidence = EvidenceRequest(key: key, runDir: runDir(for: key.runId), events: related)
        if replay != nil { focusReplay(key) }
    }

    func open(path: String) {
        NSWorkspace.shared.open(URL(fileURLWithPath: path))
    }

    func reveal(path: String) {
        NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)])
    }
}
