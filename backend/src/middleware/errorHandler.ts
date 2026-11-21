import { NextFunction, Request, Response } from 'express';
import { AppError } from '../db/pool.ts';
import { ModeRuleError } from '../domain/fees.ts';

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  if (err instanceof AppError) {
    res.status(err.status).json({
      error: err.code,
      message: err.message,
      ...(err.details || {}),
    });
    return;
  }

  if (err instanceof ModeRuleError) {
    res.status(409).json({
      error: err.code,
      message: err.message,
    });
    return;
  }

  const pgErr = err as { code?: string; message?: string };
  if (pgErr?.message === 'OUT_OF_STOCK') {
    res.status(409).json({
      error: 'OUT_OF_STOCK',
      message: 'This offer no longer has enough free stock at the selected location.',
    });
    return;
  }
  if (pgErr?.message === 'INVALID_QUANTITY') {
    res.status(400).json({
      error: 'INVALID_QUANTITY',
      message: 'Quantity must be a positive integer.',
    });
    return;
  }
  if (pgErr?.message === 'OFFER_NOT_FOUND') {
    res.status(404).json({
      error: 'OFFER_NOT_FOUND',
      message: 'The requested dealer offer was not found or is inactive.',
    });
    return;
  }

  console.error('Unhandled API error:', pgErr?.message || err);
  res.status(500).json({
    error: 'INTERNAL_ERROR',
    message: 'An unexpected server error occurred.',
  });
}
