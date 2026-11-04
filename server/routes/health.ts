/**
 * Health, Readiness, and System Metrics Router for NextGen Eval
 *
 * Implements:
 * - Public liveness probe (/health)
 * - Protected readiness probe (/ready)
 * - Restricted operational metrics (/api/metrics) requiring 'operator' or 'admin' role
 */

import { Router, Request, Response } from 'express';
import { config } from '../config';
import { evaluationQueue } from '../queue';
import { evaluationCache } from '../cache';
import { requireAuth, requireRole, authenticateRequest, UserContext } from '../auth';
import { usageLedger } from '../usageLedger';

export const healthRouter = Router();

/**
 * GET /health
 * Public liveness probe (never leaks sensitive internal information)
 */
healthRouter.get(['/health', '/api/health'], (_req: Request, res: Response): void => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
    version: '2.0.0',
    service: 'nextgen-eval-backend',
  });
});

/**
 * GET /ready
 * Readiness probe:
 * - Public callers get basic status
 * - Authenticated operators/admins receive full diagnostic details
 */
healthRouter.get('/ready', (req: Request, res: Response): void => {
  const isKeyConfigured = Boolean(config.geminiApiKey);
  const user = authenticateRequest(req);

  // If caller is an authorized operator or admin, expose detailed operational readiness
  if (user && (user.role === 'operator' || user.role === 'admin')) {
    res.json({
      status: isKeyConfigured ? 'ready' : 'configuration_warning',
      geminiApiKeyConfigured: isKeyConfigured,
      primaryModel: config.primaryModel,
      fallbackModels: config.fallbackModels,
      maxConcurrentEvaluations: config.maxConcurrentEvaluations,
      timestamp: new Date().toISOString(),
    });
    return;
  }

  // Generic sanitized readiness for unauthenticated probes
  res.json({
    status: isKeyConfigured ? 'ready' : 'configuration_warning',
    timestamp: new Date().toISOString(),
  });
});

/**
 * GET /api/metrics
 * System metrics, throughput, latency, cache efficiency, and token costs
 * Strictly restricted to operators and institution administrators
 */
healthRouter.get('/api/metrics', requireAuth, requireRole(['operator', 'admin']), (_req: Request, res: Response): void => {
  const queueMetrics = evaluationQueue.getQueueMetrics();
  const cacheStats = evaluationCache.getStats();

  res.json({
    service: 'nextgen-eval',
    timestamp: new Date().toISOString(),
    queue: queueMetrics,
    cache: cacheStats,
    models: {
      primary: config.primaryModel,
      fallbacks: config.fallbackModels,
    },
    pricingTier: config.pricing,
  });
});

/**
 * GET /api/usage/summary
 * Batch aggregated usage and cost statistics scoped to authorized caller
 */
healthRouter.get('/api/usage/summary', requireAuth, (req: Request, res: Response): void => {
  const user = (req as any).user as UserContext;
  const targetInstitution =
    user.role === 'operator' && req.query.institutionId
      ? String(req.query.institutionId)
      : user.institutionId;

  const startDate = req.query.startDate ? parseInt(String(req.query.startDate), 10) : undefined;
  const endDate = req.query.endDate ? parseInt(String(req.query.endDate), 10) : undefined;
  const dataSource = req.query.dataSource as any;

  const stats = usageLedger.getBatchStatistics(
    {
      institutionId: targetInstitution,
      startDate,
      endDate,
      dataSource,
    },
    user
  );

  res.json(stats);
});
