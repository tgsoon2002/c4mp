use std::fmt;

pub struct Order {
    pub id: u32,
    pub total: f64,
}

pub enum Status {
    Open,
    Paid,
}

pub trait Priced {
    fn price(&self) -> f64;

    fn is_free(&self) -> bool {
        self.price() == 0.0
    }
}

impl Order {
    pub fn new(id: u32) -> Self {
        Order { id, total: 0.0 }
    }

    pub fn refund(&mut self) {
        todo!()
    }
}

impl Priced for Order {
    fn price(&self) -> f64 {
        self.total
    }
}

impl fmt::Display for Order {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        write!(f, "order {}", self.id)
    }
}

pub fn make_order(id: u32) -> Order {
    Order::new(id)
}

pub mod tax {
    pub fn vat(amount: f64) -> f64 {
        amount * 0.2
    }

    pub fn exempt() -> f64 {
        unimplemented!("exemptions")
    }
}
