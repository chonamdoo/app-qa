import SwiftUI

struct ProductEvidenceOperationView: View {
    let preview: ProductEvidencePreview
    let confirm: () -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var acknowledged = false
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            ProductPageHeading(title: preview.operation == "delete" ? "이번 증거 삭제 확인" : "이번 로컬 내보내기 확인", subtitle: "실행 수집 권한과 별개인 일회성 동의입니다. 외부 전송은 하지 않습니다.")
            ProductNotice(preview.warning, tone: .warning)
            Text("원 결과 \(preview.resultRows)개 · 관리 파일 \(preview.artifacts.count)개 · 만료 \(DisplayDate.text(preview.expiresAt))")
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    ForEach(preview.artifacts) { item in
                        VStack(alignment: .leading, spacing: 4) {
                            Text("\(item.testID) · \(item.target.platform) · \(item.kind) · \(item.state)")
                            Text("\(item.privacy) · \(item.relativePath)").textSelection(.enabled)
                            Text("attempt \(item.attemptID)\ndigest \(item.sha256 ?? "실제 bytes 없음")").font(.caption.monospaced()).textSelection(.enabled)
                        }
                        Divider()
                    }
                    ForEach(preview.blocked, id: \.self) { Text($0).foregroundStyle(ProductDesign.red) }
                }
            }.frame(maxHeight: 300)
            Text("범위 digest \(preview.scopeDigest)\n정책 digest \(preview.policyDigest)").font(.caption.monospaced()).textSelection(.enabled)
            ProductNotice(preview.operation == "delete" ? "관리 복사본·정리가 불명확하면 삭제하지 않습니다. 실패·receipt·journal은 보존합니다. 선택한 digest와 동일한 자료는 다른 실행·프로젝트나 이후 capture도 증거 조회·export가 차단됩니다(물리 삭제는 선택 범위만). backup으로 취소할 수 없고, 관리 밖 export는 원격 삭제할 수 없습니다." : "묶음에는 HTML·결과 JSON·선택한 허용 파일과 누락/차단 manifest만 포함합니다. raw 영상에 가짜 마스킹을 적용하지 않습니다. 저장한 복사본은 QAutra 관리 밖입니다.", tone: .warning)
            Toggle("원시 자료의 개인정보 위험과 위의 정확한 범위를 확인했습니다", isOn: $acknowledged)
            HStack {
                Spacer()
                Button("취소") { dismiss() }.keyboardShortcut(.cancelAction)
                Button(preview.operation == "delete" ? "이번 범위 삭제" : "이번 범위 내보내기") { confirm(); dismiss() }
                    .buttonStyle(ProductButtonStyle(kind: .primary)).disabled(!acknowledged || !preview.blocked.isEmpty)
            }
        }.padding(24).frame(width: 720).background(ProductDesign.canvas).preferredColorScheme(.light)
    }
}

struct ProductEvidenceOutcomeView: View {
    let outcome: ProductEvidenceOutcome
    var body: some View {
        ProductPanel(title: outcome.operation == "delete" ? "삭제 결과" : "내보내기 결과", subtitle: outcome.outsideCopies) {
            VStack(alignment: .leading, spacing: 8) {
                ForEach(outcome.outcomes) { item in
                    Text("\(item.state) · \(item.artifactID.prefix(16))\(item.reason.map { " · " + $0 } ?? "")").textSelection(.enabled)
                }
                if let exportID = outcome.exportID { Text("export \(exportID) · 비공개 서버 사본은 10분 후 다운로드 만료").font(.caption.monospaced()).textSelection(.enabled) }
            }
        }
    }
}
