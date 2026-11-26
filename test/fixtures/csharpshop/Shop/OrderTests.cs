namespace Shop.Tests
{
    public class OrderTests
    {
        private static Order Make(int id) => new Order(id);

        [Fact]
        public void HasId()
        {
            Assert.Equal(1, Make(1).Id);
        }

        [Theory]
        [InlineData(0)]
        public void IsFree(int id)
        {
            Assert.True(Make(id).IsFree());
        }

        [Trait("kind", "slow"), Xunit.Fact]
        public void Prices() => Assert.Equal(0m, Make(2).Price());
    }
}
