#include "gtest/gtest.h"
#include "../src/order.hpp"

static int makeId() { return 1; }

class OrderFixture : public ::testing::Test {
protected:
    void SetUp() override {}
};

TEST(OrderTest, IsFree) {
    shop::Point p{makeId(), 2};
    EXPECT_EQ(p.sum(), 3);
}

TEST_F(OrderFixture, Total) {
    EXPECT_EQ(makeId(), 1);
}
