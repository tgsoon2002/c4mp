using System;

namespace Shop
{
    public interface IPriced
    {
        decimal Price();
    }

    public class Order : IPriced
    {
        public int Id { get; set; }
        private decimal total;

        public Order(int id)
        {
            Id = id;
        }

        public decimal Price()
        {
            return total;
        }

        public void Refund()
        {
            throw new NotImplementedException();
        }

        public bool IsFree() => Price() == 0;
    }

    public struct Money
    {
        public decimal Amount;
    }

    public record Receipt(int OrderId, decimal Total);

    public enum Status
    {
        Open,
        Paid
    }

    namespace Tax
    {
        public class Vat
        {
            public decimal Of(decimal amount)
            {
                return amount * 0.2m;
            }
        }
    }
}
