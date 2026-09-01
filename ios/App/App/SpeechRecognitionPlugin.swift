import AVFoundation
import Capacitor
import Speech

/*
  The native half of `@capacitor-community/speech-recognition` never actually
  ships: the package's `ios/Plugin/Plugin.swift` has no `Package.swift` of its
  own, so Capacitor's SPM build silently drops it — there is no entry for it
  in CapApp-SPM/Package.swift — and CocoaPods, the usual fallback, cannot run
  on this machine's Ruby. The package's JS half is fine and already calls
  `registerPlugin('SpeechRecognition', ...)`; all that is missing is
  something registered under that same name. NativeChromePlugin already
  relies on the same trick for a different plugin: an app-target class with
  the right `jsName` satisfies `Capacitor.Plugins.SpeechRecognition` exactly
  as if the pod had built, so this is App-target source rather than a
  dependency, and the community package stays installed for its JS half only.

  The method and event shapes below are the community package's own — see its
  `dist/esm/definitions.d.ts` — not invented here, because lib/speech.ts and
  SpeakingSession are already written against that contract.
*/
@objc(SpeechRecognitionPlugin)
public class SpeechRecognitionPlugin: CAPPlugin, CAPBridgedPlugin {
  public let identifier = "SpeechRecognitionPlugin"
  public let jsName = "SpeechRecognition"
  public let pluginMethods: [CAPPluginMethod] = [
    CAPPluginMethod(name: "available", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "isListening", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "getSupportedLanguages", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "checkPermissions", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "requestPermissions", returnType: CAPPluginReturnPromise)
  ]

  private let defaultMaxResults = 5

  // The engine and its tap live for as long as the plugin does, not for one
  // answer: recreating them on every question would mean a fresh hardware
  // start/stop click on every turn of the interview. Only the recognizer, its
  // request and its task change per answer, and — see beginSegment below —
  // sometimes several times within a single answer.
  private let audioEngine = AVAudioEngine()
  private var speechRecognizer: SFSpeechRecognizer?
  private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
  private var recognitionTask: SFSpeechRecognitionTask?

  private var listening = false
  private var wantsPartialResults = false
  private var maxResults = 5
  // Only occupied when the caller asked for a single non-streaming result:
  // the call that start() has not resolved yet, because it is waiting on
  // Apple's own final transcription rather than on us.
  private var pendingStartCall: CAPPluginCall?

  // What the segments that have already ended contributed, and what the
  // segment still in flight has produced so far. Kept apart rather than
  // appended immediately because combinedTranscript() below needs to replace
  // the second half on every event without disturbing the first.
  private var accumulatedTranscript = ""
  private var currentSegmentText = ""

  /*
    How many segments in a row have ended in an error without producing a
    word. A segment that ends is ordinary — Apple closes one every minute or
    so and beginSegment simply opens another. A segment that ends *in error*
    having heard nothing is not: the recogniser has become unavailable, the
    permission was revoked from Settings while we were listening, or the
    device lost the network a server-side locale needs. Restarting on that
    unconditionally spins as fast as the failures arrive, holding the audio
    session open and telling the app nothing, so it is counted instead and
    the session is ended once the failures stop looking like a blip.
  */
  private var consecutiveFailedSegments = 0
  private static let maxConsecutiveFailedSegments = 3

  deinit {
    recognitionTask?.cancel()
    audioEngine.inputNode.removeTap(onBus: 0)
    if audioEngine.isRunning {
      audioEngine.stop()
    }
    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
  }

  // MARK: - Plugin methods

  @objc func available(_ call: CAPPluginCall) {
    call.resolve(["available": SFSpeechRecognizer() != nil])
  }

  @objc func start(_ call: CAPPluginCall) {
    DispatchQueue.main.async { [weak self] in
      self?.beginListening(call)
    }
  }

  @objc func stop(_ call: CAPPluginCall) {
    DispatchQueue.main.async { [weak self] in
      self?.teardown()
      call.resolve()
    }
  }

  @objc func isListening(_ call: CAPPluginCall) {
    DispatchQueue.main.async { [weak self] in
      call.resolve(["listening": self?.listening ?? false])
    }
  }

  @objc func getSupportedLanguages(_ call: CAPPluginCall) {
    let languages = SFSpeechRecognizer.supportedLocales().map { $0.identifier }
    call.resolve(["languages": languages])
  }

  @objc override public func checkPermissions(_ call: CAPPluginCall) {
    call.resolve(["speechRecognition": combinedPermissionState()])
  }

  @objc override public func requestPermissions(_ call: CAPPluginCall) {
    // Speech authorization is what allows audio to become text at all, and
    // the microphone permission is what allows this plugin to receive any
    // audio in the first place — both are real gates on the feature, so both
    // are requested here, and either one being refused reads as the whole
    // feature being refused.
    SFSpeechRecognizer.requestAuthorization { [weak self] _ in
      AVAudioSession.sharedInstance().requestRecordPermission { _ in
        DispatchQueue.main.async {
          call.resolve(["speechRecognition": self?.combinedPermissionState() ?? "denied"])
        }
      }
    }
  }

  // MARK: - Permissions

  private func combinedPermissionState() -> String {
    let speech = SFSpeechRecognizer.authorizationStatus()
    let microphone = AVAudioSession.sharedInstance().recordPermission
    if speech == .denied || speech == .restricted || microphone == .denied {
      return "denied"
    }
    if speech == .authorized && microphone == .granted {
      return "granted"
    }
    return "prompt"
  }

  // MARK: - Listening session

  private func beginListening(_ call: CAPPluginCall) {
    guard !listening else {
      call.reject("Speech recognition is already listening.")
      return
    }
    guard SFSpeechRecognizer.authorizationStatus() == .authorized else {
      call.reject("Speech recognition permission has not been granted.")
      return
    }
    guard AVAudioSession.sharedInstance().recordPermission == .granted else {
      call.reject("Microphone permission has not been granted.")
      return
    }

    let language = call.getString("language") ?? "en-GB"
    guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: language)), recognizer.isAvailable else {
      call.reject("Speech recognition is not available for \(language) on this device.")
      return
    }

    let session = AVAudioSession.sharedInstance()
    do {
      /*
        .playAndRecord rather than a plain .record. Every prompt the
        candidate hears — the examiner's question, a replay, the next
        question — plays through an ordinary <audio> element in the web
        view, which shares this same process-wide session; nothing here
        ever plays audio through it directly. .record has no output route
        at all, so the moment this plugin used it even once, the *next*
        <audio>.play() anywhere in the app — not only while this plugin is
        listening, but for the rest of the process — would go silent.
        .defaultToSpeaker is what keeps that later playback on the
        loudspeaker rather than the earpiece a plain .playAndRecord session
        would otherwise default to.
      */
      try session.setCategory(.playAndRecord, mode: .measurement, options: [.duckOthers, .defaultToSpeaker])
      try session.setActive(true, options: .notifyOthersOnDeactivation)
    } catch {
      call.reject("Could not configure the audio session.", nil, error)
      return
    }

    speechRecognizer = recognizer
    wantsPartialResults = call.getBool("partialResults") ?? false
    maxResults = call.getInt("maxResults") ?? defaultMaxResults
    pendingStartCall = wantsPartialResults ? nil : call
    accumulatedTranscript = ""
    currentSegmentText = ""
    consecutiveFailedSegments = 0

    let inputNode = audioEngine.inputNode
    // The node's own format, not a hardcoded sample rate — asking for
    // anything else is the classic way to make installTap throw on real
    // hardware, where the microphone's native rate is whatever it is.
    let recordingFormat = inputNode.outputFormat(forBus: 0)
    inputNode.removeTap(onBus: 0)
    inputNode.installTap(onBus: 0, bufferSize: 1024, format: recordingFormat) { [weak self] buffer, _ in
      self?.recognitionRequest?.append(buffer)
    }

    audioEngine.prepare()
    do {
      try audioEngine.start()
    } catch {
      inputNode.removeTap(onBus: 0)
      try? session.setActive(false, options: .notifyOthersOnDeactivation)
      pendingStartCall = nil
      call.reject("Could not start the audio engine.", nil, error)
      return
    }

    listening = true
    beginSegment()
    notifyListeners("listeningState", data: ["status": "started"])

    // Per the package's contract, a partial-results caller gets this promise
    // back immediately and reads everything else off the partialResults
    // event; a caller that asked for one non-streaming answer instead keeps
    // this call open in pendingStartCall until a result actually finishes.
    if wantsPartialResults {
      call.resolve()
    }
  }

  /*
    One SFSpeechRecognitionTask covers one segment of an answer, not the
    whole thing. Apple ends a task on its own well before an IELTS answer is
    finished — the exact limit is undocumented and has moved between OS
    versions, but a minute or so is typical, and a full Part 2 answer runs
    60 to 120 seconds. handleResult treats that ending the same way it
    treats a recoverable error: fold what this segment produced into
    accumulatedTranscript and open a fresh request. The engine and its tap
    are untouched by any of this, so the microphone never closes and there
    is no gap for a word to be lost in.
  */
  private func beginSegment() {
    guard let speechRecognizer else { return }
    recognitionTask?.cancel()
    currentSegmentText = ""

    let request = SFSpeechAudioBufferRecognitionRequest()
    request.shouldReportPartialResults = wantsPartialResults
    recognitionRequest = request
    recognitionTask = speechRecognizer.recognitionTask(with: request) { [weak self] result, error in
      self?.handleResult(result, error)
    }
  }

  private func handleResult(_ result: SFSpeechRecognitionResult?, _ error: Error?) {
    // Apple does not promise this callback lands on the main thread, and
    // every property it touches here is otherwise only touched from methods
    // already dispatched onto it.
    DispatchQueue.main.async { [weak self] in
      guard let self, self.listening else { return }

      if let result {
        // The recogniser reports the whole segment heard so far on every
        // callback, not a delta, so the caller is meant to replace rather
        // than append — see combinedTranscript(), which does the same
        // thing across the segment boundary this restarts.
        self.currentSegmentText = result.bestTranscription.formattedString
        if self.wantsPartialResults {
          self.notifyListeners("partialResults", data: ["matches": [self.combinedTranscript()]])
        }
      }

      guard (result?.isFinal ?? false) || error != nil else { return }

      if !self.wantsPartialResults {
        self.finishNonStreamingCall(result: result, error: error)
        self.teardown()
        return
      }

      /* A segment that produced text is evidence the recogniser is alive,
         whatever it ended with, so the count only rises on a silent failure
         and any word at all clears it. */
      if error != nil && self.currentSegmentText.isEmpty {
        self.consecutiveFailedSegments += 1
      } else {
        self.consecutiveFailedSegments = 0
      }

      self.accumulatedTranscript = self.combinedTranscript()
      self.currentSegmentText = ""

      if self.consecutiveFailedSegments >= SpeechRecognitionPlugin.maxConsecutiveFailedSegments {
        /* Stop rather than keep trying. The app hears this as the recogniser
           having stopped, which is what has actually happened, and can offer
           the learner the retry — a decision that belongs to the UI and not
           to a loop down here. */
        self.teardown()
        self.notifyListeners("listeningState", data: ["status": "stopped"])
        return
      }

      self.beginSegment()
    }
  }

  private func finishNonStreamingCall(result: SFSpeechRecognitionResult?, error: Error?) {
    guard let call = pendingStartCall else { return }
    pendingStartCall = nil
    if let error {
      call.reject(error.localizedDescription)
      return
    }
    guard let result else {
      call.reject("Speech recognition ended without a result.")
      return
    }
    let matches = Array(result.transcriptions.prefix(maxResults).map { $0.formattedString })
    call.resolve(["matches": matches])
  }

  /// Everything the segments that have already ended produced, plus whatever
  /// the segment currently in flight has produced so far — the single string
  /// the app is meant to treat as the whole answer up to this point.
  private func combinedTranscript() -> String {
    if accumulatedTranscript.isEmpty { return currentSegmentText }
    if currentSegmentText.isEmpty { return accumulatedTranscript }
    return "\(accumulatedTranscript) \(currentSegmentText)"
  }

  /// Mirrors stop(): tears down the task, request, tap, engine and session,
  /// and — if a listen was actually in progress — tells the JS side so. Safe
  /// to call more than once; a second call finds nothing left to do.
  private func teardown() {
    let wasListening = listening
    listening = false

    recognitionTask?.cancel()
    recognitionTask = nil
    recognitionRequest = nil

    audioEngine.inputNode.removeTap(onBus: 0)
    if audioEngine.isRunning {
      audioEngine.stop()
    }
    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)

    accumulatedTranscript = ""
    currentSegmentText = ""

    if let pendingStartCall {
      self.pendingStartCall = nil
      pendingStartCall.reject("Speech recognition was stopped before it produced a result.")
    }

    if wasListening {
      notifyListeners("listeningState", data: ["status": "stopped"])
    }
  }
}
