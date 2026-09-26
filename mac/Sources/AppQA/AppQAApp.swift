// App entry: workspace window, runs history window, settings; engine shutdown on quit; foreground notifications.
import AppKit
import SwiftUI
import UserNotifications

@main
struct AppQAApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @State private var workspace = Workspace.shared

    var body: some Scene {
        Window("App QA", id: "workspace") {
            WorkspaceView()
                .environment(workspace)
                .frame(minWidth: 1180, minHeight: 700)
                .task { await workspace.boot() }
        }
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

    func applicationDidFinishLaunching(_ notification: Notification) {
        UNUserNotificationCenter.current().delegate = notifications
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

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
