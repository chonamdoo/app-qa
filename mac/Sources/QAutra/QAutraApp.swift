import AppKit
import SwiftUI
import UserNotifications

@main
struct QAutraApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @State private var workspace = Workspace.shared
    @State private var catalog = ProductCatalog()

    var body: some Scene {
        Window("QAutra", id: "workspace") {
            ProductShellView()
                .environment(workspace)
                .environment(catalog)
                .frame(minWidth: 1024, minHeight: 700)
                .task { await workspace.boot() }
        }
        .windowStyle(.hiddenTitleBar)
        .defaultSize(width: 1480, height: 900)
        .commands {
            CommandGroup(after: .windowArrangement) {
                OpenRunsCommand()
            }
            CommandGroup(replacing: .newItem) {}
        }

        Window("실행 기록", id: "runs") {
            RunsView()
                .environment(workspace)
        }
        .defaultSize(width: 920, height: 560)

        Settings {
            SettingsView()
                .environment(workspace)
        }
    }
}

private struct OpenRunsCommand: View {
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        Button("실행 기록") { openWindow(id: "runs") }
            .keyboardShortcut("r", modifiers: [.command, .shift])
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    private let notifications = NotificationPresenter()
    private var terminationPending = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        UNUserNotificationCenter.current().delegate = notifications
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard !terminationPending else { return .terminateCancel }
        terminationPending = true
        Workspace.shared.regression.draining = true
        Task { @MainActor in
            let allowed = await prepareTermination()
            if !allowed { Workspace.shared.regression.draining = false }
            terminationPending = false
            sender.reply(toApplicationShouldTerminate: allowed)
        }
        return .terminateLater
    }

    @MainActor private func prepareTermination() async -> Bool {
        let workspace = Workspace.shared
        guard let api = workspace.api else {
            let alert = NSAlert()
            alert.messageText = "엔진 연결 상태를 확인할 수 없습니다."
            alert.informativeText = "진행 작업의 종료·영상·정리를 확인하지 못했습니다. 종료를 취소하고 다시 연결하거나, 상태가 미확인인 채 앱만 종료할 수 있습니다. 안전한 정리나 백그라운드 완료를 보장하지 않습니다."
            alert.addButton(withTitle: "종료 취소")
            alert.addButton(withTitle: "미확인 상태로 앱 종료")
            return alert.runModal() == .alertSecondButtonReturn
        }
        let identity = ProductReadIdentity(api: api)
        func checkConnection() throws {
            guard identity == ProductReadIdentity(api: workspace.api) else { throw APIError(status: 0, message: "종료 대조 중 엔진 연결이 바뀌었습니다") }
        }
        do {
            var runs: [RegressionRun] = try await api.regression(RegressionCommand(method: "regression.list"))
            let jobs: JobsResponse = try await api.get("/api/jobs")
            var sessions = try await api.agent(.list, as: [AgentSessionView].self).value
            try checkConnection()
            let activeRuns = runs.filter { !$0.terminal }
            let activeIDs = Set(activeRuns.map(\.id))
            let activeJobs = jobs.jobs.filter(\.isActive)
            let openSessions = sessions.filter { $0.state != "closed" }
            if workspace.regression.intents.contains(where: { intent in intent.attempted && intent.belongs(to: api) && !runs.contains(where: { $0.id == intent.id }) }) {
                throw APIError(status: 0, message: "전송한 요청 중 durable 접수 여부가 미확인인 기록이 있습니다. 같은 UUID 상태 조회로 대조하세요.")
            }
            if activeRuns.isEmpty && activeJobs.isEmpty && openSessions.isEmpty { return true }
            let alert = NSAlert()
            alert.messageText = "진행 중인 QA 작업이 있습니다."
            alert.informativeText = "실행 \(activeRuns.count)개 · 이전 작업 \(activeJobs.count)개 · 직접 세션 \(openSessions.count)개. 중지 후 종료는 새 입력을 막고 영상 확정·소유 자원 정리 완료를 기다립니다. 창만 닫으면 실행은 유지됩니다."
            alert.addButton(withTitle: "계속 실행")
            alert.addButton(withTitle: "중지 후 종료")
            guard alert.runModal() == .alertSecondButtonReturn else { return false }
            for run in activeRuns {
                try checkConnection()
                let _: RegressionRun = try await api.regression(RegressionCommand(method: "regression.stop", requestId: run.id))
            }
            for job in activeJobs { try checkConnection(); try await api.postEmpty("/api/jobs/\(APIClient.segment(job.id))/cancel") }
            var cancelledScripts = Set<String>()
            var closedSessions = Set<String>()
            var deadline = Date().addingTimeInterval(30)
            while identity == ProductReadIdentity(api: workspace.api) {
                for session in sessions where session.state != "closed" {
                    try checkConnection()
                    if let scriptID = session.activeScriptId, cancelledScripts.insert(scriptID).inserted {
                        let _: AgentReply<AgentScriptView> = try await api.agent(.scriptCancel(scriptID))
                    } else if session.canClose && closedSessions.insert(session.id).inserted {
                        let _: AgentReply<AgentSessionView> = try await api.agent(.close(session.id))
                    }
                }
                runs = try await api.regression(RegressionCommand(method: "regression.list"))
                let latestJobs: JobsResponse = try await api.get("/api/jobs")
                sessions = try await api.agent(.list, as: [AgentSessionView].self).value
                try checkConnection()
                let pending = runs.filter { !$0.terminal }
                let uncertain = runs.filter { activeIDs.contains($0.id) && ($0.state == "unknown" || $0.attempts.contains { $0.cleanup == "unknown" }) }
                if pending.isEmpty && latestJobs.jobs.allSatisfy({ !$0.isActive }) && sessions.allSatisfy({ $0.state == "closed" }) {
                    if uncertain.isEmpty { return true }
                    throw APIError(status: 0, message: "중지한 실행의 효과·자원 정리가 미확인입니다. 복구 상태를 확인해야 합니다.")
                }
                if Date() >= deadline {
                    let waiting = NSAlert()
                    waiting.messageText = "영상·자원 정리를 아직 기다리고 있습니다."
                    waiting.informativeText = "완료로 간주하거나 엔진을 강제 종료하지 않습니다. 종료를 취소해 상태를 보거나 계속 기다리세요."
                    waiting.addButton(withTitle: "종료 취소")
                    waiting.addButton(withTitle: "계속 기다리기")
                    guard waiting.runModal() == .alertSecondButtonReturn else { return false }
                    deadline = Date().addingTimeInterval(30)
                }
                try await Task.sleep(for: .seconds(1))
            }
            throw APIError(status: 0, message: "정리 도중 엔진 연결이 변경되었습니다.")
        } catch {
            let alert = NSAlert()
            alert.messageText = "안전한 종료를 확인하지 못했습니다."
            alert.informativeText = "\(error.localizedDescription). 변경 명령을 다시 보내지 않습니다. 앱을 유지하고 실행·복구 상태를 조회하세요."
            alert.addButton(withTitle: "앱으로 돌아가기")
            alert.runModal()
            return false
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        Workspace.shared.engine.stop()
    }
}

/// Shows job notifications even while the app is frontmost.
final class NotificationPresenter: NSObject, UNUserNotificationCenterDelegate, Sendable {
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .sound]
    }
}
