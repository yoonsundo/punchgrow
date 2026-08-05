// swift-tools-version: 6.1
import PackageDescription

let package = Package(
    name: "PunchGrowMenuBar",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "PunchGrowMenuBar", targets: ["PunchGrowMenuBar"]),
    ],
    targets: [
        .executableTarget(
            name: "PunchGrowMenuBar",
            resources: [.process("Resources")]
        ),
        .testTarget(
            name: "PunchGrowMenuBarTests",
            dependencies: ["PunchGrowMenuBar"],
            resources: [.process("Fixtures")]
        ),
    ]
)
