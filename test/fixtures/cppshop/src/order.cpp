#include "order.hpp"

namespace shop {

Order::Order(int id, double total) : id_(id), total_(total) {}

void Order::refund() {
    total_ = 0.0;
}

int makeId(int seed) {
    return seed * 31;
}

Order* findOrder(int id) {
    return nullptr;
}

}  // namespace shop
