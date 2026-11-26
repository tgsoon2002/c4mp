#pragma once
#include <string>

namespace shop {

struct Point {
    int x;
    int y;
    int sum() const { return x + y; }
};

class Order {
public:
    Order(int id, double total);
    bool isFree() const { return total_ == 0.0; }
    void refund();

private:
    int id_;
    double total_;
};

template <typename T>
T maxOf(T a, T b) {
    return a > b ? a : b;
}

enum class Status { Open, Paid };

}  // namespace shop
