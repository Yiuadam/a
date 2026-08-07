import Foundation
import whisper

/*
  The whisper.cpp context, and the only place that talks to C.

  It is an actor because the context is not thread-safe and a transcription must
  not overlap the next one. Loading is expensive — the weights are read into
  memory once and kept for the whole interview, which is why the plugin exposes
  `prepare` separately from `start`.
*/
actor WhisperContext {
    enum WhisperError: Error {
        case modelLoadFailed(String)
        case transcriptionFailed(Int32)
    }

    private var context: OpaquePointer?

    init(modelPath: String) throws {
        var params = whisper_context_default_params()
        // Core ML / Metal encoders are an optimisation, not a requirement, and
        // they need their own converted model alongside the ggml one. CPU is
        // the honest default until that is built and measured on a device.
        params.use_gpu = false
        guard let context = whisper_init_from_file_with_params(modelPath, params) else {
            throw WhisperError.modelLoadFailed(modelPath)
        }
        self.context = context
    }

    deinit {
        if let context { whisper_free(context) }
    }

    /// Transcribe 16 kHz mono samples. `onProgress` receives 0–100.
    func transcribe(samples: [Float], onProgress: @escaping (Int) -> Void) throws -> String {
        guard let context else { throw WhisperError.modelLoadFailed("context released") }
        guard !samples.isEmpty else { return "" }

        var params = whisper_full_default_params(WHISPER_SAMPLING_GREEDY)
        // `params.language` holds the pointer, not the string, so it has to
        // outlive this call — `withCString` would hand over a dangling one.
        let language = strdup("en")
        defer { free(language) }
        params.language = UnsafePointer(language)
        params.translate = false
        params.print_realtime = false
        params.print_progress = false
        params.print_timestamps = false
        params.no_timestamps = true
        // Whisper transcribes silence into hallucinated filler; suppressing the
        // non-speech tokens is the same defence the web path applies in
        // cleanTranscript().
        params.suppress_nst = true
        params.n_threads = Int32(max(1, min(6, ProcessInfo.processInfo.activeProcessorCount - 1)))

        let progress = ProgressBox(onProgress)
        params.progress_callback_user_data = Unmanaged.passUnretained(progress).toOpaque()
        params.progress_callback = { _, _, value, userData in
            guard let userData else { return }
            let box = Unmanaged<ProgressBox>.fromOpaque(userData).takeUnretainedValue()
            box.report(Int(value))
        }

        let status = samples.withUnsafeBufferPointer { buffer in
            whisper_full(context, params, buffer.baseAddress, Int32(buffer.count))
        }
        guard status == 0 else { throw WhisperError.transcriptionFailed(status) }

        var text = ""
        for index in 0..<whisper_full_n_segments(context) {
            if let segment = whisper_full_get_segment_text(context, index) {
                text += String(cString: segment)
            }
        }
        return text.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

/// A reference the C progress callback can carry across as a raw pointer.
private final class ProgressBox {
    private let handler: (Int) -> Void
    init(_ handler: @escaping (Int) -> Void) { self.handler = handler }
    func report(_ percent: Int) { handler(percent) }
}
