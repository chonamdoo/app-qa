// qa-ocr: Apple Vision text recognition for app-qa.
// Usage: qa-ocr <image.png>
// Prints JSON {secs, width, height, items: [{text, confidence, box: [x, y, w, h]}]} where box is normalized (0…1)
// with a top-left origin. Exit codes: 64 usage, 65 unreadable image, 70 recognition failure.
import AppKit
import Foundation
import Vision

func fail(_ message: String, _ code: Int32) -> Never {
    FileHandle.standardError.write("\(message)\n".data(using: .utf8)!)
    exit(code)
}

guard CommandLine.arguments.count == 2 else { fail("usage: qa-ocr <image.png>", 64) }
let path = CommandLine.arguments[1]
guard let image = NSImage(contentsOfFile: path),
      let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
    fail("cannot load \(path)", 65)
}

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.recognitionLanguages = ["ko-KR", "en-US"]
request.usesLanguageCorrection = true

let start = Date()
do {
    try VNImageRequestHandler(cgImage: cg, options: [:]).perform([request])
} catch {
    fail("recognition failed: \(error.localizedDescription)", 70)
}

var items: [[String: Any]] = []
for observation in request.results ?? [] {
    guard let top = observation.topCandidates(1).first else { continue }
    let b = observation.boundingBox // normalized, origin bottom-left
    items.append([
        "text": top.string,
        "confidence": top.confidence,
        "box": [b.minX, 1 - b.maxY, b.width, b.height],
    ])
}

let out: [String: Any] = [
    "secs": Date().timeIntervalSince(start),
    "width": cg.width,
    "height": cg.height,
    "items": items,
]
do {
    let data = try JSONSerialization.data(withJSONObject: out, options: [.sortedKeys])
    FileHandle.standardOutput.write(data)
} catch {
    fail("cannot encode result: \(error.localizedDescription)", 70)
}
