import SwiftUI

struct DirectSessionsView: View {
    @Environment(Workspace.self) private var workspace

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("엔진 직접 세션").font(.headline)
                Spacer()
                Button("새로고침", systemImage: "arrow.clockwise") {
                    workspace.refreshDirectSessions()
                }
                .disabled(workspace.directOperation != nil)
                .accessibilityIdentifier("agent.refresh")
                .accessibilityLabel("직접 세션과 선택한 코드 실행 상태 새로고침")
            }
            .padding(10)
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    if let operation = workspace.directOperation {
                        ProgressView(operationLabel(operation))
                            .controlSize(.small)
                            .accessibilityIdentifier("agent.loading")
                    }
                    if let message = workspace.directMutationMessage {
                        Card(tint: .orange) {
                            if let target = workspace.directMutationTarget {
                                Text(target).font(.caption2.monospaced()).textSelection(.enabled)
                            }
                            Text(message).font(.caption).textSelection(.enabled)
                            if let meta = workspace.directMutationMeta { AgentMetaView(meta: meta) }
                        }
                        .accessibilityIdentifier("agent.mutationResult")
                    }
                    if let error = workspace.directError {
                        Card(tint: .red) {
                            Label("현재 상태를 확인하지 못함", systemImage: "exclamationmark.triangle")
                                .font(.callout.weight(.semibold))
                            Text(error).font(.caption).textSelection(.enabled)
                            Text("이전 목록을 현재 상태로 표시하지 않습니다. 새로고침은 조회만 하며 변경 요청을 재전송하지 않습니다.")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                        .accessibilityIdentifier("agent.error")
                    }
                    if let updatedAt = workspace.directUpdatedAt {
                        Text("마지막 조회 \(DisplayDate.text(updatedAt)) · 자동 갱신 아님")
                            .font(.caption).foregroundStyle(.secondary)
                            .accessibilityIdentifier("agent.updatedAt")
                        if workspace.directSessions.isEmpty {
                            ContentUnavailableView("직접 세션 없음", systemImage: "terminal", description: Text("현재 엔진의 session.list가 빈 목록을 반환했습니다."))
                                .accessibilityIdentifier("agent.empty")
                        } else {
                            sessionList
                            if let session = workspace.directSession {
                                DirectSessionDetail(session: session)
                            }
                        }
                    } else if workspace.directOperation == nil, workspace.directError == nil {
                        ContentUnavailableView("세션 상태 미조회", systemImage: "terminal", description: Text("엔진 연결 후 새로고침하세요."))
                            .accessibilityIdentifier("agent.unloaded")
                    }
                    if let meta = workspace.directMeta {
                        AgentMetaView(meta: meta)
                            .accessibilityIdentifier("agent.replyMeta")
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(10)
            }
        }
        .accessibilityIdentifier("agent.panel")
        .task { workspace.refreshDirectSessions() }
    }

    private var sessionList: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(workspace.directSessions) { session in
                Button {
                    workspace.selectDirectSession(session.sessionId)
                } label: {
                    VStack(alignment: .leading, spacing: 4) {
                        HStack {
                            Text(session.app).font(.callout.weight(.semibold))
                            Spacer()
                            AgentStateTag(state: session.state)
                        }
                        Text("\(session.platform) · \(session.deviceId)")
                            .font(.caption).foregroundStyle(.secondary)
                        Text(session.sessionId).font(.caption2.monospaced())
                            .lineLimit(1).truncationMode(.middle)
                    }
                    .padding(8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(session.sessionId == workspace.directSessionID ? Color.accentColor.opacity(0.12) : Color.clear, in: RoundedRectangle(cornerRadius: 8))
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(workspace.directOperation != nil)
                .accessibilityIdentifier("agent.session.\(session.sessionId)")
                .accessibilityLabel("\(session.app), \(session.platform), \(session.deviceId), \(session.state), 세션 \(session.sessionId)")
                .accessibilityAddTraits(session.sessionId == workspace.directSessionID ? .isSelected : [])
            }
        }
        .accessibilityIdentifier("agent.sessions")
    }

    private func operationLabel(_ operation: Workspace.DirectSessionOperation) -> String {
        switch operation {
        case .refresh: "세션·코드 실행 조회 중…"
        case .cancel: "코드 중지 요청·상태 확인 중…"
        case .close: "세션 닫기 요청·상태 확인 중…"
        }
    }
}

private struct DirectSessionDetail: View {
    @Environment(Workspace.self) private var workspace
    @Environment(\.openWindow) private var openWindow
    let session: AgentSessionView

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Divider()
            HStack {
                Text("선택한 세션").font(.headline)
                Spacer()
                AgentStateTag(state: session.state)
            }
            if session.state == "unknown" {
                Text("unknown · 기기 변경 효과·소유권이 확인되지 않았습니다. 재실행·인계·재개하지 않습니다.")
                    .font(.callout).foregroundStyle(.orange)
                    .accessibilityIdentifier("agent.unknown")
            }
            field("앱 / 플랫폼 / 화면", "\(session.app) / \(session.platform) / \(session.surface)")
            field("디바이스", session.deviceId)
            field("버전 / revision", "\(session.version ?? "미제공") / \(session.revision)")
            field("시작", DisplayDate.text(session.createdAt))
            field("sessionId", session.sessionId)
            field("runId", session.runId)
            field("workerId", session.workerId)
            field("instanceId", session.instanceId)
            field("activeScriptId", session.activeScriptId ?? "없음")
            field("stopReason", session.stopReason ?? "없음")
            field("증거 경로", session.evidenceDir)
            capabilities
            if let script = workspace.directScript {
                scriptDetail(script)
            } else {
                Text("이 화면에서 조회한 코드 실행 없음. 활성 소유권은 activeScriptId로만 확인합니다.")
                    .font(.caption).foregroundStyle(.secondary)
                    .accessibilityIdentifier("agent.script.empty")
            }
            VStack(alignment: .leading, spacing: 8) {
                Button("활성 코드 중지", role: .destructive) { workspace.cancelDirectScript() }
                    .disabled(!workspace.canCancelDirectScript)
                    .accessibilityIdentifier("agent.script.cancel")
                    .accessibilityLabel("선택한 세션의 활성 코드 실행 중지 요청")
                Button("유휴 세션 닫기", role: .destructive) { workspace.closeDirectSession() }
                    .disabled(!workspace.canCloseDirectSession)
                    .accessibilityIdentifier("agent.session.close")
                    .accessibilityLabel("선택한 유휴 직접 세션 닫기")
                Text("ready·stopped이고 activeScriptId가 없는 세션만 닫기를 요청합니다. 서버가 사용 중 여부를 다시 확인합니다. 변경 요청은 재전송하지 않습니다.")
                    .font(.caption).foregroundStyle(.secondary)
                Button("이 실행 기록·증거 보기", systemImage: "clock.arrow.circlepath") {
                    workspace.requestedRunID = session.runId
                    Task { await workspace.loadRuns() }
                    openWindow(id: "runs")
                }
                .accessibilityIdentifier("agent.run.history")
                .accessibilityLabel("선택한 세션의 저장된 실행 기록과 스텝 증거 보기")
                Text("실행 기록 창의 활동 재생은 저장된 이벤트·증거 조회이며 동작을 다시 실행하지 않습니다.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            .controlSize(.small)
        }
        .accessibilityIdentifier("agent.session.detail")
    }

    private var capabilities: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("엔진 capability").font(.callout.weight(.semibold))
            field("semantic / coordinates", "\(session.capabilities.semantic) / \(session.capabilities.coordinates)")
            field("좌표계 / 격리", "\(session.capabilities.coordinateSpace) / \(session.capabilities.isolation)")
            field("hostGlobalInput", String(session.capabilities.hostGlobalInput))
            field("webview / recording / modelRequired", "\(session.capabilities.webview) / \(session.capabilities.recording) / \(session.capabilities.modelRequired)")
            field("허용 동작", session.capabilities.mutationKinds.joined(separator: ", "))
        }
        .accessibilityIdentifier("agent.capabilities")
    }

    private func scriptDetail(_ script: AgentScriptView) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Divider()
            HStack {
                Text(session.activeScriptId == script.scriptId ? "활성 코드 실행" : "마지막 조회한 코드 실행 (기록)")
                    .font(.callout.weight(.semibold))
                Spacer()
                AgentStateTag(state: script.state)
            }
            field("scriptId", script.scriptId)
            field("sessionIds", script.sessionIds.joined(separator: ", "))
            field("시작 / 종료", "\(DisplayDate.text(script.startedAt)) / \(DisplayDate.text(script.endedAt))")
            Text("completed는 코드 실행 완료이며 업무 PASS가 아닙니다. 업무 판정은 저장된 assertion·실행 증거에서 확인하세요.")
                .font(.caption).foregroundStyle(.secondary)
            if let error = script.error {
                field("코드 실행 오류", "\(error.code): \(error.message) · effect=\(error.effect)")
            }
            if !script.stdout.isEmpty { field("stdout", script.stdout) }
            if !script.stderr.isEmpty { field("stderr", script.stderr) }
            field("trustBoundary", script.trustBoundary)
        }
        .accessibilityIdentifier("agent.script.detail")
    }

    private func field(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label).font(.caption).foregroundStyle(.secondary)
            Text(value).font(.caption.monospaced()).textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
        }
        .accessibilityElement(children: .combine)
    }
}

private struct AgentStateTag: View {
    let state: String

    var body: some View {
        Tag(text: state, color: state == "unknown" ? .orange : state == "failed" ? .red : .secondary)
            .accessibilityLabel(state == "unknown" ? "unknown, 결과와 소유권 미확인" : state)
    }
}

private struct AgentMetaView: View {
    let meta: AgentMeta

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("응답 \(meta.at)")
            Text("requestId: \(meta.requestId)")
            if let id = meta.runId { Text("runId: \(id)") }
            if let id = meta.jobId { Text("jobId: \(id)") }
            if let id = meta.sessionId { Text("sessionId: \(id)") }
            if let revision = meta.revision { Text("revision: \(revision)") }
            if let id = meta.workerId { Text("workerId: \(id)") }
            if let id = meta.instanceId { Text("instanceId: \(id)") }
        }
        .font(.caption2.monospaced())
        .foregroundStyle(.secondary)
        .textSelection(.enabled)
    }
}
