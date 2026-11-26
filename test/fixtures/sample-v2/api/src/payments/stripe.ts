import Stripe from 'stripe';

export function charge(amount: number) {
  return new Stripe('key').charges.create({ amount });
}
