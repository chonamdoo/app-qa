import Foundation

@main
struct DisplayDateFixture {
    struct Input: Decodable {
        let timeZone: String
        let values: [String?]
        let missing: String?
    }

    static func main() {
        do {
            let input = try JSONDecoder().decode(Input.self, from: FileHandle.standardInput.readDataToEndOfFile())
            guard let zone = TimeZone(identifier: input.timeZone) else { exit(2) }
            let values = input.values.map { DisplayDate.text($0, missing: input.missing ?? "미확인", timeZone: zone) }
            try FileHandle.standardOutput.write(contentsOf: JSONEncoder().encode(values))
        } catch {
            FileHandle.standardError.write(Data("\(error)\n".utf8))
            exit(1)
        }
    }
}
