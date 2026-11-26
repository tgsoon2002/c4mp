from shop.models.order import Order
from . import pricing


class OrderService:
    def __init__(self):
        pass

    def create(self, order_id, total):
        return Order(order_id, pricing.apply_discount(total))

    def refund(self, order_id):
        raise NotImplementedError


def list_orders():
    """Return all orders."""
    ...
