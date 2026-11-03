import Foundation
import Darwin

@main struct NativeBootShareFixture {
    @MainActor static func main() throws {
        umask(0o077)
        guard CommandLine.arguments.count == 2 else { fatalError("Provide the private fixture root") }
        let base = URL(fileURLWithPath: CommandLine.arguments[1])
        let root = base.appendingPathComponent(".qa/instances/machines")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let store = try NativeStore(root: root.path)
        let id = UUID().uuidString.lowercased(), machine = root.appendingPathComponent(id)
        for suffix in ["kit", "status/recordings"] {
            try FileManager.default.createDirectory(at: machine.appendingPathComponent(suffix), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        }
        let metadata = NativeMetadata(root: root.path, rootId: store.rootId, id: id, name: "Boot-share fixture", platform: "desktop-safari", cpuCount: 2, memoryMiB: 4096, diskGiB: 64, state: "stopped", phase: "idle", installed: true)
        let boot: [String: Any] = ["version": 1, "instanceId": id, "epoch": 1, "bootToken": String(repeating: "a", count: 64), "platform": "desktop-safari"]
        try NativeFiles.writeNew(JSONSerialization.data(withJSONObject: boot), to: machine.appendingPathComponent("kit/instance.json").path)
        let video = machine.appendingPathComponent("status/recordings/video.mov").path
        var result: [String: String] = [:]
        func inspect(_ name: String) {
            do { try store.verifyBootShares(metadata); result[name] = "accepted" }
            catch let fault as NativeFault { result[name] = fault.code }
            catch { result[name] = "unexpected_error" }
        }
        try NativeFiles.sparseDisk(video, bytes: 32 * 1024 * 1024)
        inspect("retained32MiB")
        let fd = open(video, O_RDWR | O_NOFOLLOW | O_CLOEXEC)
        guard fd >= 0 else { fatalError("Missing private video fixture") }
        defer { close(fd) }
        guard ftruncate(fd, 1024 * 1024 * 1024) == 0 else { fatalError("Cannot size private video fixture") }
        inspect("retained1GiB")
        guard ftruncate(fd, 1024 * 1024 * 1024 + 16 * 1024 * 1024 + 1) == 0 else { fatalError("Cannot size private video fixture") }
        inspect("overBudget")
        guard ftruncate(fd, 32 * 1024 * 1024) == 0, chmod(video, 0o644) == 0 else { fatalError("Cannot change private fixture mode") }
        inspect("publicVideo")
        guard chmod(video, 0o600) == 0 else { fatalError("Cannot restore private fixture mode") }
        let alias = machine.appendingPathComponent("status/recordings/alias").path
        guard symlink(video, alias) == 0 else { fatalError("Cannot create fixture symlink") }
        inspect("symlinkVideo")
        guard unlink(alias) == 0, link(video, alias) == 0 else { fatalError("Cannot create fixture hardlink") }
        inspect("hardlinkedVideo")
        guard unlink(alias) == 0, mkfifo(alias, 0o600) == 0 else { fatalError("Cannot create fixture FIFO") }
        inspect("fifoVideo")
        print(String(data: try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]), encoding: .utf8)!)
    }
}
