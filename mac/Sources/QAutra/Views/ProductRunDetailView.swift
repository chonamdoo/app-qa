import AppKit
import Combine
import AVKit
import CryptoKit
import SwiftUI

struct ProductRunDetailView: View {
    @Environment(Workspace.self) private var workspace
    let run: RunListItem
    @State private var summary: ProductJSON?
    @State private var events: [QaEvent] = []
    @State private var loading = false
    @State private var error: String?
    @State private var evidence: EvidenceRequest?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                ProductPageHeading(title: run.displayTitle, subtitle: "저장된 실행 · \(DisplayDate.text(run.startedAt))")
                Text(run.id).font(.caption.monospaced()).textSelection(.enabled)
                ProductNotice("과거 실행의 읽기 전용 기록입니다. 현재 계획·프로필로 누락된 revision·attempt·검증 범위를 소급 보충하지 않습니다. 새 정식 실행은 발행본 선택 화면에서 시작하세요.", tone: .warning)
                Button("기록 다시 조회") { Task { await load() } }.buttonStyle(ProductButtonStyle())
                if loading { ProgressView("저장된 기록 조회 중") }
                if let error { ProductNotice(error, tone: .error) }
                if let summary {
                    ProductPanel(title: "실행 당시 저장된 결과") { Text(summary.readable).font(.callout.monospaced()).textSelection(.enabled) }
                }
                ProductPanel(title: "읽기 전용 Replay · 저장된 단계") {
                    VStack(alignment: .leading, spacing: 12) {
                        ForEach(events.filter { if case .stepStarted = $0.body { return true }; return false }) { event in
                            Button {
                                if let key = event.stepKey { evidence = EvidenceRequest(key: key, runDir: run.runDir, events: events.filter { $0.stepKey == key }) }
                            } label: {
                                VStack(alignment: .leading, spacing: 5) {
                                    if case .stepStarted(let label) = event.body { Text(label) }
                                    Text("\(event.testId ?? "미기록") · \(event.platform ?? "미기록") · \(DisplayDate.text(event.ts))").font(.caption)
                                }.frame(maxWidth: .infinity, alignment: .leading)
                            }.buttonStyle(ProductButtonStyle())
                        }
                        if events.isEmpty { Text("이 실행에 조회된 단계가 없습니다. 다른 실행이나 샘플 화면으로 대체하지 않습니다.") }
                    }
                }
            }.padding(32)
        }.background(ProductDesign.canvas)
        .task(id: ProductReadIdentity(api: workspace.api, runID: run.id)) { await load() }
        .sheet(item: $evidence) { EvidenceView(request: $0) }
    }
    private func load() async {
        summary = nil; events = []; error = nil; loading = false
        guard let api = workspace.api else { error = "엔진 연결이 필요합니다."; return }
        if let journal = run.eventJournal, !journal.usable {
            error = journal.problem
            return
        }
        let identity = ProductReadIdentity(api: api, runID: run.id)
        loading = true; defer { if identity == ProductReadIdentity(api: workspace.api, runID: run.id) { loading = false } }
        do {
            let data = try await api.data(for: api.runFileRequest(runId: run.id, runDir: run.runDir, path: "summary.json"))
            let value = try JSONDecoder().decode(ProductJSON.self, from: data)
            guard value["runId"]?.string == run.id else { throw APIError(status: 0, message: "저장 요약 runId 불일치") }
            guard identity == ProductReadIdentity(api: workspace.api, runID: run.id), !Task.isCancelled else { return }
            summary = value
            let bytes = try await api.data(for: api.request("/api/runs/\(APIClient.segment(run.id))/events"))
            let parsed = try bytes.split(separator: 10).map { try JSONDecoder().decode(QaEvent.self, from: Data($0)) }
            guard parsed.allSatisfy({ $0.runId == run.id || $0.runId == nil && $0.type == "log" }) else { throw APIError(status: 0, message: "저장 이벤트 runId 불일치") }
            guard identity == ProductReadIdentity(api: workspace.api, runID: run.id), !Task.isCancelled else { return }
            events = parsed
        } catch { if identity == ProductReadIdentity(api: workspace.api, runID: run.id), !Task.isCancelled { self.error = error.localizedDescription } }
    }
}

struct RegressionRunDetailView: View {
    @Environment(Workspace.self) private var workspace
    @Environment(\.dismiss) private var dismiss
    let requestID: String
    var onClose: (() -> Void)? = nil
    @State private var run: RegressionRun?
    @State private var selectedAttemptID = ""
    @State private var loading = false
    @State private var error: String?
    @State private var stopping = false
    @State private var stopAttempted = false
    @State private var confirmStop = false
    @State private var repeating = false
    @State private var compareID = ""
    @State private var comparison: RegressionComparison?
    @State private var compareError: String?
    @State private var comparing = false
    @State private var origin = ProductReadIdentity(api: nil)
    private var selected: RegressionAttempt? { run?.attempts.first { $0.id == selectedAttemptID } }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(alignment: .top) {
                ProductPageHeading(title: run?.name ?? "실행 상세", subtitle: run.map { "접수 \(DisplayDate.text($0.createdAt)) · 갱신 \(DisplayDate.text($0.updatedAt))" } ?? "durable 요청 기록을 조회합니다.")
                Spacer()
                Button("닫기") { if let onClose { onClose() } else { dismiss() } }.buttonStyle(ProductButtonStyle())
            }
            Text(requestID).font(.caption.monospaced()).foregroundStyle(ProductDesign.muted).textSelection(.enabled)
            if let error { ProductNotice(error, tone: .error) }
            if loading { ProgressView("서버 상태 조회 중") }
            if let run {
                HStack {
                    ProductStatusBadge(status: run.state)
                    if let verdict = businessVerdict(run) { ProductStatusBadge(status: verdict) }
                    Spacer()
                    Button("상태 조회") { Task { await refresh() } }.buttonStyle(ProductButtonStyle()).disabled(loading)
                    Button("별도 새 attempt") { repeating = true }.buttonStyle(ProductButtonStyle(kind: .primary))
                    if !run.terminal { Button(run.stopRequested || stopAttempted ? "중지 요청됨 · 종료 확인 중" : "중지 후 정리") { confirmStop = true }.buttonStyle(ProductButtonStyle(kind: .danger)).disabled(run.stopRequested || stopAttempted || stopping) }
                }
                if let message = run.message { ProductNotice("\(run.code ?? run.state) · \(message)", tone: .warning) }
                if run.state == "unknown" { ProductNotice("원 실행 결과 미확인 · 당시 완료·증거·정리를 확인하지 못했습니다. 현재 자원 복구 근거는 아래에서 별도로 확인하며, 늦은 응답이나 새 PASS로 원 unknown을 덮지 않습니다.", tone: .warning) }
                ScrollView {
                    VStack(alignment: .leading, spacing: 18) {
                        ProductPanel(title: "Space · 이 실행의 attempt", subtitle: "Space는 관측 UI입니다. 새 VM을 생성하거나 이전 attempt 화면을 이어받지 않습니다.") {
                            VStack(alignment: .leading, spacing: 12) {
                                ForEach(run.attempts) { attempt in
                                    Button { selectedAttemptID = attempt.id } label: {
                                        HStack {
                                            VStack(alignment: .leading, spacing: 4) {
                                                Text("\((attempt.chain?.members ?? [attempt.testId]).joined(separator: " → ")) · \(attempt.target.platform)")
                                                Text("\(attempt.target.deviceId) · attempt \(attempt.id)").font(.caption.monospaced())
                                            }
                                            Spacer()
                                            ProductStatusBadge(status: attempt.state)
                                            Text("검증 \(attempt.completedChecks.count)/\(attempt.requiredChecks.count)")
                                            if selectedAttemptID == attempt.id { Image(systemName: "checkmark.circle.fill") }
                                        }.frame(maxWidth: .infinity, alignment: .leading)
                                    }.buttonStyle(ProductButtonStyle())
                                }
                                if run.attempts.isEmpty { ProductNotice("필수 attempt가 없습니다. 전체 PASS가 될 수 없습니다.", tone: .warning) }
                            }
                        }
                        if let selected { RegressionAttemptDetail(attempt: selected).id(ProductAttemptIdentity(api: ProductReadIdentity(api: workspace.api), requestID: requestID, attemptID: selected.id)) }
                        ProductPanel(title: "읽기 전용 실행 비교", subtitle: "원 실패와 새 attempt를 보존합니다. 같은 ID는 동일 초기 조건의 증거가 아닙니다.") {
                            VStack(alignment: .leading, spacing: 12) {
                                Picker("비교할 이전 실행", selection: $compareID) {
                                    Text("명시적으로 선택").tag("")
                                    ForEach(workspace.regression.runs.filter { $0.id != requestID }) { value in Text("\(value.name) · \(DisplayDate.text(value.createdAt))").tag(value.id) }
                                }
                                Button("두 실행 조건·결과 비교") { Task { await compare() } }.buttonStyle(ProductButtonStyle()).disabled(compareID.isEmpty || comparing)
                                if comparing { ProgressView("비교 기록 조회 중") }
                                if let compareError { ProductNotice(compareError, tone: .warning) }
                                if let comparison {
                                    ForEach(comparison.comparisons.indices, id: \.self) { index in
                                        let item = comparison.comparisons[index]
                                        VStack(alignment: .leading, spacing: 6) {
                                            Text("\(item.comparable ? "비교 가능" : "동일 조건 비교 불가") · \(item.classification)").font(.headline)
                                            Text(item.reason)
                                            Text("원 attempt \(item.beforeAttemptId ?? "대응 없음") → 새 attempt \(item.attemptId)").font(.caption.monospaced())
                                            HStack(alignment: .top, spacing: 24) {
                                                VStack(alignment: .leading, spacing: 4) {
                                                    Text("이전 실행").font(.caption).foregroundStyle(ProductDesign.muted)
                                                    ProductStatusBadge(status: item.before?["business"]?.string ?? "NOT_RUN")
                                                    Text("영상 \(item.before?["evidence"]?.string ?? "미확인") · 정리 \(item.before?["cleanup"]?.string ?? "미확인")").font(.caption)
                                                }
                                                VStack(alignment: .leading, spacing: 4) {
                                                    Text("새 실행").font(.caption).foregroundStyle(ProductDesign.muted)
                                                    ProductStatusBadge(status: item.after["business"]?.string ?? "NOT_RUN")
                                                    Text("영상 \(item.after["evidence"]?.string ?? "미확인") · 정리 \(item.after["cleanup"]?.string ?? "미확인")").font(.caption)
                                                }
                                            }
                                            DisclosureGroup("저장된 실제 조건·판정 근거") {
                                                Text("이전: \(item.before?.readable ?? "대응 결과 없음")\n현재: \(item.after.readable)").font(.caption.monospaced()).textSelection(.enabled)
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            } else if !loading { ProductNotice("이 요청의 현재 서버 기록이 없습니다. 미등록·미실행으로 추정하거나 자동 재전송하지 않습니다.", tone: .warning) }
        }.padding(28).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .task(id: ProductReadIdentity(api: workspace.api, runID: requestID)) {
            run = nil; selectedAttemptID = ""; comparison = nil
            origin = ProductReadIdentity(api: workspace.api)
            await workspace.regression.refresh(api: workspace.api)
            while !Task.isCancelled {
                await refresh()
                do { try await Task.sleep(for: .seconds(2)) } catch { break }
            }
        }
        .onChange(of: compareID) { _, _ in comparison = nil; compareError = nil }
        .sheet(isPresented: $repeating) { if let run { ProductNewRunView(onStarted: { repeating = false }, repeatRun: run) } }
        .confirmationDialog("새 입력을 중지하고 영상·자원을 정리할까요?", isPresented: $confirmStop, titleVisibility: .visible) {
            Button("중지 후 정리", role: .destructive) { Task { await stop() } }
            Button("계속 실행", role: .cancel) {}
        } message: { Text("중지 요청은 rollback이 아닙니다. 진행 중인 효과·영상 확정·정리 완료는 서버 상태로 별도 확인합니다.") }
    }
    private func businessVerdict(_ run: RegressionRun) -> String? {
        if run.complete { return "PASS" }
        if run.attempts.contains(where: { $0.business == "FAIL" }) { return "FAIL" }
        if run.state == "unknown" { return "UNKNOWN" }
        return run.terminal ? "INCONCLUSIVE" : nil
    }
    private func refresh() async {
        guard let api = workspace.api, origin == ProductReadIdentity(api: api), !loading else { return }
        loading = true; defer { loading = false }
        do {
            let value: RegressionRun = try await api.regression(RegressionCommand(method: "regression.status", requestId: requestID))
            guard origin == ProductReadIdentity(api: workspace.api), value.id == requestID, !Task.isCancelled else { return }
            run = value; error = nil
            if !value.attempts.contains(where: { $0.id == selectedAttemptID }) { selectedAttemptID = value.attempts.first?.id ?? "" }
        } catch { if origin == ProductReadIdentity(api: workspace.api), !Task.isCancelled { self.error = "상태 조회 실패: \(error.localizedDescription) · 마지막 기록은 최신 상태가 아닐 수 있습니다." } }
    }
    private func stop() async {
        guard let api = workspace.api, origin == ProductReadIdentity(api: api), !stopAttempted, run?.terminal == false else { return }
        stopAttempted = true; stopping = true; defer { stopping = false }
        do {
            let value: RegressionRun = try await api.regression(RegressionCommand(method: "regression.stop", requestId: requestID))
            guard origin == ProductReadIdentity(api: workspace.api), value.id == requestID else { return }
            run = value
        } catch { if origin == ProductReadIdentity(api: workspace.api) { self.error = "중지 응답 미확인: \(error.localizedDescription). 다시 전송하지 않고 상태를 조회합니다." } }
    }
    private func compare() async {
        guard let api = workspace.api, origin == ProductReadIdentity(api: api), !comparing else { return }
        let before = compareID
        comparing = true; comparison = nil; compareError = nil; defer { comparing = false }
        do {
            let value: RegressionComparison = try await api.regression(RegressionCommand(method: "regression.compare", before: before, after: requestID))
            guard origin == ProductReadIdentity(api: workspace.api), compareID == before, value.before == before, value.after == requestID, value.readOnly else { return }
            comparison = value
        } catch { if origin == ProductReadIdentity(api: workspace.api), compareID == before { compareError = error.localizedDescription } }
    }
}

private struct ProductAttemptIdentity: Hashable {
    let api: ProductReadIdentity
    let requestID: String
    let attemptID: String
}

struct RegressionAttemptDetail: View {
    let attempt: RegressionAttempt
    @Environment(Workspace.self) private var workspace
    @State private var revision: RegressionRevision?
    @State private var receipts: [ProductJSON] = []
    @State private var events: [QaEvent] = []
    @State private var target: ProductJSON?
    @State private var video: AttemptVideoReceipt?
    @State private var readError: String?
    @State private var selectedMoment: String?
    @State private var videoError: String?
    @State private var selectedCheck = ""
    @State private var evidence: EvidenceRequest?
    @State private var loading = false
    @State private var recovery: ExecutionResourceRecovery?
    @State private var recoveryError: String?
    @State private var recoveryLoading = false
    @State private var recoveryReadSequence = 0
    private var checks: [RegressionCheck] { revision?.definition.checks.filter { attempt.requiredChecks.contains($0.id) } ?? [] }
    @State private var contentWidth: CGFloat = 1200
    private var receipt: ProductJSON? { receipts.last { $0["assertionId"]?.string == selectedCheck } }
    private var test: RegressionDefinition.Test? { revision?.definition.tests.first { $0.id == attempt.testId } }
    private var members: [String] { attempt.chain?.members ?? [attempt.testId] }
    private var artifactIdentity: String { [attempt.id, attempt.runId ?? "", attempt.state, attempt.evidence, attempt.completedChecks.joined()].joined(separator: ":") }
    private func plannedSteps(_ testID: String) -> [String] {
        for event in events {
            if case .runStarted(_, _, let tests, _) = event.body,
               let plan = tests.first(where: { $0.id == testID && $0.platforms.contains(attempt.target.platform) }) { return plan.steps }
        }
        return []
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            ProductPanel(title: test?.name ?? attempt.testId, subtitle: "선택 attempt \(attempt.id) · revision \(attempt.revisionId)") {
                VStack(alignment: .leading, spacing: 12) {
                    HStack { Text("업무 판정"); ProductStatusBadge(status: attempt.business); Text("실행 확실성"); ProductStatusBadge(status: attempt.state) }
                    Text("필수 검증 \(attempt.completedChecks.count)/\(attempt.requiredChecks.count) · 영상 \(attempt.evidence) · 정리 \(attempt.cleanup)")
                    if attempt.chain != nil { Text("동일 세션의 명시 순서 · \(members.joined(separator: " → "))").font(.callout).textSelection(.enabled) }
                    if let message = attempt.message { ProductNotice("\(attempt.code ?? "") · \(message)", tone: .warning) }
                    if loading { ProgressView("선택 attempt 근거 조회 중") }
                    if let readError { ProductNotice(readError, tone: .warning) }
                    if let target {
                        DisclosureGroup("실제 대상 receipt") {
                            Text(target.readable).font(.callout.monospaced()).textSelection(.enabled)
                        }
                    }
                    if attempt.runId == nil { ProductNotice("아직 배정된 실행 관측이 없습니다. 이전 attempt의 화면·단계·PASS를 표시하지 않습니다.") }
                }
            }
            if attempt.state == "unknown" || recovery?.observation != nil {
                ResourceRecoveryPanel(snapshot: recovery, readError: recoveryError, busy: recoveryLoading, showVideo: true,
                    onRefresh: { Task { await refreshRecovery() } })
            }
            AttemptSpaceView(attempt: attempt)
            if contentWidth >= 1100 {
                HStack(alignment: .top, spacing: 20) { timeline.frame(maxWidth: .infinity); verification.frame(width: contentWidth >= 1600 ? 300 : 264) }
            } else {
                VStack(alignment: .leading, spacing: 20) { timeline; verification.frame(maxWidth: 765, alignment: .leading) }
            }
            ProductPanel(title: "실제 저장 영상 · 읽기 전용 Replay", subtitle: "재생은 실행 명령을 발생시키지 않습니다. capture 범위·공백과 원 FAIL을 따로 보존합니다.") {
                VStack(alignment: .leading, spacing: 12) {
                    if let videoError { ProductNotice(videoError, tone: .warning) }
                    if let video, let runID = attempt.runId {
                        Text("영상 \(video.state) · recorder 정리 \(video.cleanup) · segment \(video.segments.count)개")
                        if let code = video.code { Text(code).font(.caption.monospaced()) }
                        ForEach(video.gaps.indices, id: \.self) { index in
                            let gap = video.gaps[index]
                            ProductNotice("영상 공백 \(DisplayDate.text(gap.from)) ~ \(DisplayDate.text(gap.to)) · \(gap.reason)", tone: .warning)
                        }
                        ForEach(video.segments, id: \.file) { segment in
                            VStack(alignment: .leading, spacing: 8) {
                                Text("\(segment.source) · \(DisplayDate.text(segment.startedAt)) ~ \(DisplayDate.text(segment.endedAt))")
                                Text("\(segment.file) · \(segment.frames) frames · \(segment.durationSeconds)초").font(.caption.monospaced())
                                ReceiptVideoPlayer(runID: runID, segment: segment, seekAt: selectedMoment).id(ProductReadIdentity(api: workspace.api, runID: runID, artifact: segment.file))
                            }
                        }
                        if video.segments.isEmpty { ProductNotice("영상 receipt는 있지만 재생 가능한 실제 파일이 없습니다. incomplete는 정상 영상이 아닙니다.", tone: .warning) }
                    } else if attempt.evidence == "recording" || attempt.evidence == "finalizing" { Text("필수 영상 수집·최종화 중입니다. 아직 확정된 재생 파일이 없습니다.") }
                    else if attempt.runId == nil { Text("영상 없음 · 실행 전 대기/차단 또는 미배정입니다.") }
                }
            }
        }
        .task(id: ProductReadIdentity(api: workspace.api, runID: attempt.runId, artifact: artifactIdentity)) { await load() }
        .sheet(item: $evidence) { EvidenceView(request: $0) }
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { contentWidth = $0 }
    }
    private var timeline: some View {
        ProductPanel(title: "시나리오 단계 · 저장된 관측", subtitle: "선택 revision·test·target·attempt만 사용합니다.") {
            VStack(alignment: .leading, spacing: 12) {
                ForEach(members, id: \.self) { testID in
                    VStack(alignment: .leading, spacing: 12) {
                        Text(testID).font(.headline).textSelection(.enabled)
                        let byStep = Dictionary(grouping: events.lazy.filter { $0.testId == testID && $0.platform == attempt.target.platform }) { $0.index }
                        let steps = plannedSteps(testID)
                        if !steps.isEmpty {
                            ForEach(steps.indices, id: \.self) { index in
                                let label = steps[index]
                                let related = byStep[index] ?? []
                                VStack(alignment: .leading, spacing: 8) {
                                    Text("\(index + 1). \(label)").font(.callout).textSelection(.enabled)
                                    Text(related.isEmpty ? "이 attempt의 관측 없음 · 미실행/미확인" : "저장 이벤트 \(related.count)개").font(.caption).foregroundStyle(ProductDesign.muted)
                                    if let key = related.first?.stepKey {
                                        Button("이 단계 Replay 근거") {
                                            selectedMoment = related.last { if case .stepFinished = $0.body { return true }; return false }?.ts
                                            evidence = EvidenceRequest(key: key, runDir: nil, events: related)
                                        }.buttonStyle(ProductButtonStyle(size: .small))
                                    }
                                }
                                Divider()
                            }
                        } else { Text("이 TC의 고정된 실행 단계가 아직 기록되지 않았습니다. 현재 정의로 과거 단계 index를 추정하지 않습니다.") }
                    }
                }
            }
        }
    }
    private var verification: some View {
        ProductPanel(title: "필수 검증 \(attempt.completedChecks.count)/\(attempt.requiredChecks.count)") {
            VStack(alignment: .leading, spacing: 12) {
                ForEach(checks) { check in
                    Button { selectedCheck = check.id; selectedMoment = receipts.last { $0["assertionId"]?.string == check.id }?["evaluatedAt"]?.string } label: {
                        VStack(alignment: .leading, spacing: 6) {
                            Text("\(check.testId) · \(check.path) · \(check.kind)")
                            Text(check.description).textSelection(.enabled)
                            Text("\(check.scope) · \(check.platforms.joined(separator: ", "))").font(.caption)
                            ProductStatusBadge(status: receipts.last { $0["assertionId"]?.string == check.id }?["verdict"]?.string ?? "NOT_RUN")
                        }.frame(maxWidth: .infinity, alignment: .leading)
                    }.buttonStyle(ProductButtonStyle())
                }
                if checks.isEmpty { ProductNotice("결합된 필수 검증 정의를 조회하지 못했습니다. 0개를 PASS로 처리하지 않습니다.", tone: .warning) }
                if let receipt { Text("선택 검증 actual·관측 receipt\n\(receipt.readable)").font(.callout.monospaced()).textSelection(.enabled) }
                else if !selectedCheck.isEmpty { Text("선택 검증의 이 attempt receipt가 없습니다.") }
            }
        }
    }
    private func refreshRecovery() async {
        guard let api = workspace.api else { return }
        let selected = attempt
        let identity = ProductReadIdentity(api: api, runID: selected.runId, artifact: selected.id)
        recoveryReadSequence += 1
        let sequence = recoveryReadSequence
        func current() -> Bool { sequence == recoveryReadSequence && identity == ProductReadIdentity(api: workspace.api, runID: attempt.runId, artifact: attempt.id) && !Task.isCancelled }
        recoveryLoading = true
        defer { if current() { recoveryLoading = false } }
        do {
            let reply = try await api.agent(.executionStatus(attemptID: selected.id), as: ExecutionResourceRecovery.self)
            try reply.value.validate(attempt: selected)
            guard current() else { return }
            recovery = reply.value; recoveryError = nil
        } catch { if current() { recoveryError = "원 attempt 복구 근거 조회 실패: \(error.localizedDescription). 마지막 관측은 최신 상태가 아닐 수 있습니다." } }
    }

    private func load() async {
        revision = nil; receipts = []; events = []; target = nil; video = nil; readError = nil; videoError = nil; selectedCheck = ""
        guard let api = workspace.api else { return }
        let identity = ProductReadIdentity(api: api, runID: attempt.runId, artifact: artifactIdentity)
        func current() -> Bool { identity == ProductReadIdentity(api: workspace.api, runID: attempt.runId, artifact: artifactIdentity) && !Task.isCancelled }
        loading = true; defer { if current() { loading = false } }
        await refreshRecovery()
        guard current() else { return }
        do {
            let value: RegressionRevision = try await api.regression(RegressionCommand(method: "scenario.get", revisionId: attempt.revisionId))
            guard current(), value.id == attempt.revisionId else { return }
            revision = value
            guard let runID = attempt.runId else { return }
            let manifestData = try await api.data(for: api.runFileRequest(runId: runID, runDir: nil, path: "attempt-manifest.json"))
            let manifest = try JSONDecoder().decode(ProductJSON.self, from: manifestData)
            let manifestChain = try JSONDecoder().decode(RegressionExecutionChain?.self, from: JSONEncoder().encode(manifest["chain"] ?? .null))
            guard manifestChain == attempt.chain else { throw APIError(status: 0, message: "동일 세션 흐름의 원 구성·순서가 선택 attempt와 일치하지 않습니다") }
            guard manifest["attemptId"]?.string == attempt.id, manifest["revisionId"]?.string == attempt.revisionId, manifest["testId"]?.string == attempt.testId,
                  manifest["target"]?["deviceId"]?.string == attempt.target.deviceId, manifest["target"]?["platform"]?.string == attempt.target.platform else { throw APIError(status: 0, message: "선택 attempt와 저장 manifest identity가 일치하지 않습니다") }
            let eventData = try await api.data(for: api.request("/api/runs/\(APIClient.segment(runID))/events"))
            let decoded = try eventData.split(separator: 10).map { try JSONDecoder().decode(QaEvent.self, from: Data($0)) }
            guard decoded.allSatisfy({ $0.runId == runID || $0.runId == nil && $0.type == "log" }) else { throw APIError(status: 0, message: "이벤트 runId 불일치") }
            guard current() else { return }; events = decoded
            let targetData = try await api.data(for: api.runFileRequest(runId: runID, runDir: nil, path: "target-receipt.json"))
            let observed = try JSONDecoder().decode(ProductJSON.self, from: targetData)
            guard ["qautra/attempt-target/v2", "qautra/attempt-target/v3"].contains(observed["schema"]?.string ?? ""), observed["attemptId"]?.string == attempt.id,
                  observed["target"]?["device"]?["id"]?.string == attempt.target.deviceId, observed["target"]?["device"]?["platform"]?.string == attempt.target.platform else { throw APIError(status: 0, message: "실제 대상 receipt 불일치") }
            guard current() else { return }; target = observed
            let bytes = try await api.data(for: api.runFileRequest(runId: runID, runDir: nil, path: "assertions.jsonl"))
            let assertions = try bytes.split(separator: 10).map { try JSONDecoder().decode(ProductJSON.self, from: Data($0)) }
            guard assertions.allSatisfy({ $0["attemptId"]?.string == attempt.id && $0["revisionId"]?.string == attempt.revisionId && $0["runId"]?.string == runID && $0["target"]?["deviceId"]?.string == attempt.target.deviceId && $0["target"]?["platform"]?.string == attempt.target.platform && attempt.requiredChecks.contains($0["assertionId"]?.string ?? "") }) else { throw APIError(status: 0, message: "다른 attempt·검증의 receipt를 표시하지 않습니다") }
            guard current() else { return }; receipts = assertions
        } catch { if current() { readError = "선택 attempt 근거 조회: \(error.localizedDescription). 누락을 이전 PASS로 보충하지 않습니다." } }
        guard let runID = attempt.runId, current() else { return }
        do {
            let bytes = try await api.data(for: api.runFileRequest(runId: runID, runDir: nil, path: "video/\(attempt.id)/manifest.json"))
            let value = try JSONDecoder().decode(AttemptVideoReceipt.self, from: bytes)
            guard value.schema == "qautra/attempt-video/v1", value.binding.attemptId == attempt.id, value.binding.runId == runID, value.binding.platform == attempt.target.platform, value.binding.deviceId == attempt.target.deviceId else { throw APIError(status: 0, message: "영상 receipt의 attempt·target 불일치") }
            guard current() else { return }; video = value
        } catch { if current() { videoError = "영상 missing/조회 실패: \(error.localizedDescription). 저장 중·실패·삭제 여부는 엔진 기록을 확인하세요." } }
    }
}


struct ReceiptVideoPlayer: View {
    let runID: String
    let segment: AttemptVideoReceipt.Segment
    var seekAt: String? = nil
    @Environment(Workspace.self) private var workspace
    @State private var player: AVPlayer?
    @State private var error: String?
    @State private var loading = false
    @State private var temporary: URL?
    @State private var visible = true
    private var seekSeconds: Double? {
        guard let moment = DisplayDate.date(seekAt), let start = DisplayDate.date(segment.startedAt) else { return nil }
        let seconds = moment.timeIntervalSince(start)
        return seconds >= 0 && seconds <= segment.durationSeconds ? seconds : nil
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let player, let item = player.currentItem {
                VideoPlayer(player: player).frame(minHeight: 300)
                    .onReceive(item.publisher(for: \.status)) { status in if status == .failed { error = item.error?.localizedDescription ?? "영상 재생 실패" } }
                if let seekSeconds {
                    Button("선택 단계·검증 시각으로 이동") { player.seek(to: CMTime(seconds: seekSeconds, preferredTimescale: 600)) }.buttonStyle(ProductButtonStyle())
                    Text("receipt 시각 기준 위치입니다. capture 시계 차이·영상 공백은 원본 receipt와 함께 확인하세요.").font(.callout)
                }
            } else { Button("실제 파일 조회 후 재생") { Task { await load() } }.buttonStyle(ProductButtonStyle()).disabled(loading || workspace.api == nil) }
            if loading { ProgressView("영상 파일·receipt 검증 중") }
            if let error { ProductNotice("영상 재생 실패: \(error)", tone: .error) }
        }.onAppear { visible = true }
            .onDisappear { visible = false; player?.pause(); player = nil; removeTemporary() }
    }
    private func removeTemporary() { if let temporary { try? FileManager.default.removeItem(at: temporary); self.temporary = nil } }
    private func load() async {
        guard visible, let api = workspace.api, !loading, segment.frames > 0, segment.durationSeconds > 0, segment.bytes > 0,
              !segment.file.hasPrefix("/"), !segment.file.split(separator: "/", omittingEmptySubsequences: false).contains(where: { $0 == ".." || $0 == "." || $0.isEmpty }) else { error = "receipt에 재생 가능한 안전한 파일이 없습니다."; return }
        let identity = ProductReadIdentity(api: api, runID: runID, artifact: segment.file)
        loading = true; error = nil; defer { loading = false }
        var directory: URL?
        do {
            let (download, response) = try await api.session.download(for: api.runFileRequest(runId: runID, runDir: nil, path: segment.file))
            defer { try? FileManager.default.removeItem(at: download) }
            guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw APIError(status: 0, message: "영상 파일 missing·접근 불가") }
            let handle = try FileHandle(forReadingFrom: download); defer { try? handle.close() }
            var digest = SHA256(), count = 0
            while let chunk = try handle.read(upToCount: 1_048_576), !chunk.isEmpty { digest.update(data: chunk); count += chunk.count }
            guard count == segment.bytes, digest.finalize().map({ String(format: "%02x", $0) }).joined() == segment.sha256 else { throw APIError(status: 0, message: "실제 영상의 크기·SHA-256이 receipt와 다릅니다") }
            guard visible, identity == ProductReadIdentity(api: workspace.api, runID: runID, artifact: segment.file), !Task.isCancelled else { return }
            let folder = FileManager.default.temporaryDirectory.appendingPathComponent("qautra-video-\(UUID().uuidString)", isDirectory: true)
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700]); directory = folder
            let file = folder.appendingPathComponent("segment.mp4")
            try FileManager.default.moveItem(at: download, to: file)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
            let asset = AVURLAsset(url: file)
            guard try await asset.load(.isPlayable) else { throw APIError(status: 0, message: "실제 파일을 AVPlayer로 재생할 수 없습니다") }
            guard visible, identity == ProductReadIdentity(api: workspace.api, runID: runID, artifact: segment.file), !Task.isCancelled else { try? FileManager.default.removeItem(at: folder); return }
            removeTemporary(); temporary = folder; player = AVPlayer(playerItem: AVPlayerItem(asset: asset))
        } catch {
            if let directory { try? FileManager.default.removeItem(at: directory) }
            if identity == ProductReadIdentity(api: workspace.api, runID: runID, artifact: segment.file), !Task.isCancelled { self.error = error.localizedDescription }
        }
    }
}
