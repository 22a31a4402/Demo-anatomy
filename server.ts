/**
 * Dedicated Backend Server Entry Point
 * Mounts Vite dev middlewares in development or serves dist/ in production.
 */

import path from 'path';
import fs from 'fs';
import express, { Request, Response, NextFunction } from 'express';
import { app } from './server/app';
import { config } from './server/config';

async function startServer() {
  const isDev = process.env.NODE_ENV !== 'production';

  if (isDev) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);

    // Fallback for client SPA routes in development
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

    console.log('[NextGen Eval] Vite dev middlewares mounted successfully.');
  } else {
    const distPath = path.resolve(process.cwd(), 'dist');
    if (fs.existsSync(distPath)) {
      app.use(express.static(distPath));
      app.use((req: Request, res: Response, next: NextFunction) => {
        if (req.method === 'GET' && !req.path.startsWith('/api') && !req.path.startsWith('/health')) {
          res.sendFile(path.join(distPath, 'index.html'));
          return;
        }
        next();
      });
      console.log(`[NextGen Eval] Serving static production files from: ${distPath}`);
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
    console.log(` Health: http://localhost:${PORT}/health`);
    console.log(`=======================================================`);
  });
}

export { app };
export default app;

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
