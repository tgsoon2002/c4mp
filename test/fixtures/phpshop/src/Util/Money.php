<?php

namespace Shop\Util;

use Psr\Log\LoggerInterface;
use Shop\HttpKit\Client;
use Shop\Models\{Order, Status as OrderStatus};
use function Shop\Models\make_order;

final class Money
{
    public static function format(float $amount): string
    {
        return number_format($amount, 2);
    }
}
