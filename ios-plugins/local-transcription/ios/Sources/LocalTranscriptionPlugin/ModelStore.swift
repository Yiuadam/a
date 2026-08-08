import Foundation

/*
  Where the ggml weights come from on iOS.

  Two sources, in order: the app bundle, if a build chose to ship the file, and
  otherwise a one-off download into Application Support. Downloading keeps the
  App Store binary small — 145 MB of weights inside the .ipa is a large price
  for every user, including those who never open the speaking test — at the
  cost of a wait the first time, which is exactly the trade the web path makes.

  The download is marked as excluded from iCloud backup: it is a public file
  that can always be fetched again, and backing it up would cost the user their
  iCloud quota for nothing.
*/
enum ModelStore {
    enum ModelError: Error {
        case unknownModel(String)
        case downloadFailed(Int)
    }

    /// The same two options the web offers, named the same way.
    static let files: [String: String] = [
        "base.en": "ggml-base.en.bin",
        "tiny.en": "ggml-tiny.en.bin"
    ]

    static let hosts = [
        "https://huggingface.co/ggerganov/whisper.cpp/resolve/main",
        "https://huggingface.co/ggml-org/whisper.cpp/resolve/main"
    ]

    static func bundled(_ model: String) -> URL? {
        guard let file = files[model] else { return nil }
        let name = (file as NSString).deletingPathExtension
        return Bundle.main.url(forResource: name, withExtension: "bin")
    }

    static func cached(_ model: String) throws -> URL {
        guard let file = files[model] else { throw ModelError.unknownModel(model) }
        let support = try FileManager.default.url(for: .applicationSupportDirectory,
                                                  in: .userDomainMask,
                                                  appropriateFor: nil,
                                                  create: true)
        let directory = support.appendingPathComponent("whisper", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory.appendingPathComponent(file)
    }

    /// The path to usable weights, downloading them if this is the first time.
    static func resolve(_ model: String) async throws -> URL {
        if let bundled = bundled(model) { return bundled }

        let destination = try cached(model)
        if FileManager.default.fileExists(atPath: destination.path) { return destination }

        guard let file = files[model] else { throw ModelError.unknownModel(model) }
        var lastStatus = 0
        for host in hosts {
            guard let url = URL(string: "\(host)/\(file)") else { continue }
            do {
                let (temporary, response) = try await URLSession.shared.download(from: url)
                let status = (response as? HTTPURLResponse)?.statusCode ?? 0
                guard (200..<300).contains(status) else {
                    lastStatus = status
                    continue
                }
                try? FileManager.default.removeItem(at: destination)
                try FileManager.default.moveItem(at: temporary, to: destination)
                var resourceValues = URLResourceValues()
                resourceValues.isExcludedFromBackup = true
                var mutable = destination
                try? mutable.setResourceValues(resourceValues)
                return destination
            } catch {
                lastStatus = 0
            }
        }
        throw ModelError.downloadFailed(lastStatus)
    }

    static func isReady(_ model: String) -> Bool {
        if bundled(model) != nil { return true }
        guard let cached = try? cached(model) else { return false }
        return FileManager.default.fileExists(atPath: cached.path)
    }
}
