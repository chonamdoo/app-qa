import SwiftUI

struct WorkspaceView: View {
    @Environment(Workspace.self) private var workspace
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            if let replay = workspace.replay {
                ProductPageHeading(title: replay.run.displayTitle, subtitle: "읽기 전용 legacy Replay · \(DisplayDate.text(replay.run.startedAt))")
                ProductNotice("저장된 이벤트·화면만 표시합니다. 실행·녹화 시작·계획 생성·입력·제어권 반환 명령은 제공하지 않습니다.")
                HSplitView {
                    ActivityView().frame(minWidth: 340, maxWidth: .infinity, maxHeight: .infinity)
                    DeviceScreenView().frame(minWidth: 280, maxWidth: .infinity, maxHeight: .infinity)
                }
            } else {
                ContentUnavailableView("선택한 저장 Replay 없음", systemImage: "play.rectangle", description: Text("실행 상세에서 정확한 attempt와 단계를 선택하세요. 현재 다른 실행의 화면으로 대체하지 않습니다."))
            }
        }.padding(24)
    }
}
