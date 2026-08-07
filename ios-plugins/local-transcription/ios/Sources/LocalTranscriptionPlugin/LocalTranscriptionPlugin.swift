import AVFoundation
import Capacitor
import Foundation

/*
  The Capacitor half: the methods lib/transcribe.ts calls.

  The shape deliberately matches the web path — prepare, start, stop, cancel,
  and a `progress` event — so the TypeScript above it does not care which
  platform it is running on. Audio stays inside this plugin: the JS side only
  ever receives text.
*/
@objc(LocalTranscriptionPlugin)
public class LocalTranscriptionPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "LocalTranscriptionPlugin"
    public let jsName = "LocalTranscription"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isAvailable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestPermissions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "prepare", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancel", returnType: CAPPluginReturnPromise)
    ]

    private let recorder = AudioRecorder()
    private var requestedModel = "base.en"
    private var loadedModel: String?
    // One load at a time, shared by whoever needs the context. `start` kicks it
    // off and `stop` awaits the same task rather than starting a second one.
    private var loadTask: Task<WhisperContext, Error>?

    @objc func isAvailable(_ call: CAPPluginCall) {
        // The plugin being present is what "available" means: the weights are
        // fetched on demand, so a missing download is not unavailability.
        call.resolve(["available": true, "model": loadedModel ?? ""])
    }

    @objc func requestPermissions(_ call: CAPPluginCall) {
        let granted: (Bool) -> Void = { allowed in
            call.resolve(["microphone": allowed ? "granted" : "denied"])
        }
        if #available(iOS 17.0, *) {
            AVAudioApplication.requestRecordPermission(completionHandler: granted)
        } else {
            AVAudioSession.sharedInstance().requestRecordPermission(granted)
        }
    }

    @objc func prepare(_ call: CAPPluginCall) {
        select(call.getString("model") ?? "base.en")
        Task {
            do {
                _ = try await context()
                call.resolve()
            } catch {
                call.reject("Could not load the speech model: \(error.localizedDescription)")
            }
        }
    }

    @objc func start(_ call: CAPPluginCall) {
        select(call.getString("model") ?? "base.en")
        do {
            try recorder.start()
        } catch {
            call.reject("Could not start recording: \(error.localizedDescription)")
            return
        }
        // Recording is already running; the weights can finish loading while
        // the candidate is still talking.
        Task { _ = try? await context() }
        call.resolve()
    }

    @objc func stop(_ call: CAPPluginCall) {
        let samples = recorder.stop()
        Task {
            do {
                let whisper = try await context()
                let text = try await whisper.transcribe(samples: samples) { [weak self] percent in
                    self?.notifyListeners("progress", data: ["percent": percent])
                }
                call.resolve(["text": text])
            } catch {
                call.reject("Could not transcribe: \(error.localizedDescription)")
            }
        }
    }

    @objc func cancel(_ call: CAPPluginCall) {
        recorder.cancel()
        call.resolve()
    }

    private func select(_ model: String) {
        guard model != requestedModel else { return }
        requestedModel = model
        // A different size was asked for: drop the load in flight rather than
        // transcribe with weights nobody chose.
        loadTask?.cancel()
        loadTask = nil
        loadedModel = nil
    }

    private func context() async throws -> WhisperContext {
        if let loadTask { return try await loadTask.value }
        let model = requestedModel
        let task = Task { () -> WhisperContext in
            let path = try await ModelStore.resolve(model)
            return try WhisperContext(modelPath: path.path)
        }
        loadTask = task
        do {
            let context = try await task.value
            loadedModel = model
            return context
        } catch {
            loadTask = nil
            throw error
        }
    }
}
