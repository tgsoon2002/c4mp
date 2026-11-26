extension Cart.Line {
    func cents() -> Int { 0 }
}

func vat(_ amount: Double) -> Double {
    amount * 0.2
}
