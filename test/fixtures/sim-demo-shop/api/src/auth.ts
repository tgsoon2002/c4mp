// Auth component of the Shop API (sim-demo-shop fixture, Phase 25 UI0).

export interface Session { customerId: string; token: string }

export function login(email: string, password: string): Session | null {
  if (!email || !password) return null;
  return { customerId: 'c-7', token: `t-${email.length}` };
}

export function logout(session: Session): void {
  session.token = '';
}
