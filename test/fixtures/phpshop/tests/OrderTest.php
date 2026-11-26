<?php

namespace Shop\Tests;

use PHPUnit\Framework\Attributes\Test;
use PHPUnit\Framework\TestCase;
use Shop\Models\Order;

class OrderTest extends TestCase
{
    private function makeOrder(float $total): Order
    {
        return new Order(1, $total);
    }

    public function testPays(): void
    {
        $this->assertTrue($this->makeOrder(1.0)->pay(2.0));
    }

    /**
     * @test
     */
    public function it_is_free(): void
    {
        $this->assertInstanceOf(Order::class, Order::free());
    }

    #[Test]
    public function refunds(): void
    {
        $this->expectException(\Exception::class);
        $this->makeOrder(1.0)->refund();
    }
}
