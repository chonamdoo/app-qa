// Bottom composer: scenario text, document attach / drag & drop (uploaded to the engine), and job actions.
import SwiftUI
import UniformTypeIdentifiers

enum DocumentTypes {
    static let extensions: Set<String> = ["md", "markdown", "txt", "csv", "tsv", "json", "yaml", "yml", "xlsx", "docx", "pdf"]
    static let contentTypes: [UTType] = extensions.compactMap { UTType(filenameExtension: $0) }
}

struct ComposerView: View {
    @Environment(Workspace.self) private var workspace
    @State private var importing = false
    @State private var dropTargeted = false
    @FocusState private var focused: Bool

    private var connected: Bool { workspace.api != nil }
    private var canPlan: Bool { connected && !workspace.uploadsPending && workspace.selectedApp != nil }

    var body: some View {
        @Bindable var workspace = workspace
        VStack(alignment: .leading, spacing: 8) {
            if !workspace.attachments.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(workspace.attachments) { attachment in
                            AttachmentChip(attachment: attachment) {
                                workspace.attachments.removeAll { $0.id == attachment.id }
                            }
                        }
                    }
                }
            }
            HStack(alignment: .bottom, spacing: 8) {
                Button {
                    importing = true
                } label: {
                    Image(systemName: "paperclip").font(.title3)
                }
                .buttonStyle(.borderless)
                .help("기획서 첨부 (md, txt, csv, xlsx, docx, pdf)")
                .accessibilityIdentifier("composer.attach")
                .accessibilityLabel("기획서 첨부")
                TextField("새 작업 — 시나리오를 입력하거나 기획서를 끌어다 놓으세요", text: $workspace.composerText, axis: .vertical)
                    .textFieldStyle(.plain)
                    .lineLimit(1...6)
                    .focused($focused)
                    .padding(.vertical, 6)
                    .accessibilityIdentifier("composer.text")
                    .accessibilityLabel("새 작업 시나리오 입력")
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background(.background, in: RoundedRectangle(cornerRadius: 18))
            .overlay(
                RoundedRectangle(cornerRadius: 18)
                    .strokeBorder(dropTargeted ? Color.accentColor : Color.primary.opacity(0.12), lineWidth: dropTargeted ? 2 : 1))
            HStack(spacing: 8) {
                Button {
                    Task { await workspace.submitPlan(thenRun: false) }
                } label: {
                    Label("계획 생성", systemImage: "wand.and.stars")
                }
                .disabled(!canPlan)
                .accessibilityIdentifier("composer.plan")
                .accessibilityLabel("계획 생성")
                Button {
                    Task { await workspace.submitPlan(thenRun: true) }
                } label: {
                    Label("계획 생성 + 실행", systemImage: "wand.and.stars.inverse")
                }
                .disabled(!canPlan)
                .accessibilityIdentifier("composer.planAndRun")
                .accessibilityLabel("계획 생성 후 실행")
                Button {
                    Task { await workspace.submitSmoke() }
                } label: {
                    Label("스모크", systemImage: "flame")
                }
                .disabled(!connected || workspace.selectedApp == nil)
                .accessibilityIdentifier("composer.smoke")
                .accessibilityLabel("스모크 테스트")
                Spacer()
                if workspace.uploadsPending {
                    ProgressView().controlSize(.small)
                    Text("문서 업로드 중…").font(.caption).foregroundStyle(.secondary)
                }
                Button {
                    Task { await workspace.submitRun() }
                } label: {
                    Label("테스트 실행", systemImage: "play.fill")
                }
                .buttonStyle(.borderedProminent)
                .keyboardShortcut(.return, modifiers: .command)
                .disabled(!connected)
                .accessibilityIdentifier("composer.run")
                .accessibilityLabel("테스트 실행")
            }
            .controlSize(.regular)
        }
        .padding(12)
        .background(.bar)
        .fileImporter(isPresented: $importing, allowedContentTypes: DocumentTypes.contentTypes, allowsMultipleSelection: true) { result in
            if case .success(let urls) = result { workspace.attach(urls) }
        }
        .onDrop(of: [.fileURL], isTargeted: $dropTargeted) { providers in
            accept(providers)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("composer")
    }

    private func accept(_ providers: [NSItemProvider]) -> Bool {
        let workspace = workspace
        var accepted = false
        for provider in providers where provider.canLoadObject(ofClass: URL.self) {
            accepted = true
            _ = provider.loadObject(ofClass: URL.self) { url, _ in
                guard let url, DocumentTypes.extensions.contains(url.pathExtension.lowercased()) else {
                    Task { @MainActor in workspace.banner = "지원하지 않는 문서 형식입니다 — md, txt, csv, xlsx, docx, pdf" }
                    return
                }
                Task { @MainActor in workspace.attach([url]) }
            }
        }
        return accepted
    }
}

private struct AttachmentChip: View {
    let attachment: Attachment
    let remove: () -> Void

    var body: some View {
        HStack(spacing: 4) {
            switch attachment.state {
            case .uploading: ProgressView().controlSize(.mini)
            case .ready: Image(systemName: "doc.text.fill").foregroundStyle(Color.accentColor)
            case .failed: Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.red)
            }
            Text(attachment.name).lineLimit(1)
            if case .failed(let message) = attachment.state {
                Text(message).foregroundStyle(.red).lineLimit(1)
            }
            Button(action: remove) { Image(systemName: "xmark.circle.fill") }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
                .accessibilityIdentifier("composer.attachment.remove.\(attachment.name)")
                .accessibilityLabel("\(attachment.name) 첨부 제거")
        }
        .font(.caption)
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(.quaternary, in: Capsule())
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("composer.attachment.\(attachment.name)")
    }
}
