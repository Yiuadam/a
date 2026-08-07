import AVFoundation
import Foundation

/*
  Captures the microphone as the 16 kHz mono float samples whisper.cpp wants.

  The tap is installed on the input node's own format, whatever the hardware
  offers, and converted on the way into the buffer. Resampling here rather than
  asking the engine for 16 kHz avoids the case where the hardware cannot supply
  that rate and the engine silently fails to start.

  Nothing is written to disk: the samples live in an array that is handed to the
  transcriber and then dropped. That is what lets the privacy page say the audio
  never leaves the device.
*/
final class AudioRecorder {
    enum RecorderError: Error {
        case converterUnavailable
        case sessionFailed(Error)
    }

    private let engine = AVAudioEngine()
    private let target = AVAudioFormat(commonFormat: .pcmFormatFloat32,
                                       sampleRate: 16_000,
                                       channels: 1,
                                       interleaved: false)!
    private var converter: AVAudioConverter?
    private var samples: [Float] = []
    private let lock = NSLock()

    var isRecording: Bool { engine.isRunning }

    func start() throws {
        let session = AVAudioSession.sharedInstance()
        do {
            // .measurement leaves the signal alone; the voice-processing modes
            // colour it in ways that cost accuracy on quiet or accented speech.
            try session.setCategory(.record, mode: .measurement, options: [.duckOthers])
            try session.setActive(true, options: .notifyOthersOnDeactivation)
        } catch {
            throw RecorderError.sessionFailed(error)
        }

        let input = engine.inputNode
        let inputFormat = input.outputFormat(forBus: 0)
        guard let converter = AVAudioConverter(from: inputFormat, to: target) else {
            throw RecorderError.converterUnavailable
        }
        self.converter = converter

        lock.lock()
        samples.removeAll(keepingCapacity: true)
        lock.unlock()

        input.installTap(onBus: 0, bufferSize: 4096, format: inputFormat) { [weak self] buffer, _ in
            self?.append(buffer, using: converter)
        }

        engine.prepare()
        try engine.start()
    }

    /// Stop capturing and hand over everything heard, in whisper's format.
    func stop() -> [Float] {
        guard engine.isRunning else { return [] }
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        converter = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)

        lock.lock()
        let captured = samples
        samples.removeAll(keepingCapacity: false)
        lock.unlock()
        return captured
    }

    /// Abandon the answer: keep nothing.
    func cancel() {
        _ = stop()
    }

    private func append(_ buffer: AVAudioPCMBuffer, using converter: AVAudioConverter) {
        let ratio = target.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 1024
        guard let converted = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else { return }

        var supplied = false
        var error: NSError?
        converter.convert(to: converted, error: &error) { _, status in
            if supplied {
                status.pointee = .noDataNow
                return nil
            }
            supplied = true
            status.pointee = .haveData
            return buffer
        }
        guard error == nil, let channel = converted.floatChannelData?[0] else { return }

        let frames = Int(converted.frameLength)
        guard frames > 0 else { return }
        lock.lock()
        samples.append(contentsOf: UnsafeBufferPointer(start: channel, count: frames))
        lock.unlock()
    }
}
