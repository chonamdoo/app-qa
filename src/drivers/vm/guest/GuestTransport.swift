import Foundation
import Network
import Security
import CryptoKit

func guestTLS(_ config: GuestConnectionConfig, queue: DispatchQueue) -> NWConnection {
    let tls = NWProtocolTLS.Options()
    sec_protocol_options_set_min_tls_protocol_version(tls.securityProtocolOptions, .TLSv12)
    sec_protocol_options_set_verify_block(tls.securityProtocolOptions, { _, trust, complete in
        let reference = sec_trust_copy_ref(trust).takeRetainedValue()
        guard let chain = SecTrustCopyCertificateChain(reference) as? [SecCertificate], let certificate = chain.first else { complete(false); return }
        let der = SecCertificateCopyData(certificate) as Data
        complete(guestHash(der) == config.pin)
    }, queue)
    let parameters = NWParameters(tls: tls, tcp: NWProtocolTCP.Options())
    return NWConnection(host: NWEndpoint.Host(config.host), port: NWEndpoint.Port(rawValue: config.port)!, using: parameters)
}

func guestFrame(_ value: Any) throws -> Data {
    let body = try GuestJSON.encode(value)
    guard !body.isEmpty, body.count <= GuestLimits.frame else { throw GuestFault("frame_limit") }
    let n = UInt32(body.count)
    var frame = Data([UInt8((n >> 24) & 255), UInt8((n >> 16) & 255), UInt8((n >> 8) & 255), UInt8(n & 255)])
    frame.append(body); return frame
}

// Transport state and Network callbacks share the owning agent's serial queue.
final class GuestControlChannel: @unchecked Sendable {
    private let connection: NWConnection
    private let queue: DispatchQueue
    private var incoming = Data()
    private var outgoing: [Data] = []
    private var outgoingBytes = 0
    private var sending = false
    private var closed = false
    private var ready = false
    var onFrame: ((Any, Int) -> Void)?
    var onClose: (() -> Void)?
    init(config: GuestConnectionConfig, queue: DispatchQueue) { self.queue = queue; connection = guestTLS(config, queue: queue) }
    func start(bootstrap: GuestBootstrap, chromePresent: Bool) {
        connection.stateUpdateHandler = { [weak self] state in
            guard let self = self, !self.closed else { return }
            switch state {
            case .ready:
                self.ready = true
                self.send(["version":1,"kind":"control","instanceId":bootstrap.instanceId,"epoch":bootstrap.epoch,"token":bootstrap.token])
                self.send(["version":1,"type":"hello","agentVersion":1,"osVersion":ProcessInfo.processInfo.operatingSystemVersionString,"safariDriverPresent":FileManager.default.isExecutableFile(atPath: "/usr/bin/safaridriver"),"chromeDriverPresent":chromePresent])
                self.readHeader()
            case .failed, .cancelled: self.close()
            default: break
            }
        }
        connection.start(queue: queue)
        queue.asyncAfter(deadline: .now() + 15) { [weak self] in if let self = self, !self.ready { self.close() } }
    }
    func send(_ value: Any) {
        guard !closed else { return }
        do {
            let frame = try guestFrame(value)
            guard outgoingBytes + frame.count <= GuestLimits.queuedBytes else { close(); return }
            outgoing.append(frame); outgoingBytes += frame.count; flush()
        } catch { close() }
    }
    private func flush() {
        guard !closed, !sending, let data = outgoing.first else { return }
        sending = true
        connection.send(content: data, completion: .contentProcessed { [weak self] error in
            guard let self = self, !self.closed else { return }
            guard error == nil else { self.close(); return }
            self.outgoingBytes -= self.outgoing.removeFirst().count; self.sending = false; self.flush()
        })
    }
    private func exact(_ count: Int, completion: @escaping @Sendable (Data) -> Void) {
        incoming = Data()
        receiveExact(count, completion: completion)
    }
    private func receiveExact(_ count: Int, completion: @escaping @Sendable (Data) -> Void) {
        guard !closed else { return }
        connection.receive(minimumIncompleteLength: 1, maximumLength: count - incoming.count) { [weak self] data, _, complete, error in
            guard let self = self, !self.closed else { return }
            guard error == nil else { self.close(); return }
            if self.incoming.isEmpty, let data = data, data.count == count { completion(data); return }
            if let data = data {
                if self.incoming.isEmpty { self.incoming.reserveCapacity(count) }
                self.incoming.append(data)
            }
            guard self.incoming.count <= count else { self.close(); return }
            if self.incoming.count == count {
                let result = self.incoming
                self.incoming = Data()
                completion(result)
                return
            }
            guard !complete else { self.close(); return }
            self.receiveExact(count, completion: completion)
        }
    }
    private func readHeader() {
        exact(4) { [weak self] header in
            guard let self = self else { return }
            let n = header.reduce(0) { ($0 << 8) | Int($1) }
            guard n > 0, n <= GuestLimits.frame else { self.close(); return }
            self.exact(n) { [weak self] body in
                guard let self = self else { return }
                do { self.onFrame?(try GuestJSON.parse(body), body.count); self.readHeader() }
                catch { self.close() }
            }
        }
    }
    func close() {
        guard !closed else { return }; closed = true
        incoming = Data()
        outgoing.removeAll(); outgoingBytes = 0; connection.cancel(); onClose?()
    }
}

private final class GuestTunnel: @unchecked Sendable {
    let id = UUID()
    let port: UInt16
    private let local: NWConnection
    private let remote: NWConnection
    private let queue: DispatchQueue
    private let authentication: Data
    private var finished = false
    private var activated = false
    private var endedDirections = 0
    private let created = Date()
    private var lastActivity = Date()
    private var timer: DispatchSourceTimer?
    var onFinish: (() -> Void)?
    init(local: NWConnection, port: UInt16, bootstrap: GuestBootstrap, config: GuestConnectionConfig, queue: DispatchQueue) throws {
        self.local = local; self.port = port; self.queue = queue; remote = guestTLS(config, queue: queue)
        authentication = try guestFrame(["version":1,"kind":"forward","instanceId":bootstrap.instanceId,"epoch":bootstrap.epoch,"token":bootstrap.token,"port":Int(port)])
    }
    func start() {
        local.stateUpdateHandler = { [weak self] state in if case .failed = state { self?.close() } }
        remote.stateUpdateHandler = { [weak self] state in
            guard let self = self, !self.finished else { return }
            switch state {
            case .ready:
                self.remote.send(content: self.authentication, completion: .contentProcessed { [weak self] error in
                    guard let self = self, !self.finished else { return }
                    guard error == nil else { self.close(); return }
                    self.activated = true; self.pump(self.local, self.remote); self.pump(self.remote, self.local)
                })
            case .failed, .cancelled: self.close()
            default: break
            }
        }
        local.start(queue: queue); remote.start(queue: queue)
        let timer = DispatchSource.makeTimerSource(queue: queue); self.timer = timer
        timer.schedule(deadline: .now() + 10, repeating: 10)
        timer.setEventHandler { [weak self] in
            guard let self = self else { return }
            let now = Date()
            if (!self.activated && now.timeIntervalSince(self.created) >= 10) || now.timeIntervalSince(self.lastActivity) >= 120 || now.timeIntervalSince(self.created) >= 86400 { self.close() }
        }
        timer.resume()
    }
    private func pump(_ source: NWConnection, _ destination: NWConnection) {
        guard !finished else { return }
        source.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { [weak self] data, _, complete, error in
            guard let self = self, !self.finished else { return }
            guard error == nil else { self.close(); return }
            let continueReading: @Sendable () -> Void = {
                if complete { self.end(destination) } else { self.pump(source, destination) }
            }
            if let data = data, !data.isEmpty {
                self.lastActivity = Date()
                destination.send(content: data, completion: .contentProcessed { [weak self] error in
                    guard let self = self, !self.finished else { return }
                    if error != nil { self.close() } else { continueReading() }
                })
            } else { continueReading() }
        }
    }
    private func end(_ destination: NWConnection) {
        destination.send(content: nil, contentContext: .finalMessage, isComplete: true, completion: .contentProcessed { [weak self] error in
            guard let self = self, !self.finished else { return }
            if error != nil { self.close(); return }
            self.endedDirections += 1
            if self.endedDirections == 2 { self.close() }
        })
    }
    func close() {
        guard !finished else { return }; finished = true
        timer?.cancel(); timer = nil; local.cancel(); remote.cancel(); onFinish?()
    }
}

private final class GuestRoutePair: @unchecked Sendable {
    let port: UInt16
    var listeners: [NWListener] = []
    var ready = 0
    var committed = false
    init(_ port: UInt16) { self.port = port }
    func close() { for listener in listeners { listener.cancel() }; listeners.removeAll(); committed = false }
}

// A captured var would allocate the same box without expressing its queue confinement.
private final class GuestRouteTransaction: @unchecked Sendable {
    var settled = false
}

final class GuestRoutes: @unchecked Sendable {
    private let bootstrap: GuestBootstrap
    private let config: GuestConnectionConfig
    private let queue: DispatchQueue
    private let permitted: () -> Bool
    private var routes: [UInt16: GuestRoutePair] = [:]
    private var pending: [GuestRoutePair] = []
    private var streams: [UUID: GuestTunnel] = [:]
    private var binding = false
    private var cancelBinding: (() -> Void)?
    init(bootstrap: GuestBootstrap, config: GuestConnectionConfig, queue: DispatchQueue, permitted: @escaping () -> Bool) {
        self.bootstrap = bootstrap; self.config = config; self.queue = queue; self.permitted = permitted
    }
    static func ports(_ payload: [String: Any]) throws -> [UInt16] {
        try GuestJSON.keys(payload, required: ["ports"])
        guard let values = payload["ports"] as? [Any], !values.isEmpty, values.count <= GuestLimits.ports else { throw GuestFault("invalid_route_ports") }
        let ports = try values.map { UInt16(try GuestJSON.integer($0, minimum: 1, maximum: 65535)) }
        guard Set(ports).count == ports.count else { throw GuestFault("duplicate_route_port") }
        return ports
    }
    func bind(_ ports: [UInt16], deadline: Int, completion: @escaping @Sendable (GuestReply) -> Void) {
        guard permitted(), !binding, routes.count + ports.filter({ routes[$0] == nil }).count <= GuestLimits.ports else { completion(.failure(GuestFault("route_bind_refused"), "not_started")); return }
        let missing = ports.filter { routes[$0] == nil }
        if missing.isEmpty { completion(.success(["ports": ports.map(Int.init)])); return }
        binding = true; pending = missing.map(GuestRoutePair.init)
        let transaction = GuestRouteTransaction()
        let finish: @Sendable (GuestFault?) -> Void = { [weak self] error in
            guard let self = self, !transaction.settled else { return }; transaction.settled = true
            self.cancelBinding = nil; self.binding = false
            if let error = error {
                for pair in self.pending { pair.close() }; self.pending.removeAll()
                completion(.failure(error, "not_started")); return
            }
            guard self.permitted(), guestNow() < deadline else {
                for pair in self.pending { pair.close() }; self.pending.removeAll()
                completion(.failure(GuestFault("route_deadline_or_epoch"), "not_started")); return
            }
            for pair in self.pending { pair.committed = true; self.routes[pair.port] = pair }
            self.pending.removeAll(); completion(.success(["ports": ports.map(Int.init)]))
        }
        cancelBinding = { finish(GuestFault("route_revoked")) }
        do {
            for pair in pending {
                for host in ["127.0.0.1", "::1"] {
                    let parameters = NWParameters.tcp
                    parameters.allowLocalEndpointReuse = false
                    parameters.requiredLocalEndpoint = .hostPort(host: NWEndpoint.Host(host), port: NWEndpoint.Port(rawValue: pair.port)!)
                    if let ip = parameters.defaultProtocolStack.internetProtocol as? NWProtocolIP.Options { ip.version = host == "::1" ? .v6 : .v4 }
                    let listener = try NWListener(using: parameters)
                    pair.listeners.append(listener)
                    listener.newConnectionHandler = { [weak self, weak pair] connection in
                        guard let self = self, let pair = pair, pair.committed, self.permitted(), self.streams.count < GuestLimits.streams else { connection.cancel(); return }
                        do {
                            try self.bootstrap.current()
                            let tunnel = try GuestTunnel(local: connection, port: pair.port, bootstrap: self.bootstrap, config: self.config, queue: self.queue)
                            self.streams[tunnel.id] = tunnel
                            tunnel.onFinish = { [weak self, weak tunnel] in if let id = tunnel?.id { self?.streams.removeValue(forKey: id) } }
                            tunnel.start()
                        } catch { connection.cancel() }
                    }
                    listener.stateUpdateHandler = { [weak self, weak pair] state in
                        guard let self = self, let pair = pair else { return }
                        switch state {
                        case .ready:
                            pair.ready += 1
                            if self.pending.allSatisfy({ $0.ready == 2 }) { finish(nil) }
                        case .failed:
                            if !transaction.settled { finish(GuestFault("loopback_port_conflict")) }
                            else if pair.committed { self.routes.removeValue(forKey: pair.port); pair.close() }
                        default: break
                        }
                    }
                    listener.start(queue: queue)
                }
            }
        } catch { finish(GuestFault("loopback_bind_failed")); return }
        queue.asyncAfter(deadline: .now() + .milliseconds(max(1, min(10_000, deadline - guestNow())))) { if !transaction.settled { finish(GuestFault("loopback_bind_timeout")) } }
    }
    func unbind(_ ports: [UInt16]) throws -> Any {
        guard !binding, ports.allSatisfy({ routes[$0] != nil }) else { throw GuestFault("route_not_owned") }
        for port in ports {
            routes.removeValue(forKey: port)?.close()
            for stream in Array(streams.values) where stream.port == port { stream.close() }
        }
        return ["ports": ports.map(Int.init)]
    }
    func close() {
        cancelBinding?()
        for pair in routes.values { pair.close() }; routes.removeAll()
        for stream in Array(streams.values) { stream.close() }; streams.removeAll()
    }
    var status: Any { ["ports": routes.keys.sorted().map(Int.init), "activeStreams": streams.count] }
}
