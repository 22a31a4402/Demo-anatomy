/**
 * Netlify Serverless Function Entry Point for Anatomy Guru
 * Wraps the pure Express backend without any Vite dev dependencies.
 */
import serverless from 'serverless-http';
import { app } from '../../server/app.ts';

const serverlessHandler = serverless(app, {
  binary: [
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'image/jpeg',
    'image/png',
    'image/webp',
    'application/octet-stream',
  ],
});

export const handler = async (event: any, context: any) => {
  // Prevent Lambda from waiting for lingering background timers or connections
  if (context) {
    context.callbackWaitsForEmptyEventLoop = false;
  }

  // Normalize path if Netlify function redirect prefixed /.netlify/functions/api
  if (event && event.path) {
    if (event.path.startsWith('/.netlify/functions/api')) {
      const sub = event.path.substring('/.netlify/functions/api'.length) || '/';
      event.path = sub.startsWith('/api') || sub.startsWith('/health') ? sub : `/api${sub.startsWith('/') ? '' : '/'}${sub}`;
    } else if (event.path.startsWith('/netlify/functions/api')) {
      const sub = event.path.substring('/netlify/functions/api'.length) || '/';
      event.path = sub.startsWith('/api') || sub.startsWith('/health') ? sub : `/api${sub.startsWith('/') ? '' : '/'}${sub}`;
    }
  }

  try {
    return await serverlessHandler(event, context);
  } catch (err: any) {
    console.error('[Netlify Function Handler Error]', err);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: err?.message || 'Serverless Execution Error',
        category: 'Netlify Function Exception',
        retryable: true,
        statusCode: 500,
      }),
    };
  }
};
