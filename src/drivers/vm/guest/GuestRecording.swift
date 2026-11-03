import Foundation
import Darwin
import CryptoKit
@preconcurrency import ScreenCaptureKit
@preconcurrency import AVFoundation
@preconcurrency import CoreMedia
@preconcurrency import CoreGraphics
@preconcurrency import CoreVideo

func requestGuestRecordingPermission(_ bootstrap: GuestBootstrap) throws {
    try GuestFiles.requireGuest()
    try bootstrap.verifyInstalledIdentity()
    guard Bundle.main.bundleURL.path == GuestFiles.root.appendingPathComponent("QAutraGuestAgent.app").path else { throw GuestFault("guest_recording_permission_source_refused") }
    guard CGRequestScreenCaptureAccess() else { throw GuestFault("guest_screen_recording_permission_required", "Grant Screen & System Audio Recording to the installed QAutraGuestAgent inside the guest, then restart the prepared guest agent. Host permissions are not used.") }
}

struct GuestRecordingIdentity: Equatable {
    let machineId: String
    let contextId: String
    let generation: Int
    let epoch: Int
    let guestPid: Int
    let recorderId: String
    let attemptId: String
    let runId: String
    init(_ object: [String: Any], bootstrap: GuestBootstrap) throws {
        try GuestJSON.keys(object, required: ["machineId","contextId","generation","epoch","guestPid","recorderId","attemptId","runId"])
        machineId = try GuestJSON.uuid(object["machineId"])
        contextId = try GuestJSON.uuid(object["contextId"])
        generation = try GuestJSON.integer(object["generation"], minimum: 1)
        epoch = try GuestJSON.integer(object["epoch"], minimum: 1)
        guestPid = try GuestJSON.integer(object["guestPid"], minimum: 1, maximum: 2147483647)
        recorderId = try GuestJSON.uuid(object["recorderId"])
        attemptId = try GuestJSON.string(object["attemptId"], maximum: 256)
        runId = try GuestJSON.string(object["runId"], maximum: 256)
        guard machineId == bootstrap.instanceId, epoch == bootstrap.epoch, guestPid == Int(getpid()) else { throw GuestFault("recording_identity_refused") }
    }
    var json: [String: Any] {
        ["machineId":machineId,"contextId":contextId,"generation":generation,"epoch":epoch,"guestPid":guestPid,"recorderId":recorderId,"attemptId":attemptId,"runId":runId]
    }
}

private final class GuestRecordingContent: @unchecked Sendable {
    let value: SCShareableContent?
    init(_ value: SCShareableContent?) { self.value = value }
}

private final class GuestRecordingAsset: @unchecked Sendable {
    let writer: AVAssetWriter
    init(_ writer: AVAssetWriter) { self.writer = writer }
}

private final class GuestVideoCapture: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
    let identity: GuestRecordingIdentity
    private let bootstrap: GuestBootstrap
    private let queue: DispatchQueue
    private let directory: URL
    private let video: URL
    private var stream: SCStream?
    private var writer: AVAssetWriter?
    private var input: AVAssetWriterInput?
    private var timer: DispatchSourceTimer?
    private var startReply: (@Sendable (GuestReply) -> Void)?
    private var stopReply: (@Sendable (GuestReply) -> Void)?
    private var started = false
    private var finalizing = false
    private var lastPTS: CMTime?
    private var firstPTS: CMTime?
    private var pendingFrame: CMSampleBuffer?
    private var stopPTS: CMTime?
    private var readyAt: Date?
    private var firstFrameAt: Date?
    private var lastCallback = guestNow()
    private var frameCount = 0
    private var width = 0
    private var height = 0
    private var displayId: CGDirectDisplayID?
    private var state = "starting"
    private var failure: String?
    private var captureState = "unknown"
    private var encoderState = "unknown"
    private var final: [String: Any]?
    private var finalHash: String?
    private var finalBytes = 0
    private let created = guestNow()
    private let maximumBytes = 1024 * 1024 * 1024
    private let maximumDuration = 600_000
    init(identity: GuestRecordingIdentity, bootstrap: GuestBootstrap, queue: DispatchQueue) throws {
        self.identity = identity; self.bootstrap = bootstrap; self.queue = queue
        let root = GuestFiles.status.appendingPathComponent("recordings", isDirectory: true)
        try GuestFiles.ensureDirectory(root)
        let context = root.appendingPathComponent(identity.contextId, isDirectory: true)
        try GuestFiles.ensureDirectory(context)
        directory = context.appendingPathComponent(identity.recorderId, isDirectory: true)
        try GuestFiles.ensureDirectory(directory, exclusive: true)
        video = directory.appendingPathComponent("video.mov")
        super.init()
        try persist()
    }
    private func persist() throws {
        try GuestFiles.atomic(directory.appendingPathComponent("status.json"), value: status)
    }
    private static func stamp(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }
    var status: [String: Any] {
        ["identity":identity.json,"state":state,"readyAt":readyAt.map(Self.stamp) as Any? ?? NSNull(),"firstFrameAt":firstFrameAt.map(Self.stamp) as Any? ?? NSNull(),"heartbeatAt":lastCallback,"frames":frameCount,"width":width,"height":height,"code":failure as Any? ?? NSNull(),"capture":captureState,"encoder":encoderState]
    }
    func assertHealthy() throws {
        try GuestFiles.requireGuestUser()
        guard CGPreflightScreenCaptureAccess(), let display = displayId, CGDisplayIsActive(display) != 0, CGDisplayIsAsleep(display) == 0 else { throw GuestFault("guest_capture_permission_or_display_lost", "Restore the owned guest's graphical login, awake display, and guest-only recording permission before a new attempt.") }
        guard state == "recording", failure == nil, stream != nil, writer?.status == .writing, frameCount > 0,
              guestNow() - lastCallback <= 5000, guestNow() - created < maximumDuration else { throw GuestFault("guest_recording_lost", "The guest recorder is not healthy; further browser mutations are blocked.") }
    }
    func start(deadline: Int, reply: @escaping @Sendable (GuestReply) -> Void) {
        startReply = reply
        let timer = DispatchSource.makeTimerSource(queue: queue); self.timer = timer
        timer.schedule(deadline: .now() + 1, repeating: 1)
        timer.setEventHandler { [weak self] in
            guard let self = self, self.state == "starting" || self.state == "recording" else { return }
            do {
                try self.bootstrap.current(); try GuestFiles.requireGuestUser()
                guard CGPreflightScreenCaptureAccess() else { throw GuestFault("guest_screen_recording_permission_required") }
                guard guestNow() - self.created < self.maximumDuration else { throw GuestFault("guest_recording_duration_limit") }
                if self.state == "starting", guestNow() >= deadline { throw GuestFault("guest_recording_first_frame_unknown") }
                if self.state == "recording", guestNow() - self.lastCallback > 5000 { throw GuestFault("guest_recording_stream_stalled") }
                var info = stat()
                if lstat(self.video.path, &info) == 0, info.st_size > self.maximumBytes { throw GuestFault("guest_recording_size_limit") }
                try self.persist()
            } catch let fault as GuestFault { self.fail(fault.code) }
            catch { self.fail("guest_recording_status_unknown") }
        }
        timer.resume()
        SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: false) { [weak self] content, error in
            let box = GuestRecordingContent(content)
            let failed = error != nil
            guard let self = self else { return }
            self.queue.async { [self] in
                guard self.state == "starting" else { return }
                do {
                    try self.bootstrap.current(); try GuestFiles.requireGuestUser()
                    guard !failed, let content = box.value else { throw GuestFault("guest_capture_display_unavailable", "Log in to the owned guest graphical desktop and grant Screen & System Audio Recording to QAutraGuestAgent inside that guest.") }
                    guard content.displays.count == 1, let display = content.displays.first,
                          CGDisplayIsActive(display.displayID) != 0, CGDisplayIsAsleep(display.displayID) == 0 else { throw GuestFault("guest_capture_single_active_display_required") }
                    let w = display.width; let h = display.height
                    guard w >= 2, h >= 2, w <= 4096, h <= 4096 else { throw GuestFault("guest_capture_display_size_unsupported") }
                    self.width = w - w % 2; self.height = h - h % 2
                    self.displayId = display.displayID
                    let writer = try AVAssetWriter(outputURL: self.video, fileType: .mov)
                    writer.movieFragmentInterval = CMTime(value: 2, timescale: 1)
                    let settings: [String: Any] = [AVVideoCodecKey:AVVideoCodecType.h264, AVVideoWidthKey:self.width, AVVideoHeightKey:self.height, AVVideoCompressionPropertiesKey:[AVVideoAverageBitRateKey:8_000_000, AVVideoMaxKeyFrameIntervalKey:30]]
                    let input = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
                    input.expectsMediaDataInRealTime = true
                    guard writer.canAdd(input) else { throw GuestFault("guest_video_encoder_unavailable") }
                    writer.add(input)
                    guard writer.startWriting() else { throw GuestFault("guest_video_writer_start_unknown") }
                    self.writer = writer; self.input = input
                    self.encoderState = "active"
                    let configuration = SCStreamConfiguration()
                    configuration.width = self.width; configuration.height = self.height
                    configuration.minimumFrameInterval = CMTime(value: 1, timescale: 30)
                    configuration.queueDepth = 6; configuration.pixelFormat = kCVPixelFormatType_32BGRA
                    configuration.showsCursor = true; configuration.capturesAudio = false
                    let filter = SCContentFilter(display: display, excludingWindows: [])
                    let stream = SCStream(filter: filter, configuration: configuration, delegate: self)
                    try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: self.queue)
                    self.stream = stream
                    self.captureState = "active"
                    stream.startCapture { [weak self] error in
                        guard let self = self else { return }
                        let failed = error != nil
                        self.queue.async { if failed { self.fail("guest_capture_start_unknown") } }
                    }
                } catch let fault as GuestFault { self.fail(fault.code, fault.message) }
                catch { self.fail("guest_capture_start_unknown") }
            }
        }
    }
    func stream(_ stream: SCStream, didStopWithError error: Error) {
        queue.async { if self.state != "finalized" { self.fail("guest_capture_stream_lost") } }
    }
    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, state == "starting" || state == "recording" else { return }
        guard CMSampleBufferIsValid(sampleBuffer),
              let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
              let raw = attachments.first?[.status] as? Int, let status = SCFrameStatus(rawValue: raw) else { fail("guest_capture_invalid_sample"); return }
        lastCallback = guestNow()
        if status == .idle { return }
        if status == .started && state == "starting" && (!CMSampleBufferDataIsReady(sampleBuffer) || CMSampleBufferGetImageBuffer(sampleBuffer) == nil) { return }
        guard status == .complete || (status == .started && state == "starting"), CMSampleBufferDataIsReady(sampleBuffer), let image = CMSampleBufferGetImageBuffer(sampleBuffer),
              CVPixelBufferGetWidth(image) == width, CVPixelBufferGetHeight(image) == height,
              let writer = writer, writer.status == .writing else { fail("guest_capture_incomplete_frame"); return }
        let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
        guard pts.isValid, !pts.isIndefinite, pts.seconds.isFinite, lastPTS.map({ CMTimeCompare(pts, $0) > 0 }) ?? true else { fail("guest_capture_timestamp_unknown"); return }
        if !started {
            writer.startSession(atSourceTime: pts); started = true; firstPTS = pts
            guard append(sampleBuffer, duration: CMTime(value: 1, timescale: 30)) else { return }
        } else {
            if let pending = pendingFrame {
                let duration = CMTimeSubtract(pts, CMSampleBufferGetPresentationTimeStamp(pending))
                guard append(pending, duration: duration) else { return }
            }
            pendingFrame = sampleBuffer
        }
        lastPTS = pts; frameCount += 1
        if state == "starting" {
            captureState = "active"
            let ready = Date(); readyAt = ready
            firstFrameAt = ready.addingTimeInterval(pts.seconds - CMClockGetTime(CMClockGetHostTimeClock()).seconds)
            state = "recording"
            do { try persist() }
            catch { fail("guest_capture_ready_persistence_unknown"); return }
            let reply = startReply; startReply = nil; reply?(.success(self.status))
        }
    }
    private func append(_ sample: CMSampleBuffer, duration: CMTime) -> Bool {
        guard let input = input, input.isReadyForMoreMediaData, duration.isValid, duration.seconds.isFinite, duration.seconds > 0 else { fail("guest_capture_encoder_backpressure"); return false }
        var timing = CMSampleTimingInfo(duration: duration, presentationTimeStamp: CMSampleBufferGetPresentationTimeStamp(sample), decodeTimeStamp: .invalid)
        var timed: CMSampleBuffer?
        guard CMSampleBufferCreateCopyWithNewTiming(allocator: kCFAllocatorDefault, sampleBuffer: sample, sampleTimingEntryCount: 1, sampleTimingArray: &timing, sampleBufferOut: &timed) == noErr,
              let timed = timed, input.append(timed) else { fail("guest_capture_write_unknown"); return false }
        return true
    }
    private func fail(_ code: String, _ message: String = "Guest recording failed after dispatch. Its capture/finalization outcome is unknown; do not retry this recorder.") {
        guard failure == nil else { return }
        failure = code; state = "failed"; timer?.cancel(); timer = nil
        try? persist()
        let start = startReply; startReply = nil
        let stop = stopReply; stopReply = nil
        start?(.failure(GuestFault(code, message), "unknown"))
        stop?(.failure(GuestFault(code, "Guest recording finalization is unknown; retain its ownership and spool."), "unknown"))
        if let stream = stream {
            captureState = "unknown"
            stream.stopCapture { [weak self] error in
                guard let self = self else { return }
                let stopped = error == nil
                self.queue.async {
                    if stopped { self.captureState = "stopped"; self.stream = nil }
                    self.preservePartialVideo()
                    try? self.persist()
                }
            }
        } else { preservePartialVideo() }
    }
    private func persistPartialFinal() {
        guard final == nil else { return }
        let result: [String: Any] = [
            "identity":identity.json, "state":"incomplete", "capture":captureState, "encoder":encoderState, "media":"partial",
            "readyAt":readyAt.map(Self.stamp) as Any? ?? NSNull(), "startedAt":firstFrameAt.map(Self.stamp) as Any? ?? NSNull(),
            "frames":frameCount, "width":width, "height":height, "code":failure as Any? ?? NSNull()
        ]
        try? GuestFiles.atomic(directory.appendingPathComponent("final.json"), value: result)
    }
    private func preservePartialVideo() {
        persistPartialFinal()
        guard started, !finalizing, let writer = writer, writer.status == .writing else { return }
        input?.markAsFinished()
        finalizing = true
        let box = GuestRecordingAsset(writer)
        writer.finishWriting { [weak self] in
            guard let self = self else { return }
            self.queue.async {
                self.encoderState = box.writer.status == .completed ? "finalized" : box.writer.status == .failed || box.writer.status == .cancelled ? "failed" : "unknown"
                self.persistPartialFinal()
                try? self.persist()
            }
        }
    }
    func halt() { fail("guest_recording_owner_revoked") }
    func stop(deadline: Int, reply: @escaping @Sendable (GuestReply) -> Void) {
        guard state == "recording", stopReply == nil, let stream = stream, writer?.status == .writing, input != nil,
              let lastPTS = lastPTS, frameCount >= 1 else { reply(.failure(GuestFault("guest_recording_stop_unconfirmed"), "unknown")); return }
        let ending = CMClockGetTime(CMClockGetHostTimeClock())
        guard CMTimeCompare(ending, lastPTS) > 0 else { reply(.failure(GuestFault("guest_recording_stop_time_unknown"), "unknown")); return }
        stopPTS = ending
        if let pending = pendingFrame {
            guard append(pending, duration: CMTimeSubtract(ending, CMSampleBufferGetPresentationTimeStamp(pending))) else { reply(.failure(GuestFault("guest_recording_last_frame_unknown"), "unknown")); return }
        }
        pendingFrame = nil
        state = "stopping"; stopReply = reply; timer?.cancel(); timer = nil
        do { try persist() } catch { fail("guest_recording_stop_persistence_unknown"); return }
        queue.asyncAfter(deadline: .now() + .milliseconds(max(1, deadline - guestNow()))) {
            if self.state == "stopping" { self.fail("guest_recording_finalize_timeout_unknown") }
        }
        stream.stopCapture { [weak self] error in
            guard let self = self else { return }
            let failed = error != nil
            self.queue.async { [self] in
                guard self.state == "stopping" else { return }
                guard !failed, let writer = self.writer, let input = self.input, writer.status == .writing else { self.fail("guest_capture_stop_unknown"); return }
                self.captureState = "stopped"
                self.stream = nil
                writer.endSession(atSourceTime: ending)
                input.markAsFinished()
                let box = GuestRecordingAsset(writer)
                self.finalizing = true
                writer.finishWriting { [weak self] in
                    guard let self = self else { return }
                    self.queue.async {
                        guard self.state == "stopping", box.writer.status == .completed else { self.fail("guest_video_finalize_unknown"); return }
                        self.encoderState = "finalized"
                        do {
                            guard guestNow() < deadline else { throw GuestFault("guest_video_finalize_deadline_unknown") }
                            let result = try self.validateVideo(deadline: deadline)
                            self.final = result; self.state = "finalized"
                            try GuestFiles.atomic(self.directory.appendingPathComponent("final.json"), value: result)
                            try self.persist()
                            let reply = self.stopReply; self.stopReply = nil; reply?(.success(result))
                        } catch let fault as GuestFault { self.fail(fault.code) }
                        catch { self.fail("guest_video_validation_unknown") }
                    }
                }
            }
        }
    }
    private func validateVideo(deadline: Int) throws -> [String: Any] {
        let fd = open(video.path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK)
        guard fd >= 0 else { throw GuestFault("guest_video_file_missing") }; defer { close(fd) }
        var before = stat()
        guard fstat(fd, &before) == 0, (before.st_mode & S_IFMT) == S_IFREG, before.st_uid == getuid(), before.st_nlink == 1,
              before.st_mode & 0o077 == 0, before.st_size > 0, before.st_size <= maximumBytes,
              let firstFrameAt = firstFrameAt, let readyAt = readyAt, let firstPTS = firstPTS, let stopPTS = stopPTS else { throw GuestFault("guest_video_file_unsafe") }
        guard fsync(fd) == 0 else { throw GuestFault("guest_video_sync_unknown") }
        var hash = SHA256(); var buffer = [UInt8](repeating: 0, count: 1024 * 1024); var total = 0
        while true {
            guard guestNow() < deadline else { throw GuestFault("guest_video_hash_deadline_unknown") }
            let count = Darwin.read(fd, &buffer, buffer.count)
            if count < 0 && errno == EINTR { continue }
            guard count >= 0 else { throw GuestFault("guest_video_hash_unknown") }
            if count == 0 { break }
            total += count; guard total <= before.st_size else { throw GuestFault("guest_video_changed") }
            buffer.withUnsafeBytes { bytes in hash.update(bufferPointer: UnsafeRawBufferPointer(rebasing: bytes[..<count])) }
        }
        var after = stat()
        guard fstat(fd, &after) == 0, total == before.st_size, after.st_size == before.st_size, after.st_ino == before.st_ino,
              after.st_mtimespec.tv_sec == before.st_mtimespec.tv_sec, after.st_mtimespec.tv_nsec == before.st_mtimespec.tv_nsec else { throw GuestFault("guest_video_changed") }
        let digest = guestHex(Data(hash.finalize())); finalHash = digest; finalBytes = total
        let capturedDuration = stopPTS.seconds - firstPTS.seconds
        guard capturedDuration.isFinite, capturedDuration > 0, capturedDuration <= Double(maximumDuration) / 1000 + 1 else { throw GuestFault("guest_video_duration_invalid") }
        var media = "valid"; var code: String?
        do {
            let asset = AVURLAsset(url: video)
            let tracks = asset.tracks(withMediaType: .video)
            guard asset.isPlayable, tracks.count == 1, let track = tracks.first,
                  Int(track.naturalSize.width) == width, Int(track.naturalSize.height) == height else { throw GuestFault("guest_video_track_invalid") }
            let duration = asset.duration.seconds
            guard duration.isFinite, duration > 0, abs(duration - capturedDuration) <= 0.25 else { throw GuestFault("guest_video_duration_invalid") }
            let reader = try AVAssetReader(asset: asset)
            let output = AVAssetReaderTrackOutput(track: track, outputSettings: [kCVPixelBufferPixelFormatTypeKey as String:kCVPixelFormatType_32BGRA])
            output.alwaysCopiesSampleData = false
            guard reader.canAdd(output) else { throw GuestFault("guest_video_decoder_unavailable") }
            reader.add(output)
            guard reader.startReading() else { throw GuestFault("guest_video_decode_failed") }
            var decoded = 0; var previous: CMTime?
            while let sample = output.copyNextSampleBuffer() {
                guard guestNow() < deadline else { reader.cancelReading(); throw GuestFault("guest_video_validation_deadline_unknown") }
                guard CMSampleBufferIsValid(sample), let image = CMSampleBufferGetImageBuffer(sample), CVPixelBufferGetWidth(image) == width, CVPixelBufferGetHeight(image) == height else { reader.cancelReading(); throw GuestFault("guest_video_decoded_frame_invalid") }
                let pts = CMSampleBufferGetPresentationTimeStamp(sample)
                guard pts.isValid, pts.seconds.isFinite, previous.map({ CMTimeCompare(pts, $0) > 0 }) ?? true else { reader.cancelReading(); throw GuestFault("guest_video_decoded_timestamp_invalid") }
                previous = pts; decoded += 1
                guard decoded <= frameCount else { reader.cancelReading(); throw GuestFault("guest_video_frame_count_invalid") }
            }
            guard reader.status == .completed, decoded == frameCount, decoded >= 1 else { throw GuestFault("guest_video_decode_incomplete") }
        } catch let fault as GuestFault { media = "invalid"; code = fault.code }
        catch { media = "invalid"; code = "guest_video_decode_failed" }
        var boundary = stat(); var named = stat()
        guard fstat(fd, &boundary) == 0, lstat(video.path, &named) == 0, boundary.st_ino == before.st_ino, boundary.st_size == before.st_size,
              boundary.st_mtimespec.tv_sec == before.st_mtimespec.tv_sec, boundary.st_mtimespec.tv_nsec == before.st_mtimespec.tv_nsec,
              named.st_ino == boundary.st_ino, named.st_dev == boundary.st_dev, named.st_nlink == 1, (named.st_mode & S_IFMT) == S_IFREG else { throw GuestFault("guest_video_file_boundary_changed") }
        let endedAt = firstFrameAt.addingTimeInterval(capturedDuration)
        return ["identity":identity.json,"state":"finalized","readyAt":Self.stamp(readyAt),"startedAt":Self.stamp(firstFrameAt),"endedAt":Self.stamp(endedAt),"sha256":digest,"bytes":total,"durationSeconds":capturedDuration,"frames":frameCount,"width":width,"height":height,"media":media,"code":code as Any? ?? NSNull()]
    }
    func read(offset: Int, length: Int) throws -> Any {
        guard state == "finalized", final != nil, offset <= finalBytes, length <= min(256 * 1024, finalBytes - offset) else { throw GuestFault("guest_video_read_range") }
        let fd = open(video.path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK)
        guard fd >= 0 else { throw GuestFault("guest_video_file_missing") }; defer { close(fd) }
        var info = stat()
        guard fstat(fd, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG, info.st_uid == getuid(), info.st_nlink == 1, info.st_size == finalBytes, info.st_mode & 0o077 == 0 else { throw GuestFault("guest_video_file_unsafe") }
        var data = Data(count: length)
        try data.withUnsafeMutableBytes { (bytes: UnsafeMutableRawBufferPointer) in
            var copied = 0
            while copied < length {
                let count = pread(fd, bytes.baseAddress!.advanced(by: copied), length - copied, off_t(offset + copied))
                if count < 0 && errno == EINTR { continue }
                guard count > 0 else { throw GuestFault("guest_video_read_incomplete") }; copied += count
            }
        }
        return ["identity":identity.json,"offset":offset,"data":data.base64EncodedString()]
    }
    func release(hash: String) throws -> Any {
        guard state == "finalized", finalHash == hash else { throw GuestFault("guest_video_release_refused") }
        try FileManager.default.removeItem(at: video)
        try GuestFiles.atomic(directory.appendingPathComponent("recovered.json"), value: ["identity":identity.json,"sha256":hash,"recoveredAt":Self.stamp(Date())])
        return ["identity":identity.json,"released":true]
    }
}

final class GuestRecordingOwner: @unchecked Sendable {
    private let bootstrap: GuestBootstrap
    private let queue: DispatchQueue
    private var capture: GuestVideoCapture?
    init(bootstrap: GuestBootstrap, queue: DispatchQueue) { self.bootstrap = bootstrap; self.queue = queue }
    func assertBrowserDispatch() throws {
        if let capture = capture { try capture.assertHealthy() }
    }
    func assertRuntimeIdentity(_ identity: GuestRecordingIdentity) throws {
        guard let capture = capture, capture.identity == identity else { throw GuestFault("guest_runtime_recorder_not_owned") }
    }
    func halt() { capture?.halt() }
    func handle(_ request: GuestRequest) {
        var mutated = false
        do {
            let p = request.payload
            let action = try GuestJSON.string(p["action"], maximum: 16)
            let extra: Set<String> = action == "read" ? ["offset","length"] : action == "release" ? ["sha256"] : []
            try GuestJSON.keys(p, required: Set(["action","identity"]).union(extra))
            let identity = try GuestRecordingIdentity(GuestJSON.object(p["identity"] as Any), bootstrap: bootstrap)
            try bootstrap.current()
            guard request.deadline > guestNow() else { throw GuestFault("guest_recording_deadline") }
            if action == "start" {
                guard capture == nil else { throw GuestFault("guest_display_recorder_already_owned") }
                try GuestFiles.requireGuest()
                guard CGPreflightScreenCaptureAccess() else { throw GuestFault("guest_screen_recording_permission_required", "Inside the owned macOS guest, enable Screen & System Audio Recording for the installed QAutraGuestAgent in System Settings > Privacy & Security. Log in to the guest desktop and restart its prepared agent as instructed. No host capture permission or fallback is used.") }
                mutated = true
                let next = try GuestVideoCapture(identity: identity, bootstrap: bootstrap, queue: queue); capture = next
                next.start(deadline: request.deadline, reply: request.reply); return
            }
            guard let capture = capture, capture.identity == identity else { throw GuestFault("guest_recorder_not_owned") }
            switch action {
            case "status": request.reply(.success(capture.status))
            case "stop": capture.stop(deadline: request.deadline, reply: request.reply)
            case "read":
                let offset = try GuestJSON.integer(p["offset"], maximum: 1024 * 1024 * 1024)
                let length = try GuestJSON.integer(p["length"], minimum: 1, maximum: 256 * 1024)
                request.reply(.success(try capture.read(offset: offset, length: length)))
            case "release":
                let hash = try GuestJSON.string(p["sha256"], maximum: 64)
                mutated = true
                let result = try capture.release(hash: hash); self.capture = nil
                request.reply(.success(result))
            default: throw GuestFault("guest_recording_action_refused")
            }
        } catch let fault as GuestFault {
            let reported = fault.code == "guest_gui_login_required" ? GuestFault(fault.code, "Log in to the owned guest graphical desktop as the installed agent user, unlock and wake its display, then prepare the guest again. Host GUI or capture is not a fallback.") : fault
            request.reply(.failure(reported, mutated ? "unknown" : "not_started"))
        }
        catch { request.reply(.failure(GuestFault("guest_recording_operation_unknown"), mutated ? "unknown" : "not_started")) }
    }
}
