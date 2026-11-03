import AppKit
import Foundation
import Observation
import UserNotifications

/// Mirror of the engine's `--platform` choice: one platform, or `all` = every platform of the selected profile.
enum PlatformChoice: String, CaseIterable, Identifiable, Sendable {
    case android, ios
    case desktopChrome = "desktop-chrome"
    case desktopSafari = "desktop-safari"
    case all

    /// Every platform id, in display order.
    static let platformIds = allCases.filter { $0 != .all }.map(\.rawValue)

    var id: String { rawValue }
    /// Website profiles name the browser that runs (Android Chrome, iOS Safari).
    func label(web: Bool) -> String {
        if self == .all { return web ? "전체" : "둘 다" }
        return (web ? Palette.webPlatformLabel : Palette.platformLabel)[rawValue] ?? rawValue
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
    var guestInstanceUIStates: [ProductReadIdentity: GuestInstanceUIState] = [:]
    let regression = ProductRegression()

    // Toolbar selections (persisted).
    private(set) var profiles: [AppProfile] = []
    private(set) var profileErrors: [AppProfilesResponse.LoadError] = []
    var selectedApp: String? {
        didSet {
            guard selectedApp != oldValue else { return }
            UserDefaults.standard.set(selectedApp, forKey: "selectedApp")
            normalizePlatform()
            Task { await loadPlan() }
        }
    }
    var platform: PlatformChoice = .android {
        didSet {
            UserDefaults.standard.set(platform.rawValue, forKey: "platform")
            if !activePlatforms.contains(devicePane) { devicePane = activePlatforms.first ?? "android" }
        }
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

    // Device pane.
    /// Overlay marks of the step currently running on each platform (cleared when the next step starts).
    private(set) var marks: [String: StepMarks] = [:]
    private(set) var recordings: [RecordingInfo] = []
    var devicePane: String = "android"
    private(set) var lastReportPath: String?

    // Runs history.
    private(set) var runs: [RunListItem] = []
    private(set) var runsError: String?
    private(set) var runsLoading = false
    var requestedRunID: String?
    var requestedReplayConsoleID: String?


    enum DirectSessionOperation { case refresh, cancel, close }
    private(set) var directSessions: [AgentSessionView] = []
    private(set) var directSessionID: String?
    private(set) var directSession: AgentSessionView?
    private(set) var directScript: AgentScriptView?
    private(set) var directOperation: DirectSessionOperation?
    private(set) var directError: String?
    private(set) var directMutationMessage: String?
    private(set) var directMeta: AgentMeta?
    private(set) var directMutationMeta: AgentMeta?
    private(set) var directMutationTarget: String?
    private(set) var directUpdatedAt: Date?
    @ObservationIgnored private var directTask: Task<Void, Never>?
    @ObservationIgnored private var connectionGeneration = 0
    @ObservationIgnored private var directGeneration = 0
    @ObservationIgnored private var directScriptIDs: [String: String] = [:]
    @ObservationIgnored private var directCancelAttempts: Set<String> = []
    @ObservationIgnored private var directCloseAttempts: Set<String> = []
    @ObservationIgnored private var directMutationInFlight = false
    @ObservationIgnored private var profilesRead = 0
    @ObservationIgnored private var devicesRead = 0
    @ObservationIgnored private var jobsRead = 0
    @ObservationIgnored private var recordingsRead = 0
    @ObservationIgnored private var planRead = 0
    @ObservationIgnored private var replayRead = 0

    var evidence: EvidenceRequest?
    var banner: String?

    @ObservationIgnored private var streamTask: Task<Void, Never>?
    @ObservationIgnored private var disconnects = 0
    @ObservationIgnored private var booted = false

    private init() {
        let defaults = UserDefaults.standard
        selectedApp = defaults.string(forKey: "selectedApp")
        platform = defaults.string(forKey: "platform").flatMap(PlatformChoice.init(rawValue:)) ?? .android
        selectedDevice = (defaults.dictionary(forKey: "selectedDevice") as? [String: String]) ?? [:]
        devicePane = platform == .all ? "android" : platform.rawValue
    }


    func boot() async {
        guard !booted else { return }
        booted = true
        _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound])
        engine.onConnect = { [weak self] api, _ in self?.connected(api) }
        engine.onDisconnect = { [weak self] in
            self?.api = nil
            self?.regression.bind(nil)
            self?.connectionGeneration += 1
            self?.streamTask?.cancel()
            self?.streamLive = false
            self?.clearConnectionData()
            self?.runs = []
            self?.runsLoading = false
            self?.runsError = "엔진 연결이 종료되어 실행 기록을 다시 조회해야 합니다"
            self?.invalidateDirectSessions(message: "엔진 연결이 종료되어 현재 세션 상태를 알 수 없습니다")
        }
        await engine.start()
    }

    private func connected(_ api: APIClient) {
        invalidateDirectSessions(message: nil)
        connectionGeneration += 1
        self.api = api
        clearConnectionData()
        regression.bind(api)
        runs = []
        runsLoading = false
        runsError = nil
        streamTask?.cancel()
        let generation = connectionGeneration
        disconnects = 0
        note("엔진에 연결됨 · 127.0.0.1:\(api.base.port ?? 0)", level: "info")
        streamTask = Task { [weak self] in
            for await message in EventStream.messages(api: api, startAfter: 0) {
                guard let self, !Task.isCancelled, generation == self.connectionGeneration else { return }
                self.handle(message)
            }
        }
        Task { await refreshAll() }
    }

    private func clearConnectionData() {
        replay = nil; live = []; marks = [:]
        runDirs = [:]; testNames = [:]; profiles = []; profileErrors = []; devices = []; jobs = []
        recordings = []; plan = nil; planMessage = nil; lastReportPath = nil
    }

    func refreshAll() async {
        refreshDirectSessions()
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
            invalidateDirectSessions(message: "연결이 끊겨 세션 상태가 최신인지 확인할 수 없습니다. 새로고침으로 다시 조회하세요.")
            streamLive = false
            disconnects += 1
            if disconnects == 1 { note("이벤트 스트림 끊김 — 재연결 중 (\(reason))", level: "warn") }
            if disconnects == 3 { Task { await engine.recover() } }
        }
    }


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
        case .runStarted(let runID, let directory, let tests, _):
            runDirs[runID] = directory
            for test in tests { testNames[test.id] = test.name }
        case .testStarted(let name):
            if let testID = event.testId { testNames[testID] = name }
        case .stepStarted:
            if let key = event.stepKey { marks[key.platform] = StepMarks() }
        case .decision, .action:
            if let platform = event.platform { marks[platform, default: StepMarks()].apply(event) }
        default: break
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


    func devices(for platform: String) -> [DeviceInfo] { devices.filter { $0.platform == platform } }

    var selectedProfile: AppProfile? { profiles.first { $0.id == selectedApp } }

    /// Website profile: device platforms run the browser app (labels say Android Chrome / iOS Safari).
    var isWebApp: Bool { selectedProfile?.web != nil }

    /// Toolbar choices: the profile's server-derived `platforms` (app → configured android/ios, web → its browsers),
    /// plus `all` (둘 다 / 전체) only when there is more than one. No profile loaded → nothing to choose.
    var platformChoices: [PlatformChoice] {
        let choices = (selectedProfile?.platforms ?? []).compactMap(PlatformChoice.init(rawValue:))
        return choices.count > 1 ? choices + [.all] : choices
    }

    /// Platforms the current choice runs on (`all` = the profile's platforms, as the engine expands it).
    var activePlatforms: [String] {
        guard platform == .all else { return [platform.rawValue] }
        return selectedProfile?.platforms ?? []
    }

    func label(platform: String) -> String { (isWebApp ? Palette.webPlatformLabel : Palette.platformLabel)[platform] ?? platform }

    /// A choice the selected profile cannot run (desktop Chrome after switching to an app, iOS on an Android-only app)
    /// falls back to `all`, or to the profile's only platform.
    private func normalizePlatform() {
        if !platformChoices.contains(platform), let fallback = platformChoices.last { platform = fallback }
        if !activePlatforms.contains(devicePane) { devicePane = activePlatforms.first ?? "android" }
    }


    func isRecording(platform: String) -> Bool {
        guard let id = selectedDevice[platform] else { return false }
        return recordings.contains { $0.platform == platform && $0.deviceId == id }
    }

    /// Active platforms with a screen to record (desktop browsers have none).
    var recordablePlatforms: [String] { activePlatforms.filter { !Palette.desktopPlatforms.contains($0) } }

    var anyRecording: Bool { recordablePlatforms.contains { isRecording(platform: $0) } }

    struct StepScreenshot: Equatable, Sendable {
        let key: StepKey
        let path: String
        /// Pre-action (observe) screenshot: the step's marks were resolved on it.
        let isBefore: Bool
    }

    /// Legacy pane fallback: only this platform's newest saved step, never another target's image.
    func latestScreenshot(platform: String) -> StepScreenshot? {
        for item in live.reversed() {
            guard let event = item.event, let key = event.stepKey, key.platform == platform else { continue }
            switch event.body {
            case .observe(let shot?, _, _, _, _): return StepScreenshot(key: key, path: shot, isBefore: true)
            case .settle(_, _, _, let shot?): return StepScreenshot(key: key, path: shot, isBefore: false)
            default: continue
            }
        }
        return nil
    }



    func loadProfiles() async {
        guard let api else { return }
        let generation = connectionGeneration
        profilesRead += 1; let ticket = profilesRead
        do {
            let response: AppProfilesResponse = try await api.get("/api/app-profiles")
            guard generation == connectionGeneration, ticket == profilesRead, !Task.isCancelled else { return }
            profiles = response.profiles
            profileErrors = response.errors
            if selectedApp == nil || !profiles.contains(where: { $0.id == selectedApp }) { selectedApp = profiles.first?.id }
            normalizePlatform()
        } catch {
            guard generation == connectionGeneration, ticket == profilesRead, !Task.isCancelled else { return }
            banner = "앱 프로필을 불러오지 못했습니다: \(error.localizedDescription)"
        }
    }

    func loadDevices() async {
        guard let api else { return }
        let generation = connectionGeneration
        devicesRead += 1; let ticket = devicesRead
        do {
            let response: DevicesResponse = try await api.get("/api/devices")
            guard generation == connectionGeneration, ticket == devicesRead, !Task.isCancelled else { return }
            devices = response.devices
            devicesError = nil
            for platform in PlatformChoice.platformIds {
                let candidates = devices(for: platform)
                if let current = selectedDevice[platform], candidates.contains(where: { $0.id == current }) { continue }
                selectedDevice[platform] = (candidates.first { $0.state == "booted" } ?? candidates.first)?.id
            }
        } catch {
            guard generation == connectionGeneration, ticket == devicesRead, !Task.isCancelled else { return }
            devicesError = error.localizedDescription
        }
    }

    func loadJobs() async {
        guard let api else { return }
        let generation = connectionGeneration
        jobsRead += 1; let ticket = jobsRead
        if let response: JobsResponse = try? await api.get("/api/jobs"),
           generation == connectionGeneration, ticket == jobsRead, !Task.isCancelled { jobs = response.jobs }
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
        guard !runsLoading else { return }
        guard let api else {
            runs = []
            runsError = "엔진에 연결되지 않아 실행 기록을 조회할 수 없습니다"
            return
        }
        let generation = connectionGeneration
        runsLoading = true
        runs = []
        runsError = nil
        defer {
            if generation == connectionGeneration { runsLoading = false }
        }
        do {
            let response = try await api.get("/api/runs", as: RunsResponse.self)
            guard generation == connectionGeneration, !Task.isCancelled else { return }
            runs = response.runs
            if lastReportPath == nil { lastReportPath = runs.first { $0.reportPath != nil }?.reportPath }
        } catch {
            guard generation == connectionGeneration else { return }
            runsError = error.localizedDescription
        }
    }

    func loadRecordings() async {
        guard let api else { return }
        let generation = connectionGeneration
        recordingsRead += 1; let ticket = recordingsRead
        if let response: RecordingsResponse = try? await api.get("/api/recordings"),
           generation == connectionGeneration, ticket == recordingsRead, !Task.isCancelled { recordings = response.recordings }
    }

    func loadPlan() async {
        guard let api, let app = selectedApp else {
            plan = nil
            return
        }
        let generation = connectionGeneration
        planRead += 1; let ticket = planRead
        do {
            let value: PlanView = try await api.get("/api/plans/\(APIClient.segment(app))")
            guard generation == connectionGeneration, ticket == planRead, selectedApp == app, !Task.isCancelled else { return }
            plan = value
            planMessage = nil
        } catch let error as APIError where error.status == 404 {
            guard generation == connectionGeneration, ticket == planRead, selectedApp == app, !Task.isCancelled else { return }
            plan = nil
            planMessage = "이 프로젝트의 legacy 계획이 없습니다. 일반 QA는 시나리오에서 원문·단계를 준비하고 발행본으로 실행하세요."
        } catch {
            guard generation == connectionGeneration, ticket == planRead, selectedApp == app, !Task.isCancelled else { return }
            plan = nil
            planMessage = error.localizedDescription
        }
    }

    var canCancelDirectScript: Bool {
        guard directOperation == nil, directUpdatedAt != nil,
              let session = directSession, let script = directScript else { return false }
        return session.activeScriptId == script.scriptId && script.state == "running"
            && !directCancelAttempts.contains(script.scriptId)
    }

    var canCloseDirectSession: Bool {
        guard directOperation == nil, directUpdatedAt != nil, let session = directSession else { return false }
        return session.canClose && !directCloseAttempts.contains(session.sessionId)
    }

    private func invalidateDirectSessions(message: String?) {
        if directMutationInFlight {
            directMutationMessage = "unknown · 변경 요청 도중 연결이 끊겼습니다. 반영·종료 여부를 알 수 없어 재전송하지 않습니다."
        }
        directGeneration += 1
        directTask?.cancel()
        directTask = nil
        directOperation = nil
        directMutationInFlight = false
        directSessions = []
        directSession = nil
        directScript = nil
        directUpdatedAt = nil
        directMeta = nil
        directError = message
    }

    private func checkDirectGeneration(_ generation: Int) throws {
        guard !Task.isCancelled, generation == directGeneration, engine.phase == .connected else {
            throw CancellationError()
        }
    }

    private func beginDirectOperation(
        _ operation: DirectSessionOperation,
        work: @escaping @MainActor (APIClient, Int) async throws -> Void
    ) {
        guard directOperation == nil else { return }
        guard let api, engine.phase == .connected else {
            invalidateDirectSessions(message: "엔진에 연결된 뒤 세션을 조회할 수 있습니다")
            return
        }
        directGeneration += 1
        let generation = directGeneration
        directOperation = operation
        directError = nil
        directMeta = nil
        directUpdatedAt = nil
        directSession = nil
        directScript = nil
        directTask = Task {
            do {
                try await work(api, generation)
            } catch {
                guard generation == directGeneration else { return }
                directSessions = []
                directSession = nil
                directScript = nil
                directUpdatedAt = nil
                directError = error.localizedDescription
                if let remote = error as? AgentRemoteError { directMeta = remote.meta }
            }
            guard generation == directGeneration else { return }
            directMutationInFlight = false
            directOperation = nil
            directTask = nil
        }
    }

    func refreshDirectSessions() {
        beginDirectOperation(.refresh) { [self] api, generation in
            try await reconcileDirectSessions(api: api, generation: generation)
        }
    }

    func selectDirectSession(_ id: String) {
        guard directOperation == nil, directSessions.contains(where: { $0.sessionId == id }) else { return }
        directSessionID = id
        refreshDirectSessions()
    }

    private func reconcileDirectSessions(api: APIClient, generation: Int) async throws {
        let list = try await api.agent(.list, as: [AgentSessionView].self)
        try checkDirectGeneration(generation)
        var sessions = list.value
        let id = directSessionID.flatMap { selected in sessions.first { $0.sessionId == selected }?.sessionId }
            ?? sessions.first?.sessionId
        var session: AgentSessionView?
        var script: AgentScriptView?
        var meta = list.meta
        if let id {
            let status = try await api.agent(.status(id), as: AgentSessionView.self)
            try checkDirectGeneration(generation)
            guard status.value.sessionId == id else {
                throw APIError(status: 0, message: "session.status의 세션 ID가 일치하지 않습니다")
            }
            session = status.value
            meta = status.meta
            if let index = sessions.firstIndex(where: { $0.sessionId == id }) { sessions[index] = status.value }
            if let scriptID = status.value.activeScriptId ?? directScriptIDs[id] {
                let execution = try await api.agent(.scriptStatus(scriptID), as: AgentScriptView.self)
                try checkDirectGeneration(generation)
                guard execution.value.scriptId == scriptID, execution.value.sessionIds.contains(id) else {
                    throw APIError(status: 0, message: "script.status의 세션 소유권이 일치하지 않습니다")
                }
                script = execution.value
                meta = execution.meta
                directScriptIDs[id] = scriptID
            }
        }
        directSessions = sessions
        directSessionID = id
        directSession = session
        directScript = script
        directMeta = meta
        directUpdatedAt = Date()
    }

    func cancelDirectScript() {
        guard canCancelDirectScript, let session = directSession, let script = directScript else { return }
        beginDirectOperation(.cancel) { [self] api, generation in
            let current = try await api.agent(.status(session.sessionId), as: AgentSessionView.self)
            try checkDirectGeneration(generation)
            let execution = try await api.agent(.scriptStatus(script.scriptId), as: AgentScriptView.self)
            try checkDirectGeneration(generation)
            guard current.value.activeScriptId == script.scriptId, execution.value.state == "running" else {
                directMutationMessage = "실행 소유권·상태가 바뀌어 취소 요청을 보내지 않았습니다."
                try await reconcileDirectSessions(api: api, generation: generation)
                return
            }
            directCancelAttempts.insert(script.scriptId)
            directMutationInFlight = true
            directMutationTarget = "scriptId: \(script.scriptId)"
            directMutationMeta = nil
            directMutationMessage = "script.cancel 응답을 기다리는 중입니다. 드라이버 종료 확인과는 별개입니다."
            do {
                let response = try await api.agent(.scriptCancel(script.scriptId), as: AgentScriptView.self, timeout: 150)
                try checkDirectGeneration(generation)
                directMutationMeta = response.meta
                directMutationMessage = "취소 응답: \(response.value.state)"
                    + (response.value.error.map { " · \($0.code): \($0.message) · effect=\($0.effect)" } ?? "")
                    + " · 드라이버 종료·소유권 해제를 확인한 뜻이 아닙니다."
                directMutationInFlight = false
            } catch {
                try checkDirectGeneration(generation)
                recordDirectMutationError(error, action: "취소")
            }
            try await reconcileDirectSessions(api: api, generation: generation)
        }
    }

    func closeDirectSession() {
        guard canCloseDirectSession, let session = directSession else { return }
        beginDirectOperation(.close) { [self] api, generation in
            let current = try await api.agent(.status(session.sessionId), as: AgentSessionView.self)
            try checkDirectGeneration(generation)
            guard current.value.sessionId == session.sessionId, current.value.canClose else {
                directMutationMessage = "세션이 유휴 상태가 아니어서 닫기 요청을 보내지 않았습니다."
                try await reconcileDirectSessions(api: api, generation: generation)
                return
            }
            directCloseAttempts.insert(session.sessionId)
            directMutationInFlight = true
            directMutationTarget = "sessionId: \(session.sessionId)"
            directMutationMeta = nil
            directMutationMessage = "session.close 응답을 기다리는 중입니다."
            do {
                let response = try await api.agent(.close(session.sessionId), as: AgentSessionView.self, timeout: 150)
                try checkDirectGeneration(generation)
                directMutationMeta = response.meta
                directMutationMessage = "닫기 응답: \(response.value.state)"
                    + (response.value.stopReason.map { " · \($0)" } ?? "")
                directMutationInFlight = false
            } catch {
                try checkDirectGeneration(generation)
                recordDirectMutationError(error, action: "닫기")
            }
            try await reconcileDirectSessions(api: api, generation: generation)
        }
    }

    private func recordDirectMutationError(_ error: Error, action: String) {
        directMutationInFlight = false
        if let remote = error as? AgentRemoteError {
            directMutationMeta = remote.meta
            directMutationMessage = "\(action) 오류 · \(remote.localizedDescription) · 요청을 재전송하지 않습니다."
        } else {
            directMutationMeta = nil
            directMutationMessage = "\(action) 결과 unknown · \(error.localizedDescription) · 반영 여부를 알 수 없어 재전송하지 않습니다."
        }
    }








    func startReplay(_ run: RunListItem) async {
        guard let api else { return }
        let generation = connectionGeneration
        replayRead += 1; let ticket = replayRead
        replay = nil
        do {
            let data = try await api.data(for: api.request("/api/runs/\(APIClient.segment(run.runId))/events"))
            guard generation == connectionGeneration, ticket == replayRead, !Task.isCancelled else { return }
            let decoder = JSONDecoder()
            var items: [ActivityItem] = []
            for line in data.split(separator: UInt8(ascii: "\n")) {
                let event = try decoder.decode(QaEvent.self, from: Data(line))
                guard event.runId == run.runId else { throw APIError(status: 0, message: "다른 실행의 이벤트가 섞여 있습니다") }
                items.append(ActivityItem(id: items.count + 1, content: .event(event), date: event.date ?? .distantPast))
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
            guard generation == connectionGeneration, ticket == replayRead, !Task.isCancelled else { return }
            banner = "실행 기록을 불러오지 못했습니다: \(error.localizedDescription)"
        }
    }

    func focusReplay(_ key: StepKey) {
        guard replay?.run.runId == key.runId else { return }
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
