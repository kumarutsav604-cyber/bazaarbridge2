import bcrypt from 'bcryptjs';
import { Router } from 'express';
import { z } from 'zod';
import { AppError, getPool } from '../db/pool.ts';
import { loginRateLimiter, requireAuth, signJwt } from '../middleware/auth.ts';

const router = Router();

const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

router.post('/login', loginRateLimiter, async (req, res, next) => {
  try {
    const parsed = LoginSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, 'INVALID_INPUT', 'Valid email and password are required.');
    }

    const { email, password } = parsed.data;
    const pool = getPool();
    const result = await pool.query<{
      user_id: string;
      name: string;
      email: string;
      password_hash: string;
      role: 'customer' | 'admin' | 'rider';
    }>(
      `SELECT user_id, name, email, password_hash, role
         FROM users
        WHERE lower(email) = lower($1)`,
      [email.trim()]
    );

    if (result.rowCount !== 1) {
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password.');
    }

    const user = result.rows[0];
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password.');
    }

    const token = signJwt({
      user_id: user.user_id,
      role: user.role,
      email: user.email,
      name: user.name,
    });

    res.json({
      token,
      user: {
        user_id: user.user_id,
        name: user.name,
        email: user.email,
        role: user.role,
      },
    });
  } catch (err) {
    next(err);
  }
});

router.get('/me', requireAuth, async (req, res, next) => {
  try {
    const pool = getPool();
    const result = await pool.query<{
      user_id: string;
      name: string;
      email: string;
      role: string;
    }>(`SELECT user_id, name, email, role FROM users WHERE user_id = $1`, [req.user!.user_id]);

    if (result.rowCount !== 1) {
      throw new AppError(404, 'USER_NOT_FOUND', 'User account not found.');
    }
    res.json({ user: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

export default router;
