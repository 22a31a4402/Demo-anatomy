/**
 * Pure Server Application Definition for NextGen Eval
 * Contains only Express middleware and API routers.
 * Completely free of build tools (like Vite) so Netlify serverless bundler works cleanly.
 */

import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import crypto from 'crypto';
import { evaluationsRouter } from './routes/evaluations';
import { answerKeysRouter } from './routes/answerKeys';
import { healthRouter } from './routes/health';

const app = express();

// Security: Configurable explicit CORS allowlist
const configuredOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

function isOriginAllowed(origin: string | undefined): boolean {
  if (!origin) return true;
  if (configuredOrigins.includes('*') || configuredOrigins.includes(origin)) {
    return true;
  }

  try {
    const parsed = new URL(origin);
    const hostname = parsed.hostname;

    // Allow localhost & loopback
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '0.0.0.0') {
      return true;
    }

    // Allow Netlify preview and production domains
    if (
      hostname === 'netlify.app' ||
      hostname.endsWith('.netlify.app') ||
      hostname.endsWith('.netlify.live') ||
      hostname === 'google.com' ||
      hostname.endsWith('.google.com') ||
      hostname === 'googleusercontent.com' ||
      hostname.endsWith('.googleusercontent.com') ||
      hostname === 'run.app' ||
      hostname.endsWith('.run.app')
    ) {
      return true;
    }
  } catch {
    return false;
  }

  return false;
}

app.use(
  cors({
    origin: (origin, callback) => {
      if (isOriginAllowed(origin)) {
        callback(null, true);
      } else {
        callback(null, false);
      }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key', 'x-correlation-id', 'x-eval-sync', 'Accept', 'X-Requested-With'],
  })
);

// Request upload bounds (up to 100MB for multimodal PDF/visual data)
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

// Correlation ID & non-sensitive operational access logger
app.use((req: Request, res: Response, next: NextFunction) => {
  const correlationId =
    (req.headers['x-correlation-id'] as string) ||
    `req_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
  req.headers['x-correlation-id'] = correlationId;
  res.setHeader('x-correlation-id', correlationId);

  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    if (!req.path.startsWith('/@') && !req.path.startsWith('/src') && !req.path.includes('.')) {
      console.log(`[HTTP][${correlationId}] ${req.method} ${req.path} -> ${res.statusCode} (${duration}ms)`);
    }
  });

  next();
});

// Normalize Netlify serverless function path rewrites
app.use((req: Request, _res: Response, next: NextFunction) => {
  if (req.url.startsWith('/.netlify/functions/api')) {
    const sub = req.url.substring('/.netlify/functions/api'.length) || '/';
    req.url = sub.startsWith('/api') || sub.startsWith('/health') ? sub : `/api${sub.startsWith('/') ? '' : '/'}${sub}`;
  } else if (req.url.startsWith('/netlify/functions/api')) {
    const sub = req.url.substring('/netlify/functions/api'.length) || '/';
    req.url = sub.startsWith('/api') || sub.startsWith('/health') ? sub : `/api${sub.startsWith('/') ? '' : '/'}${sub}`;
  }
  next();
});

// Mount dedicated backend routes (with both /api and direct aliases for serverless flexibility)
app.use(healthRouter);
app.use('/health', healthRouter);
app.use('/api/health', healthRouter);

app.use('/evaluations', evaluationsRouter);
app.use('/api/evaluations', evaluationsRouter);

app.use('/answer-keys', answerKeysRouter);
app.use('/api/answer-keys', answerKeysRouter);

// Explicit 404 handler for unmatched API routes
app.use(['/api', '/.netlify/functions/api', '/netlify/functions/api'], (req: Request, res: Response) => {
  res.status(404).setHeader('Content-Type', 'application/json').json({
    error: `API endpoint not found: ${req.method} ${req.originalUrl || req.path}`,
    category: 'Not Found',
    retryable: false,
    statusCode: 404,
  });
});

// Global Error Handler
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  console.error('[Server Error]', err?.message || err);
  const status = typeof err.statusCode === 'number' ? err.statusCode : (typeof err.status === 'number' ? err.status : 500);
  const is503 = status === 503 || /503|unavailable|high demand/i.test(err?.message || '');
  res.status(is503 ? 503 : status).setHeader('Content-Type', 'application/json').json({
    error: err.message || 'Internal Server Error',
    category: is503 ? 'Gemini Server Temporarily Busy (503)' : (err.category || 'Backend Processing Error'),
    retryable: is503 || err.retryable || false,
    statusCode: is503 ? 503 : status,
  });
});

export { app };
export default app;
