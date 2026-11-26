<?php

namespace Shop\Models;

use Shop\Contracts\Priced;
use Shop\Util\Money;

interface Payable
{
    public function pay(float $amount): bool;
}

trait Loggable
{
    public function log(string $message): void
    {
        echo $message;
    }
}

enum Status: string
{
    case Open = 'open';
    case Paid = 'paid';

    public function label(): string
    {
        return ucfirst($this->value);
    }
}

class Order implements Payable
{
    use Loggable;

    public function __construct(private int $id, private float $total)
    {
    }

    public function pay(float $amount): bool
    {
        return $amount >= $this->total;
    }

    public static function free(): self
    {
        return new self(0, 0.0);
    }

    public function refund(): void
    {
        throw new \Exception('not implemented');
    }
}

function make_order(int $id, float $total): Order
{
    return new Order($id, $total);
}
