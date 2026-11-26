namespace Shop.Util
{
    public static class Format
    {
        public static string Price(decimal amount) => amount.ToString("0.00");
    }
}
