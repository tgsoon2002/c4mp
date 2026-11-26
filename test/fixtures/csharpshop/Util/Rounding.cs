namespace Shop.Util;

public static class Rounding
{
    public static decimal Cents(decimal amount) => decimal.Round(amount, 2);
}
