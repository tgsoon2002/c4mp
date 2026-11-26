// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "Shop",
    dependencies: [
        .package(url: "https://github.com/apple/swift-collections", from: "1.0.0"),
    ],
    targets: [
        .target(name: "Shop"),
        .target(
            name: "ShopKit",
            dependencies: [.target(name: "Shop"), .product(name: "Collections", package: "swift-collections")],
            path: "Kit"
        ),
        // .target(name: "Old"),
        .target(name: "Empty"),
        .testTarget(name: "ShopTests", dependencies: ["Shop", "ShopKit"]),
    ]
)
