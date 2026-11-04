/**
 * Netlify Serverless Function Entry Point for Anatomy Guru
 * Wraps the Express application with serverless-http to serve all /api/* routes on Netlify.
 */
import serverless from 'serverless-http';
import { app } from '../../server.ts';

// Netlify Functions Handler with binary media type support
export const handler = serverless(app, {
  binary: [
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'image/jpeg',
    'image/png',
    'image/webp',
    'application/octet-stream',
  ],
});
