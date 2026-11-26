use super::helper;
use crate::shop::tax::{self, vat};

#[cfg(test)]
mod tests {
    use super::*;
    use crate::util::helper as h;
}

pub enum Align { Left, Right }

pub fn pad(a: Align) -> u32 {
    use Align::*;
    match a { Left => 0, Right => 1 }
}
