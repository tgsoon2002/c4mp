#include <vector>
#include <sys/types.h>
#include "order.hpp"
#include "shop/util.h"
#include "missing.h"
#include "gtest/gtest.h"
#include "absl/strings/str_cat.h"
#include "shop/missing.h"

int main() {
    shop::Order order(shop::clampId(1), 2.0);
    return order.isFree() ? 1 : 0;
}
