/**
 * Bounded Concurrency Job Queue and Durable Storage for NextGen Eval
 *
 * Implements Stage E (Concurrency & Scheduling):
 * - Bounded worker pool preventing Gemini rate limits & quota exhaustion
 * - Atomic disk persistence (.tmp write + atomic rename) preventing file corruption
 * - Startup recovery for interrupted jobs with automatic rescheduling
 * - Queue capacity limits and backpressure enforcement (HTTP 503 / 429)
 * - Tenant-aware job ownership tracking (institutionId, createdBy)
 * - Safe retry preventing duplicate runs
 * - Retention policy and secure deletion
 *
 * DURABILITY NOTE:
 * Local disk JSON storage provides crash-recovery across server restarts on persistent disk.
 * In distributed multi-replica or containerized auto-scaling environments (e.g., Kubernetes/Cloud Run),
 * replace local filesystem queue with Redis / BullMQ or Cloud SQL / PostgreSQL with distributed locking.
 */

import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';
import crypto from 'crypto';
import { config } from './config';
import { evaluationEngine } from './evaluator';
import { EvaluationJob, EvaluationMode, JobStatus } from './types';
import { UserContext, verifyJobAccess } from './auth';
import { evaluationMetadataService } from './evaluationMetadata';

export const MAX_QUEUE_CAPACITY = 50;

export class QueueCapacityError extends Error {
  public statusCode = 503;
  constructor(message: string) {
    super(message);
    this.name = 'QueueCapacityError';
  }
}

export class EvaluationQueue extends EventEmitter {
  private jobs = new Map<string, EvaluationJob>();
  private activeWorkers = 0;
  private queueDir: string;

  constructor() {
    super();
    this.queueDir = path.join(config.dataDir, 'jobs');
    try {
      if (!fs.existsSync(this.queueDir)) {
        fs.mkdirSync(this.queueDir, { recursive: true });
      }
      this.loadSavedJobs();
    } catch (e) {
      console.warn('[EvaluationQueue] Failed initializing storage directory:', e);
    }
  }

  /**
   * Load existing jobs from disk and automatically recover interrupted jobs
   */
  private loadSavedJobs() {
    try {
      const files = fs.readdirSync(this.queueDir);
      let recoveredCount = 0;
      for (const file of files) {
        const filePath = path.join(this.queueDir, file);

        // Clean up stale orphan temporary files older than 5 minutes
        if (file.includes('.tmp.')) {
          try {
            const stat = fs.statSync(filePath);
            if (Date.now() - stat.mtimeMs > 5 * 60 * 1000) {
              fs.unlinkSync(filePath);
              console.log(`[EvaluationQueue] Cleaned up stale temporary file: ${file}`);
            }
          } catch {}
          continue;
        }

        if (file.endsWith('.json')) {
          try {
            const raw = fs.readFileSync(filePath, 'utf-8');
            if (!raw || raw.trim().length === 0) {
              console.warn(`[EvaluationQueue] Corrupted empty job file removed: ${file}`);
              fs.unlinkSync(filePath);
              continue;
            }

            const job = JSON.parse(raw) as EvaluationJob;
            if (!job.id || !job.status) {
              console.warn(`[EvaluationQueue] Incomplete job record skipped: ${file}`);
              continue;
            }

            // Startup recovery for in-flight jobs interrupted by restart
            if (['preprocessing', 'grading', 'validating', 'assembling_report'].includes(job.status)) {
              job.status = 'queued';
              job.currentStepMessage = 'Recovered after restart; queued for processing.';
              job.updatedAt = Date.now();
              this.persistJob(job);
              recoveredCount++;
            }
            this.jobs.set(job.id, job);
          } catch (fileErr) {
            console.warn(`[EvaluationQueue] Corrupted job file skipped: ${file}`, fileErr);
          }
        }
      }
      console.log(`[EvaluationQueue] Loaded ${this.jobs.size} jobs from disk (${recoveredCount} recovered into queue).`);

      // Automatically trigger worker scheduling for recovered jobs
      setImmediate(() => this.processNext());
    } catch (e) {
      console.warn('[EvaluationQueue] Error recovering jobs:', e);
    }
  }

  /**
   * Atomic persistence to disk using temporary file and atomic rename
   */
  private persistJob(job: EvaluationJob) {
    const finalPath = path.join(this.queueDir, `${job.id}.json`);
    const tempPath = path.join(this.queueDir, `${job.id}.tmp.${Date.now()}_${crypto.randomBytes(3).toString('hex')}`);

    try {
      fs.writeFileSync(tempPath, JSON.stringify(job, null, 2), 'utf-8');
      fs.renameSync(tempPath, finalPath);
    } catch (e) {
      console.error(`[EvaluationQueue] Atomic persistence failure for job ${job.id}:`, e);
      try {
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      } catch {}
      throw new Error(`Failed to durably persist evaluation job: ${(e as any)?.message}`);
    }
  }

  public getQueuedCount(): number {
    return Array.from(this.jobs.values()).filter((j) => j.status === 'queued').length;
  }

  /**
   * Enqueue a new evaluation job with capacity and rate backpressure checks
   */
  public enqueue(
    payload: {
      sourceDoc: { name: string; text?: string; base64?: string; mimeType?: string };
      questionPaper?: { name: string; text?: string; base64?: string; mimeType?: string };
      answerKey?: { name: string; text?: string; base64?: string; mimeType?: string };
      answerKeyId?: string;
      canonicalAnswerKey?: any;
      facultyNotes?: { name: string; text?: string; base64?: string; mimeType?: string } | null;
      mode?: EvaluationMode;
      studentName?: string;
      testTitle?: string;
    },
    userContext?: UserContext | null
  ): EvaluationJob {
    // Backpressure enforcement
    const queuedCount = this.getQueuedCount();
    if (queuedCount >= MAX_QUEUE_CAPACITY) {
      throw new QueueCapacityError(
        `Evaluation queue capacity reached (${queuedCount}/${MAX_QUEUE_CAPACITY} queued). Please wait for ongoing jobs to complete.`
      );
    }

    const id = crypto.randomUUID();
    const correlationId = `eval_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const mode = payload.mode || 'without-manual';

    const job: EvaluationJob = {
      id,
      correlationId,
      status: 'queued',
      progressPercent: 0,
      currentStepMessage: 'Job queued for evaluation',
      mode,
      studentName: payload.studentName || 'Student',
      testTitle: payload.testTitle || 'Academic Assessment',
      institutionId: userContext?.institutionId || 'inst_aarshiv_01',
      createdBy: userContext?.userId || 'anonymous',
      creatorRole: userContext?.role || 'instructor',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      answerKeyId: payload.answerKeyId || payload.canonicalAnswerKey?.id,
      answerKeyVersion: payload.canonicalAnswerKey?.version,
      answerKeySourceMode: payload.canonicalAnswerKey?.sourceMode,
      canonicalAnswerKey: payload.canonicalAnswerKey,
      metrics: {
        correlationId,
        startTime: Date.now(),
        cacheHit: false,
        retriesCount: 0,
      },
      inputPayload: {
        sourceDoc: payload.sourceDoc,
        questionPaper: payload.questionPaper,
        answerKey: payload.answerKey,
        answerKeyId: payload.answerKeyId || payload.canonicalAnswerKey?.id,
        canonicalAnswerKey: payload.canonicalAnswerKey,
        facultyNotes: payload.facultyNotes,
      },
    };

    this.jobs.set(id, job);
    this.persistJob(job);
    this.emit('job:created', job);

    // Schedule queue worker
    setImmediate(() => this.processNext());

    return job;
  }

  public getJob(id: string): EvaluationJob | undefined {
    return this.jobs.get(id);
  }

  public getAllJobs(userContext?: UserContext): EvaluationJob[] {
    const all = Array.from(this.jobs.values()).sort((a, b) => b.createdAt - a.createdAt);
    if (!userContext || userContext.role === 'operator') {
      return all;
    }
    return all.filter((j) => verifyJobAccess(j, userContext));
  }

  public retryJob(id: string, userContext?: UserContext | null): EvaluationJob | null {
    const job = this.jobs.get(id);
    if (!job) return null;

    if (userContext && !verifyJobAccess(job, userContext)) {
      throw new Error('Forbidden: Unauthorized to retry this evaluation job.');
    }

    if (job.status !== 'failed' && job.status !== 'needs_review') {
      return job;
    }

    job.status = 'queued';
    job.progressPercent = 0;
    job.error = undefined;
    job.currentStepMessage = 'Retrying evaluation job...';
    job.updatedAt = Date.now();
    job.metrics.retriesCount++;

    this.persistJob(job);
    this.emit('job:updated', job);

    setImmediate(() => this.processNext());
    return job;
  }

  public cancelJob(id: string, userContext?: UserContext | null): EvaluationJob | null {
    const job = this.jobs.get(id);
    if (!job) return null;

    if (userContext && !verifyJobAccess(job, userContext)) {
      throw new Error('Forbidden: Unauthorized to cancel this evaluation job.');
    }

    if (job.status === 'completed') {
      throw new Error('Cannot cancel a completed evaluation job.');
    }

    job.status = 'cancelled';
    job.currentStepMessage = 'Evaluation job was cancelled by user.';
    job.updatedAt = Date.now();
    this.persistJob(job);
    try {
      evaluationMetadataService.generateMetadata(job);
    } catch (metaErr) {
      console.warn('[EvaluationQueue] Metadata error on cancel:', metaErr);
    }
    this.emit('job:cancelled', job);
    return job;
  }

  public deleteJob(id: string, userContext?: UserContext | null): boolean {
    const job = this.jobs.get(id);
    if (!job) return false;

    if (userContext && !verifyJobAccess(job, userContext)) {
      throw new Error('Forbidden: Unauthorized to delete this evaluation job.');
    }

    this.jobs.delete(id);
    try {
      const filePath = path.join(this.queueDir, `${id}.json`);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch (e) {
      console.warn(`[EvaluationQueue] Failed unlinking job file ${id}:`, e);
    }
    return true;
  }

  /**
   * Process jobs with bounded worker concurrency and prevent duplicate execution
   */
  private async processNext() {
    if (this.activeWorkers >= config.maxConcurrentEvaluations) {
      return;
    }

    // Atomically find next queued job
    const nextJob = Array.from(this.jobs.values()).find((j) => j.status === 'queued');
    if (!nextJob) return;

    // Immediately claim job to prevent duplicate assignment
    nextJob.status = 'preprocessing';
    nextJob.currentStepMessage = 'Initializing evaluation worker...';
    nextJob.updatedAt = Date.now();
    this.persistJob(nextJob);

    this.activeWorkers++;
    const job = nextJob;

    try {
      console.log(
        `[EvaluationQueue] Processing job ${job.id} (${job.studentName}). Concurrency: ${this.activeWorkers}/${config.maxConcurrentEvaluations}`
      );

      const report = await evaluationEngine.evaluate(job, (percent, msg) => {
        job.progressPercent = percent;
        job.currentStepMessage = msg;
        job.updatedAt = Date.now();
        this.persistJob(job);
        this.emit('job:progress', job);
      });

      job.report = report;
      job.status = 'completed';
      job.progressPercent = 100;
      job.currentStepMessage = 'Evaluation complete and verified';
      job.updatedAt = Date.now();
      this.persistJob(job);
      try {
        evaluationMetadataService.generateMetadata(job);
      } catch (metaErr) {
        console.warn('[EvaluationQueue] Metadata error on complete:', metaErr);
      }
      this.emit('job:completed', job);
    } catch (err: any) {
      console.error(`[EvaluationQueue] Job ${job.id} error:`, err?.message || err);

      // Distinguish academic validation review requirement from system failures
      if (err?.name === 'ValidationError') {
        job.status = 'needs_review';
        job.error = `Academic Validation Discrepancy: ${err.message}`;
        job.errorCategory = 'Academic Validation Discrepancy';
        job.statusCode = 422;
        job.isRetryable = false;
        job.currentStepMessage = `Needs Review: ${err.message}`;
      } else {
        const is503 =
          err?.statusCode === 503 ||
          err?.status === 503 ||
          /503|unavailable|high demand|overloaded/i.test(err?.message || '') ||
          /<!doctype|<html|unexpected token '<'|is not valid json/i.test(err?.message || '');
        job.status = 'failed';
        job.error = err?.message || 'Unknown evaluation failure';
        job.errorCategory = err?.category || (is503 ? 'Gemini Server Temporarily Busy (503)' : 'Evaluation Failure');
        job.statusCode = is503 ? 503 : (err?.statusCode || err?.status || 500);
        job.isRetryable = err?.retryable !== undefined ? err.retryable : is503;
        job.currentStepMessage = `Failed: ${job.error}`;
      }

      job.updatedAt = Date.now();
      this.persistJob(job);
      try {
        evaluationMetadataService.generateMetadata(job);
      } catch (metaErr) {
        console.warn('[EvaluationQueue] Metadata error on failure:', metaErr);
      }
      this.emit('job:failed', job);
    } finally {
      this.activeWorkers--;
      setImmediate(() => this.processNext());
    }
  }

  /**
   * Prune expired jobs older than retention period
   */
  public pruneExpiredJobs(retentionDays = 30): number {
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    let pruned = 0;
    for (const [id, job] of this.jobs.entries()) {
      if (['completed', 'failed'].includes(job.status) && job.createdAt < cutoff) {
        this.deleteJob(id);
        pruned++;
      }
    }
    return pruned;
  }

  public getQueueMetrics() {
    const jobs = Array.from(this.jobs.values());
    const completed = jobs.filter((j) => j.status === 'completed');
    const failed = jobs.filter((j) => j.status === 'failed');
    const needsReview = jobs.filter((j) => j.status === 'needs_review');
    const queued = jobs.filter((j) => j.status === 'queued');
    const running = jobs.filter((j) =>
      ['preprocessing', 'grading', 'validating', 'assembling_report'].includes(j.status)
    );

    const totalCost = completed.reduce((acc, j) => acc + (j.metrics.estimatedCostUsd || 0), 0);
    const totalLatency = completed.reduce((acc, j) => acc + (j.metrics.totalLatencyMs || 0), 0);
    const avgLatencyMs = completed.length > 0 ? Math.round(totalLatency / completed.length) : 0;

    return {
      activeWorkers: this.activeWorkers,
      maxWorkers: config.maxConcurrentEvaluations,
      maxQueueCapacity: MAX_QUEUE_CAPACITY,
      totalJobs: jobs.length,
      queued: queued.length,
      running: running.length,
      completed: completed.length,
      failed: failed.length,
      needsReview: needsReview.length,
      avgLatencyMs,
      totalEstimatedCostUsd: parseFloat(totalCost.toFixed(4)),
    };
  }
}

export const evaluationQueue = new EvaluationQueue();
