import Foundation

enum DisplayDate {
    private static let fractional = Date.ISO8601FormatStyle(includingFractionalSeconds: true)
    private static let whole = Date.ISO8601FormatStyle()
    private static let output = Date.VerbatimFormatStyle(
        format: "\(year: .defaultDigits)년 \(month: .twoDigits)월 \(day: .twoDigits)일 \(hour: .twoDigits(clock: .twentyFourHour, hourCycle: .zeroBased))시 \(minute: .twoDigits)분 \(second: .twoDigits)초",
        locale: Locale(identifier: "ko_KR"),
        timeZone: .autoupdatingCurrent,
        calendar: Calendar(identifier: .gregorian)
    )

    static func date(_ iso: String?) -> Date? {
        guard let iso else { return nil }
        return (try? fractional.parse(iso)) ?? (try? whole.parse(iso))
    }
    static func text(_ iso: String?, missing: String = "미확인", timeZone: TimeZone = .autoupdatingCurrent) -> String {
        guard let iso else { return missing }
        guard let date = date(iso) else { return "\(missing) · 원 기록: \(iso)" }
        return text(date, timeZone: timeZone)
    }

    static func text(_ date: Date, timeZone: TimeZone = .autoupdatingCurrent) -> String {
        var style = output
        style.timeZone = timeZone
        let offset = timeZone.secondsFromGMT(for: date)
        let zone = String(format: "%@%02d:%02d", offset >= 0 ? "+" : "-", abs(offset) / 3600, abs(offset) / 60 % 60)
        return "\(date.formatted(style)) \(timeZone.identifier) (UTC\(zone))"
    }
}
