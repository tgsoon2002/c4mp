import Foundation

public struct Order {
    public let id: Int
    public var total: Double

    public init(id: Int) {
        self.id = id
        self.total = 0
    }

    public mutating func refund() {
        total = 0
    }
}

public enum Status: String {
    case open, paid

    var label: String { rawValue }

    func next() -> Status {
        self == .open ? .paid : .open
    }
}

public protocol Priced {
    func price() -> Double
    init(raw: Double)
}

extension Order: Priced {
    public func price() -> Double {
        total
    }

    public init(raw: Double) {
        self.init(id: 0)
        self.total = raw
    }
}

public final class Cart {
    private var orders: [Order] = []

    public func add(_ order: Order) {
        orders.append(order)
    }

    deinit {}

    public class Line {
        func describe() -> String { "line" }
    }
}

actor Counter {
    private var value = 0

    func tick() -> Int {
        value += 1
        return value
    }
}

#if canImport(Combine)
public func makeOrder(id: Int) -> Order {
    Order(id: id)
}
#endif
