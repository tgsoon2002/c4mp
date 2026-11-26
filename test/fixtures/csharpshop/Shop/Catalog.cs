namespace Shop.Catalog;

public class Item
{
    public string Name { get; init; } = "";

    public string Label() => Name.ToUpper();

    public class Dim
    {
        public int Width() => 1;
    }
}
