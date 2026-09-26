// SSE client over URLSession async bytes: reconnects with backoff and resumes via Last-Event-ID.
import Foundation

enum StreamMessage: Sendable {
    case connected
    case event(QaEvent)
    /// The engine restarted (sequence numbers began again); everything it still buffers follows.
    case reset
    /// Some events were dropped from the engine's ring buffer before we could replay them.
    case gap
    case disconnected(String)
}

enum EventStream {
    /// Streams engine events until the consumer stops iterating. `startAfter` = last seq already seen (0 = full replay).
    static func messages(api: APIClient, startAfter: Int) -> AsyncStream<StreamMessage> {
        AsyncStream { continuation in
            let task = Task {
                var lastId = startAfter
                var delay: Duration = .milliseconds(500)
                let config = URLSessionConfiguration.ephemeral
                // Heartbeats arrive every 15 s; a silent minute means the connection is dead.
                config.timeoutIntervalForRequest = 60
                config.timeoutIntervalForResource = 60 * 60 * 24 * 7
                let session = URLSession(configuration: config)
                let decoder = JSONDecoder()
                while !Task.isCancelled {
                    do {
                        var request = api.request("/api/events")
                        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
                        request.setValue(String(lastId), forHTTPHeaderField: "Last-Event-ID")
                        let (bytes, response) = try await session.bytes(for: request)
                        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
                        guard status == 200 else { throw APIError(status: status, message: "이벤트 스트림 연결 거부") }
                        continuation.yield(.connected)
                        delay = .milliseconds(500)
                        var line: [UInt8] = []
                        var eventName: String?
                        var dataLines: [String] = []
                        for try await byte in bytes {
                            if byte != 0x0A {
                                line.append(byte)
                                continue
                            }
                            if line.last == 0x0D { line.removeLast() }
                            defer { line.removeAll(keepingCapacity: true) }
                            if line.isEmpty {
                                // Blank line = dispatch (URLSession's `lines` would drop these, hence the manual parser).
                                switch eventName {
                                case "reset":
                                    lastId = 0
                                    continuation.yield(.reset)
                                case "gap":
                                    continuation.yield(.gap)
                                default:
                                    if !dataLines.isEmpty, let event = try? decoder.decode(QaEvent.self, from: Data(dataLines.joined(separator: "\n").utf8)) {
                                        lastId = event.seq
                                        continuation.yield(.event(event))
                                    }
                                }
                                eventName = nil
                                dataLines.removeAll()
                                continue
                            }
                            if line.first == 0x3A { continue }  // ":" comment / heartbeat
                            let text = String(decoding: line, as: UTF8.self)
                            let field: Substring
                            var value: Substring
                            if let colon = text.firstIndex(of: ":") {
                                field = text[..<colon]
                                value = text[text.index(after: colon)...]
                                if value.first == " " { value = value.dropFirst() }
                            } else {
                                field = Substring(text)
                                value = ""
                            }
                            switch field {
                            case "event": eventName = String(value)
                            case "data": dataLines.append(String(value))
                            default: break  // id/retry: seq is inside the JSON payload
                            }
                        }
                        continuation.yield(.disconnected("스트림이 닫혔습니다"))
                    } catch is CancellationError {
                        break
                    } catch {
                        if Task.isCancelled { break }
                        continuation.yield(.disconnected(error.localizedDescription))
                    }
                    try? await Task.sleep(for: delay)
                    delay = min(delay * 2, .seconds(5))
                }
                session.invalidateAndCancel()
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}
