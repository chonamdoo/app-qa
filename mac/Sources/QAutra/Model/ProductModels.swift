import Foundation

struct ProductSnapshot: Decodable, Sendable {
    let revision: Int
    let scenarios: [ProductScenario]
    let documents: [ProductDocument]
    let environments: [ProductEnvironment]
    let settings: ProductSettings
}

struct ProductScenario: Decodable, Identifiable, Sendable {
    let id: String
    let name: String
    let expected: String?
    let requirementID: String?
    let app: String
    let platforms: [String]
    let createdAt: String
    let path: String
    let definition: ProductJSON?
    let source: ProductScenarioSource?
    let executable: Bool?
    let problems: [ProductJSON]?
    let legacy: ProductJSON?
}

struct ProductDocument: Decodable, Identifiable, Sendable {
    let id: String
    let name: String
    let path: String
    let sha256: String
    let createdAt: String
    let segments: [ProductSourceSegment]?
    let originalPath: String?
    let ledgerDigest: String?
    let issues: [ProductJSON]?
    var jsonRows: [ProductJSONSourceRow]? = nil
    var derivation: ProductJSONSourceDerivation? = nil
}

struct ProductJSONSourceRow: Decodable, Sendable {
    let index: Int
    let startByte: Int
    let endByte: Int
}

struct ProductJSONSourceDerivation: Decodable, Sendable {
    let kind: String
    let documentID: String
    let name: String
    let path: String
    let sha256: String
    let ledgerDigest: String
    let rowCount: Int
    let row: ProductJSONSourceRow
}

struct ProductEnvironment: Decodable, Identifiable, Sendable {
    let id: String
    let name: String
    let platform: String
    let deviceID: String?
    let createdAt: String
}

struct ProductSettings: Codable, Sendable {
    var frontendURL: String
    var apiURL: String
    var webLimit: Int
    var androidLimit: Int
    var iosLimit: Int
    var totalLimit: Int
    var retentionDays: Int
    var codexEnabled: Bool
    var claudeEnabled: Bool
}

struct ProductScenarioRequest: Encodable, Sendable {
    let revision: Int
    let definition: ProductJSON
    let source: ProductScenarioSource
    var id: String? = nil
}

struct ProductDocumentRequest: Encodable, Sendable {
    let revision: Int
    let name: String
    let path: String
}

struct ProductDocumentRowsRequest: Encodable, Sendable {
    let revision: Int
    let documentID: String
}

struct ProductEnvironmentRequest: Encodable, Sendable {
    let revision: Int
    let name: String
    let platform: String
    let deviceID: String?
}

struct ProductSettingsRequest: Encodable, Sendable {
    let revision: Int
    let settings: ProductSettings
}

struct ProductSourceIdentity: Hashable, Sendable {
    let documentID: String
    private let segmentBytes: Data

    init(documentID: String, segmentID: String) {
        self.documentID = documentID
        segmentBytes = Data(segmentID.utf8)
    }
}

struct ProductSourceSegment: Codable, Identifiable, Sendable {
    let id: String
    let locator: String
    let text: String
    let kind: String
    var byteIdentity: Data { Data(id.utf8) }
}

struct ProductSourceMapping: Codable, Sendable {
    let documentID: String
    let segmentID: String
    let disposition: String
    let stepPaths: [String]
    let checkPaths: [String]
    let reason: String
    var role: String? = nil
    var logicalCaseID: String? = nil
    var originalCaseID: String? = nil
}

struct ProductManualSourceResolution: Codable, Equatable, Sendable {
    let kind: String
    let documentID: String
    let sourceSha256: String
    let sourceLedgerDigest: String
    let transcriptDocumentID: String
    let transcriptSha256: String
    let transcriptLedgerDigest: String
    let coverage: String
}

struct ProductScenarioSource: Codable, Sendable {
    let documentIDs: [String]
    let notes: String
    let mappings: [ProductSourceMapping]
    let reviewed: Bool
    var resolutions: [ProductManualSourceResolution]? = nil
}
