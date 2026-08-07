// swift-tools-version: 5.9
import PackageDescription

/*
  A Capacitor plugin that transcribes speech with whisper.cpp on the phone.

  It depends on whisper.cpp itself, which ships a Swift package exposing the
  `whisper` target. Pinning to a tag rather than a branch keeps a build
  reproducible; bump it deliberately.

  This package has never been compiled — see README.md.
*/
let package = Package(
    name: "LocalTranscription",
    platforms: [.iOS(.v14)],
    products: [
        .library(name: "LocalTranscription", targets: ["LocalTranscriptionPlugin"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "8.0.0"),
        .package(url: "https://github.com/ggml-org/whisper.cpp.git", from: "1.7.4")
    ],
    targets: [
        .target(
            name: "LocalTranscriptionPlugin",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm"),
                .product(name: "whisper", package: "whisper.cpp")
            ],
            path: "ios/Sources/LocalTranscriptionPlugin"
        )
    ]
)
