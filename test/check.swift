// Decodes every frame of an MP4 with AVFoundation (what iPhone Photos uses) and prints a summary.
// Usage: swift test/check.swift file.mp4 [...]
import AVFoundation

func check(_ path: String) async {
  let asset = AVURLAsset(url: URL(fileURLWithPath: path))
  do {
    let dur = try await asset.load(.duration)
    let playable = try await asset.load(.isPlayable)
    var line = "\((path as NSString).lastPathComponent): \(String(format: "%.2f", dur.seconds))s playable=\(playable)"
    let reader = try AVAssetReader(asset: asset)
    var outs: [(String, AVAssetReaderTrackOutput)] = []
    for t in try await asset.load(.tracks) {
      let tr = try await t.load(.timeRange)
      if t.mediaType == .video {
        let size = try await t.load(.naturalSize)
        line += " | video \(Int(size.width))x\(Int(size.height)) \(String(format: "%.2f", tr.duration.seconds))s"
        let o = AVAssetReaderTrackOutput(track: t, outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA])
        reader.add(o); outs.append(("video", o))
      } else if t.mediaType == .audio {
        line += " | audio \(String(format: "%.2f", tr.duration.seconds))s"
        let o = AVAssetReaderTrackOutput(track: t, outputSettings: [AVFormatIDKey: kAudioFormatLinearPCM])
        reader.add(o); outs.append(("audio", o))
      }
    }
    guard reader.startReading() else { print(line, "| READ FAILED", reader.error as Any); return }
    for (kind, o) in outs {
      var n = 0, last = CMTime.zero
      while let sb = o.copyNextSampleBuffer() {
        n += kind == "video" ? 1 : CMSampleBufferGetNumSamples(sb)
        last = CMSampleBufferGetPresentationTimeStamp(sb)
      }
      line += " | \(kind) decoded \(n) (last pts \(String(format: "%.2f", last.seconds)))"
    }
    line += reader.status == .completed ? " | OK" : " | STATUS \(reader.status.rawValue) \(String(describing: reader.error))"
    print(line)
  } catch { print(path, "ERROR", error) }
}

for p in CommandLine.arguments.dropFirst() { await check(p) }
