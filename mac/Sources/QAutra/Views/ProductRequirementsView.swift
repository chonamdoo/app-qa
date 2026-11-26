import AppKit
import SwiftUI

struct ProductRequirementsView: View {
    @Environment(Workspace.self) private var workspace
    @Environment(ProductCatalog.self) private var catalog
    @State private var uploading = false
    @State private var message: String?
    @State private var selectedDocument = ""
    @State private var segmentQuery = ""
    @State private var segmentPage = 0
    @State private var sourceOrigins: [String: RegressionSourceOrigin] = [:]
    @State private var sourceProblems: [String: String] = [:]
    @State private var readingSources = false
    @State private var readSequence = 0
    @State private var sourceReadCount = 0
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                HStack {
                    ProductPageHeading(title: "요구사항 추적", subtitle: "원문 구간 → 검토한 단계·검증 → 발행 revision → 해당 attempt 근거")
                    Spacer()
                    Button("문서 연결") { upload() }.buttonStyle(ProductButtonStyle()).disabled(uploading || workspace.api == nil || catalog.snapshot == nil || catalog.needsReconciliation)
                    Button("새로고침") { Task { await refresh() } }.buttonStyle(ProductButtonStyle())
                }
                if catalog.loading || workspace.regression.loading || uploading || readingSources { ProgressView("원문 기록 조회·연결 중") }
                if let error = catalog.error { ProductNotice(error, tone: .error) }
                if let message { ProductNotice(message, tone: .warning) }
                if let message = catalog.mutationMessage { ProductNotice(message) }
                ProductNotice("문서의 기존 Result는 참고 이력입니다. 현재 plan의 최신 PASS나 다른 revision 결과로 원문 검증을 채우지 않습니다. 파일 형식·열 이름을 고정하지 않습니다.")
                ForEach(sourceProblems.keys.sorted(), id: \.self) { key in
                    ProductNotice("\(key) · \(sourceProblems[key] ?? "원문 미확인")", tone: .warning)
                }
                Picker("원문 문서", selection: $selectedDocument) { Text("문서 선택").tag(""); ForEach(catalog.snapshot?.documents ?? []) { Text($0.name).tag($0.id) } }
                if let document = catalog.snapshot?.documents.first(where: { $0.id == selectedDocument }) {
                    ProductPanel(title: document.name, subtitle: "등록 \(DisplayDate.text(document.createdAt))") {
                        VStack(alignment: .leading, spacing: 12) {
                            Text(document.path).font(.caption.monospaced()).textSelection(.enabled)
                            Text("SHA-256 \(document.sha256)").font(.caption.monospaced()).textSelection(.enabled)
                            Text("구간 ledger \(document.ledgerDigest ?? "원 기록 없음")").font(.caption.monospaced()).textSelection(.enabled)
                            if let parent = document.derivation {
                                ProductNotice("원본 \(parent.name) · 전체 \(parent.rowCount)개 객체행 중 \(parent.row.index + 1)번째 · bytes \(parent.row.startByte)..<\(parent.row.endByte). 원본 전체와 이 행의 정확한 bytes를 함께 보존합니다. TC 의미·실행 자격을 자동 승인하지 않습니다.")
                                Text("원본 SHA-256 \(parent.sha256)").font(.caption.monospaced()).textSelection(.enabled)
                            }
                            if let rows = document.jsonRows, !rows.isEmpty {
                                let children = (catalog.snapshot?.documents ?? []).filter { $0.derivation?.documentID == document.id }
                                let matchingChildren = children.filter { matchesParent($0, document) }
                                let separated = matchingChildren.count == rows.count
                                ProductNotice("JSON 객체행 후보 \(rows.count)개 · 같은 원본·ledger 세대의 분리 원문 \(matchingChildren.count)개. 공통 실행 가이드는 별도 원문으로 연결하세요. 분리나 일부 행의 대응만으로 전체 문서의 검토·실행 자격을 확정하지 않습니다.")
                                if children.count > matchingChildren.count {
                                    ProductNotice("다른 원본·ledger 세대이거나 행 위치를 확인할 수 없는 분리 원문 \(children.count - matchingChildren.count)개는 현재 구간 대응에 합치지 않습니다. 발행 이력은 당시 기록을 별도로 표시합니다.", tone: .warning)
                                }
                                Button(separated ? "전체 객체행 원문이 이미 분리됨" : "전체 객체행을 별도 원문으로 보존") {
                                    Task { _ = await catalog.splitDocumentRows(api: workspace.api, documentID: document.id) }
                                }.buttonStyle(ProductButtonStyle()).disabled(separated || catalog.mutationPending || catalog.needsReconciliation || workspace.api == nil)
                            }
                            ForEach(Array((document.issues ?? []).enumerated()), id: \.offset) { _, issue in ProductNotice(issue.readable, tone: .warning) }
                            if document.segments == nil { ProductNotice("legacy 문서 · 원문 구간 ledger가 없어 완전한 해석 검토를 확인할 수 없습니다. 원본을 보존하며 새 시나리오 준비에서 다시 연결하세요.", tone: .warning) }
                            ProductSearchField("원문 구간·텍스트 검색", text: $segmentQuery)
                            let allSegments = document.segments ?? []
                            let segments = segmentQuery.isEmpty ? allSegments : allSegments.filter { $0.locator.localizedStandardContains(segmentQuery) || $0.text.localizedStandardContains(segmentQuery) }
                            let start = min(segmentPage * 50, max(0, segments.count - 1))
                            let end = min(start + 50, segments.count)
                            let current = currentMappings(document, segments: segments[start..<end])
                            HStack {
                                Text("원문 구간 \(segments.isEmpty ? 0 : start + 1)–\(end) / \(segments.count)").font(.caption).foregroundStyle(ProductDesign.muted)
                                Spacer()
                                Button("이전 50개") { segmentPage -= 1 }.buttonStyle(ProductButtonStyle(size: .small)).disabled(segmentPage == 0)
                                Button("다음 50개") { segmentPage += 1 }.buttonStyle(ProductButtonStyle(size: .small)).disabled(end >= segments.count)
                            }
                            ForEach(segments[start..<end], id: \.byteIdentity) { segment in
                                VStack(alignment: .leading, spacing: 12) {
                                    Text("\(segment.locator) · \(segment.kind)").font(.headline)
                                    Text(segment.text).textSelection(.enabled)
                                    let traces = current[ProductSourceIdentity(documentID: document.id, segmentID: segment.id)] ?? []
                                    ForEach(Array(traces.enumerated()), id: \.offset) { _, trace in
                                        VStack(alignment: .leading, spacing: 8) {
                                            Text(trace.scenario.name).font(.headline)
                                            if let child = trace.child, let parent = child.derivation {
                                                Button("분리 원문 \(child.name) · 객체행 \(parent.row.index + 1)/\(parent.rowCount) · /\(parent.row.index) · bytes \(parent.row.startByte)..<\(parent.row.endByte)") { selectedDocument = child.id }
                                                    .buttonStyle(ProductButtonStyle(size: .small))
                                                Text("분리 원문 구간 \(trace.segment.locator)").font(.caption.monospaced()).textSelection(.enabled)
                                            }
                                            Text("해석 검토 \(trace.scenario.source?.reviewed == true ? "기록 있음" : "미완료") · 실행 정의 \(trace.scenario.executable == true ? "발행 후보 점검 필요" : "지원·검토 필요")")
                                            Text("\(trace.mapping.disposition) · \(trace.mapping.reason)")
                                            Text("단계: \(trace.mapping.stepPaths.joined(separator: ", "))\n검증: \(trace.mapping.checkPaths.joined(separator: ", "))").font(.callout.monospaced())
                                        }.padding(14).background(ProductDesign.canvas, in: RoundedRectangle(cornerRadius: 8))
                                    }
                                    if traces.isEmpty { ProductNotice("이 원문 구간에 연결된 시나리오 대응 없음 · 검토 필요", tone: .warning) }
                                    Divider()
                                }
                            }
                            publicationHistory(document)
                        }
                    }
                } else if (catalog.snapshot?.documents ?? []).isEmpty && !catalog.loading { ContentUnavailableView("연결된 원문 없음", systemImage: "doc.text", description: Text("문서를 연결하거나 시나리오 작성에서 원문을 붙여넣으세요. 업로드만으로 의미 해석·발행이 완료되지 않습니다.")) }
            }.padding(.horizontal, 40).padding(.vertical, 32)
        }.background(ProductDesign.canvas)
        .task(id: ProductReadIdentity(api: workspace.api)) { await refresh() }
        .onChange(of: selectedDocument) { _, _ in segmentQuery = ""; segmentPage = 0 }
        .onChange(of: segmentQuery) { _, _ in segmentPage = 0 }
    }
    private func refresh() async {
        readSequence += 1
        let sequence = readSequence
        let identity = ProductReadIdentity(api: workspace.api)
        sourceOrigins = [:]
        sourceProblems = [:]
        sourceReadCount = 0
        readingSources = true
        defer { if readSequence == sequence { readingSources = false } }
        await catalog.refresh(api: workspace.api)
        await workspace.regression.refresh(api: workspace.api)
        guard identity == ProductReadIdentity(api: workspace.api), readSequence == sequence, !Task.isCancelled else { return }
        await readSourcePage(sequence: sequence, identity: identity)
    }
    private var sourceTargets: [(revisionID: String, testID: String, captured: Bool)] {
        workspace.regression.revisions.flatMap { revision in
            revision.definition.tests.map { (revision.id, $0.id, $0.sourceManifest != nil) }
        }
    }
    private func loadMoreSources() async {
        guard !readingSources else { return }
        let sequence = readSequence
        let identity = ProductReadIdentity(api: workspace.api)
        readingSources = true
        defer { if readSequence == sequence { readingSources = false } }
        await readSourcePage(sequence: sequence, identity: identity)
    }
    private func readSourcePage(sequence: Int, identity: ProductReadIdentity) async {
        guard let api = workspace.api, identity == ProductReadIdentity(api: api) else { return }
        let targets = sourceTargets
        let start = min(sourceReadCount, targets.count)
        let end = min(start + 10, targets.count)
        for target in targets[start..<end] {
            guard identity == ProductReadIdentity(api: workspace.api), readSequence == sequence, !Task.isCancelled else { return }
            let key = originKey(target.revisionID, target.testID)
            if !target.captured {
                sourceProblems[key] = "not-captured · 발행 당시 원문 snapshot 기록 없음. 현재 파일로 보충하지 않습니다."
            } else {
                do {
                    let snapshot: RegressionSourceSnapshot = try await api.regression(RegressionCommand(method: "scenario.origin", revisionId: target.revisionID, testId: target.testID), humanReview: true)
                    guard identity == ProductReadIdentity(api: workspace.api), readSequence == sequence, !Task.isCancelled else { return }
                    if snapshot.schema != "qautra/scenario-origin/v1" || snapshot.revisionId != target.revisionID || snapshot.testId != target.testID {
                        sourceProblems[key] = "unverified · 원 snapshot의 형식·발행 identity 미확인. 현재 파일로 보충하지 않습니다."
                    } else if snapshot.availability == .notCaptured {
                        sourceProblems[key] = "not-captured · 발행 당시 원문 snapshot 기록 없음. 현재 파일로 보충하지 않습니다."
                    } else if snapshot.manifestSha256 == nil || snapshot.manifest?.schema != "qautra/scenario-source/v2" {
                        sourceProblems[key] = "unverified · 원 manifest·digest를 확인하지 못했습니다. 현재 파일로 보충하지 않습니다."
                    } else if let manifest = snapshot.manifest {
                        sourceOrigins[key] = manifest
                    }
                } catch {
                    guard identity == ProductReadIdentity(api: workspace.api), readSequence == sequence, !Task.isCancelled else { return }
                    sourceProblems[key] = "원 snapshot 조회 실패: \(error.localizedDescription). 현재 초안으로 대신하지 않습니다."
                }
            }
            sourceReadCount += 1
        }
    }
    private func originKey(_ revisionID: String, _ testID: String) -> String { revisionID + ":" + testID }
    private func matchesParent(_ child: ProductDocument, _ parent: ProductDocument) -> Bool {
        guard let derivation = child.derivation, derivation.kind == "qautra/json-object-row/v1",
              derivation.documentID == parent.id, derivation.sha256 == parent.sha256,
              derivation.ledgerDigest == parent.ledgerDigest,
              let rows = parent.jsonRows, derivation.rowCount == rows.count,
              rows.indices.contains(derivation.row.index) else { return false }
        let row = rows[derivation.row.index]
        return row.index == derivation.row.index && row.startByte == derivation.row.startByte && row.endByte == derivation.row.endByte
    }
    private func segmentIndex(_ document: ProductDocument) -> [ProductSourceIdentity: ProductSourceSegment] {
        var index: [ProductSourceIdentity: ProductSourceSegment] = [:]
        for segment in document.segments ?? [] {
            index[ProductSourceIdentity(documentID: document.id, segmentID: segment.id)] = segment
        }
        return index
    }
    private func currentMappings(_ document: ProductDocument, segments: ArraySlice<ProductSourceSegment>) -> [ProductSourceIdentity: [CurrentRequirementTrace]] {
        let decoder = JSONDecoder()
        var visible: [ProductSourceIdentity: ProductSourceSegment] = [:]
        var pointers: [Data: ProductSourceIdentity] = [:]
        var ambiguousPointers: Set<Data> = []
        for segment in segments {
            let identity = ProductSourceIdentity(documentID: document.id, segmentID: segment.id)
            visible[identity] = segment
            if let pointer = RequirementJSONPointer.decode(segment.id, using: decoder) {
                if pointers[pointer] != nil { ambiguousPointers.insert(pointer) }
                pointers[pointer] = identity
            }
        }
        var children: [String: ProductDocument] = [:]
        for child in catalog.snapshot?.documents ?? [] where matchesParent(child, document) {
            children[child.id] = child
        }
        var childIndexes: [String: [ProductSourceIdentity: ProductSourceSegment]] = [:]
        var result: [ProductSourceIdentity: [CurrentRequirementTrace]] = [:]
        for scenario in catalog.snapshot?.scenarios ?? [] {
            for mapping in scenario.source?.mappings ?? [] {
                let identity = ProductSourceIdentity(documentID: mapping.documentID, segmentID: mapping.segmentID)
                if let segment = visible[identity] {
                    result[identity, default: []].append(CurrentRequirementTrace(scenario: scenario, mapping: mapping, segment: segment, child: nil))
                    continue
                }
                guard let child = children[mapping.documentID], let derivation = child.derivation,
                      let childPointer = RequirementJSONPointer.decode(mapping.segmentID, using: decoder) else { continue }
                var pointer = Data("/\(derivation.row.index)".utf8)
                pointer.append(childPointer)
                guard !ambiguousPointers.contains(pointer), let parentIdentity = pointers[pointer] else { continue }
                if childIndexes[child.id] == nil { childIndexes[child.id] = segmentIndex(child) }
                guard let segment = childIndexes[child.id]?[identity] else { continue }
                result[parentIdentity, default: []].append(CurrentRequirementTrace(scenario: scenario, mapping: mapping, segment: segment, child: child))
            }
        }
        return result
    }
    private func historyRows(_ document: ProductDocument) -> [PublishedRequirementTrace] {
        var rows: [PublishedRequirementTrace] = []
        for revision in workspace.regression.revisions {
            for test in revision.definition.tests {
                guard let origin = sourceOrigins[originKey(revision.id, test.id)] else { continue }
                let mappings = Dictionary(grouping: origin.source.mappings, by: \.documentID)
                for frozenDocument in origin.documents {
                    let parent = frozenDocument.derivation.flatMap { $0.documentID == document.id ? $0 : nil }
                    guard frozenDocument.id == document.id || parent != nil else { continue }
                    let segments = segmentIndex(frozenDocument)
                    let traces = (mappings[frozenDocument.id] ?? []).map { mapping in
                        PublishedRequirementMapping(mapping: mapping, segment: segments[ProductSourceIdentity(documentID: mapping.documentID, segmentID: mapping.segmentID)])
                    }
                    rows.append(PublishedRequirementTrace(revision: revision, test: test, origin: origin, document: frozenDocument, parent: parent, mappings: traces))
                }
            }
        }
        return rows
    }
    private func publicationHistory(_ document: ProductDocument) -> some View {
        let rows = historyRows(document)
        return VStack(alignment: .leading, spacing: 16) {
            Text("발행 당시 원문·실행 이력").font(.headline)
            Text("현재 초안의 경로·대응 수정과 별개로 보존한 manifest를 읽습니다. 아래 판정은 원 흐름 기록이며 개별 TC의 PASS로 대신하지 않습니다.").font(.caption).foregroundStyle(ProductDesign.muted)
            HStack {
                Text("발행 원문 조회 \(sourceReadCount)/\(sourceTargets.count) · 아직 조회하지 않은 발행본에도 관련 이력이 있을 수 있습니다.").font(.caption).foregroundStyle(ProductDesign.muted)
                Spacer()
                Button("다음 발행 원문 10개 조회") { Task { await loadMoreSources() } }
                    .buttonStyle(ProductButtonStyle(size: .small))
                    .disabled(readingSources || sourceReadCount >= sourceTargets.count || workspace.api == nil)
            }
            ForEach(rows) { row in
                VStack(alignment: .leading, spacing: 10) {
                    Text(row.test.name).font(.headline)
                    Text("발행 \(DisplayDate.text(row.revision.publishedAt)) · \(row.revision.id)").font(.caption.monospaced()).textSelection(.enabled)
                    Text("원 시나리오 \(row.origin.scenarioID) · \(row.origin.digest)").font(.caption.monospaced()).textSelection(.enabled)
                    Text("원본 SHA-256 \(row.document.sha256) · 구간 ledger \(row.document.ledgerDigest ?? "원 기록 없음")").font(.caption.monospaced()).textSelection(.enabled)
                    if let parent = row.document.derivation {
                        Text("발행 당시 분리 원문 \(row.document.name) · \(row.document.id)").font(.caption.monospaced()).textSelection(.enabled)
                        Text("원본 \(parent.name) · \(parent.documentID) · 객체행 \(parent.row.index + 1)/\(parent.rowCount) · /\(parent.row.index) · bytes \(parent.row.startByte)..<\(parent.row.endByte)").font(.caption.monospaced()).textSelection(.enabled)
                        Text("원본 SHA-256 \(parent.sha256) · 구간 ledger \(parent.ledgerDigest)").font(.caption.monospaced()).textSelection(.enabled)
                    }
                    Text("원문 검토 \(row.origin.review?["principalId"]?.string ?? "주체 기록 없음") · \(DisplayDate.text(row.origin.review?["reviewedAt"]?.string ?? ""))").font(.caption)
                    let relatedIDs = Set([row.document.id] + [row.parent?.documentID].compactMap { $0 })
                    ForEach(Array((row.origin.source.resolutions ?? []).filter { relatedIDs.contains($0.documentID) || relatedIDs.contains($0.transcriptDocumentID) }.enumerated()), id: \.offset) { _, resolution in
                        ProductNotice("사람의 전체 원문 대조 기록 · parser 경고와 원본 bytes는 보존됩니다. 자동 해석·실행 PASS가 아닙니다.")
                        Text(resolution.coverage).textSelection(.enabled)
                        Text("원본 \(resolution.documentID) · \(resolution.sourceSha256)\n전체 전사본 \(resolution.transcriptDocumentID) · \(resolution.transcriptSha256)").font(.caption.monospaced()).textSelection(.enabled)
                    }
                    if (row.parent?.sha256 ?? row.document.sha256) != document.sha256 || (row.parent?.ledgerDigest ?? row.document.ledgerDigest) != document.ledgerDigest {
                        ProductNotice("선택 문서와 발행 당시 원본 해시·ledger 세대가 다르거나 미확인입니다. 이하 원 snapshot만 표시하며 현재 문서로 보충하지 않습니다.", tone: .warning)
                    }
                    ForEach(Array(row.mappings.enumerated()), id: \.offset) { _, trace in
                        if let segment = trace.segment {
                            Text("\(segment.locator) · \(segment.text)").textSelection(.enabled)
                        } else { ProductNotice("원 manifest의 구간 \(trace.mapping.segmentID)을 확인하지 못했습니다.", tone: .warning) }
                        Text("\(trace.mapping.disposition) · \(trace.mapping.reason)").textSelection(.enabled)
                        Text("단계: \(trace.mapping.stepPaths.joined(separator: ", "))\n검증: \(trace.mapping.checkPaths.joined(separator: ", "))").font(.callout.monospaced())
                    }
                    let checkIDs = Set(row.revision.definition.checks.filter { $0.testId == row.test.id }.map(\.id))
                    let attempts = workspace.regression.runs.flatMap(\.attempts).filter {
                        $0.revisionId == row.revision.id && ($0.chain?.members ?? [$0.testId]).contains(row.test.id)
                    }
                    ForEach(attempts) { attempt in
                        let required = attempt.requiredChecks.filter { checkIDs.contains($0) }
                        let completed = Set(attempt.completedChecks)
                        HStack {
                            Text("\(attempt.target.platform) · 원 흐름 판정")
                            ProductStatusBadge(status: attempt.business)
                            Text("이 TC 검증 \(required.filter { completed.contains($0) }.count)/\(required.count) · 영상 \(attempt.evidence) · 정리 \(attempt.cleanup)")
                        }
                        Text("attempt \(attempt.id)").font(.caption.monospaced()).textSelection(.enabled)
                    }
                    if attempts.isEmpty { Text("이 revision·TC의 실행 근거 없음 · 미실행") }
                }.padding(14).background(ProductDesign.canvas, in: RoundedRectangle(cornerRadius: 8))
            }
            if rows.isEmpty { Text(readingSources ? "발행 당시 원문 조회 중" : "조회한 발행본에서 확인한 관련 원문 없음 · 미조회·조회 실패·미실행을 다른 초안이나 revision으로 채우지 않습니다.") }
        }
    }
    private func upload() {
        guard let api = workspace.api, !uploading else { return }
        let panel = NSOpenPanel(); panel.canChooseDirectories = false
        guard panel.runModal() == .OK, let url = panel.url else { return }
        let identity = ProductReadIdentity(api: api)
        uploading = true
        Task {
            defer { uploading = false }
            let access = url.startAccessingSecurityScopedResource(); defer { if access { url.stopAccessingSecurityScopedResource() } }
            do {
                let value = try await api.upload(fileURL: url)
                guard identity == ProductReadIdentity(api: workspace.api) else { return }
                let before = Set(catalog.snapshot?.documents.map(\.id) ?? [])
                if await catalog.connectDocument(api: api, name: value.name, upload: value) {
                    selectedDocument = catalog.snapshot?.documents.first { !before.contains($0.id) }?.id ?? ""
                    message = "원문·해시·추출 구간과 이슈를 연결했습니다. 의미 해석과 실행 검토는 시나리오에서 별도로 확인하세요."
                }
            } catch { if identity == ProductReadIdentity(api: workspace.api) { message = "업로드 응답 미확인: \(error.localizedDescription). 자동 재전송하지 않습니다." } }
        }
    }
}

private struct PublishedRequirementTrace: Identifiable {
    let revision: RegressionRevision
    let test: RegressionDefinition.Test
    let origin: RegressionSourceOrigin
    let document: ProductDocument
    let parent: ProductJSONSourceDerivation?
    let mappings: [PublishedRequirementMapping]
    var id: String { revision.id + ":" + test.id + ":" + document.id }
}

private struct CurrentRequirementTrace {
    let scenario: ProductScenario
    let mapping: ProductSourceMapping
    let segment: ProductSourceSegment
    let child: ProductDocument?
}

private struct PublishedRequirementMapping {
    let mapping: ProductSourceMapping
    let segment: ProductSourceSegment?
}

private enum RequirementJSONPointer {
    static func decode(_ segmentID: String, using decoder: JSONDecoder) -> Data? {
        guard segmentID.utf8.starts(with: "json:".utf8),
              let pointer = try? decoder.decode(String.self, from: Data(segmentID.utf8.dropFirst(5))) else { return nil }
        let bytes = Data(pointer.utf8)
        guard bytes.isEmpty || bytes.first == 47 else { return nil }
        var index = 0
        while index < bytes.count {
            if bytes[index] == 126 {
                guard index + 1 < bytes.count, bytes[index + 1] == 48 || bytes[index + 1] == 49 else { return nil }
                index += 2
            } else {
                index += 1
            }
        }
        return bytes
    }
}
