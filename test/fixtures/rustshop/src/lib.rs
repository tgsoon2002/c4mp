mod shop;
pub mod util;

use crate::shop::{make_order, Order};
use serde::Serialize;
use shop::tax;
use std::collections::HashMap;

pub fn total() -> u32 {
    make_order(1).id
}
