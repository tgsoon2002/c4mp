using System.Linq;
using Shop.Util;
using static Shop.Util.Format;
using Json = Newtonsoft.Json.JsonConvert;
using Ints = System.Collections.Generic.List<int>;
using Tools;
using Missing.Thing;
// using Commented.Out;

namespace Shop.Billing
{
    using Shop.Catalog;

    public class Checkout
    {
        public string Total(Item[] items)
        {
            using (var log = new System.IO.StringWriter()) { }
            using var other = new System.IO.StringWriter();
            var note = "using Not.An.Import;";
            return Price(Rounding.Cents(items.Count()));
        }

        public string Dump(object o) => Json.SerializeObject(o);
    }
}
