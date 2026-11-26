import Foundation

@main
enum GuestJSONFixture {
    struct FixtureFailure: Error {
        let message: String
    }

    static func response(_ count: Int) -> Data {
        var data = Data("{\"value\":\"".utf8)
        data.append(Data(repeating: 65, count: count))
        data.append(Data("\"}".utf8))
        return data
    }

    static func summary(_ value: Any) throws -> [String: Any] {
        let object = try GuestJSON.object(value)
        guard let text = object["value"] as? String else {
            throw FixtureFailure(message: "Parsed response lost its string value")
        }
        return [
            "keys": object.keys.sorted(),
            "bytes": text.utf8.count,
            "allA": text.utf8.allSatisfy { $0 == 65 },
        ]
    }

    static func rejection(_ data: Data, response: Bool = false) -> String? {
        do {
            if response {
                _ = try GuestJSON.parse(data, stringLimit: GuestLimits.response)
            } else {
                _ = try GuestJSON.parse(data)
            }
            return nil
        } catch let fault as GuestFault {
            return fault.code
        } catch {
            return "rejected"
        }
    }

    static func result(_ scenario: String) throws -> Any {
        switch scenario {
        case "request-boundary":
            return [
                "accepted": try summary(GuestJSON.parse(response(GuestLimits.body))),
                "oversizedRejected": rejection(response(GuestLimits.body + 1)) != nil,
            ] as [String: Any]
        case "large-response":
            return try summary(GuestJSON.parse(response(GuestLimits.body + 1), stringLimit: GuestLimits.response))
        case "whole-response-boundary":
            let overhead = Data("{\"value\":\"\"}".utf8).count
            let data = response(GuestLimits.response - overhead)
            return [
                "frameBytes": data.count,
                "value": try summary(GuestJSON.parse(data, stringLimit: GuestLimits.response)),
            ] as [String: Any]
        case "response-string-boundary":
            return [
                "accepted": try summary(GuestJSON.parse(response(GuestLimits.response), stringLimit: GuestLimits.response)),
                "oversizedRejected": rejection(response(GuestLimits.response + 1), response: true) != nil,
            ] as [String: Any]
        case "oversized-frame":
            var data = Data("{}".utf8)
            data.append(Data(repeating: 32, count: GuestLimits.frame - data.count + 1))
            return [
                "frameBytes": data.count,
                "fault": rejection(data, response: true) ?? "accepted",
            ] as [String: Any]
        case "malformed":
            return [
                "duplicateNullKey": rejection(Data(#"{"value":null,"value":1}"#.utf8)) ?? "accepted",
                "duplicateEscapedKey": rejection(Data(#"{"value":1,"\u0076alue":2}"#.utf8)) ?? "accepted",
                "invalidUTF8Rejected": rejection(Data([34, 255, 34])) != nil,
                "invalidEscapeRejected": rejection(Data(#""\q""#.utf8)) != nil,
                "invalidHexEscapeRejected": rejection(Data(#""\u12G4""#.utf8)) != nil,
                "truncatedEscapeRejected": rejection(Data([34, 92])) != nil,
                "unpairedHighSurrogateRejected": rejection(Data(#""\uD800""#.utf8)) != nil,
                "unpairedLowSurrogateRejected": rejection(Data(#""\uDC00""#.utf8)) != nil,
                "mismatchedSurrogateRejected": rejection(Data(#""\uD800\u0041""#.utf8)) != nil,
                "trailingLiteralRejected": rejection(Data("true false".utf8)) != nil,
                "trailingObjectRejected": rejection(Data("{} {}".utf8)) != nil,
            ] as [String: Any]
        case "valid-values":
            let data = Data(#"{"문구":"\uD83D\uDE00\nQA","plain":"한글 café 😀","escaped":"\"\\\/\b\f\n\r\t","literals":[true,false,null],"numbers":[0,-1.25e2,0.125,2E+3],"nested":{"value":"kept"}}"#.utf8)
            return try GuestJSON.parse(data)
        default:
            throw FixtureFailure(message: "Unknown fixture scenario")
        }
    }

    static func main() throws {
        guard CommandLine.arguments.count == 2 else {
            throw FixtureFailure(message: "Expected one fixture scenario")
        }
        let value = try result(CommandLine.arguments[1])
        let output = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
        FileHandle.standardOutput.write(output)
        FileHandle.standardOutput.write(Data([10]))
    }
}
