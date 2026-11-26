import { useCart } from '../cart';
import { api } from '../api';

export function Checkout() {
  const { items, total } = useCart();
  // TODO: payment form (waiting on Payment Service)
  return (
    <section>
      <h1>Your order</h1>
      {items.map(i => <p key={i.id}>{i.name} x{i.qty}</p>)}
      <p>Total: ${total.toFixed(2)}</p>
      <button onClick={() => api.post('/orders', { items })}>Place order</button>
    </section>
  );
}
