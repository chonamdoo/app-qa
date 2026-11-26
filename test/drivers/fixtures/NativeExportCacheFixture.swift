import Darwin
import Foundation

// Only the UI error carrier is supplied here; the shipping cache implementation is compiled unchanged.
struct APIError: Error {
    let status: Int
    let message: String
}

private struct CacheInput: Decodable {
    let root: String
    let lease: NativeExportLease
}

private actor Retirement {
    private var requests = 0

    func apply(_ lease: NativeExportLease) throws {
        requests += 1
        let marker: [String: Any] = [
            "schema": "qautra/native-export-retired/v1", "id": lease.id,
            "secret": lease.secret, "retiredAt": ISO8601DateFormatter().string(from: Date())
        ]
        let file = URL(fileURLWithPath: lease.directory).appendingPathComponent("retired.json")
        try JSONSerialization.data(withJSONObject: marker).write(to: file, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
    }

    func count() -> Int { requests }
}

@main
struct NativeExportCacheFixture {
    static func main() async throws {
        umask(0o077)
        guard CommandLine.arguments.count == 2 else { throw CocoaError(.fileReadInvalidFileName) }
        let input = try JSONDecoder().decode(CacheInput.self, from: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1])))
        let retirement = Retirement()
        let state: String
        do {
            try await NativeExportCache.reap(root: input.root, lease: input.lease) {
                try await retirement.apply(input.lease)
            }
            state = "closed"
        } catch { state = "blocked" }
        let result: [String: Any] = ["state": state, "retireCalls": await retirement.count()]
        FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]))
        FileHandle.standardOutput.write(Data("\n".utf8))
    }
}
