import AppKit
import SwiftUI

struct ProductScenariosView: View {
    @Environment(Workspace.self) private var workspace
    @Environment(ProductCatalog.self) private var catalog
    @State private var adding = false
    @State private var selected: ProductScenario?
    @State private var publishingSuite = false
    @State private var interpreting = false
    @State private var search = ""

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                HStack {
                    ProductPageHeading(title: "시나리오", subtitle: "원문 검토 · 실행 정의 검증 · 불변 revision 발행을 구분합니다.")
                    Spacer()
                    Button("새로고침") { Task { await refresh() } }.buttonStyle(ProductButtonStyle())
                    Button("선택적 원문 해석") { interpreting = true }.buttonStyle(ProductButtonStyle()).disabled(workspace.api == nil || catalog.snapshot == nil)
                    Button("묶음 검토·발행") { publishingSuite = true }.buttonStyle(ProductButtonStyle()).disabled(workspace.api == nil || catalog.snapshot == nil)
                    Button("시나리오 작성·가져오기", systemImage: "plus") { adding = true }.buttonStyle(ProductButtonStyle(kind: .primary)).disabled(workspace.api == nil || catalog.snapshot == nil)
                }
                if catalog.loading || workspace.regression.loading { ProgressView("시나리오 조회 중") }
                if let error = catalog.error { ProductNotice(error, tone: .error) }
                if let error = workspace.regression.error { ProductNotice(error, tone: .error) }
                if workspace.api == nil { ProductNotice("엔진 연결이 필요합니다. 이전 연결의 결과를 현재 상태로 표시하지 않습니다.", tone: .warning) }
                ProductSearchField("시나리오 이름 검색", text: $search)
                ProductPanel(title: "초안·검토 기록", subtitle: "준비 상태는 업무 판정이 아닙니다. legacy는 원본 보존·읽기 전용입니다.") {
                    VStack(alignment: .leading, spacing: 14) {
                        ForEach((catalog.snapshot?.scenarios ?? []).filter { search.isEmpty || $0.name.localizedCaseInsensitiveContains(search) }) { scenario in
                            Button { selected = scenario } label: {
                                HStack {
                                    VStack(alignment: .leading, spacing: 5) {
                                        Text(scenario.name).font(.headline)
                                        Text("\(scenario.app) · \(scenario.platforms.joined(separator: " · ")) · \(DisplayDate.text(scenario.createdAt))").font(.caption)
                                        Text(scenario.id).font(.caption.monospaced()).foregroundStyle(ProductDesign.muted)
                                    }
                                    Spacer()
                                    ProductStatusBadge(status: scenario.definition == nil ? "legacy" : scenario.executable == true ? "reviewed" : "blocked")
                                }.contentShape(Rectangle())
                            }.buttonStyle(.plain)
                            Divider()
                        }
                        if (catalog.snapshot?.scenarios ?? []).isEmpty { Text("저장된 초안이 없습니다. 문서·붙여넣기 또는 수동 단계로 준비하세요.") }
                    }
                }
                ProductPanel(title: "발행된 revision", subtitle: "발행은 지원 범위 고정이며 실제 실행 PASS나 프로젝트 권한이 아닙니다.") {
                    VStack(alignment: .leading, spacing: 16) {
                        ForEach(workspace.regression.revisions) { revision in
                            VStack(alignment: .leading, spacing: 6) {
                                Text(revision.name).font(.headline)
                                Text("발행 \(DisplayDate.text(revision.publishedAt)) · 필수 검증 \(revision.definition.checks.count)개")
                                Text(revision.id).font(.caption.monospaced()).textSelection(.enabled)
                                if !revision.executable { ProductNotice("이전 발행본 · 원본 보존·읽기 전용입니다. 현재 계약으로 다시 검토·발행해야 실행할 수 있습니다.", tone: .warning) }
                                ForEach(revision.definition.chains ?? []) { chain in
                                    Text("동일 세션 흐름 · \(chain.members.joined(separator: " → "))").font(.callout).textSelection(.enabled)
                                }
                                ForEach(revision.definition.checks) { check in
                                    Text("\(check.path) · \(check.scope) · \(check.description)").font(.callout).textSelection(.enabled)
                                }
                            }
                            Divider()
                        }
                        if workspace.regression.revisions.isEmpty { Text("발행본이 없습니다. 검토한 초안에서 후보 미리보기 후 명시적으로 발행하세요.") }
                    }
                }
            }.padding(.horizontal, 40).padding(.vertical, 32)
        }.background(ProductDesign.canvas)
        .task(id: ProductReadIdentity(api: workspace.api)) { await refresh() }
        .sheet(isPresented: $adding) { ScenarioEditor() }
        .sheet(item: $selected) { ScenarioPublicationView(scenario: $0) }
        .sheet(isPresented: $publishingSuite) { ScenarioPublicationView() }
        .sheet(isPresented: $interpreting) { ProductAuthoringView() }
    }
    private func refresh() async {
        await catalog.refresh(api: workspace.api)
        await workspace.regression.refresh(api: workspace.api)
        await workspace.loadProfiles()
    }
}

private struct ScenarioManualStep: Identifiable {
    let id = UUID()
    var kind = "see"
    var selector = "text"
    var target = ""
    var value = ""
    var timeout = 5000
    var minimum = 1
    var group = ""
    var comparison = "=="
    var expectedNumber = 0.0
    var note = ""
    var original: ProductJSON? = nil
    static let kinds = ["launch", "open", "tap", "longPress", "type", "clear", "press", "back", "hideKeyboard", "see", "assertText", "assertNoText", "checkEach", "wait", "capture"]
    static func label(_ kind: String) -> String {
        switch kind {
        case "launch": "대상 열기"
        case "open": "URL·링크 열기"
        case "tap": "요소 클릭"
        case "longPress": "요소 길게 누르기"
        case "type": "필드 입력"
        case "clear": "필드 지우기"
        case "press": "키 누르기"
        case "back": "뒤로 이동"
        case "hideKeyboard": "키보드 숨기기"
        case "see": "지정 요소 보임 검증"
        case "assertText": "현재 관측 텍스트 포함 검증"
        case "assertNoText": "현재 관측 텍스트 없음 검증"
        case "checkEach": "관측된 각 줄 수치 검증"
        case "wait": "지정 요소 준비 대기"
        default: "화면 근거 저장"
        }
    }
    var isCheck: Bool { ["see", "assertText", "assertNoText", "checkEach"].contains(kind) || original?["expect"] != nil }
    var usesTarget: Bool { ["tap", "longPress", "type", "clear", "see", "wait"].contains(kind) }
    var valid: Bool {
        if original != nil { return true }
        if usesTarget && target.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return false }
        if ["open", "assertText", "assertNoText", "capture"].contains(kind) && value.isEmpty { return false }
        if kind == "checkEach" && (value.isEmpty || group.isEmpty || minimum < 1) { return false }
        return timeout > 0 && timeout <= 120000
    }
    var definition: ProductJSON {
        if let original { return original }
        let selectorValue = ProductJSON.object([selector: .string(target)])
        var fields: [String: ProductJSON] = ["timeout": .number(Double(timeout))]
        if !note.isEmpty { fields["note"] = .string(note) }
        switch kind {
        case "launch", "back", "hideKeyboard": fields[kind] = .bool(true)
        case "tap", "longPress", "clear", "see": fields[kind] = selectorValue
        case "type": fields["type"] = .string(value); fields["into"] = selectorValue
        case "press": fields["press"] = .string(value.isEmpty ? "tab" : value)
        case "wait": fields["wait"] = .object(["until": selectorValue])
        case "checkEach": fields["checkEach"] = .object(["pattern": .string(value), "min": .number(Double(minimum)), "rule": .object([comparison: .array([.object(["var": .string(group)]), .number(expectedNumber)])])])
        default: fields[kind] = .string(value)
        }
        return .object(fields)
    }
}

private struct ScenarioMappingDraft {
    var disposition = "unsupported"
    var stepPaths = Set<String>()
    var checkPaths = Set<String>()
    var reason = ""
    var role = "expected"
    var logicalCaseID = ""
    var originalCaseID = ""
}

private struct ScenarioDefinitionScope: Identifiable {
    let path: String
    let isStep: Bool
    let isCheck: Bool
    let title: String
    var id: String { path }

    static func rows(_ definition: ProductJSON) -> [Self] {
        var result: [Self] = []
        func walk(_ steps: ProductJSON?, path: String, title: String) {
            for (index, step) in (steps?.values ?? []).enumerated() {
                let location = "\(path)[\(index)]"
                let label = "\(title) \(index + 1)"
                let kind = ScenarioManualStep.kinds.first { step[$0] != nil } ?? "지원 범위 검토 필요"
                let check = ["see", "assertText", "assertNoText", "checkEach"].contains { step[$0] != nil }
                result.append(Self(path: location, isStep: true, isCheck: check && !path.hasPrefix("teardown"), title: "\(label) · \(ScenarioManualStep.label(kind))"))
                if let expectation = step["expect"], !path.hasPrefix("teardown") {
                    if case .array(let values) = expectation {
                        for (number, _) in values.enumerated() {
                            result.append(Self(path: "\(location).expect[\(number)]", isStep: false, isCheck: true, title: "\(label)의 기대값 \(number + 1)"))
                        }
                    } else { result.append(Self(path: "\(location).expect[0]", isStep: false, isCheck: true, title: "\(label)의 기대값")) }
                }
                if let repeated = step["repeat"] { walk(repeated["steps"], path: "\(location).repeat.steps", title: "\(label) 반복 단계") }
                if case .object(let branches)? = step["which"] {
                    for key in branches.keys.sorted() { walk(branches[key], path: "\(location).which.\(key)", title: "\(label) 분기 \(key)") }
                }
            }
        }
        walk(definition["setup"], path: "setup", title: "준비")
        walk(definition["steps"], path: "steps", title: "단계")
        walk(definition["teardown"], path: "teardown", title: "정리")
        return result
    }
}

private struct ScenarioEditor: View {
    @Environment(Workspace.self) private var workspace
    @Environment(ProductCatalog.self) private var catalog
    @Environment(\.dismiss) private var dismiss
    var existing: ProductScenario? = nil
    @State private var name = ""
    @State private var app = ""
    @State private var startup = "launch"
    @State private var platforms = Set<String>()
    @State private var notes = ""
    @State private var pasted = ""
    @State private var documentIDs = Set<String>()
    @State private var documentQuery = ""
    @State private var documentPage = 0
    @State private var mappings: [ProductSourceIdentity: ScenarioMappingDraft] = [:]
    @State private var mappingPages: [String: Int] = [:]
    @State private var resolutions: [ProductManualSourceResolution] = []
    @State private var resolutionOriginal = ""
    @State private var resolutionTranscript = ""
    @State private var resolutionCoverage = ""
    @State private var steps = [ScenarioManualStep()]
    @State private var reviewed = false
    @State private var uploading = false
    @State private var message: String?
    @State private var origin = ProductReadIdentity(api: nil)
    private let notesID = "00000000-0000-4000-8000-000000000001"
    private var documents: [ProductDocument] {
        var result = (catalog.snapshot?.documents ?? []).filter { documentIDs.contains($0.id) }
        if !notes.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            let lines = notes.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n").components(separatedBy: "\n")
            let segments = lines.enumerated().compactMap { index, text in
                text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : ProductSourceSegment(id: "line:\(index + 1)", locator: "line:\(index + 1)", text: text, kind: "text")
            }
            result.append(ProductDocument(id: notesID, name: "수동 원문·공통 전제", path: "manual:scenario-notes", sha256: "저장 시 원문과 함께 고정", createdAt: "", segments: segments, originalPath: "manual:scenario-notes", ledgerDigest: nil, issues: []))
        }
        return result
    }
    private var availablePlatforms: [String] { workspace.profiles.first { $0.id == app }?.platforms ?? [] }
    private var valid: Bool {
        !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !app.isEmpty && !platforms.isEmpty && platforms.isSubset(of: Set(availablePlatforms)) && !steps.isEmpty && steps.allSatisfy(\.valid)
            && (!notes.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !documents.isEmpty)
    }
    private var source: ProductScenarioSource {
        let values = documents.flatMap { document in (document.segments ?? []).map { segment -> ProductSourceMapping in
            let mapping = mappings[ProductSourceIdentity(documentID: document.id, segmentID: segment.id)] ?? ScenarioMappingDraft()
            let selectedSteps = mapping.stepPaths.sorted()
            return ProductSourceMapping(documentID: document.id, segmentID: segment.id, disposition: mapping.disposition,
                stepPaths: mapping.disposition == "mapped" ? selectedSteps : [],
                checkPaths: mapping.disposition == "mapped" ? mapping.checkPaths.sorted() : [],
                reason: mapping.reason, role: mapping.role,
                logicalCaseID: mapping.logicalCaseID.isEmpty ? nil : mapping.logicalCaseID,
                originalCaseID: mapping.originalCaseID.isEmpty ? nil : mapping.originalCaseID)
        } }
        return ProductScenarioSource(documentIDs: documents.map(\.id), notes: notes, mappings: values, reviewed: reviewed, resolutions: resolutions.isEmpty ? nil : resolutions)
    }
    private var definition: ProductJSON {
        var fields: [String: ProductJSON] = [:]
        if case .object(let original)? = existing?.definition { fields = original }
        fields["name"] = .string(name.trimmingCharacters(in: .whitespacesAndNewlines))
        fields["app"] = .string(app); fields["platforms"] = .array(platforms.sorted().map(ProductJSON.string))
        fields["start"] = .string(startup)
        fields["steps"] = .array(steps.map(\.definition))
        if fields["reset"] == nil { fields["reset"] = .string("none") }
        return .object(fields)
    }
    var body: some View {
        let definitionScopes = ScenarioDefinitionScope.rows(definition)
        let allDocuments = catalog.snapshot?.documents ?? []
        let availableDocuments = documentQuery.isEmpty ? allDocuments : allDocuments.filter {
            $0.name.localizedStandardContains(documentQuery) || ($0.segments ?? []).contains { $0.text.localizedStandardContains(documentQuery) }
        }
        let documentStart = min(documentPage * 40, max(0, availableDocuments.count - 1))
        let documentEnd = min(documentStart + 40, availableDocuments.count)
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                ProductPageHeading(title: "시나리오 준비", subtitle: "원문 의미를 유지하고 지원하는 동작·검증을 직접 대응시킵니다.")
                Spacer()
                Button("닫기") { dismiss() }.buttonStyle(ProductButtonStyle()).disabled(catalog.mutationPending || uploading)
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    TextField("시나리오 이름", text: $name).textFieldStyle(.roundedBorder)
                    Picker("등록 프로젝트", selection: $app) { Text("선택").tag(""); ForEach(workspace.profiles) { Text($0.name).tag($0.id) } }
                    HStack { ForEach(availablePlatforms, id: \.self) { p in Toggle(p, isOn: membership(p, in: $platforms)) } }
                    Picker("시작 방식", selection: $startup) {
                        Text("대상 새로 열기 · launch").tag("launch")
                        Text("현재 세션 유지 · attach").tag("attach")
                    }
                    Text("다음 TC가 앞선 상태를 이어받으려면 attach를 선택하고, 묶음 발행에서 동일 세션 흐름과 순서를 명시하세요. 시작 방식은 자동 변경하지 않습니다.").font(.caption).foregroundStyle(ProductDesign.muted)
                    ProductPanel(title: "원문·공통 전제·복수 기대값") {
                        VStack(alignment: .leading, spacing: 12) {
                            TextEditor(text: $notes).frame(minHeight: 100).overlay(RoundedRectangle(cornerRadius: 8).stroke(ProductDesign.line)).accessibilityLabel("수동 원문과 전제·기대값")
                            ProductNotice("문구를 입력했다고 assertText로 바꾸지 않습니다. 삭제·저장·업무 의미, canvas·시각 판정 등 지원되지 않는 검증은 아래에서 미지원으로 남기세요.")
                            HStack {
                                Button(uploading ? "업로드 중…" : "문서 첨부") { chooseDocument() }.buttonStyle(ProductButtonStyle())
                                Button("붙여넣기 문서 보존") { Task { await savePasted() } }.buttonStyle(ProductButtonStyle()).disabled(pasted.isEmpty)
                            }.disabled(uploading || workspace.api == nil || catalog.needsReconciliation)
                            TextEditor(text: $pasted).frame(minHeight: 80).overlay(RoundedRectangle(cornerRadius: 8).stroke(ProductDesign.line)).accessibilityLabel("보존할 원문 붙여넣기")
                            TextField("연결할 원문 이름·원 TC ID·본문 검색", text: $documentQuery).textFieldStyle(.roundedBorder)
                            HStack {
                                Text("선택 \(documentIDs.count)개 · 검색 결과 \(availableDocuments.count)개 · \(availableDocuments.isEmpty ? 0 : documentStart + 1)–\(documentEnd) 표시").font(.caption).foregroundStyle(ProductDesign.muted)
                                Spacer()
                                Button("이전 40개") { documentPage -= 1 }.buttonStyle(ProductButtonStyle(size: .small)).disabled(documentPage == 0)
                                Button("다음 40개") { documentPage += 1 }.buttonStyle(ProductButtonStyle(size: .small)).disabled(documentEnd >= availableDocuments.count)
                            }
                            ForEach(availableDocuments[documentStart..<documentEnd]) { document in
                                Toggle(document.name, isOn: membership(document.id, in: $documentIDs))
                                if let parent = document.derivation {
                                    Text("원본 \(parent.name) · 객체행 \(parent.row.index + 1)/\(parent.rowCount) · 원 TC ID와 과거 Result는 원문에 그대로 보존").font(.caption).foregroundStyle(ProductDesign.muted)
                                }
                            }
                        }
                    }
                    ProductPanel(title: "수동 단계 편집", subtitle: "아래 순서는 한 상태 의존 흐름입니다. 모델 해석·자동 수리·병렬 분할은 하지 않습니다.") {
                        VStack(alignment: .leading, spacing: 16) {
                            ForEach($steps) { $step in
                                VStack(alignment: .leading, spacing: 10) {
                                    if let original = step.original {
                                        Text("저장된 원본 단계 · 변경 없이 보존").font(.headline)
                                        Text(original.readable).font(.callout.monospaced()).textSelection(.enabled)
                                        Button("이 단계를 수동 양식으로 새로 작성") { step.original = nil; reviewed = false }.buttonStyle(ProductButtonStyle())
                                    } else {
                                    HStack {
                                        Picker("동작·검증", selection: $step.kind) { ForEach(ScenarioManualStep.kinds, id: \.self) { Text(ScenarioManualStep.label($0)).tag($0) } }
                                        Button("위로") { moveUp(step.id) }.buttonStyle(ProductButtonStyle(size: .small))
                                        Button("삭제", role: .destructive) { steps.removeAll { $0.id == step.id } }.buttonStyle(ProductButtonStyle(size: .small))
                                    }
                                    if step.usesTarget {
                                        Picker("정확한 요소 식별", selection: $step.selector) { Text("접근 텍스트").tag("text"); Text("접근 설명").tag("desc"); Text("안정적 ID").tag("id") }
                                        TextField("실제 대상의 정확한 식별값", text: $step.target).textFieldStyle(.roundedBorder)
                                    }
                                    if step.kind == "press" {
                                        Picker("키", selection: $step.value) { Text("Tab").tag(""); ForEach(["enter", "back", "tab", "escape", "delete"], id: \.self) { Text($0).tag($0) } }
                                    } else if ["open", "type", "assertText", "assertNoText", "checkEach", "capture"].contains(step.kind) {
                                        TextField(step.kind == "checkEach" ? "명명 그룹을 포함한 정규식" : "명시적인 입력·기대값", text: $step.value).textFieldStyle(.roundedBorder)
                                    }
                                    if step.kind == "checkEach" {
                                        TextField("검증할 명명 그룹", text: $step.group).textFieldStyle(.roundedBorder)
                                        Picker("비교 연산", selection: $step.comparison) { ForEach(["==", "!=", ">", ">=", "<", "<="], id: \.self) { Text($0).tag($0) } }
                                        TextField("기대 수치", value: $step.expectedNumber, format: .number)
                                        Stepper("최소 표본 \(step.minimum)개", value: $step.minimum, in: 1...10000)
                                    }
                                    TextField("단계 제한 시간(ms)", value: $step.timeout, format: .number.grouping(.never))
                                    TextField("원문 의미·관측 범위 설명", text: $step.note).textFieldStyle(.roundedBorder)
                                    if step.isCheck { ProductNotice("검증 범위: \(step.kind == "see" ? "지정한 관측 요소" : "현재 수집된 화면 텍스트"). 화면 밖·불완전 관측은 저장소 상태나 업무 의미의 증거가 아닙니다. 실제 지원·시간 조건은 후보 미리보기에서 확인하세요.", tone: .warning) }
                                    }
                                }
                                Divider()
                            }
                            Button("단계 추가") { steps.append(ScenarioManualStep()) }.buttonStyle(ProductButtonStyle())
                        }
                    }
                    sourceResolutionEditor
                    ForEach(documents) { document in
                        ProductPanel(title: "원문 대응 검토 · \(document.name)", subtitle: "\(document.path) · SHA-256 \(document.sha256)") {
                            VStack(alignment: .leading, spacing: 14) {
                                ForEach(Array((document.issues ?? []).enumerated()), id: \.offset) { _, issue in ProductNotice(issue.readable, tone: .warning) }
                                if document.segments == nil { ProductNotice("이 문서는 원문 구간 ledger가 없는 legacy 기록입니다. 검토·발행 자격을 자동 승계하지 않습니다.", tone: .warning) }
                                let segments = document.segments ?? []
                                let page = min(mappingPages[document.id] ?? 0, max(0, (segments.count - 1) / 10))
                                let start = page * 10
                                let end = min(start + 10, segments.count)
                                HStack {
                                    Text("원문 구간 \(segments.isEmpty ? 0 : start + 1)–\(end) / \(segments.count)").font(.caption).foregroundStyle(ProductDesign.muted)
                                    Spacer()
                                    Button("이전 10개") { mappingPages[document.id] = page - 1 }.buttonStyle(ProductButtonStyle(size: .small)).disabled(start == 0)
                                    Button("다음 10개") { mappingPages[document.id] = page + 1 }.buttonStyle(ProductButtonStyle(size: .small)).disabled(end >= segments.count)
                                }
                                Text("다른 페이지의 원문도 저장·발행 검토 대상입니다. 표시한 구간만으로 범위를 줄이지 않습니다.").font(.caption).foregroundStyle(ProductDesign.muted)
                                ForEach(segments[start..<end], id: \.byteIdentity) { segment in mappingEditor(document: document, segment: segment, scopes: definitionScopes) }
                            }
                        }
                    }
                    Toggle("원문 전체·공통 전제·복수 기대값과 미지원 범위를 직접 대조했습니다", isOn: $reviewed)
                    ProductNotice("미지원 구간은 저장할 수 있지만 발행·실행 가능으로 가장하지 않습니다. 과거 Result는 참고 이력이며 새 실행 결과가 아닙니다.")
                    if let message { ProductNotice(message, tone: .warning) }
                    if let error = catalog.error { ProductNotice(error, tone: .error) }
                    if let message = catalog.mutationMessage { ProductNotice(message) }
                    if catalog.needsReconciliation { Button("저장 반영 여부 조회") { Task { await catalog.refresh(api: workspace.api) } }.buttonStyle(ProductButtonStyle()) }
                }
            }
            HStack {
                Spacer()
                Button(reviewed ? "검토 기록과 초안 저장" : "미검토 초안 저장") {
                    Task { if await catalog.addScenario(api: workspace.api, definition: definition, source: source, id: existing?.id) { dismiss() } }
                }.buttonStyle(ProductButtonStyle(kind: .primary)).disabled(!valid || hasPendingResolution || catalog.mutationPending || catalog.needsReconciliation || uploading || origin != ProductReadIdentity(api: workspace.api))
            }
        }.padding(28).frame(minWidth: 820, idealWidth: 960, minHeight: 720).background(ProductDesign.canvas).preferredColorScheme(.light)
        .interactiveDismissDisabled(catalog.mutationPending || uploading)
        .onAppear { loadExisting() }
        .onChange(of: app) { _, _ in platforms = Set(availablePlatforms); reviewed = false }
        .onChange(of: definition) { _, _ in reviewed = false }
        .onChange(of: notes) { _, _ in reviewed = false }
        .onChange(of: resolutions) { _, _ in reviewed = false }
        .onChange(of: resolutionOriginal) { _, _ in reviewed = false }
        .onChange(of: resolutionTranscript) { _, _ in reviewed = false }
        .onChange(of: resolutionCoverage) { _, _ in reviewed = false }
        .onChange(of: documentQuery) { _, _ in documentPage = 0 }
    }
    private func loadExisting() {
        origin = ProductReadIdentity(api: workspace.api)
        guard let existing, let definition = existing.definition else {
            app = workspace.selectedApp ?? ""; platforms = Set(availablePlatforms); return
        }
        name = existing.name; app = existing.app; platforms = Set(existing.platforms)
        startup = definition["start"]?.string ?? "launch"
        notes = existing.source?.notes ?? ""; documentIDs = Set(existing.source?.documentIDs ?? [])
        resolutions = existing.source?.resolutions ?? []
        steps = (definition["steps"]?.values ?? []).map { original in
            var step = ScenarioManualStep()
            step.original = original
            step.kind = ScenarioManualStep.kinds.first { original[$0] != nil } ?? "unsupported"
            return step
        }
        for mapping in existing.source?.mappings ?? [] {
            var draft = ScenarioMappingDraft()
            draft.disposition = mapping.disposition; draft.reason = mapping.reason; draft.role = mapping.role ?? "expected"
            draft.logicalCaseID = mapping.logicalCaseID ?? ""; draft.originalCaseID = mapping.originalCaseID ?? ""
            draft.stepPaths = Set(mapping.stepPaths)
            draft.checkPaths = Set(mapping.checkPaths)
            mappings[ProductSourceIdentity(documentID: mapping.documentID, segmentID: mapping.segmentID)] = draft
        }
        reviewed = false
    }
    private func membership(_ value: String, in selection: Binding<Set<String>>) -> Binding<Bool> {
        Binding(get: { selection.wrappedValue.contains(value) }, set: { if $0 { selection.wrappedValue.insert(value) } else { selection.wrappedValue.remove(value) }; reviewed = false })
    }
    private func moveUp(_ id: UUID) { if let index = steps.firstIndex(where: { $0.id == id }), index > 0 { steps.swapAt(index, index - 1); reviewed = false } }
    private func mappingEditor(document: ProductDocument, segment: ProductSourceSegment, scopes: [ScenarioDefinitionScope]) -> some View {
        let key = ProductSourceIdentity(documentID: document.id, segmentID: segment.id)
        let binding = Binding(get: { mappings[key] ?? ScenarioMappingDraft() }, set: { mappings[key] = $0; reviewed = false })
        return VStack(alignment: .leading, spacing: 10) {
            Text("\(segment.locator) · \(segment.kind)").font(.caption).foregroundStyle(ProductDesign.muted)
            Text(segment.text).textSelection(.enabled)
            Picker("이 구간의 처리", selection: binding.disposition) { Text("미지원·질문 필요").tag("unsupported"); Text("단계·검증 대응").tag("mapped"); Text("참고·기존 Result").tag("reference") }
            Picker("원문 역할", selection: binding.role) {
                Text("기대값 · 독립 필수 검증 필요").tag("expected")
                Text("공통 전제").tag("precondition"); Text("절차").tag("step")
                Text("TC 식별자").tag("identity"); Text("과거 결과 이력").tag("history"); Text("비필수 참고").tag("reference")
                Text("원본 보존 · 전체 전사본에 대응").tag("transcribed")
            }
            TextField("논리 TC ID (선택)", text: binding.logicalCaseID).textFieldStyle(.roundedBorder)
            TextField("원 TC ID (선택)", text: binding.originalCaseID).textFieldStyle(.roundedBorder)
            if binding.wrappedValue.disposition == "mapped" {
                ForEach(scopes) { scope in
                    Toggle(scope.title + (scope.isCheck ? " · 필수 검증" : ""), isOn: Binding(get: {
                        binding.wrappedValue.stepPaths.contains(scope.path) || binding.wrappedValue.checkPaths.contains(scope.path)
                    }, set: { enabled in
                        if enabled {
                            if scope.isStep { binding.wrappedValue.stepPaths.insert(scope.path) }
                            if scope.isCheck { binding.wrappedValue.checkPaths.insert(scope.path) }
                        } else {
                            binding.wrappedValue.stepPaths.remove(scope.path)
                            binding.wrappedValue.checkPaths.remove(scope.path)
                        }
                    }))
                }
            }
            TextField("대응 근거 또는 미지원·참고 사유", text: binding.reason).textFieldStyle(.roundedBorder)
            Divider()
        }
    }
    private var unresolvedDocuments: [ProductDocument] {
        documents.filter {
            (!($0.issues ?? []).isEmpty || ($0.segments ?? []).contains { $0.kind == "unparsed" || $0.kind == "image" }) &&
                $0.originalPath?.lowercased().hasSuffix(".json") != true &&
                !($0.issues ?? []).contains { ($0["code"]?.string ?? "").hasPrefix("source_json_") }
        }
    }
    private var readableTranscripts: [ProductDocument] {
        documents.filter {
            $0.id != notesID && $0.ledgerDigest != nil && !($0.segments ?? []).isEmpty &&
            ($0.issues ?? []).isEmpty && !($0.segments ?? []).contains { $0.kind == "unparsed" || $0.kind == "image" }
        }
    }
    private var hasPendingResolution: Bool {
        !resolutionOriginal.isEmpty || !resolutionTranscript.isEmpty || !resolutionCoverage.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
    @ViewBuilder private var sourceResolutionEditor: some View {
        let selection = documents
        let originals = unresolvedDocuments
        if !originals.isEmpty || !resolutions.isEmpty {
            let transcripts = selection.filter {
                $0.id != notesID && $0.ledgerDigest != nil && !($0.segments ?? []).isEmpty &&
                ($0.issues ?? []).isEmpty && !($0.segments ?? []).contains { $0.kind == "unparsed" || $0.kind == "image" }
            }
            ProductPanel(title: "미독해 원문 · 사람이 대조한 전체 전사본", subtitle: "원본 bytes·parser 경고는 그대로 보존합니다. 이 대조는 파싱 성공이나 실행 PASS가 아닙니다.") {
                VStack(alignment: .leading, spacing: 14) {
                    ProductNotice("원본의 모든 페이지·표·그림·공통 전제·기대값을 직접 대조한 전사본을 먼저 원문으로 연결하세요. 일부 발췌나 경고 무시로 대신할 수 없습니다. 관계를 적용하면 원본의 실행 대응을 원본 보존 대응으로 바꾸며, 전사본의 각 구간은 아래에서 별도로 검토해야 합니다.", tone: .warning)
                    Picker("미독해 원본", selection: $resolutionOriginal) {
                        Text("원본 선택").tag("")
                        ForEach(originals) { Text($0.name).tag($0.id) }
                    }
                    Picker("대조한 전체 전사본", selection: $resolutionTranscript) {
                        Text("전사본 선택").tag("")
                        ForEach(transcripts.filter { $0.id != resolutionOriginal }) { Text($0.name).tag($0.id) }
                    }
                    TextField("직접 대조한 전체 범위: 모든 페이지·표·그림·기대값", text: $resolutionCoverage, axis: .vertical).textFieldStyle(.roundedBorder).lineLimit(3...6)
                    Button("이 원본의 전체 전사 관계 적용·교체") { bindSourceResolution() }
                        .buttonStyle(ProductButtonStyle()).disabled(resolutionOriginal.isEmpty || resolutionTranscript.isEmpty || resolutionCoverage.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    if hasPendingResolution {
                        ProductNotice("전사 관계 입력을 적용하거나 취소한 뒤 시나리오를 저장하세요. 적용하지 않은 입력은 검토 기록으로 저장되지 않습니다.", tone: .warning)
                        Button("전사 관계 입력 취소") { resolutionOriginal = ""; resolutionTranscript = ""; resolutionCoverage = "" }.buttonStyle(ProductButtonStyle())
                    }
                    ForEach(Array(resolutions.enumerated()), id: \.offset) { _, resolution in
                        VStack(alignment: .leading, spacing: 8) {
                            Text("\(selection.first { $0.id == resolution.documentID }?.name ?? resolution.documentID) → \(selection.first { $0.id == resolution.transcriptDocumentID }?.name ?? resolution.transcriptDocumentID)").font(.headline)
                            Text(resolution.coverage).textSelection(.enabled)
                            Text("원본 \(resolution.sourceSha256)\n전사본 \(resolution.transcriptSha256)").font(.caption.monospaced()).textSelection(.enabled)
                            Button("이 전사 관계 제거", role: .destructive) { resolutions.removeAll { $0.documentID == resolution.documentID }; reviewed = false }.buttonStyle(ProductButtonStyle())
                        }
                        Divider()
                    }
                }
            }
        }
    }
    private func bindSourceResolution() {
        guard let original = unresolvedDocuments.first(where: { $0.id == resolutionOriginal }),
              let transcript = readableTranscripts.first(where: { $0.id == resolutionTranscript }),
              original.id != transcript.id, let originalLedger = original.ledgerDigest, let transcriptLedger = transcript.ledgerDigest else {
            message = "현재 원본과 전체 전사본의 고정 해시·구간 ledger를 확인하세요. legacy 문서는 원본을 다시 연결해야 합니다."
            return
        }
        let coverage = resolutionCoverage.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !coverage.isEmpty else { return }
        guard !resolutions.contains(where: { $0.documentID != original.id && $0.transcriptDocumentID == transcript.id }) else {
            message = "다른 원본에 연결한 전사본입니다. 원본별 전체 전사본을 별도로 연결하세요."
            return
        }
        let resolution = ProductManualSourceResolution(kind: "manual-full-transcript/v1", documentID: original.id, sourceSha256: original.sha256,
            sourceLedgerDigest: originalLedger, transcriptDocumentID: transcript.id, transcriptSha256: transcript.sha256,
            transcriptLedgerDigest: transcriptLedger, coverage: coverage)
        resolutions.removeAll { $0.documentID == original.id }
        resolutions.append(resolution)
        for segment in original.segments ?? [] {
            let key = ProductSourceIdentity(documentID: original.id, segmentID: segment.id)
            var mapping = mappings[key] ?? ScenarioMappingDraft()
            mapping.disposition = "reference"; mapping.role = "transcribed"
            mapping.stepPaths = []; mapping.checkPaths = []
            mapping.reason = "전체 전사본 \(transcript.name)에 원문을 보존 대응: \(coverage)"
            mappings[key] = mapping
        }
        reviewed = false
        resolutionOriginal = ""; resolutionTranscript = ""; resolutionCoverage = ""
        message = "전체 전사 관계를 검토용 초안에 연결했습니다. 전사본의 모든 구간과 각 기대값의 필수 검증을 대조한 뒤 검토 기록을 저장하세요."
    }
    private func chooseDocument() {
        guard let api = workspace.api, !uploading else { return }
        let panel = NSOpenPanel(); panel.allowsMultipleSelection = false; panel.canChooseDirectories = false
        guard panel.runModal() == .OK, let url = panel.url else { return }
        uploading = true
        Task {
            defer { uploading = false }
            let access = url.startAccessingSecurityScopedResource(); defer { if access { url.stopAccessingSecurityScopedResource() } }
            do {
                let upload = try await api.upload(fileURL: url)
                guard origin == ProductReadIdentity(api: workspace.api) else { return }
                let previous = Set(catalog.snapshot?.documents.map(\.id) ?? [])
                if await catalog.connectDocument(api: api, name: upload.name, upload: upload) { documentIDs.formUnion((catalog.snapshot?.documents ?? []).filter { !previous.contains($0.id) }.map(\.id)); reviewed = false }
            } catch { if origin == ProductReadIdentity(api: workspace.api) { message = "업로드 결과 미확인: \(error.localizedDescription). 자동 재전송하지 않습니다." } }
        }
    }
    private func savePasted() async {
        guard let api = workspace.api, !uploading, !pasted.isEmpty else { return }
        uploading = true; defer { uploading = false }
        do {
            var request = api.request("/api/docs", method: "POST")
            request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
            request.setValue("scenario-source.txt", forHTTPHeaderField: "X-Filename")
            request.httpBody = Data(pasted.utf8)
            let upload = try JSONDecoder().decode(UploadResult.self, from: try await api.data(for: request))
            guard origin == ProductReadIdentity(api: workspace.api) else { return }
            let previous = Set(catalog.snapshot?.documents.map(\.id) ?? [])
            if await catalog.connectDocument(api: api, name: upload.name, upload: upload) { documentIDs.formUnion((catalog.snapshot?.documents ?? []).filter { !previous.contains($0.id) }.map(\.id)); pasted = ""; reviewed = false }
        } catch { if origin == ProductReadIdentity(api: workspace.api) { message = "원문 저장 결과 미확인: \(error.localizedDescription). 조회 전 재전송하지 않습니다." } }
    }
}

private struct ScenarioPublicationView: View {
    var scenario: ProductScenario? = nil
    @Environment(Workspace.self) private var workspace
    @Environment(ProductCatalog.self) private var catalog
    @Environment(\.dismiss) private var dismiss
    @State private var selection = Set<String>()
    @State private var chains: [RegressionExecutionChain] = []
    @State private var resolvedTests: [RegressionDefinition.Test] = []
    @State private var candidate: RegressionCandidate?
    @State private var checks = Set<String>()
    @State private var busy = false
    @State private var publishAttempted = false
    @State private var message: String?
    @State private var origin = ProductReadIdentity(api: nil)
    @State private var editing = false

    private var scenarios: [ProductScenario] { catalog.snapshot?.scenarios ?? scenario.map { [$0] } ?? [] }
    private var selected: [ProductScenario] { scenarios.filter { selection.contains($0.id) } }
    private var paths: [String] { selected.map(\.path) }
    private var validChains: Bool {
        chains.allSatisfy { $0.members.count >= 2 && Set($0.members).count == $0.members.count }
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack {
                ProductPageHeading(title: scenario?.name ?? "시나리오 묶음 검토", subtitle: "원문 · 독립 흐름 · 동일 세션의 명시 순서 · 필수 검증을 고정합니다.")
                Spacer()
                Button("닫기") { dismiss() }.buttonStyle(ProductButtonStyle()).disabled(busy)
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    ProductPanel(title: "발행할 원문·시나리오") {
                        VStack(alignment: .leading, spacing: 12) {
                            ForEach(scenarios) { item in
                                Toggle(isOn: Binding(get: { selection.contains(item.id) }, set: {
                                    if $0 { selection.insert(item.id) } else { selection.remove(item.id) }
                                })) {
                                    Text("\(item.name) · \(item.platforms.joined(separator: " · "))")
                                }.disabled(item.definition == nil || busy || publishAttempted)
                            }
                            if let scenario, scenario.definition == nil { sourceDetails(scenario) }
                            ForEach(selected) { sourceDetails($0) }
                        }
                    }
                    if let scenario, scenario.definition != nil {
                        Button("원문 대응·단계 수정 후 다시 검토") { editing = true }.buttonStyle(ProductButtonStyle()).disabled(busy || publishAttempted)
                    }
                    if !resolvedTests.isEmpty { chainEditor.disabled(busy || publishAttempted) }
                    Button("실행 후보 미리보기") { Task { await preview() } }.buttonStyle(ProductButtonStyle()).disabled(busy || paths.isEmpty || !validChains || publishAttempted || origin != ProductReadIdentity(api: workspace.api))
                    if let candidate {
                        Text("후보 생성 \(DisplayDate.text(candidate.createdAt))").font(.caption)
                        Text("digest \(candidate.digest)").font(.caption.monospaced()).textSelection(.enabled)
                        ForEach(Array(candidate.problems.enumerated()), id: \.offset) { _, problem in ProductNotice("\(problem.path) · \(problem.code) · \(problem.message)", tone: .warning) }
                        ForEach(candidate.definition.tests) { test in
                            Text("\(test.id) · \(test.name) · 시작 \(test.spec["start"]?.string ?? "미확인") · reset \(test.spec["reset"]?.readable ?? "미확인")").font(.callout).textSelection(.enabled)
                        }
                        ForEach(candidate.definition.sources, id: \.path) { source in Text("\(source.kind) · \(source.path) · \(source.sha256)").font(.caption.monospaced()).textSelection(.enabled) }
                        ForEach(candidate.definition.checks) { check in
                            Toggle(isOn: Binding(get: { checks.contains(check.id) }, set: { if $0 { checks.insert(check.id) } else { checks.remove(check.id) } })) {
                                VStack(alignment: .leading, spacing: 5) { Text("\(check.testId) · \(check.path) · \(check.kind) · \(check.scope)"); Text(check.description).textSelection(.enabled); Text(check.platforms.joined(separator: " · ")).font(.caption) }
                            }.disabled(busy || publishAttempted)
                        }
                        ProductNotice("각 필수 검증의 대상·기대값·관측 범위를 직접 검토하세요. 발행은 PASS나 위험 동작 승인이 아닙니다.")
                    }
                    if let message { ProductNotice(message, tone: .warning) }
                    if publishAttempted { Button("발행 기록 조회 · 재전송 없음") { Task { await workspace.regression.refresh(api: workspace.api); if let candidate { message = workspace.regression.revisions.contains { $0.id == candidate.digest } ? "해당 digest의 발행 기록이 있습니다." : "현재 조회에 발행 기록이 없습니다. 응답 유실을 미반영으로 단정하지 않습니다." } } }.buttonStyle(ProductButtonStyle()).disabled(busy) }
                }
            }
            HStack { if busy { ProgressView() }; Spacer(); Button("검토한 후보 명시 발행") { Task { await publish() } }.buttonStyle(ProductButtonStyle(kind: .primary)).disabled(busy || publishAttempted || candidate == nil || candidate?.problems.isEmpty != true || checks.isEmpty || checks != Set(candidate?.definition.checks.map(\.id) ?? []) || origin != ProductReadIdentity(api: workspace.api)) }
        }.padding(28).frame(minWidth: 800, idealWidth: 960, minHeight: 720).background(ProductDesign.canvas).preferredColorScheme(.light)
        .interactiveDismissDisabled(busy)
        .onAppear { origin = ProductReadIdentity(api: workspace.api); if let scenario { selection = [scenario.id] } }
        .onChange(of: paths) { _, _ in invalidate(); chains = []; resolvedTests = [] }
        .onChange(of: chains) { _, _ in invalidate() }
        .sheet(isPresented: $editing, onDismiss: { dismiss() }) { if let scenario { ScenarioEditor(existing: scenario) } }
    }
    private var chainEditor: some View {
        ProductPanel(title: "같은 상태를 이어받는 TC 흐름") {
            VStack(alignment: .leading, spacing: 14) {
                ProductNotice("미지정 TC는 독립 흐름으로 순차 실행합니다. 동일 흐름은 같은 앱·프로필·플랫폼이어야 하며, 두 번째 TC부터 attach가 필요합니다. 선행 실패·정리 실패 뒤에는 후행 입력을 차단합니다.")
                ForEach(chains) { chain in
                    VStack(alignment: .leading, spacing: 10) {
                        HStack {
                            Text("동일 세션 흐름").font(.headline)
                            Spacer()
                            Button("흐름 해제") { chains.removeAll { $0.id == chain.id } }.buttonStyle(ProductButtonStyle())
                        }
                        Text(chain.id).font(.caption.monospaced()).foregroundStyle(ProductDesign.muted)
                        ForEach(resolvedTests) { test in
                            Toggle("\(test.id) · \(test.name) · \(test.spec["start"]?.string ?? "미확인")", isOn: chainMembership(chain.id, testID: test.id))
                                .disabled(chains.contains { $0.id != chain.id && $0.members.contains(test.id) })
                        }
                        ForEach(Array(chain.members.enumerated()), id: \.offset) { index, member in
                            HStack {
                                Text("\(index + 1). \(member)").font(.callout.monospaced())
                                Spacer()
                                Button("위로") { moveMember(chain.id, from: index, by: -1) }.disabled(index == 0)
                                Button("아래로") { moveMember(chain.id, from: index, by: 1) }.disabled(index == chain.members.count - 1)
                            }.buttonStyle(ProductButtonStyle())
                        }
                        if chain.members.count < 2 { ProductNotice("한 흐름에 TC를 2개 이상 선택하세요.", tone: .warning) }
                        Divider()
                    }
                }
                Button("동일 세션 흐름 추가") { chains.append(RegressionExecutionChain(id: UUID().uuidString.lowercased(), members: [])) }.buttonStyle(ProductButtonStyle())
                if candidate == nil { Text("구성 변경 후 후보를 다시 미리보고 필수 검증을 재검토해야 발행할 수 있습니다.").font(.caption) }
            }
        }
    }
    private func sourceDetails(_ item: ProductScenario) -> some View {
        DisclosureGroup("\(item.name) · 원문·정의 보기") {
            VStack(alignment: .leading, spacing: 8) {
                if let definition = item.definition {
                    Text(definition.readable).font(.callout.monospaced()).textSelection(.enabled)
                } else {
                    ProductNotice("legacy · 원문 보존·읽기 전용입니다. 이전 단일 텍스트 기대값은 새 발행 자격이 아닙니다.", tone: .warning)
                    Text(item.legacy?.readable ?? item.expected ?? "기대값 기록 없음").textSelection(.enabled)
                }
                if let source = item.source {
                    Text(source.notes).textSelection(.enabled)
                    Text("해석 검토: \(source.reviewed ? "기록 있음" : "미검토")")
                    ForEach(Array(source.mappings.enumerated()), id: \.offset) { _, mapping in Text("\(mapping.segmentID) · \(mapping.disposition) · \(mapping.stepPaths.joined(separator: ", ")) · \(mapping.reason)").textSelection(.enabled) }
                }
                ForEach(Array((item.problems ?? []).enumerated()), id: \.offset) { _, problem in ProductNotice(problem.readable, tone: .warning) }
            }
        }
    }
    private func invalidate() { candidate = nil; checks = []; message = nil }
    private func chainMembership(_ chainID: String, testID: String) -> Binding<Bool> {
        Binding(get: { chains.first { $0.id == chainID }?.members.contains(testID) == true }, set: { enabled in
            guard let index = chains.firstIndex(where: { $0.id == chainID }) else { return }
            if enabled { if !chains[index].members.contains(testID) { chains[index].members.append(testID) } }
            else { chains[index].members.removeAll { $0 == testID } }
        })
    }
    private func moveMember(_ chainID: String, from: Int, by offset: Int) {
        guard let index = chains.firstIndex(where: { $0.id == chainID }), chains[index].members.indices.contains(from), chains[index].members.indices.contains(from + offset) else { return }
        chains[index].members.swapAt(from, from + offset)
    }
    private func preview() async {
        guard let api = workspace.api, origin == ProductReadIdentity(api: api), !busy, !paths.isEmpty, validChains, !publishAttempted else { return }
        busy = true; invalidate(); defer { busy = false }
        do {
            let value: RegressionCandidate = try await api.regression(RegressionCommand(method: "scenario.preview", paths: paths, chains: chains))
            guard origin == ProductReadIdentity(api: workspace.api), !Task.isCancelled else { return }
            resolvedTests = value.definition.tests
            candidate = value
        } catch { if origin == ProductReadIdentity(api: workspace.api) { message = error.localizedDescription } }
    }
    private func publish() async {
        guard let api = workspace.api, origin == ProductReadIdentity(api: api), let candidate, candidate.problems.isEmpty, !busy, !publishAttempted, checks == Set(candidate.definition.checks.map(\.id)), !checks.isEmpty else { return }
        busy = true; publishAttempted = true; defer { busy = false }
        do {
            let revision: RegressionRevision = try await api.regression(RegressionCommand(method: "scenario.publish", candidateId: candidate.candidateId, digest: candidate.digest, reviewedChecks: checks.sorted()), humanReview: true)
            guard origin == ProductReadIdentity(api: workspace.api), revision.id == candidate.digest else { return }
            message = "검토한 digest를 발행했습니다. 실제 실행 검증은 아직 수행하지 않았습니다."
            await workspace.regression.refresh(api: workspace.api)
        } catch { if origin == ProductReadIdentity(api: workspace.api) { message = "발행 응답 미확인·거부: \(error.localizedDescription). 기록 조회 전 재전송하지 않습니다." } }
    }
}
