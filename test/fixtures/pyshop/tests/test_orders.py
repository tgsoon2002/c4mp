import unittest

import pytest

from shop.models.order import Order


@pytest.fixture
def order():
    return Order(id="a1", total=0)


def make_order(total):
    return Order(id="a2", total=total)


def test_free(order):
    assert order.is_free()


@pytest.mark.parametrize("total", [1, 2])
def test_not_free(total):
    assert not make_order(total).is_free()


class TestOrders:
    def setup_method(self):
        self.order = make_order(3)

    def test_total(self):
        assert self.order.total == 3


class OrderCase(unittest.TestCase):
    def test_id(self):
        self.assertEqual(make_order(0).id, "a2")
