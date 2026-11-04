/**
 * Dedicated Production Backend Entry Point for NextGen Eval
 *
 * Implements:
 * - Express server on port 3000
 * - Protected Gemini API invocation
 * - Correlation ID tracking
 * - Evaluation job routes & SSE streams
 * - Explicit configurable CORS allowlist
 * - Request validation & upload bounds (50MB)
 * - Safe operational logging with secret redaction
 * - Vite middleware integration for seamless AI Studio development
 * - Production static serving
 */

import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { config } from './server/config';
import { evaluationsRouter } from './server/routes/evaluations';
import { answerKeysRouter } from './server/routes/answerKeys';
import { healthRouter } from './server/routes/health';

const app = express();

// Security: Configurable explicit CORS allowlist with AI Studio preview support
const configuredOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

function isOriginAllowed(origin: string | undefined): boolean {
  // Allow requests with no origin (mobile apps, curl, same-origin, or SSR)
  if (!origin) return true;

  // Explicitly configured origins or wildcard
  if (configuredOrigins.includes('*') || configuredOrigins.includes(origin)) {
    return true;
  }

  try {
    const parsed = new URL(origin);
    const hostname = parsed.hostname;

    // Allow localhost & loopback on any port
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '0.0.0.0') {
      return true;
    }

    // Allow Google AI Studio Preview & Google Cloud hosting domains
    if (
      hostname === 'google.com' ||
      hostname.endsWith('.google.com') ||
      hostname === 'googleusercontent.com' ||
      hostname.endsWith('.googleusercontent.com') ||
      hostname === 'run.app' ||
      hostname.endsWith('.run.app') ||
      hostname.endsWith('.web.app') ||
      hostname.endsWith('.firebaseapp.com')
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
        // Disallow cross-origin access without crashing the Express pipeline
        callback(null, false);
      }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key', 'x-correlation-id'],
  })
);

// Request upload bounds (up to 50MB for multimodal PDF/visual data)
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

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
    // Log only non-asset paths and never log body or query tokens
    if (!req.path.startsWith('/@') && !req.path.startsWith('/src') && !req.path.includes('.')) {
      console.log(`[HTTP][${correlationId}] ${req.method} ${req.path} -> ${res.statusCode} (${duration}ms)`);
    }
  });

  next();
});

// Mount dedicated backend routes
app.use(healthRouter);
app.use('/api/health', healthRouter);
app.use('/api/evaluations', evaluationsRouter);
app.use('/api/answer-keys', answerKeysRouter);

// Explicit 404 handler for unmatched API routes to ensure JSON response instead of HTML
app.use('/api', (req: Request, res: Response) => {
  res.status(404).setHeader('Content-Type', 'application/json').json({
    error: `API endpoint not found: ${req.method} ${req.originalUrl || req.path}`,
    category: 'Not Found',
    retryable: false,
    statusCode: 404,
  });
});

// Global Error Handler
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  // Prevent logging full sensitive bodies
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

async function startServer() {
  const isDev = process.env.NODE_ENV !== 'production';

  if (isDev) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);

    // Explicit fallback for client SPA routes in development (pathless middleware for Express 5 compatibility)
    app.use(async (req: Request, res: Response, next: NextFunction) => {
      if (req.method !== 'GET' || req.path.startsWith('/api') || req.path.startsWith('/health')) {
        return next();
      }
      try {
        const indexPath = path.resolve(process.cwd(), 'index.html');
        if (fs.existsSync(indexPath)) {
          const rawTemplate = fs.readFileSync(indexPath, 'utf-8');
          const transformedHtml = await vite.transformIndexHtml(req.originalUrl, rawTemplate);
          res.status(200).set({ 'Content-Type': 'text/html' }).end(transformedHtml);
          return;
        }
      } catch (e) {
        return next(e);
      }
      next();
    });

    console.log('[NextGen Eval] Vite dev middlewares & SPA fallback mounted successfully.');
  } else {
    const distPath = path.resolve(process.cwd(), 'dist');
    if (fs.existsSync(distPath)) {
      app.use(express.static(distPath));
      // Explicit fallback for client SPA routes in production
      app.use((req: Request, res: Response, next: NextFunction) => {
        if (req.method === 'GET' && !req.path.startsWith('/api') && !req.path.startsWith('/health')) {
          res.sendFile(path.join(distPath, 'index.html'));
          return;
        }
        next();
      });
      console.log(`[NextGen Eval] Serving static production files from: ${distPath}`);
    } else {
      console.warn(`[NextGen Eval] Production dist folder not found at ${distPath}. Running static fallback.`);
    }
  }

  const PORT = config.port;
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`=======================================================`);
    console.log(` NextGen Eval Dedicated AI Backend Server`);
    console.log(` Port: ${PORT}`);
    console.log(` Mode: ${isDev ? 'Development' : 'Production'}`);
    console.log(` Primary Model: ${config.primaryModel}`);
    console.log(` Fallback Models: ${config.fallbackModels.join(', ')}`);
    console.log(` Concurrency Limit: ${config.maxConcurrentEvaluations}`);
    console.log(` Health: http://localhost:${PORT}/health`);
    console.log(`=======================================================`);
  });
}

// Export app instance for serverless hosting (e.g. Netlify Functions)
export { app };
export default app;

// Only start HTTP listener when executed directly as a standalone server
const isServerless = Boolean(
  process.env.NETLIFY ||
  process.env.AWS_LAMBDA_FUNCTION_NAME ||
  process.env.LAMBDA_TASK_ROOT
);

if (!isServerless) {
  startServer().catch((err) => {
    console.error('[Fatal] Failed to start server:', err);
    process.exit(1);
  });
}

