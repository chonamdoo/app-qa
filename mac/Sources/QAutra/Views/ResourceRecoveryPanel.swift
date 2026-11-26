import SwiftUI

struct ResourceRecoveryPanel: View {
    let snapshot: ExecutionResourceRecovery?
    var readError: String? = nil
    var actionError: String? = nil
    var busy = false
    var canReconcile = false
    var showVideo = false
    let onRefresh: () -> Void
    var onReconcile: (() -> Void)? = nil

    var body: some View {
        ProductPanel(title: "원 실행의 자원·증거 복구", subtitle: "실행 재전송·업무 재판정이 아닌 원 authority 대조입니다.") {
            VStack(alignment: .leading, spacing: 14) {
                HStack {
                    Button("복구 근거 조회", action: onRefresh).buttonStyle(ProductButtonStyle()).disabled(busy)
                    if let onReconcile { Button("원 자원 복구 확인", action: onReconcile).buttonStyle(ProductButtonStyle()).disabled(busy || !canReconcile) }
                    if busy { ProgressView().controlSize(.small) }
                }
                if let readError { ProductNotice(readError, tone: .warning) }
                if let actionError { ProductNotice(actionError, tone: .warning) }
                if let snapshot {
                    HStack {
                        Text("현재 사용자 전체 실행 점유")
                        ProductStatusBadge(status: snapshot.admission.state)
                        Text(snapshot.admission.ownership).font(.caption)
                    }
                    if let owner = snapshot.admission.ownerId { Text(owner).font(.caption.monospaced()).textSelection(.enabled) }
                    ProductNotice("자원이 정리되어도 원 FAIL·unknown·미완료 검증을 PASS로 바꾸지 않습니다. 다음 실행은 별도 승인·새 attempt로 수행합니다.")
                    if let instances = snapshot.instances {
                        Text("이번 확인에서 Chrome 예약 정리 \(instances.recovered.count)건 · 재사용 차단 \(instances.blocked.count)건")
                        if !instances.recovered.isEmpty { Text("정리된 Chrome은 환경 목록에서 준비 점검 후 사용하세요. 자동으로 다시 실행하지 않습니다.").font(.callout) }
                        ForEach(instances.blocked, id: \.instanceId) { blocked in Text("\(blocked.instanceId) · \(blocked.code)").font(.caption.monospaced()).textSelection(.enabled) }
                    }
                    if let observation = snapshot.observation {
                        Text("마지막 원 자원 관측 \(DisplayDate.text(observation.observedAt)) · \(observation.state == "verified" ? "필수 근거 확인됨" : "복구 미확인")")
                        Text("원 점유 \(observation.scope.ownerId) · generation \(observation.scope.generation)").font(.caption.monospaced()).textSelection(.enabled)
                        ForEach(observation.problems, id: \.self) { ProductNotice($0, tone: .warning) }
                        ForEach(observation.sources) { source in
                            VStack(alignment: .leading, spacing: 10) {
                                if let context = source.context { Text("\(context.testId) · attempt \(context.attemptId)").font(.headline).textSelection(.enabled) }
                                else { Text("원 binding 미확인").font(.headline) }
                                ForEach(source.checks) { check in
                                    HStack(alignment: .top) {
                                        Text(check.title).frame(minWidth: 180, alignment: .leading)
                                        Text(check.label)
                                        if let code = check.code { Text(code).font(.caption.monospaced()).textSelection(.enabled) }
                                    }
                                }
                                DisclosureGroup("원 native·backend 관측 근거") {
                                    VStack(alignment: .leading, spacing: 8) {
                                        Text("native \(source.id) · binding SHA-256 \(source.reference.bindingSha256)")
                                        if let native = source.native { Text(native.readable) }
                                        if let fixture = source.fixture { Text(fixture.readable) }
                                        if let hash = source.evidenceSha256 { Text("증거 inventory SHA-256 \(hash)") }
                                    }.font(.caption.monospaced()).textSelection(.enabled)
                                }
                                if showVideo, let context = source.context {
                                    Text("원 소유자의 종료 시 영상 상태: \(source.video). 실제 파일 크기·SHA-256·재생 가능 여부는 아래에서 확인합니다.").font(.callout)
                                    ForEach(source.segments, id: \.file) { segment in
                                        VStack(alignment: .leading, spacing: 8) {
                                            Text("\(DisplayDate.text(segment.startedAt)) ~ \(DisplayDate.text(segment.endedAt)) · \(segment.frames) frames · \(segment.durationSeconds)초").font(.caption)
                                            ReceiptVideoPlayer(runID: context.runId, segment: segment)
                                        }
                                    }
                                    if source.segments.isEmpty { ProductNotice("복구된 재생 segment가 없습니다. raw 진단 증거와 정상 영상을 구분합니다.", tone: .warning) }
                                }
                            }.padding(.top, 10)
                        }
                    } else { Text("조회된 원 자원 복구 근거가 없습니다. 종료·복원·재사용 가능을 뜻하지 않습니다.") }
                } else { Text("원 실행의 자원 복구 상태를 조회하세요. 프로세스 종료나 시간 경과로 해제를 추정하지 않습니다.") }
            }
        }
    }
}
