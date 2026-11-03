import Foundation

struct NativeFault: Error, LocalizedError, Sendable {
    let code: String
    let message: String
    let effect: String

    init(_ code: String, _ message: String, effect: String = "not_started") {
        self.code = code
        self.message = String(message.prefix(2048))
        self.effect = effect
    }

    var errorDescription: String? { message }
}

indirect enum NativeJSON: Codable, Sendable, Equatable {
    case object([String: NativeJSON])
    case array([NativeJSON])
    case string(String)
    case number(Double)
    case bool(Bool)
    case null

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() { self = .null }
        else if let value = try? container.decode(Bool.self) { self = .bool(value) }
        else if let value = try? container.decode(String.self) { self = .string(value) }
        else if let value = try? container.decode(Double.self), value.isFinite { self = .number(value) }
        else if let value = try? container.decode([NativeJSON].self) { self = .array(value) }
        else { self = .object(try container.decode([String: NativeJSON].self)) }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .object(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .string(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .bool(let value): try container.encode(value)
        case .null: try container.encodeNil()
        }
    }

    var objectValue: [String: NativeJSON]? {
        if case .object(let value) = self { return value }
        return nil
    }

    static func integer(_ value: Int) -> NativeJSON { .number(Double(value)) }
    static func optional(_ value: String?) -> NativeJSON { value.map(NativeJSON.string) ?? .null }
    static func optional(_ value: Double?) -> NativeJSON { value.map(NativeJSON.number) ?? .null }
}

struct NativeJSONParser {
    private let bytes: [UInt8]
    private var index = 0
    private var nodes = 0

    init(_ data: Data) { bytes = Array(data) }

    mutating func parse() throws -> NativeJSON {
        let result = try value(depth: 0)
        whitespace()
        guard index == bytes.count else { throw invalid() }
        return result
    }

    private func invalid() -> NativeFault { NativeFault("invalid_json", "Expected bounded, unambiguous JSON") }

    private mutating func whitespace() {
        while index < bytes.count && [UInt8(9), 10, 13, 32].contains(bytes[index]) { index += 1 }
    }

    private mutating func consume(_ byte: UInt8) -> Bool {
        whitespace()
        guard index < bytes.count && bytes[index] == byte else { return false }
        index += 1
        return true
    }

    private mutating func value(depth: Int) throws -> NativeJSON {
        nodes += 1
        guard depth <= 16, nodes <= 8192 else { throw invalid() }
        whitespace()
        guard index < bytes.count else { throw invalid() }
        switch bytes[index] {
        case 123:
            index += 1
            var result: [String: NativeJSON] = [:]
            if consume(125) { return .object(result) }
            repeat {
                whitespace()
                let key = try string()
                guard result[key] == nil, consume(58) else { throw invalid() }
                result[key] = try value(depth: depth + 1)
                if consume(125) { return .object(result) }
                guard consume(44) else { throw invalid() }
            } while true
        case 91:
            index += 1
            var result: [NativeJSON] = []
            if consume(93) { return .array(result) }
            repeat {
                result.append(try value(depth: depth + 1))
                if consume(93) { return .array(result) }
                guard consume(44) else { throw invalid() }
            } while true
        case 34: return .string(try string())
        case 116: try literal("true"); return .bool(true)
        case 102: try literal("false"); return .bool(false)
        case 110: try literal("null"); return .null
        default:
            let start = index
            while index < bytes.count && ((48...57).contains(bytes[index]) || [UInt8(45), 43, 46, 69, 101].contains(bytes[index])) { index += 1 }
            guard index > start,
                  let number = try? JSONDecoder().decode(Double.self, from: Data(bytes[start..<index])), number.isFinite else { throw invalid() }
            return .number(number)
        }
    }

    private mutating func string() throws -> String {
        guard index < bytes.count && bytes[index] == 34 else { throw invalid() }
        let start = index
        index += 1
        while index < bytes.count {
            if bytes[index] == 34 {
                index += 1
                guard let result = try? JSONDecoder().decode(String.self, from: Data(bytes[start..<index])) else { throw invalid() }
                return result
            }
            guard bytes[index] >= 32 else { throw invalid() }
            if bytes[index] == 92 {
                index += 2
                guard index <= bytes.count else { throw invalid() }
            } else { index += 1 }
        }
        throw invalid()
    }

    private mutating func literal(_ text: String) throws {
        let expected = Array(text.utf8)
        guard index + expected.count <= bytes.count,
              bytes[index..<(index + expected.count)].elementsEqual(expected) else { throw invalid() }
        index += expected.count
    }
}

func nativeUUID(_ value: String) -> Bool {
    UUID(uuidString: value)?.uuidString.lowercased() == value
}

extension Dictionary where Key == String, Value == NativeJSON {
    func requireKeys(_ required: Set<String>, optional: Set<String> = []) throws {
        let actual = Set(keys)
        guard required.isSubset(of: actual), actual.isSubset(of: required.union(optional)) else {
            throw NativeFault("invalid_fields", "Missing or unexpected object fields")
        }
    }

    func text(_ key: String) throws -> String {
        guard case .string(let value)? = self[key] else { throw NativeFault("invalid_fields", "Expected string field: \(key)") }
        return value
    }

    func integer(_ key: String, range: ClosedRange<Int>) throws -> Int {
        guard case .number(let number)? = self[key], number.isFinite,
              number.rounded() == number, number >= Double(range.lowerBound), number <= Double(range.upperBound) else {
            throw NativeFault("invalid_fields", "Invalid integer field: \(key)")
        }
        return Int(number)
    }

    func boolean(_ key: String) throws -> Bool {
        guard case .bool(let value)? = self[key] else { throw NativeFault("invalid_fields", "Expected boolean field: \(key)") }
        return value
    }
}

struct NativeRequest: Sendable {
    let id: String
    let action: String
    let instanceID: String?
    let payload: [String: NativeJSON]

    init(_ object: [String: NativeJSON]) throws {
        try object.requireKeys(["version", "id", "action"], optional: ["instanceId", "payload"])
        _ = try object.integer("version", range: 1...1)
        id = try object.text("id")
        guard nativeUUID(id) else { throw NativeFault("invalid_id", "Request id must be a canonical lowercase UUID") }
        action = try object.text("action")
        guard ["probe", "list", "create", "start", "stop", "poweroff", "show", "hide", "status", "automation", "recovery.register", "recovery.observe", "recovery.runtime"].contains(action) else {
            throw NativeFault("invalid_action", "Unsupported native action")
        }
        if let value = object["instanceId"] {
            guard case .string(let identifier) = value, nativeUUID(identifier) else {
                throw NativeFault("invalid_instance", "instanceId must be a canonical lowercase machine UUID")
            }
            instanceID = identifier
        } else { instanceID = nil }
        if let value = object["payload"] {
            guard case .object(let fields) = value else { throw NativeFault("invalid_payload", "payload must be an object") }
            payload = fields
        } else { payload = [:] }
        if action == "probe" || action == "list" {
            guard instanceID == nil, payload.isEmpty else { throw NativeFault("invalid_fields", "This action does not accept instance fields") }
        } else {
            guard instanceID != nil else { throw NativeFault("invalid_instance", "This action requires a machine UUID") }
            if !["create", "automation", "recovery.register", "recovery.observe", "recovery.runtime"].contains(action) && !payload.isEmpty {
                throw NativeFault("invalid_payload", "This action does not accept payload fields")
            }
        }
    }
}

func nativeSuccess(_ id: String, _ result: NativeJSON) -> NativeJSON {
    .object(["version": .integer(1), "id": .string(id), "ok": .bool(true), "result": result])
}

func nativeFailure(_ id: String, _ error: NativeFault) -> NativeJSON {
    .object(["version": .integer(1), "id": .string(id), "ok": .bool(false), "error": .object([
        "code": .string(error.code), "message": .string(error.message), "effect": .string(error.effect)
    ])])
}
