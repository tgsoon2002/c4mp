import passport from 'passport';
import jwt from 'jsonwebtoken';
import { Strategy as JwtStrategy, ExtractJwt } from 'passport-jwt';
import { users } from '../db';

// Token verify logic
passport.use(new JwtStrategy({
  jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
  secretOrKey: process.env.JWT_SECRET,
}, async (payload, done) => {
  const user = await users.findById(payload.sub);
  return user ? done(null, user) : done(null, false);
}));

export const requireAuth = passport.authenticate('jwt', { session: false });

export function issueToken(userId: string) {
  return jwt.sign({ sub: userId }, process.env.JWT_SECRET!, { expiresIn: '1h' });
}

export function revokeToken(token: string) {
  // TODO: keep a revoked-token list
}
