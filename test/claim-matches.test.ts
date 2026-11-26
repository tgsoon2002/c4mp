import { claimMatches } from '../src/c4/ownership';
import type { Claim } from '../src/types';

const folderClaim: Claim = { kind: 'folder', path: 'src/orders/', fn: null, elementId: 'app.orders', claimIndex: 0 };
const fileClaim: Claim = { kind: 'file', path: 'src/util.ts', fn: null, elementId: 'app.util', claimIndex: 0 };
const fnClaim: Claim = { kind: 'function', path: 'src/payments.ts', fn: 'createPayment', elementId: 'app.payments', claimIndex: 0 };

describe('claimMatches', () => {
  it('folder claim matches a file under the folder and misses one outside it', () => {
    expect(claimMatches(folderClaim, 'src/orders/order.ts', 'createOrder')).toBe(true);
    expect(claimMatches(folderClaim, 'src/auth/login.ts', 'login')).toBe(false);
  });

  it('file claim matches its exact file and misses another file', () => {
    expect(claimMatches(fileClaim, 'src/util.ts', 'formatDate')).toBe(true);
    expect(claimMatches(fileClaim, 'src/util2.ts', 'formatDate')).toBe(false);
  });

  it('function claim matches the named function in its file and misses another function', () => {
    expect(claimMatches(fnClaim, 'src/payments.ts', 'createPayment')).toBe(true);
    expect(claimMatches(fnClaim, 'src/payments.ts', 'refundPayment')).toBe(false);
  });
});
