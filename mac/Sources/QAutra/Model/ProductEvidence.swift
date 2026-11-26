import AppKit
import Foundation
import Observation
import UniformTypeIdentifiers

struct ProductEvidenceArtifact: Decodable, Identifiable, Sendable {
    let id: String
    let requestID: String
    let attemptID: String
    let runID: String
    let revisionID: String
    let testID: String
    let target: RegressionTarget
    let kind: String
    let relativePath: String
    let capturedAt: String
    let captureClock: String
    let privacy: String
    let state: String
    let sha256: String?
    let bytes: Int?
    let reason: String?
    let deletable: Bool
    let exportable: Bool
    let gaps: [ProductJSON]
}
struct ProductEvidenceLibrary: Decodable, Sendable {
    let artifacts: [ProductEvidenceArtifact]
    let limitations: [String]
    let externalTransmission: String
}
struct ProductEvidenceReportRow: Decodable, Identifiable, Sendable {
    let requestID: String
    let runName: String
    let attemptID: String
    let runID: String?
    let revisionID: String
    let testID: String
    let originalCaseIDs: [String]?
    let target: RegressionTarget
    let createdAt: String
    let business: String
    let execution: String
    let evidence: String
    let cleanup: String
    let code: String?
    let expected: [RegressionCheck]
    let requiredChecks: [String]
    let completedChecks: [String]
    let actual: ProductJSON
    let conditions: ProductJSON?
    let limitations: [String]
    var id: String { requestID + ":" + attemptID }
}
struct ProductEvidenceSymptom: Decodable, Identifiable, Sendable {
    let id: String
    let category: String
    let revisionID: String
    let testID: String
    let target: RegressionTarget
    let requiredChecks: [String]
    let symptom: String
    let attemptIDs: [String]
    let requestIDs: [String]
}
struct ProductEvidenceReports: Decodable, Sendable {
    let rows: [ProductEvidenceReportRow]
    let groups: [ProductEvidenceSymptom]
}
struct ProductEvidencePreview: Decodable, Identifiable, Sendable {
    let previewID: String
    let operation: String
    let scopeDigest: String
    let policyDigest: String
    let expiresAt: String
    let artifacts: [ProductEvidenceArtifact]
    let resultRows: Int
    let warning: String
    let blocked: [String]
    var id: String { previewID }
}
struct ProductEvidenceConsent: Decodable, Sendable {
    let consentID: String
    let scopeDigest: String
    let expiresAt: String
}
struct ProductEvidenceOutcome: Decodable, Sendable {
    struct Item: Decodable, Identifiable, Sendable {
        let artifactID: String
        let state: String
        let reason: String?
        var id: String { artifactID }
    }
    let operation: String
    let exportID: String?
    let filename: String?
    let outcomes: [Item]
    let outsideCopies: String
}

@MainActor @Observable
final class ProductEvidenceModel {
    var reports: ProductEvidenceReports?
    var library: ProductEvidenceLibrary?
    var preview: ProductEvidencePreview?
    var outcome: ProductEvidenceOutcome?
    var error: String?
    var loading = false
    var operating = false
    private var identity = ProductReadIdentity(api: nil)
    private var sequence = 0
    private var pendingPreviewID: String?
    private var exportCancellation: NativeExportCancellation?

    func bind(_ api: APIClient?) {
        let next = ProductReadIdentity(api: api)
        guard next != identity else { return }
        exportCancellation?.cancel()
        exportCancellation = nil
        identity = next
        sequence += 1
        pendingPreviewID = nil
        reports = nil; library = nil; preview = nil; outcome = nil; error = nil
        loading = false; operating = false
    }
    func refresh(api: APIClient?, filters: [String: String] = [:]) async {
        bind(api)
        guard let api else { return }
        sequence += 1
        let generation = sequence, current = identity
        loading = true; error = nil
        defer { if current == identity && generation == sequence { loading = false } }
        do {
            var cleanupProblem: String?
            if !operating {
                do { try await api.recoverProductEvidenceDownloads() }
                catch { cleanupProblem = error.localizedDescription }
            }
            var body: [String: ProductJSON] = ["method": .string("library")]
            for (key, value) in filters where !value.isEmpty { body[key] = .string(value) }
            let fetched: ProductEvidenceLibrary = try await api.productAction(section: "evidence", body: .object(body))
            let results: ProductEvidenceReports = try await api.productAction(section: "evidence", body: .object(["method": .string("reports")]))
            guard current == identity, current == ProductReadIdentity(api: api), generation == sequence, !Task.isCancelled else { return }
            library = fetched; reports = results
            error = cleanupProblem
        } catch {
            guard current == identity, generation == sequence, !Task.isCancelled else { return }
            self.error = error.localizedDescription
        }
    }
    func prepare(api: APIClient?, operation: String, requestIDs: [String], artifactIDs: [String]) async {
        bind(api)
        guard let api, !operating else { return }
        let current = identity
        operating = true; error = nil; outcome = nil
        defer { if current == identity { operating = false } }
        do {
            let result: ProductEvidencePreview = try await api.productAction(section: "evidence", body: .object([
                "method": .string("operation.preview"), "operation": .string(operation),
                "selection": .object(["requestIDs": .array(requestIDs.sorted().map(ProductJSON.string)), "artifactIDs": .array(artifactIDs.sorted().map(ProductJSON.string))])
            ]), humanReview: true)
            guard current == identity, !Task.isCancelled else { return }
            pendingPreviewID = result.id; preview = result
        } catch { if current == identity { self.error = error.localizedDescription } }
    }
    func confirm(api: APIClient?, preview confirmed: ProductEvidencePreview) async {
        bind(api)
        guard let api, !operating, pendingPreviewID == confirmed.id else { return }
        let current = identity
        pendingPreviewID = nil; preview = nil; operating = true; error = nil
        defer { if current == identity { operating = false } }
        do {
            let consent: ProductEvidenceConsent = try await api.productAction(section: "evidence", body: .object([
                "method": .string("consent.grant"), "previewID": .string(confirmed.previewID),
                "scopeDigest": .string(confirmed.scopeDigest), "acknowledgeRaw": .bool(true)
            ]), humanReview: true)
            guard current == identity, !Task.isCancelled else { return }
            let result: ProductEvidenceOutcome = try await api.productAction(section: "evidence", body: .object([
                "method": .string("operation.execute"), "consentID": .string(consent.consentID), "scopeDigest": .string(consent.scopeDigest)
            ]), humanReview: true)
            guard current == identity, !Task.isCancelled else { return }
            outcome = result
            if let exportID = result.exportID {
                let panel = NSSavePanel()
                panel.nameFieldStringValue = result.filename ?? "qautra-evidence.tar"
                panel.allowedContentTypes = [UTType(filenameExtension: "tar") ?? .data]
                guard panel.runModal() == .OK, let destination = panel.url, current == identity, !Task.isCancelled else { return }
                let cancellation = NativeExportCancellation()
                exportCancellation = cancellation
                defer { cancellation.cancel(); if current == identity { exportCancellation = nil } }
                try await api.productEvidenceSave(exportID: exportID, to: destination, cancellation: cancellation)
                guard current == identity, !Task.isCancelled else { return }
            }
            await refresh(api: api)
        } catch {
            if current == identity { self.error = "작업 결과 확인 필요: \(error.localizedDescription). 변경 명령은 자동 재전송하지 않습니다. 다시 조회하고 새 작업은 별도로 확인하세요." }
        }
    }
}
