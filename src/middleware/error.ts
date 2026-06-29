import type { ErrorRequestHandler } from 'express';

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  // Never log request bodies, codes, or secrets — only a generic message.
  console.error('request_error', err instanceof Error ? err.message : 'unknown');
  if (res.headersSent) return;
  res.status(500).json({ error: 'internal_error' });
};
