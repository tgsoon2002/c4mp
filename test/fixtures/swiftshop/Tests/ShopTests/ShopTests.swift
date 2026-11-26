import XCTest
@testable import Shop
@_spi(Kit) @testable import ShopKit
import Collections
import struct Foundation.URL
import Empty
import Old

final class ShopTests: XCTestCase {
    func testOrder() { XCTAssertEqual(kitOrder().id, 1) }
    func makeId() -> Int { 1 }
}

// swift-testing
struct KitTests {
    @Test func formats() { assert(kitOrder().id == 1) }

    @Test("rounds money")
    func rounds() {}
}

@Test func freeOrder() {}
