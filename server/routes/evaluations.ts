/**
 * Evaluation API Routes for NextGen Eval
 *
 * Implements:
 * - Server-side authentication and role-based access control
 * - Multi-tenant isolation and ownership verification
 * - Request validation and backpressure enforcement
 * - SSE real-time streaming with EventSource token support
 * - Secure job retry and deletion endpoints
 */

import { Router, Request, Response } from 'express';
import { evaluationQueue, QueueCapacityError } from '../queue';
import { EvaluationJob, EvaluationMode, CanonicalAnswerKey } from '../types';
import { requireAuth, requireRole, verifyJobAccess, UserContext, checkEvaluationRateLimit } from '../auth';
import { usageLedger } from '../usageLedger';
import { answerKeyService } from '../answerKeyService';
import { evaluationEngine } from '../evaluator';
import { evaluationMetadataService } from '../evaluationMetadata';
import { config } from '../config';

export const evaluationsRouter = Router();

// Apply authentication middleware to all evaluations routes
evaluationsRouter.use(requireAuth);

const ALLOWED_MIME_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'text/plain',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/msword',
  'application/octet-stream',
];

function validateDocumentPayload(doc: any, fieldName: string): string | null {
  if (!doc) return null;
  if (typeof doc !== 'object') {
    return `${fieldName} must be an object.`;
  }
  const cleanMime = doc.mimeType ? String(doc.mimeType).split(';')[0].trim().toLowerCase() : '';
  if (cleanMime && !ALLOWED_MIME_TYPES.includes(cleanMime)) {
    return `${fieldName} has unsupported MIME type: '${doc.mimeType}'. Allowed formats: PDF, JPEG, PNG, WebP, plain text, DOCX.`;
  }
  if (doc.name && typeof doc.name !== 'string') {
    return `${fieldName}.name must be a string.`;
  }
  if (doc.name && doc.name.length > 255) {
    return `${fieldName}.name cannot exceed 255 characters.`;
  }
  if (doc.text && typeof doc.text !== 'string') {
    return `${fieldName}.text must be a string.`;
  }
  if (doc.base64 && typeof doc.base64 !== 'string') {
    return `${fieldName}.base64 must be a string.`;
  }
  return null;
}

/**
 * POST /api/evaluations
 * Create & enqueue a new evaluation job
 */
evaluationsRouter.post('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const user = (req as any).user as UserContext;

    // Check evaluation-specific rate limit (15 evals/min per client key)
    const clientKey = `${user.userId}_${user.institutionId}`;
    const evalRateLimit = checkEvaluationRateLimit(clientKey);
    if (!evalRateLimit.allowed) {
      res.setHeader('Retry-After', evalRateLimit.retryAfterSeconds);
      res.status(429).json({
        error: 'Too Many Evaluation Requests: Evaluation creation rate limit exceeded. Please back off and retry.',
        retryAfterSeconds: evalRateLimit.retryAfterSeconds,
      });
      return;
    }

    const {
      sourceDoc,
      questionPaper,
      answerKey,
      answerKeyId,
      canonicalAnswerKey: rawCanonicalAnswerKey,
      facultyNotes,
      mode = 'without-manual',
      studentName,
      testTitle,
    } = req.body;

    // Mode validation
    if (mode !== 'with-manual' && mode !== 'without-manual') {
      res.status(400).json({
        error: `Invalid evaluation mode '${mode}'. Allowed modes are 'with-manual' or 'without-manual'.`,
      });
      return;
    }

    // Document validation
    if (!sourceDoc || (!sourceDoc.text && !sourceDoc.base64)) {
      res.status(400).json({
        error: 'Invalid request: sourceDoc (containing text or visual base64) is required.',
      });
      return;
    }

    const srcError = validateDocumentPayload(sourceDoc, 'sourceDoc');
    if (srcError) {
      res.status(400).json({ error: srcError });
      return;
    }

    // Resolve Canonical Answer Key if specified by ID or object
    let resolvedCanonicalKey: CanonicalAnswerKey | undefined = undefined;

    if (answerKeyId) {
      const found = answerKeyService.getAnswerKey(String(answerKeyId), user);
      if (!found) {
        res.status(404).json({ error: `Answer key not found or access denied: ${answerKeyId}` });
        return;
      }
      if (found.status !== 'approved') {
        res.status(422).json({
          error: `Cannot evaluate student script with unapproved answer key. Current status: '${found.status}'. The instructor must review and approve the answer key first.`,
        });
        return;
      }
      resolvedCanonicalKey = found;
    } else if (rawCanonicalAnswerKey) {
      if (rawCanonicalAnswerKey.status !== 'approved') {
        res.status(422).json({
          error: `Cannot evaluate student script with unapproved answer key. Current status: '${rawCanonicalAnswerKey.status}'. The instructor must review and approve the answer key first.`,
        });
        return;
      }
      resolvedCanonicalKey = rawCanonicalAnswerKey;
    } else if (questionPaper && answerKey) {
      // Auto-detect mapped approved answer key for this Question Paper + Answer Key pair using full content hash
      const mappedPair = answerKeyService.findApprovedKeyForReferencePair(questionPaper, answerKey, user);
      if (mappedPair) {
        resolvedCanonicalKey = mappedPair;
      }
    } else if (questionPaper) {
      // Auto-detect mapped approved answer key for this question paper
      const mapped = answerKeyService.findApprovedKeyForQuestionPaper(questionPaper, user);
      if (mapped) {
        resolvedCanonicalKey = mapped;
      }
    }

    const effectiveQuestionPaper = questionPaper || resolvedCanonicalKey?.sourceQuestionPaperDoc;

    if (questionPaper) {
      const qpError = validateDocumentPayload(questionPaper, 'questionPaper');
      if (qpError) {
        res.status(400).json({ error: qpError });
        return;
      }
    }

    if (answerKey) {
      const akError = validateDocumentPayload(answerKey, 'answerKey');
      if (akError) {
        res.status(400).json({ error: akError });
        return;
      }
    }

    if (facultyNotes) {
      const fnError = validateDocumentPayload(facultyNotes, 'facultyNotes');
      if (fnError) {
        res.status(400).json({ error: fnError });
        return;
      }
    }

    if (mode === 'with-manual' && !facultyNotes) {
      res.status(400).json({
        error: 'Invalid request: facultyNotes is required for with-manual mode.',
      });
      return;
    }

    const sanitizedStudentName = studentName ? String(studentName).trim().substring(0, 200) : undefined;
    const sanitizedTestTitle = testTitle ? String(testTitle).trim().substring(0, 200) : undefined;

    const job = evaluationQueue.enqueue(
      {
        sourceDoc,
        questionPaper: effectiveQuestionPaper,
        answerKey,
        answerKeyId: resolvedCanonicalKey ? resolvedCanonicalKey.id : answerKeyId,
        canonicalAnswerKey: resolvedCanonicalKey,
        facultyNotes,
        mode: mode as EvaluationMode,
        studentName: sanitizedStudentName,
        testTitle: sanitizedTestTitle,
      },
      user
    );

    // In serverless environments (Netlify, AWS Lambda) or when requested via sync query/header,
    // execute evaluation synchronously within the request so background containers aren't frozen
    // and polling across different serverless instances isn't required.
    const isServerless = Boolean(
      process.env.NETLIFY ||
      process.env.AWS_LAMBDA_FUNCTION_NAME ||
      process.env.LAMBDA_TASK_ROOT ||
      process.env.AWS_EXECUTION_ENV ||
      process.env.VERCEL
    );
    const preferSync = req.query.sync === 'true' || req.headers['x-eval-sync'] === 'true' || isServerless;

    if (preferSync) {
      try {
        console.log(`[evaluationsRouter] Running direct synchronous evaluation for ${job.studentName} (${job.id})...`);
        const report = await evaluationEngine.evaluate(job);
        job.report = report;
        job.status = 'completed';
        job.progressPercent = 100;
        job.currentStepMessage = 'Evaluation complete and verified';
        job.updatedAt = Date.now();

        try {
          evaluationMetadataService.generateMetadata(job);
        } catch {}

        res.status(200).json({
          jobId: job.id,
          correlationId: job.correlationId,
          status: 'completed',
          progressPercent: 100,
          currentStepMessage: 'Evaluation complete and verified',
          report,
          links: {
            status: `/api/evaluations/${job.id}`,
            results: `/api/evaluations/${job.id}/results`,
          },
        });
        return;
      } catch (evalErr: any) {
        console.error(`[evaluationsRouter] Direct evaluation failed for ${job.id}:`, evalErr);
        job.status = evalErr?.name === 'ValidationError' ? 'needs_review' : 'failed';
        job.error = evalErr?.message || 'Evaluation failed on backend';
        res.status(evalErr?.statusCode || (evalErr?.name === 'ValidationError' ? 422 : 500)).json({
          jobId: job.id,
          correlationId: job.correlationId,
          status: job.status,
          error: job.error,
          category: evalErr?.name || 'Evaluation Failure',
        });
        return;
      }
    }

    res.status(202).json({
      jobId: job.id,
      correlationId: job.correlationId,
      status: job.status,
      message: 'Evaluation job accepted and queued for processing.',
      links: {
        status: `/api/evaluations/${job.id}`,
        results: `/api/evaluations/${job.id}/results`,
        events: `/api/evaluations/${job.id}/events`,
      },
    });
  } catch (err: any) {
    if (err instanceof QueueCapacityError) {
      res.setHeader('Retry-After', 30);
      res.status(503).json({
        error: err.message,
        retryAfterSeconds: 30,
      });
      return;
    }
    console.error('[evaluationsRouter] Error creating job:', err?.message || err);
    res.status(500).json({ error: err?.message || 'Internal server error creating evaluation job' });
  }
});

/**
 * GET /api/evaluations/usage/summary
 * Batch aggregated usage and cost statistics scoped to authorized institution
 */
evaluationsRouter.get('/usage/summary', (req: Request, res: Response): void => {
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

/**
 * GET /api/evaluations/:id
 * Retrieve job status, progress, and execution metrics with ownership check
 */
evaluationsRouter.get('/:id', (req: Request, res: Response): void => {
  const user = (req as any).user as UserContext;
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const job = evaluationQueue.getJob(id);

  if (!job) {
    res.status(404).json({ error: `Evaluation job not found: ${id}` });
    return;
  }

  if (!verifyJobAccess(job, user)) {
    res.status(403).json({ error: 'Forbidden: You do not have permission to access this evaluation job.' });
    return;
  }

  res.json({
    id: job.id,
    correlationId: job.correlationId,
    status: job.status,
    progressPercent: job.progressPercent,
    currentStepMessage: job.currentStepMessage,
    studentName: job.studentName,
    testTitle: job.testTitle,
    mode: job.mode,
    institutionId: job.institutionId,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    error: job.error,
    category: job.errorCategory,
    statusCode: job.statusCode,
    retryable: job.isRetryable,
    metrics: job.metrics,
    hasReport: Boolean(job.report),
  });
});

/**
 * GET /api/evaluations/:id/results
 * Retrieve final validated evaluation report with ownership check
 */
evaluationsRouter.get('/:id/results', (req: Request, res: Response): void => {
  const user = (req as any).user as UserContext;
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const job = evaluationQueue.getJob(id);

  if (!job) {
    res.status(404).json({ error: `Evaluation job not found: ${id}` });
    return;
  }

  if (!verifyJobAccess(job, user)) {
    res.status(403).json({ error: 'Forbidden: You do not have permission to view results for this evaluation job.' });
    return;
  }

  if (job.status === 'failed') {
    const is503 = job.statusCode === 503 || /503|unavailable|high demand/i.test(job.error || '');
    const status = is503 ? 503 : 422;
    res.status(status).setHeader('Content-Type', 'application/json').json({
      error: job.error || 'Evaluation failed on backend.',
      category: job.errorCategory || (is503 ? 'Gemini Server Temporarily Busy (503)' : 'Evaluation Failure'),
      status: 'failed',
      retryable: job.isRetryable !== undefined ? job.isRetryable : is503,
      statusCode: status,
      jobId: job.id,
    });
    return;
  }

  if (job.status !== 'completed' || !job.report) {
    res.status(409).setHeader('Content-Type', 'application/json').json({
      error: `Report is not ready. Current job status: ${job.status}`,
      status: job.status,
      progressPercent: job.progressPercent,
      currentStepMessage: job.currentStepMessage,
    });
    return;
  }

  res.json({
    id: job.id,
    report: job.report,
    metrics: job.metrics,
  });
});

/**
 * GET /api/evaluations/:id/usage
 * Retrieve granular usage and itemized cost breakdown for a specific evaluation job
 */
evaluationsRouter.get('/:id/usage', (req: Request, res: Response): void => {
  const user = (req as any).user as UserContext;
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const job = evaluationQueue.getJob(id);

  if (!job) {
    res.status(404).json({ error: `Evaluation job not found: ${id}` });
    return;
  }

  if (!verifyJobAccess(job, user)) {
    res.status(403).json({ error: 'Forbidden: You do not have permission to view usage for this evaluation job.' });
    return;
  }

  const usageSummary = usageLedger.getJobUsageSummary(id, user);
  if (!usageSummary) {
    res.status(404).json({ error: `Usage telemetry not found for evaluation: ${id}` });
    return;
  }

  res.json(usageSummary);
});

/**
 * POST /api/evaluations/:id/retry
 * Safe retry of eligible failed tasks with ownership check
 */
evaluationsRouter.post('/:id/retry', (req: Request, res: Response): void => {
  const user = (req as any).user as UserContext;
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

  try {
    const job = evaluationQueue.retryJob(id, user);
    if (!job) {
      res.status(404).json({ error: `Evaluation job not found or ineligible for retry: ${id}` });
      return;
    }

    res.json({
      id: job.id,
      status: job.status,
      message: 'Evaluation job queued for retry.',
    });
  } catch (err: any) {
    if (err?.message?.includes('Forbidden')) {
      res.status(403).json({ error: err.message });
      return;
    }
    res.status(500).json({ error: err?.message || 'Error retrying job' });
  }
});

/**
 * POST /api/evaluations/:id/cancel
 * Cancel a queued or active evaluation job
 */
evaluationsRouter.post('/:id/cancel', (req: Request, res: Response): void => {
  const user = (req as any).user as UserContext;
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

  try {
    const job = evaluationQueue.cancelJob(id, user);
    if (!job) {
      res.status(404).json({ error: `Evaluation job not found: ${id}` });
      return;
    }
    res.json({
      id: job.id,
      status: job.status,
      message: `Evaluation job ${id} successfully cancelled.`,
    });
  } catch (err: any) {
    if (err?.message?.includes('Forbidden')) {
      res.status(403).json({ error: err.message });
      return;
    }
    res.status(400).json({ error: err?.message || 'Error cancelling job' });
  }
});

/**
 * GET /api/evaluations/:id/review
 * Retrieve draft evaluation report and validation discrepancies for jobs needing review
 */
evaluationsRouter.get('/:id/review', (req: Request, res: Response): void => {
  const user = (req as any).user as UserContext;
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const job = evaluationQueue.getJob(id);

  if (!job) {
    res.status(404).json({ error: `Evaluation job not found: ${id}` });
    return;
  }

  if (!verifyJobAccess(job, user)) {
    res.status(403).json({ error: 'Forbidden: You do not have permission to review this job.' });
    return;
  }

  res.json({
    id: job.id,
    status: job.status,
    studentName: job.studentName,
    testTitle: job.testTitle,
    validationError: job.error,
    draftReport: job.draftReport || null,
    metrics: job.metrics,
    institutionId: job.institutionId,
  });
});

/**
 * POST /api/evaluations/prune
 * Prune historical jobs older than retention window (default 30 days)
 * Operator or Admin only
 */
evaluationsRouter.post('/prune', requireRole(['operator', 'admin']), (req: Request, res: Response): void => {
  const retentionDays = parseInt(req.body.retentionDays || '30', 10);
  const pruned = evaluationQueue.pruneExpiredJobs(retentionDays);
  res.json({
    success: true,
    message: `Pruned ${pruned} jobs older than ${retentionDays} days.`,
    prunedCount: pruned,
  });
});

/**
 * DELETE /api/evaluations/:id
 * Secure deletion of evaluation job with ownership check
 */
evaluationsRouter.delete('/:id', (req: Request, res: Response): void => {
  const user = (req as any).user as UserContext;
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

  try {
    const deleted = evaluationQueue.deleteJob(id, user);
    if (!deleted) {
      res.status(404).json({ error: `Evaluation job not found: ${id}` });
      return;
    }
    res.json({ success: true, message: `Evaluation job ${id} successfully deleted.` });
  } catch (err: any) {
    if (err?.message?.includes('Forbidden')) {
      res.status(403).json({ error: err.message });
      return;
    }
    res.status(500).json({ error: err?.message || 'Error deleting job' });
  }
});

/**
 * GET /api/evaluations/:id/events
 * Real-time Server-Sent Events (SSE) stream for status and progress
 */
evaluationsRouter.get('/:id/events', (req: Request, res: Response): void => {
  const user = (req as any).user as UserContext;
  const jobId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const job = evaluationQueue.getJob(jobId);

  if (!job) {
    res.status(404).json({ error: `Evaluation job not found: ${jobId}` });
    return;
  }

  if (!verifyJobAccess(job, user)) {
    res.status(403).json({ error: 'Forbidden: You do not have permission to listen to events for this job.' });
    return;
  }

  // Set SSE Headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  res.write('\n');

  const sendEvent = (event: string, data: any) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // Send initial state
  sendEvent('status', {
    id: job.id,
    status: job.status,
    progressPercent: job.progressPercent,
    currentStepMessage: job.currentStepMessage,
  });

  if (job.status === 'completed') {
    sendEvent('completed', { report: job.report, metrics: job.metrics });
    res.end();
    return;
  }

  if (job.status === 'needs_review') {
    sendEvent('needs_review', { error: job.error, status: job.status });
    res.end();
    return;
  }

  if (job.status === 'failed' || job.status === 'cancelled') {
    sendEvent('failed', { error: job.error, status: job.status });
    res.end();
    return;
  }

  // Event Listeners
  const onProgress = (updatedJob: EvaluationJob) => {
    if (updatedJob.id === jobId) {
      sendEvent('progress', {
        id: updatedJob.id,
        status: updatedJob.status,
        progressPercent: updatedJob.progressPercent,
        currentStepMessage: updatedJob.currentStepMessage,
      });
    }
  };

  const onCompleted = (completedJob: EvaluationJob) => {
    if (completedJob.id === jobId) {
      sendEvent('completed', {
        id: completedJob.id,
        report: completedJob.report,
        metrics: completedJob.metrics,
      });
      cleanup();
      res.end();
    }
  };

  const onFailed = (failedJob: EvaluationJob) => {
    if (failedJob.id === jobId) {
      const eventName = failedJob.status === 'needs_review' ? 'needs_review' : 'failed';
      sendEvent(eventName, {
        id: failedJob.id,
        error: failedJob.error,
        status: failedJob.status,
      });
      cleanup();
      res.end();
    }
  };

  const cleanup = () => {
    evaluationQueue.off('job:progress', onProgress);
    evaluationQueue.off('job:completed', onCompleted);
    evaluationQueue.off('job:failed', onFailed);
  };

  evaluationQueue.on('job:progress', onProgress);
  evaluationQueue.on('job:completed', onCompleted);
  evaluationQueue.on('job:failed', onFailed);

  req.on('close', cleanup);
});

/**
 * POST /api/evaluations/sync
 * Synchronous direct evaluation endpoint with authentication & validation
 */
evaluationsRouter.post('/sync', async (req: Request, res: Response): Promise<void> => {
  try {
    const user = (req as any).user as UserContext;

    // Check evaluation-specific rate limit
    const clientKey = `${user.userId}_${user.institutionId}`;
    const evalRateLimit = checkEvaluationRateLimit(clientKey);
    if (!evalRateLimit.allowed) {
      res.setHeader('Retry-After', evalRateLimit.retryAfterSeconds);
      res.status(429).json({
        error: 'Too Many Evaluation Requests: Evaluation creation rate limit exceeded.',
        retryAfterSeconds: evalRateLimit.retryAfterSeconds,
      });
      return;
    }

    const {
      sourceDoc,
      questionPaper,
      answerKey,
      facultyNotes,
      mode = 'with-manual',
      studentName,
      testTitle,
    } = req.body;

    if (mode !== 'with-manual' && mode !== 'without-manual') {
      res.status(400).json({ error: `Invalid evaluation mode '${mode}'.` });
      return;
    }

    if (!sourceDoc || (!sourceDoc.text && !sourceDoc.base64)) {
      res.status(400).json({ error: 'sourceDoc is required.' });
      return;
    }

    const srcErr = validateDocumentPayload(sourceDoc, 'sourceDoc');
    if (srcErr) {
      res.status(400).json({ error: srcErr });
      return;
    }

    if (mode === 'with-manual' && !facultyNotes) {
      res.status(400).json({ error: 'facultyNotes is required for with-manual mode.' });
      return;
    }

    const sanitizedStudentName = studentName ? String(studentName).trim().substring(0, 200) : undefined;
    const sanitizedTestTitle = testTitle ? String(testTitle).trim().substring(0, 200) : undefined;

    const job = evaluationQueue.enqueue(
      {
        sourceDoc,
        questionPaper,
        answerKey,
        facultyNotes,
        mode: mode as EvaluationMode,
        studentName: sanitizedStudentName,
        testTitle: sanitizedTestTitle,
      },
      user
    );

    const timeoutMs = Math.max(config.requestTimeoutMs * 2, 360000);
    const startTime = Date.now();

    const waitForJob = new Promise<EvaluationJob>((resolve, reject) => {
      const checkInterval = setInterval(() => {
        const current = evaluationQueue.getJob(job.id);
        if (!current) {
          clearInterval(checkInterval);
          reject(new Error('Job lost'));
          return;
        }

        if (current.status === 'completed') {
          clearInterval(checkInterval);
          resolve(current);
        } else if (current.status === 'failed' || current.status === 'needs_review' || current.status === 'cancelled') {
          clearInterval(checkInterval);
          reject(new Error(current.error || `Evaluation ended with status: ${current.status}`));
        } else if (Date.now() - startTime > timeoutMs) {
          clearInterval(checkInterval);
          reject(new Error('Evaluation timed out'));
        }
      }, 500);
    });

    const finishedJob = await waitForJob;
    res.json({
      report: finishedJob.report,
      metrics: finishedJob.metrics,
      jobId: finishedJob.id,
    });
  } catch (err: any) {
    console.error('[evaluationsRouter] Sync evaluation error:', err?.message || err);
    res.status(500).json({ error: err?.message || 'Sync evaluation failed' });
  }
});

/**
 * GET /api/evaluations
 * List evaluation jobs scoped to caller's authorization context
 */
evaluationsRouter.get('/', (req: Request, res: Response): void => {
  const user = (req as any).user as UserContext;
  const jobs = evaluationQueue.getAllJobs(user).map((j) => ({
    id: j.id,
    studentName: j.studentName,
    testTitle: j.testTitle,
    status: j.status,
    progressPercent: j.progressPercent,
    currentStepMessage: j.currentStepMessage,
    institutionId: j.institutionId,
    createdAt: j.createdAt,
    metrics: j.metrics,
  }));
  res.json(jobs);
});
