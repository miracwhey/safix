// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "FixupCapacitorRoomplan",
    platforms: [.iOS(.v16)],
    products: [
        .library(
            name: "FixupCapacitorRoomplan",
            targets: ["RoomPlanPlugin"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "8.0.0")
    ],
    targets: [
        .target(
            name: "RoomPlanPlugin",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm")
            ],
            path: "ios/Sources/RoomPlan",
            resources: [
                .copy("PrivacyInfo.xcprivacy")
            ],
            linkerSettings: [
                .linkedFramework("RoomPlan", .when(platforms: [.iOS])),
                .linkedFramework("ARKit", .when(platforms: [.iOS])),
            ]
        ),
        // Day 9 B15: pure-Swift test target for the canonical converter's
        // host-wall matcher + wall-doubling detector. Does NOT pull in any
        // `RoomPlan.CapturedRoom` fixtures — the heavy logic lives in the
        // pure layer, and a real `CapturedRoom` is not Mac-SDK-buildable.
        .testTarget(
            name: "RoomPlanPluginTests",
            dependencies: ["RoomPlanPlugin"],
            path: "ios/Tests"
        )
    ]
)
