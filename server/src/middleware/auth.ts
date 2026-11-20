import type { Request, RequestHandler } from 'express';
import jwt, { type JwtPayload } from 'jsonwebtoken';

export interface AuthedRequest extends Request {
  auth?: JwtPayload | string;
}

// Sends 401 directly (not via next(err)) because errorHandler maps errors to 500.
export const requireAuth: RequestHandler = (req, res, next) => {
  const secret = process.env.JWT_SECRET;
  const header = req.headers.authorization;
  const match = header ? /^Bearer (\S+)$/.exec(header) : null;
  if (!secret || !match) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  try {
    (req as AuthedRequest).auth = jwt.verify(match[1], secret, { algorithms: ['HS256'] });
  } catch {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  next();
};
