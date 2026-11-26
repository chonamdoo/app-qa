import AppKit
import SwiftUI

struct ProductEvidenceLibraryView: View {
    @Environment(Workspace.self) private var workspace
    let onOpenRun: (RunListItem) -> Void
    @State private var model = ProductEvidenceModel()
    @State private var requestID = ""
    @State private var attemptID = ""
    @State private var target = ""
    @State private var kind = ""
    @State private var capturedFrom = Date()
    @State private var capturedTo = Date()
    @State private var fromEnabled = false
    @State private var toEnabled = false
    @State private var selected = Set<String>()
    @State private var replayAttemptID = ""
    private var filters: [String: String] {
        ["requestID": requestID, "attemptID": attemptID, "target": target, "kind": kind,
         "capturedFrom": fromEnabled ? captureBoundary(capturedFrom, upper: false) : "",
         "capturedTo": toEnabled ? captureBoundary(capturedTo, upper: true) : ""]
    }
    private var invalidRange: Bool {
        fromEnabled && toEnabled && floor(capturedFrom.timeIntervalSince1970) > floor(capturedTo.timeIntervalSince1970)
    }
    private func captureBoundary(_ date: Date, upper: Bool) -> String {
        Date(timeIntervalSince1970: floor(date.timeIntervalSince1970) + (upper ? 0.999 : 0))
            .ISO8601Format(.init(includingFractionalSeconds: true))
    }
    private var artifacts: [ProductEvidenceArtifact] { model.library?.artifacts ?? [] }
    private var selectedArtifacts: [ProductEvidenceArtifact] { artifacts.filter { selected.contains($0.id) } }
    private var replay: RegressionAttempt? { workspace.regression.runs.flatMap(\.attempts).first { $0.id == replayAttemptID } }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                HStack {
                    ProductPageHeading(title: "증거 보관함", subtitle: "manifest·attempt 소유권으로 확인한 실제 관리 파일만 표시합니다.")
                    Spacer()
                    Button("새로고침") { reload() }.buttonStyle(ProductButtonStyle()).disabled(model.operating || invalidRange)
                }
                ProductNotice("로컬 읽기·AI 전송·export·삭제는 별도 권한입니다. 실행의 capture 동의는 수집만 허용합니다. 외부 전송은 기본 차단이며, raw 화면·영상의 개인정보를 가짜 마스킹으로 숨기지 않습니다.")
                if workspace.api == nil { ProductNotice("엔진 연결이 필요합니다. 이전 자료를 현재 관측으로 표시하지 않습니다.", tone: .warning) }
                if let error = model.error { ProductNotice(error, tone: .error) }
                if model.loading || model.operating { ProgressView("실제 파일·소유권·삭제 권위 조회 중") }
                ProductPanel(title: "찾기", subtitle: "수집 시각은 source/encoder 시각과 manifest 갱신 시각을 구분합니다. \(TimeZone.current.identifier) 기준 년·월·일·시·분·초를 선택하며 종료는 선택한 초 전체를 포함합니다.") {
                    VStack(spacing: 10) {
                        HStack { TextField("run 요청 UUID", text: $requestID); TextField("attempt UUID", text: $attemptID) }
                        HStack { TextField("대상 device ID 또는 플랫폼", text: $target); TextField("종류: video / screenshot / log / source", text: $kind) }
                        HStack(alignment: .top, spacing: 20) {
                            VStack(alignment: .leading) {
                                Toggle("수집 시작 시각 사용", isOn: $fromEnabled)
                                ProductCaptureTimePicker(value: $capturedFrom, title: "수집 시작 시각")
                                    .frame(minWidth: 220, minHeight: 28).disabled(!fromEnabled)
                            }
                            VStack(alignment: .leading) {
                                Toggle("수집 종료 시각 사용", isOn: $toEnabled)
                                ProductCaptureTimePicker(value: $capturedTo, title: "수집 종료 시각")
                                    .frame(minWidth: 220, minHeight: 28).disabled(!toEnabled)
                            }
                        }
                        if invalidRange { ProductNotice("수집 시작 시각은 종료 시각보다 늦을 수 없습니다.", tone: .warning) }
                        HStack { Spacer(); Button("조건 적용") { selected = []; replayAttemptID = ""; reload() }.buttonStyle(ProductButtonStyle()).disabled(invalidRange || model.operating) }
                    }.textFieldStyle(.roundedBorder)
                }
                HStack {
                    Text("선택 \(selected.count)개 / 조회 \(artifacts.count)개")
                    Spacer()
                    Button("조회된 삭제 가능 파일 선택") { selected = Set(artifacts.filter(\.deletable).map(\.id)) }.buttonStyle(ProductButtonStyle())
                    Button("선택 내보내기") { prepare("export") }.buttonStyle(ProductButtonStyle()).disabled(selected.isEmpty || model.operating)
                    Button("선택 삭제") { prepare("delete") }.buttonStyle(ProductButtonStyle(kind: .danger)).disabled(selected.isEmpty || model.operating)
                }
                ProductNotice("삭제는 같은 attempt의 관리 원본·썸네일·임시 segment·spool·진단 복사본 전체의 소유권·정리가 확인돼야 합니다. 활성·unknown·복구 증거는 삭제하지 않습니다. 필터로 숨긴 복사본이 있으면 범위 확인에서 차단합니다.")
                ForEach(model.library?.limitations ?? [], id: \.self) { ProductNotice($0, tone: .warning) }
                if let outcome = model.outcome { ProductEvidenceOutcomeView(outcome: outcome) }
                ForEach(artifacts) { artifact in
                    ProductPanel(title: "\(artifact.testID) · \(artifact.kind)", subtitle: "\(DisplayDate.text(artifact.capturedAt)) · \(artifact.captureClock)") {
                        VStack(alignment: .leading, spacing: 10) {
                            HStack {
                                Toggle("이번 작업에 선택", isOn: Binding(get: { selected.contains(artifact.id) }, set: { if $0 { selected.insert(artifact.id) } else { selected.remove(artifact.id) } }))
                                Spacer()
                                ProductStatusBadge(status: artifact.state)
                                Button("attempt 읽기 전용 Replay") { replayAttemptID = artifact.attemptID }.buttonStyle(ProductButtonStyle())
                            }
                            Text("\(artifact.target.platform) · \(artifact.target.deviceId) · \(artifact.privacy)")
                            Text(artifact.relativePath).textSelection(.enabled)
                            Text("run \(artifact.runID)\nattempt \(artifact.attemptID)\nrevision \(artifact.revisionID)\ndigest \(artifact.sha256 ?? "확인되지 않음")").font(.caption.monospaced()).textSelection(.enabled)
                            Text("실제 bytes \(artifact.bytes.map(String.init) ?? "없음") · export \(artifact.exportable ? "별도 동의 가능" : "차단") · 삭제 \(artifact.deletable ? "전체 범위 확인 필요" : "차단")")
                            if let reason = artifact.reason { ProductNotice(reason, tone: .warning) }
                            if !artifact.gaps.isEmpty { DisclosureGroup("영상 공백·불완전 근거 \(artifact.gaps.count)개") { ForEach(artifact.gaps.indices, id: \.self) { index in Text(artifact.gaps[index].readable).textSelection(.enabled) } } }
                        }
                    }
                }
                if let replay { RegressionAttemptDetail(attempt: replay).id(replay.id + (workspace.api.map { String(describing: ObjectIdentifier($0.session)) } ?? "disconnected")) }
                if artifacts.isEmpty && !model.loading { ContentUnavailableView("조회된 실제 파일 없음", systemImage: "archivebox", description: Text("run·attempt·대상·종류·수집 시각을 확인하세요. 파일 없음과 미수집·삭제·불완전 상태는 대체하지 않습니다.")) }
                DisclosureGroup("legacy 원본 증거 · 읽기 전용") {
                    ForEach(workspace.runs) { run in Button(run.displayTitle) { onOpenRun(run) }.buttonStyle(ProductButtonStyle()) }
                }
            }.padding(.horizontal, 40).padding(.vertical, 32)
        }.background(ProductDesign.canvas)
        .task(id: ProductReadIdentity(api: workspace.api)) {
            selected = []; replayAttemptID = ""; model.bind(workspace.api)
            await model.refresh(api: workspace.api, filters: filters)
            await workspace.regression.refresh(api: workspace.api); await workspace.loadRuns()
        }
        .sheet(item: $model.preview) { preview in
            ProductEvidenceOperationView(preview: preview) { Task { await model.confirm(api: workspace.api, preview: preview) } }
        }
    }
    private func reload() {
        guard !invalidRange else { return }
        Task { await model.refresh(api: workspace.api, filters: filters) }
    }
    private func prepare(_ operation: String) {
        let requestIDs = Array(Set(selectedArtifacts.map(\.requestID)))
        Task { await model.prepare(api: workspace.api, operation: operation, requestIDs: requestIDs, artifactIDs: Array(selected)) }
    }
}

private struct ProductCaptureTimePicker: NSViewRepresentable {
    @Binding var value: Date
    let title: String
    func makeCoordinator() -> Coordinator { Coordinator(value: $value) }
    func makeNSView(context: Context) -> NSDatePicker {
        let picker = NSDatePicker()
        picker.datePickerStyle = .textFieldAndStepper
        picker.datePickerElements = [.yearMonthDay, .hourMinuteSecond]
        picker.locale = Locale(identifier: "ko_KR")
        picker.calendar = Calendar(identifier: .gregorian)
        picker.target = context.coordinator
        picker.action = #selector(Coordinator.changed(_:))
        return picker
    }
    func updateNSView(_ picker: NSDatePicker, context: Context) {
        context.coordinator.value = $value
        if picker.dateValue != value { picker.dateValue = value }
        picker.isEnabled = context.environment.isEnabled
        picker.timeZone = .current
        picker.setAccessibilityLabel(title)
    }
    @MainActor
    final class Coordinator: NSObject {
        var value: Binding<Date>
        init(value: Binding<Date>) { self.value = value }
        @objc func changed(_ picker: NSDatePicker) { value.wrappedValue = picker.dateValue }
    }
}
