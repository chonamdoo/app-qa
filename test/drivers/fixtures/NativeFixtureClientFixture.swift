import Darwin
import Foundation

@main
struct NativeFixtureClientFixture {
    static func main() {
        do { try initialize() }
        catch {
            let error = error as NSError
            let output: [String: Any] = ["state": "rejected", "domain": error.domain, "code": error.code]
            if let bytes = try? JSONSerialization.data(withJSONObject: output, options: [.sortedKeys]) { FileHandle.standardError.write(bytes) }
            exit(2)
        }
    }
    private static func initialize() throws {
        guard CommandLine.arguments.count == 2 else { throw CocoaError(.fileReadNoPermission) }
        let home = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true).standardizedFileURL
        let support = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: false).standardizedFileURL
        guard home.resolvingSymlinksInPath() == home, support.path.hasPrefix(home.path + "/"), Bundle.main.bundleIdentifier == "dev.qautra.fixture.client-restart" else {
            throw CocoaError(.fileReadNoPermission)
        }
        let principal = ["clientAuthorityId": "restart-client", "principalRef": "restart-principal", "accountRef": "restart-account", "tenant": "restart-tenant"]
        let client = try QAutraFixtureClient(clientEndpoint: URL(string: "https://client.invalid/claim")!, appCredential: String(repeating: "x", count: 32), expectedPrincipal: principal)
        client.stop()
        let output: [String: Any] = ["state": "initialized", "support": support.path]
        FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: output, options: [.sortedKeys]))
    }
}
