import Foundation
import Darwin

@main
struct NativeRecoveryFixture {
    @MainActor
    static func main() {
        do { try run() }
        catch {
            FileHandle.standardError.write(Data("\(error)\n".utf8))
            exit(1)
        }
    }

    @MainActor
    static func run() throws {
        if CommandLine.arguments[1] == "hold" {
            let lease = try NativeFileLease(CommandLine.arguments[2])
            FileHandle.standardOutput.write(Data("ready\n".utf8))
            withExtendedLifetime(lease) { _ = FileHandle.standardInput.readDataToEndOfFile() }
            return
        }
        let scenario = CommandLine.arguments[1]
        let root = CommandLine.arguments[2]
        try FileManager.default.createDirectory(atPath: URL(fileURLWithPath: root).deletingLastPathComponent().path, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try NativeFiles.makeDirectory(root, exclusive: true)
        let store = try NativeStore(root: root)
        let id = UUID().uuidString.lowercased()
        var created: (NativeMetadata, NativeFileLease)? = try store.create(id: id, options: NativeCreateOptions(name: "Synthetic cold ownership record", platform: "desktop-safari", cpuCount: 2, memoryMiB: 4096, diskGiB: 64))
        var metadata = created!.0
        created = nil
        let directory = try store.directory(id)
        let image = directory + "/disk.img"
        try NativeFiles.sparseDisk(image, bytes: 64 * 1024 * 1024 * 1024)
        let marker = Data("QAutra retained disk content".utf8)
        let writer = try FileHandle(forWritingTo: URL(fileURLWithPath: image))
        try writer.write(contentsOf: marker)
        try writer.close()
        let hardware = Data("synthetic-hardware-identity".utf8)
        let identifier = Data("synthetic-machine-identity".utf8)
        try NativeFiles.writeNew(hardware, to: directory + "/hardware-model.bin")
        try NativeFiles.writeNew(identifier, to: directory + "/machine-identifier.bin")
        try NativeFiles.writeNew(Data("synthetic-auxiliary-storage".utf8), to: directory + "/auxiliary-storage")
        metadata.installed = true
        metadata.phase = "unknown"
        metadata.state = "unknown"
        metadata.error = "Previous owner exited without confirmation"
        metadata.artifacts = NativeArtifacts(diskIdentity: NativeFiles.identity(try NativeFiles.inspect(image)), auxiliaryIdentity: NativeFiles.identity(try NativeFiles.inspect(directory + "/auxiliary-storage")), hardwareHash: NativeFiles.hash(hardware), machineHash: NativeFiles.hash(identifier), minimumCPUCount: 2, minimumMemoryMiB: 4096)
        try store.save(metadata)
        let machine = NativeMachine(metadata: metadata, store: store)
        var holder: Process?
        var holderInput: Pipe?
        if ["image-busy", "machine-busy", "sidecar-busy"].contains(scenario) {
            let path: String
            if scenario == "image-busy" { path = image }
            else if scenario == "machine-busy" { path = directory + "/owner.lock" }
            else { path = store.runtime + "/disk-\(metadata.artifacts!.diskIdentity).lock" }
            let child = Process()
            child.executableURL = URL(fileURLWithPath: CommandLine.arguments[0])
            child.arguments = ["hold", path]
            let input = Pipe(), output = Pipe()
            child.standardInput = input
            child.standardOutput = output
            try child.run()
            var ready = Data()
            while ready.count < 6 {
                let data = output.fileHandleForReading.readData(ofLength: 6 - ready.count)
                guard !data.isEmpty else { throw NSError(domain: "FixtureHolder", code: 1) }
                ready.append(data)
            }
            guard ready == Data("ready\n".utf8) else { throw NSError(domain: "FixtureHolder", code: 2) }
            holder = child
            holderInput = input
        }
        defer {
            try? holderInput?.fileHandleForWriting.close()
            holder?.waitUntilExit()
        }
        if scenario == "changed-artifact" {
            let file = try FileHandle(forWritingTo: URL(fileURLWithPath: directory + "/hardware-model.bin"))
            try file.write(contentsOf: Data("changed".utf8))
            try file.close()
        }
        var fault: String?
        do { try machine.stop(force: scenario != "graceful") }
        catch let error as NativeFault { fault = error.code }
        if scenario == "historical" {
            var registrationFault: String?, observationFault: String?
            do { _ = try machine.registerRecovery([:]) }
            catch let error as NativeFault { registrationFault = error.code }
            do { _ = try machine.observeRecovery(["recorderId":.string(UUID().uuidString.lowercased()),"nativeGeneration":.string(UUID().uuidString.lowercased())]) }
            catch let error as NativeFault { observationFault = error.code }
            let archive = URL(fileURLWithPath: root).deletingLastPathComponent().appendingPathComponent("guest-attempts").path
            let result: [String: Any] = ["state":machine.metadata.state,"registrationFault":registrationFault as Any? ?? NSNull(),"observationFault":observationFault as Any? ?? NSNull(),"archiveCreated":FileManager.default.fileExists(atPath: archive)]
            print(String(decoding: try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]), as: UTF8.self))
            return
        }
        let persisted = try JSONDecoder().decode(NativeMetadata.self, from: NativeFiles.read(directory + "/native.json", maximum: 65536))
        let reader = try FileHandle(forReadingFrom: URL(fileURLWithPath: image))
        let retained = try reader.read(upToCount: marker.count)
        try reader.close()
        let result: [String: Any] = ["fault": fault as Any? ?? NSNull(), "state": persisted.state, "phase": persisted.phase, "sameMachine": persisted.id == id && persisted.rootId == metadata.rootId, "diskIdentityPreserved": NativeFiles.identity(try NativeFiles.inspect(image)) == metadata.artifacts!.diskIdentity, "diskContentPreserved": retained == marker, "noDisplay": !machine.canShow]
        print(String(decoding: try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]), as: UTF8.self))
    }
}
