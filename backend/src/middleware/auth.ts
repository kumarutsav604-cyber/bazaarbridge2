import { NextFunction, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.ts';
import { AppError } from '../db/pool.ts';

export interface AuthUser {
  user_id: string;
  role: 'customer' | 'admin' | 'rider';
  email?: string;
  name?: string;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export function signJwt(user: AuthUser): string {
  return jwt.sign(
    {
      user_id: user.user_id,
      role: user.role,
      email: user.email,
      name: user.name,
    },
    env.jwtSecret,
    { expiresIn: '12h' }
  );
}

export function verifyJwtToken(token: string): AuthUser {
  try {
    const decoded = jwt.verify(token, env.jwtSecret) as AuthUser;
    if (!decoded?.user_id || !decoded?.role) {
      throw new AppError(401, 'UNAUTHORIZED', 'Invalid authentication token.');
    }
    return decoded;
  } catch {
    throw new AppError(401, 'UNAUTHORIZED', 'Authentication token is invalid or expired.');
  }
}

export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    next(new AppError(401, 'UNAUTHORIZED', 'Authentication required.'));
    return;
  }
  const token = header.slice('Bearer '.length).trim();
  if (!token) {
    next(new AppError(401, 'UNAUTHORIZED', 'Authentication required.'));
    return;
  }
  try {
    req.user = verifyJwtToken(token);
    next();
  } catch (err) {
    next(err);
  }
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  requireAuth(req, res, (err) => {
    if (err) {
      next(err);
      return;
    }
    if (req.user?.role !== 'admin') {
      next(new AppError(403, 'FORBIDDEN', 'Admin role required for this endpoint.'));
      return;
    }
    next();
  });
}

export function optionalAuth(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) {
    try {
      req.user = verifyJwtToken(header.slice('Bearer '.length).trim());
    } catch {
      // ignore invalid optional token
    }
  }
  next();
}

export const loginRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json({
      error: 'RATE_LIMITED',
      message: 'Too many login attempts. Please wait one minute before retrying.',
    });
  },
});
