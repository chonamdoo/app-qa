import CryptoKit
import Foundation
import Observation

struct GuestHostCapabilities: Decodable, Sendable {
    let supported: Bool
    let reason: String?
    let minimumCPUCount: Int
    let minimumMemoryMiB: Int
    let physicalMemoryMiB: Int
    let availableMemoryMiB: Int
    let logicalCPUCount: Int
    let maximumMachines: Int
}

struct GuestInstanceProfile: Decodable, Identifiable, Sendable {
    let id: String
    let name: String
    let platform: String
    let runtime: String?
    var usesOwnedChrome: Bool { platform == "desktop-chrome" && runtime != "macos-guest" }
}

struct GuestInstanceList: Decodable, Sendable {
    let profiles: [GuestInstanceProfile]
    let instances: [GuestBrowserInstance]
    let capabilities: GuestHostCapabilities?
    let runtimes: [GuestRuntimeCapability]?
}

struct GuestRuntimeCapability: Decodable, Sendable {
    let runtime: String
    let platform: String
    let available: Bool
    let readiness: String
    let reason: String?
    let capture: String
    let recordingReady: Bool
    let hostGlobalInput: Bool
}

struct GuestBrowserInstance: Decodable, Identifiable, Sendable {
    let id: String
    let profileId: String
    let name: String
    let platform: String
    let runtime: String?
    let machineId: String?
    let generation: Int
    let state: String
    let nativeState: String?
    let progress: Double?
    let cpuCount: Int?
    let memoryMiB: Int?
    let diskGiB: Int?
    let requestedResources: GuestInstanceResources?
    let osVersion: String?
    let browserVersion: String?
    let activeSessionId: String?
    let activeRunId: String?
    let createdAt: String
    let reason: String?
    let hostGlobalInput: Bool
    let isolation: String
    let frameAvailable: Bool

    var isOwnedChrome: Bool { runtime == "owned-chrome" && platform == "desktop-chrome" }
    var isGuest: Bool { runtime == "macos-guest" && machineId != nil && ["desktop-chrome", "desktop-safari"].contains(platform) }
    var hasKnownRuntime: Bool { isOwnedChrome || isGuest }
    var deviceID: String { "\(isOwnedChrome ? "chrome" : isGuest ? "guest" : "unknown"):\(id)" }
    var resourceDescription: String {
        if isOwnedChrome { return "소유 headless Chrome · VM 자원 할당 없음" }
        guard isGuest, let cpuCount, let memoryMiB, let diskGiB else { return "runtime·실제 guest 자원 미확인" }
        return "실제 macOS guest · CPU \(cpuCount) · 메모리 \(memoryMiB) MiB · 디스크 \(diskGiB) GiB"
    }
    var browserName: String { platform == "desktop-safari" ? "Safari" : "Chrome" }
    var label: String {
        switch state {
        case "preparing": isOwnedChrome ? "Chrome 준비 중" : "guest 준비 중"
        case "setup-required": isOwnedChrome ? "Chrome 준비 필요" : "guest 준비 필요"
        case "ready": "준비됨 · 실행 lease 점검 별도"
        case "running": "QA 세션 사용 중"
        case "stopping": "종료 확인 중"
        case "stopped": "중지됨"
        case "unknown": "결과 미확인 · 재사용 금지"
        case "error": "오류"
        default: "응답 확인 필요"
        }
    }
    var hasActiveLease: Bool { activeSessionId != nil || activeRunId != nil || state == "running" || state == "stopping" }
    var canStart: Bool { hasKnownRuntime && !hasActiveLease && (isOwnedChrome ? state == "stopped" : ["installed", "stopped"].contains(nativeState ?? "")) }
    var canPrepare: Bool { hasKnownRuntime && !hasActiveLease && state == "setup-required" && (isOwnedChrome || nativeState == "running") }
    var canShow: Bool { isGuest && (nativeState == "running" || nativeState == "starting") }
}

struct GuestInstanceResources: Codable, Sendable {
    let cpuCount: Int
    let memoryMiB: Int
    let diskGiB: Int
}

enum GuestInstanceAction: String, Sendable {
    case start = "instance.start"
    case prepare = "instance.prepare"
    case stop = "instance.stop"
    case show = "instance.show"
    case hide = "instance.hide"
}

struct GuestInstanceCreation {
    enum Phase: Equatable { case pending, unknown, notStarted, returned }

    let requestID: String
    let profileID: String
    let profileName: String
    let platform: String
    let name: String
    let resources: GuestInstanceResources?
    var phase: Phase = .pending
    var error: String?
    var matched: GuestBrowserInstance?
    var confirmedMachineID: String?
    var reconciliation = "아직 읽기 전용 목록과 대조하지 않았어요."

    var blocksNewRequest: Bool {
        phase == .pending || (phase == .unknown && (matched == nil || matched?.state == "unknown"))
    }

    func accepts(_ instance: GuestBrowserInstance, allowLargerResources: Bool) -> Bool {
        guard instance.id == requestID, instance.profileId == profileID, instance.name == name,
              instance.platform == platform, !instance.hostGlobalInput else { return false }
        if resources == nil {
            return instance.runtime == "owned-chrome" && platform == "desktop-chrome"
                && instance.machineId == nil && instance.cpuCount == nil && instance.memoryMiB == nil
                && instance.diskGiB == nil && instance.isolation == "owned-browser-context"
        }
        guard let resources, let machineID = instance.machineId, UUID(uuidString: machineID) != nil,
              machineID != instance.id, instance.runtime == "macos-guest",
              instance.isolation == (platform == "desktop-chrome" ? "guest-browser-session" : "guest-desktop"),
              let cpu = instance.cpuCount, let memory = instance.memoryMiB, let disk = instance.diskGiB else { return false }
        if let requested = instance.requestedResources,
           requested.cpuCount != resources.cpuCount || requested.memoryMiB != resources.memoryMiB || requested.diskGiB != resources.diskGiB { return false }
        if platform == "desktop-chrome" && (allowLargerResources || instance.requestedResources != nil) {
            return cpu >= resources.cpuCount && memory >= resources.memoryMiB && disk >= resources.diskGiB
        }
        return cpu == resources.cpuCount && memory == resources.memoryMiB && disk == resources.diskGiB
    }
}

@MainActor @Observable
final class GuestInstanceUIState {
    let identity: ProductReadIdentity
    let endpoint: String
    private let identitySession: URLSession
    private let engineTokenDigest: Data
    var listing: GuestInstanceList?
    var listError: String?
    var loading = false
    var readSequence = 0
    var creation: GuestInstanceCreation?
    var profileID = ""
    var name = ""
    var cpu = 2
    var memory = 4096
    var draftInitialized = false
    var pendingAction: Int?
    var actionSequence = 0
    var actionErrors: [String: String] = [:]
    var recovery: ExecutionResourceRecovery?
    var recoveryReadError: String?
    var recoveryActionError: String?
    var recoveryPending = false
    var recoveryReadSequence = 0

    init(api: APIClient) {
        identity = ProductReadIdentity(api: api)
        endpoint = api.base.absoluteString
        identitySession = api.session
        engineTokenDigest = Data(SHA256.hash(data: Data(api.token.utf8)))
    }

    func belongsToSameEngine(as other: GuestInstanceUIState) -> Bool {
        endpoint == other.endpoint && engineTokenDigest == other.engineTokenDigest
    }

    func reconcile(_ listing: GuestInstanceList) {
        guard var creation else { return }
        let matches = listing.instances.filter { $0.id == creation.requestID }
        if matches.count == 1, let instance = matches.first,
           creation.accepts(instance, allowLargerResources: creation.confirmedMachineID == instance.machineId) {
            creation.matched = instance
            creation.reconciliation = "정확한 UUID·프로필·이름·runtime·소유권이 일치하는 기록: \(instance.label). 실제 입력·첫 영상 프레임 준비 완료는 실행 lease에서 별도로 확인합니다."
        } else {
            creation.matched = nil
            creation.reconciliation = matches.isEmpty
                ? "읽기 전용 목록에 같은 UUID가 없어요. 생성되지 않았다는 증거는 아니며 다시 보내지 않아요."
                : "같은 UUID의 기록이 있지만 요청 파라미터 또는 guest 소유권을 정확히 확인할 수 없어요. 공유 VM의 더 큰 할당 자원만으로 원래 요청값을 추정하지 않아요."
        }
        self.creation = creation
    }
}

extension Workspace {
    func guestInstanceUIState(for api: APIClient) -> GuestInstanceUIState {
        let identity = ProductReadIdentity(api: api)
        if let state = guestInstanceUIStates[identity] { return state }
        let state = GuestInstanceUIState(api: api)
        guestInstanceUIStates[identity] = state
        return state
    }

    func hasUnresolvedGuestCreation(excluding state: GuestInstanceUIState) -> Bool {
        guestInstanceUIStates.values.contains {
            $0 !== state && $0.belongsToSameEngine(as: state) && $0.creation?.blocksNewRequest == true
        }
    }

    func refreshGuestInstances(in state: GuestInstanceUIState) async {
        guard let api, state.identity == ProductReadIdentity(api: api) else { return }
        state.readSequence += 1
        let sequence = state.readSequence
        state.loading = true
        defer { if sequence == state.readSequence { state.loading = false } }
        do {
            let reply = try await api.agent(.instances, as: GuestInstanceList.self)
            guard !Task.isCancelled, state.identity == ProductReadIdentity(api: self.api), sequence == state.readSequence else { return }
            state.listing = reply.value
            state.listError = nil
            state.reconcile(reply.value)
            for previous in guestInstanceUIStates.values where previous !== state && previous.belongsToSameEngine(as: state) {
                previous.reconcile(reply.value)
            }
        } catch {
            guard !Task.isCancelled, state.identity == ProductReadIdentity(api: self.api), sequence == state.readSequence else { return }
            state.listing = nil
            state.listError = error.localizedDescription
        }
        await refreshExecutionRecovery(in: state)
    }

    func refreshExecutionRecovery(in state: GuestInstanceUIState) async {
        guard let api, state.identity == ProductReadIdentity(api: api) else { return }
        state.recoveryReadSequence += 1
        let sequence = state.recoveryReadSequence
        do {
            let reply = try await api.agent(.executionStatus(), as: ExecutionResourceRecovery.self)
            try reply.value.validate()
            guard !Task.isCancelled, state.identity == ProductReadIdentity(api: self.api), sequence == state.recoveryReadSequence else { return }
            state.recovery = reply.value
            state.recoveryReadError = nil
        } catch {
            guard !Task.isCancelled, state.identity == ProductReadIdentity(api: self.api), sequence == state.recoveryReadSequence else { return }
            state.recoveryReadError = "복구 상태 조회 실패: \(error.localizedDescription). 마지막 관측은 최신 상태가 아닐 수 있습니다."
        }
    }

    func reconcileExecution(in state: GuestInstanceUIState) async {
        guard !state.recoveryPending, let api, state.identity == ProductReadIdentity(api: api) else { return }
        state.recoveryPending = true
        state.recoveryReadSequence += 1
        defer { state.recoveryPending = false }
        do {
            let reply = try await api.agent(.reconcileExecution, as: ExecutionResourceRecovery.self, timeout: 120)
            try reply.value.validate()
            guard !Task.isCancelled, state.identity == ProductReadIdentity(api: self.api) else { return }
            state.recovery = reply.value
            state.recoveryActionError = nil
        } catch {
            state.recoveryActionError = "복구 확인 응답: \(error.localizedDescription). 테스트·변경 동작은 재전송하지 않으며 원 판정을 유지합니다."
        }
        await refreshGuestInstances(in: state)
    }

    func createGuestInstance(in state: GuestInstanceUIState, profile: GuestInstanceProfile) async -> GuestBrowserInstance? {
        guard !Task.isCancelled, state.creation == nil, state.pendingAction == nil, !hasUnresolvedGuestCreation(excluding: state),
              let api, state.identity == ProductReadIdentity(api: api) else { return nil }
        let intent = GuestInstanceCreation(requestID: UUID().uuidString.lowercased(), profileID: profile.id.lowercased(),
            profileName: profile.name, platform: profile.platform, name: state.name.trimmingCharacters(in: .whitespacesAndNewlines),
            resources: profile.usesOwnedChrome ? nil : GuestInstanceResources(cpuCount: state.cpu, memoryMiB: state.memory, diskGiB: 64))
        state.creation = intent
        do {
            let reply = try await api.agent(.createInstance(requestID: intent.requestID, profileID: intent.profileID, name: intent.name, resources: intent.resources), as: GuestBrowserInstance.self, timeout: 180)
            guard var current = state.creation, current.requestID == intent.requestID else { return nil }
            guard !Task.isCancelled, state.identity == ProductReadIdentity(api: self.api) else {
                current.phase = .unknown
                current.error = "생성 응답 전에 원래 엔진 연결이 바뀌었어요. 이 요청은 이전 연결에 남겨 두며 현재 엔진의 생성 결과로 표시하지 않아요."
                state.creation = current
                return nil
            }
            guard current.accepts(reply.value, allowLargerResources: true) else {
                throw APIError(status: 0, message: "생성 응답의 UUID·파라미터·guest 소유권이 요청과 일치하지 않아 결과를 확정할 수 없어요.")
            }
            current.phase = .returned
            current.matched = reply.value
            current.confirmedMachineID = reply.value.machineId
            current.reconciliation = "원래 요청 응답과 runtime 소유권을 확인했습니다. 실제 실행·녹화 준비 완료를 뜻하지 않습니다."
            state.creation = current
            return reply.value
        } catch {
            guard var current = state.creation, current.requestID == intent.requestID else { return nil }
            current.phase = (error as? AgentRemoteError)?.detail.effect == "not_started" ? .notStarted : .unknown
            current.error = error.localizedDescription
            state.creation = current
            return nil
        }
    }

    func performGuestInstance(_ action: GuestInstanceAction, instance: GuestBrowserInstance, in state: GuestInstanceUIState,
                              cancelActive: Bool = false, force: Bool = false) async {
        guard !Task.isCancelled, state.pendingAction == nil, state.creation?.phase != .pending,
              let api, state.identity == ProductReadIdentity(api: api), instance.hasKnownRuntime else { return }
        let key = "\(instance.id):\(action.rawValue)"
        guard let listed = state.listing?.instances.first(where: { $0.id == instance.id }),
              listed.machineId == instance.machineId, listed.generation == instance.generation else {
            state.actionErrors[key] = "\(action.rawValue) · \(instance.id): 목록의 소유권·generation이 바뀌어 요청을 보내지 않았어요."
            return
        }
        state.actionSequence += 1
        let sequence = state.actionSequence
        state.pendingAction = sequence
        defer { if state.pendingAction == sequence { state.pendingAction = nil } }
        do {
            let reply = try await api.agent(.instance(action, instance.id, cancelActive: cancelActive, force: force), as: GuestBrowserInstance.self, timeout: 180)
            guard !Task.isCancelled, state.identity == ProductReadIdentity(api: self.api) else {
                throw APIError(status: 0, message: "원래 엔진 연결이 바뀌어 변경 결과를 현재 상태로 확인할 수 없어요. 이전 연결에 결과 미확인으로 보관하며 재전송하지 않아요.")
            }
            guard reply.value.id == instance.id, reply.value.machineId == instance.machineId,
                  reply.value.profileId == instance.profileId, reply.value.platform == instance.platform,
                  reply.value.runtime == instance.runtime, !reply.value.hostGlobalInput, reply.value.isolation == instance.isolation else {
                throw APIError(status: 0, message: "변경 응답의 guest 소유권이 원래 요청과 일치하지 않아 결과를 확정할 수 없어요.")
            }
        } catch {
            let effect = (error as? AgentRemoteError)?.detail.effect ?? "unknown"
            state.actionErrors[key] = "\(action.rawValue) · \(instance.id) · effect=\(effect): \(error.localizedDescription). 자동 재전송하지 않아요. 다른 창 표시·숨기기 성공으로 이 기록을 지우지 않아요."
        }
        if !Task.isCancelled, state.identity == ProductReadIdentity(api: self.api) { await refreshGuestInstances(in: state) }
    }
}
