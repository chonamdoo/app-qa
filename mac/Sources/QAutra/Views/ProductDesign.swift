import SwiftUI

enum ProductDesign {
    static let background = Color(red: 1, green: 1, blue: 1)
    static let canvas = color(0xf8f9fb)
    static let sidebar = color(0xf3f4f6)
    static let ink = color(0x20232c)
    static let muted = color(0x687180)
    static let line = color(0xe6e8ed)
    static let blue = color(0x4266e8)
    static let blueDark = color(0x3152c6)
    static let blueSoft = color(0xedf1ff)
    static let green = color(0x24734f)
    static let greenSoft = color(0xeaf6ef)
    static let red = color(0xc04449)
    static let redSoft = color(0xfceff0)
    static let amber = color(0x93651c)
    static let amberSoft = color(0xfcf5e7)
    static let sidebarWidth: CGFloat = 228
    static let topbarHeight: CGFloat = 64
    static let panelRadius: CGFloat = 12
    static let controlRadius: CGFloat = 8
    static let contentHorizontalPadding: CGFloat = 40
    static let contentVerticalPadding: CGFloat = 32

    static func displayFont(_ size: CGFloat) -> Font {
        .system(size: size)
    }

    static func bodyFont(_ size: CGFloat = 16) -> Font {
        .system(size: size)
    }

    private static func color(_ hex: UInt32) -> Color {
        Color(red: Double((hex >> 16) & 255) / 255,
              green: Double((hex >> 8) & 255) / 255,
              blue: Double(hex & 255) / 255)
    }
}

enum ProductButtonKind {
    case standard, primary, ghost, danger
}

enum ProductButtonSize {
    case standard, small
}

struct ProductButtonStyle: ButtonStyle {
    var kind: ProductButtonKind = .standard
    var size: ProductButtonSize = .standard
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(ProductDesign.bodyFont(size == .small ? 11 : 13).weight(.medium))
            .frame(minHeight: size == .small ? 16 : 19.5)
            .padding(.horizontal, size == .small ? 9 : 17)
            .padding(.vertical, size == .small ? 5 : 9)
            .frame(minHeight: size == .small ? 28 : 40)
            .foregroundStyle(foreground)
            .background(background.opacity(configuration.isPressed ? 0.75 : 1))
            .clipShape(RoundedRectangle(cornerRadius: ProductDesign.controlRadius))
            .overlay {
                RoundedRectangle(cornerRadius: ProductDesign.controlRadius)
                    .strokeBorder(border, lineWidth: 1)
            }
            .opacity(isEnabled ? 1 : 0.45)
            .contentShape(RoundedRectangle(cornerRadius: ProductDesign.controlRadius))
    }

    private var foreground: Color {
        switch kind {
        case .standard: ProductDesign.ink
        case .ghost: ProductDesign.muted
        case .primary: .white
        case .danger: ProductDesign.red
        }
    }

    private var background: Color {
        switch kind {
        case .standard: ProductDesign.background
        case .primary: ProductDesign.blue
        case .ghost: .clear
        case .danger: ProductDesign.redSoft
        }
    }

    private var border: Color {
        switch kind {
        case .standard: ProductDesign.line
        case .primary, .ghost: .clear
        case .danger: ProductDesign.red.opacity(0.2)
        }
    }
}

struct ProductPageHeading: View {
    let title: String
    let subtitle: String

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(ProductDesign.displayFont(28).weight(.semibold))
                .foregroundStyle(ProductDesign.ink)
                .frame(minHeight: 37.8, alignment: .leading)
                .accessibilityAddTraits(.isHeader)
            if !subtitle.isEmpty {
                Text(subtitle)
                    .font(ProductDesign.bodyFont(13))
                    .foregroundStyle(ProductDesign.muted)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(minHeight: 21.45, alignment: .leading)
            }
        }
    }
}

struct ProductPageHeader<Actions: View>: View {
    let title: String
    let subtitle: String
    private let actions: Actions

    init(title: String, subtitle: String, @ViewBuilder actions: () -> Actions) {
        self.title = title
        self.subtitle = subtitle
        self.actions = actions()
    }

    var body: some View {
        HStack(alignment: .center, spacing: 24) {
            ProductPageHeading(title: title, subtitle: subtitle)
            Spacer(minLength: 16)
            actions
        }
    }
}

extension ProductPageHeader where Actions == EmptyView {
    init(title: String, subtitle: String) {
        self.init(title: title, subtitle: subtitle) { EmptyView() }
    }
}

struct ProductPanel<Content: View>: View {
    let title: String
    let subtitle: String
    private let content: Content

    init(title: String = "", subtitle: String = "", @ViewBuilder content: () -> Content) {
        self.title = title
        self.subtitle = subtitle
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            if !title.isEmpty || !subtitle.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    if !title.isEmpty {
                        Text(title)
                            .font(ProductDesign.bodyFont(16).weight(.semibold))
                            .foregroundStyle(ProductDesign.ink)
                            .accessibilityAddTraits(.isHeader)
                    }
                    if !subtitle.isEmpty {
                        Text(subtitle)
                            .font(ProductDesign.bodyFont(13))
                            .foregroundStyle(ProductDesign.muted)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
            content
        }
        .padding(24)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(ProductDesign.background)
        .clipShape(RoundedRectangle(cornerRadius: ProductDesign.panelRadius))
        .overlay {
            RoundedRectangle(cornerRadius: ProductDesign.panelRadius)
                .strokeBorder(ProductDesign.line, lineWidth: 1)
        }
    }
}

enum ProductNoticeTone {
    case neutral, warning, error, success
}

struct ProductNotice: View {
    private let text: String
    private let tone: ProductNoticeTone

    init(_ text: String, tone: ProductNoticeTone = .neutral) {
        self.text = text
        self.tone = tone
    }

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: symbol)
                .accessibilityHidden(true)
            Text(text)
                .lineSpacing(8)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
        }
        .font(ProductDesign.bodyFont(13))
        .foregroundStyle(foreground)
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(background)
        .clipShape(RoundedRectangle(cornerRadius: ProductDesign.controlRadius))
    }

    private var symbol: String {
        switch tone {
        case .neutral: "info.circle"
        case .warning: "exclamationmark.triangle"
        case .error: "exclamationmark.circle"
        case .success: "checkmark.circle"
        }
    }

    private var foreground: Color {
        switch tone {
        case .neutral: ProductDesign.muted
        case .warning: ProductDesign.amber
        case .error: ProductDesign.red
        case .success: ProductDesign.green
        }
    }

    private var background: Color {
        switch tone {
        case .neutral: ProductDesign.sidebar
        case .warning: ProductDesign.amberSoft
        case .error: ProductDesign.redSoft
        case .success: ProductDesign.greenSoft
        }
    }
}

/// Design `.qa-field` search input: 40pt bordered control with a leading magnifier.
struct ProductSearchField: View {
    let prompt: String
    @Binding var text: String

    init(_ prompt: String, text: Binding<String>) {
        self.prompt = prompt
        _text = text
    }

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass")
                .foregroundStyle(ProductDesign.muted)
                .accessibilityHidden(true)
            TextField(prompt, text: $text)
                .textFieldStyle(.plain)
                .accessibilityLabel(prompt)
        }
        .font(ProductDesign.bodyFont(13))
        .padding(.horizontal, 12)
        .frame(minHeight: 40)
        .background(ProductDesign.background)
        .clipShape(RoundedRectangle(cornerRadius: ProductDesign.controlRadius))
        .overlay {
            RoundedRectangle(cornerRadius: ProductDesign.controlRadius)
                .strokeBorder(ProductDesign.line, lineWidth: 1)
        }
    }
}

struct ProductStatusBadge: View {
    let status: String

    var body: some View {
        let item = appearance
        HStack(spacing: 4) {
            Image(systemName: item.icon).accessibilityHidden(true)
            Text(item.title)
        }
        .font(ProductDesign.bodyFont(11).weight(.medium))
        .foregroundStyle(item.foreground)
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        .background(item.background, in: RoundedRectangle(cornerRadius: 4))
        .accessibilityLabel("상태: \(item.title)")
    }

    private var appearance: (title: String, icon: String, foreground: Color, background: Color) {
        switch status.uppercased() {
        case "PASS": ("통과", "checkmark", ProductDesign.green, ProductDesign.greenSoft)
        case "FAIL", "FAILED": ("실패", "xmark", ProductDesign.red, ProductDesign.redSoft)
        case "ERROR", "BLOCKED": ("차단", "exclamationmark.triangle", ProductDesign.amber, ProductDesign.amberSoft)
        case "RUNNING": ("실행 중", "play", ProductDesign.blue, ProductDesign.blueSoft)
        case "PREPARING": ("준비 중", "clock", ProductDesign.blue, ProductDesign.blueSoft)
        case "STOPPING": ("중지 중", "pause", ProductDesign.amber, ProductDesign.amberSoft)
        case "FINALIZING": ("최종 확인 중", "clock", ProductDesign.blue, ProductDesign.blueSoft)
        case "FINISHED": ("실행 종료", "stop", ProductDesign.muted, ProductDesign.sidebar)
        case "QUEUED", "PENDING": ("대기 중", "clock", ProductDesign.amber, ProductDesign.amberSoft)
        case "READY": ("준비됨", "checkmark", ProductDesign.green, ProductDesign.greenSoft)
        case "COMPLETED", "SUCCEEDED": ("작업 완료", "stop", ProductDesign.muted, ProductDesign.sidebar)
        case "CLOSED": ("닫힘", "stop", ProductDesign.muted, ProductDesign.sidebar)
        case "CANCELLED", "STOPPED": ("중지됨", "stop", ProductDesign.amber, ProductDesign.amberSoft)
        case "NOT-RUN", "NOT_RUN", "SKIPPED": ("미실행", "circle", ProductDesign.muted, ProductDesign.canvas)
        case "INCONCLUSIVE": ("판정 불가", "questionmark.circle", ProductDesign.amber, ProductDesign.amberSoft)
        case "UNKNOWN", "UNCERTAIN", "UNFINISHED": ("결과 미확인", "questionmark.circle", ProductDesign.amber, ProductDesign.amberSoft)
        default: (status.isEmpty ? "미확인" : status, "circle", ProductDesign.muted, ProductDesign.canvas)
        }
    }
}

struct ProductReadIdentity: Hashable {
    let connection: ObjectIdentifier?
    let runID: String?
    let artifact: String?

    init(api: APIClient?, runID: String? = nil, artifact: String? = nil) {
        connection = api.map { ObjectIdentifier($0.session) }
        self.runID = runID
        self.artifact = artifact
    }
}
