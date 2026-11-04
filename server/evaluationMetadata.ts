/**
 * Developer-Only Evaluation Cost & Performance Metadata Generator for Anatomy Guru
 *
 * Implements strict server-side audit requirements:
 * - Generates metadata.json in private backend directory (.data/evaluations/metadata/)
 * - Emits structured developer log with exact prefix: [ANATOMY GURU EVALUATION COST METADATA]
 * - Records actual Gemini input/output/cached tokens, primary and fallback models
 * - Records isolated extraction and grading stage costs (USD and INR)
 * - Records total retries, fallbacks, API call attempts, and API & pipeline latency
 * - Preserves partial usage data for failed/aborted evaluations
 * - Never fabricates missing token counts or costs (strict null preservation)
 * - Remains strictly server-side, emitted only to developer logs (never dashboards or student reports)
 * - Never includes student names, student answers, or API keys in the developer log
 * - Integrates with existing usageLedger and pricing engine
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { config } from './config';
import { usageLedger, GeminiAttemptRecord, UsageSourceType } from './usageLedger';
import { EvaluationJob, JobStatus } from './types';
import { ACTIVE_PRICING_VERSION } from './pricing';

export interface StageUsageDetail {
  status: 'success' | 'failed' | 'skipped' | 'not_attempted';
  calls: number;
  retries: number;
  model: string | null;
  latencyMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
  totalTokens: number | null;
  costUsd: number | null;
  costInr: number | null;
}

export interface EvaluationCostMetadata {
  evaluationId: string;
  correlationId: string;
  studentName: string;
  testTitle: string;
  mode: string;
  evaluationStatus: JobStatus;
  error: string | null;

  // Model details
  model: string;
  modelsUsed: string[];

  // Actual Gemini token counts across stages
  tokens: {
    inputTokens: number | null;
    outputTokens: number | null;
    cachedTokens: number | null;
    totalTokens: number | null;
  };

  // Distinct extraction and grading costs (USD and converted INR)
  extractionCost: {
    usd: number | null;
    inr: number | null;
  };
  gradingCost: {
    usd: number | null;
    inr: number | null;
  };
  totalCost: {
    usd: number | null;
    inr: number | null;
  };

  // Stage breakdown
  stages: {
    extraction: StageUsageDetail;
    grading: StageUsageDetail;
  };

  // Retries, API calls, and latency
  retries: number;
  fallbacks: number;
  apiCalls: number;
  successfulCalls: number;
  failedCalls: number;
  apiLatencyMs: number;
  latencyMs: number;

  // Pricing configuration and conversion details
  pricing: {
    version: string;
    exchangeRateUsed: number;
  };

  // Strict zero-fabrication and integrity metadata
  zeroFabrication: {
    isCostCalculable: boolean;
    uncalculatedReason: string | null;
    usageCompleteness: 'COMPLETE' | 'PARTIAL' | 'UNAVAILABLE';
    dataSource: UsageSourceType;
    isPartial: boolean;
  };

  // Audit timestamps
  timestamp: number;
  createdAt: string;
}

export class EvaluationMetadataService {
  private metadataBaseDir: string;

  constructor() {
    this.metadataBaseDir = path.join(config.dataDir, 'metadata');
    try {
      if (!fs.existsSync(this.metadataBaseDir)) {
        fs.mkdirSync(this.metadataBaseDir, { recursive: true });
      }
    } catch (e) {
      console.warn('[EvaluationMetadataService] Error creating metadata directory:', e);
    }
  }

  /**
   * Generates and atomically persists developer-only evaluation cost metadata
   */
  public generateMetadata(job: EvaluationJob): EvaluationCostMetadata {
    const exchangeRate = parseFloat(process.env.USD_TO_INR_RATE || '85.0');

    // Retrieve ledger entries recorded by geminiClient for this job
    const usageSummary = usageLedger.getJobUsageSummary(job.id, {
      userId: 'system_dev_auditor',
      role: 'operator',
      institutionId: job.institutionId || 'inst_anatomy_guru',
      name: 'System Developer Auditor',
    });

    const calls: GeminiAttemptRecord[] = usageSummary?.calls || [];

    // Separate calls by pipeline stage
    const extractionCalls = calls.filter(
      (c) => c.pipelineStage === 'student_extraction' || c.pipelineStage === 'extraction'
    );
    const gradingCalls = calls.filter((c) => c.pipelineStage === 'grading');

    // Analyze extraction stage
    const extractionDetail = this.analyzeStage(extractionCalls, exchangeRate, Boolean(job.canonicalAnswerKey));

    // Analyze grading stage
    const gradingDetail = this.analyzeStage(gradingCalls, exchangeRate, true);

    // Compute aggregated token metrics without fabrication
    const aggregatedTokens = this.calculateAggregatedTokens(extractionDetail, gradingDetail, calls);

    // Compute costs
    const { totalCostUsd, totalCostInr, isCostCalculable, uncalculatedReason } = this.calculateTotalCosts(
      extractionDetail,
      gradingDetail,
      exchangeRate,
      calls
    );

    // Models used
    const modelsUsed = Array.from(new Set(calls.map((c) => c.actualModel || c.requestedModel).filter(Boolean)));
    const primaryModel: string =
      job.metrics?.modelUsed ||
      modelsUsed[0] ||
      config.primaryModel;

    // Total retries, fallbacks, and calls
    const retriedCalls = calls.filter((c) => c.attemptNumber > 1).length;
    const fallbackCalls = calls.filter((c) => c.isFallback).length;
    const successfulCalls = calls.filter((c) => c.status === 'success').length;
    const failedCalls = calls.filter((c) => c.status === 'failed' || c.status === 'timeout').length;

    // Latency
    const apiLatencyMs = calls.reduce((acc, c) => acc + (c.latencyMs || 0), 0);
    const latencyMs = job.metrics?.totalLatencyMs ?? (
      job.metrics?.startTime ? Date.now() - job.metrics.startTime : 0
    );

    // Completeness check
    const isPartial =
      job.status !== 'completed' ||
      (extractionCalls.length > 0 && extractionDetail.status !== 'success') ||
      (gradingCalls.length > 0 && gradingDetail.status !== 'success') ||
      usageSummary?.usageCompleteness === 'PARTIAL';

    const usageCompleteness = usageSummary?.usageCompleteness || (
      calls.length === 0 ? 'UNAVAILABLE' : (isPartial ? 'PARTIAL' : 'COMPLETE')
    );

    const dataSource: UsageSourceType = usageSummary?.dataSource || (
      calls.length > 0 ? calls[0].usageSource : 'UNKNOWN'
    );

    const metadata: EvaluationCostMetadata = {
      evaluationId: job.id,
      correlationId: job.correlationId,
      studentName: job.studentName,
      testTitle: job.testTitle || 'Academic Assessment',
      mode: job.mode,
      evaluationStatus: job.status,
      error: job.error || null,

      model: primaryModel,
      modelsUsed: modelsUsed.length > 0 ? modelsUsed : [primaryModel],

      tokens: aggregatedTokens,

      extractionCost: {
        usd: extractionDetail.costUsd,
        inr: extractionDetail.costInr,
      },
      gradingCost: {
        usd: gradingDetail.costUsd,
        inr: gradingDetail.costInr,
      },
      totalCost: {
        usd: totalCostUsd,
        inr: totalCostInr,
      },

      stages: {
        extraction: extractionDetail,
        grading: gradingDetail,
      },

      retries: retriedCalls,
      fallbacks: fallbackCalls,
      apiCalls: calls.length,
      successfulCalls,
      failedCalls,
      apiLatencyMs,
      latencyMs,

      pricing: {
        version: usageSummary?.pricingVersion || ACTIVE_PRICING_VERSION,
        exchangeRateUsed: exchangeRate,
      },

      zeroFabrication: {
        isCostCalculable,
        uncalculatedReason,
        usageCompleteness,
        dataSource,
        isPartial,
      },

      timestamp: Date.now(),
      createdAt: new Date().toISOString(),
    };

    // Persist to private backend directory
    this.persistMetadataToDisk(metadata);

    // Log exclusively to developer console (strictly server-side)
    this.emitDeveloperLog(metadata);

    return metadata;
  }

  /**
   * Analyzes an individual pipeline stage (extraction or grading)
   */
  private analyzeStage(
    calls: GeminiAttemptRecord[],
    exchangeRate: number,
    isApplicable: boolean
  ): StageUsageDetail {
    if (!isApplicable && calls.length === 0) {
      return {
        status: 'skipped',
        calls: 0,
        retries: 0,
        model: null,
        latencyMs: 0,
        inputTokens: null,
        outputTokens: null,
        cachedTokens: null,
        totalTokens: null,
        costUsd: null,
        costInr: null,
      };
    }

    if (calls.length === 0) {
      return {
        status: 'not_attempted',
        calls: 0,
        retries: 0,
        model: null,
        latencyMs: 0,
        inputTokens: null,
        outputTokens: null,
        cachedTokens: null,
        totalTokens: null,
        costUsd: null,
        costInr: null,
      };
    }

    const retries = calls.filter((c) => c.attemptNumber > 1).length;
    const latencyMs = calls.reduce((acc, c) => acc + (c.latencyMs || 0), 0);
    const models = Array.from(new Set(calls.map((c) => c.actualModel || c.requestedModel)));
    const model = models[0] || null;

    const successful = calls.filter((c) => c.status === 'success');

    if (successful.length === 0) {
      // Stage was attempted but all attempts failed
      return {
        status: 'failed',
        calls: calls.length,
        retries,
        model,
        latencyMs,
        inputTokens: null,
        outputTokens: null,
        cachedTokens: null,
        totalTokens: null,
        costUsd: null,
        costInr: null,
      };
    }

    // Only count tokens from the successful call to avoid double-counting retried failures
    const primarySuccess = successful[successful.length - 1];

    const hasInputTokens = primarySuccess.inputTokens !== null && primarySuccess.inputTokens !== undefined;
    const hasOutputTokens = primarySuccess.outputTokens !== null && primarySuccess.outputTokens !== undefined;

    let inputTokens: number | null = null;
    let outputTokens: number | null = null;
    let cachedTokens: number | null = null;
    let totalTokens: number | null = null;

    if (hasInputTokens && hasOutputTokens) {
      inputTokens = primarySuccess.inputTokens;
      outputTokens = primarySuccess.outputTokens;
      cachedTokens = primarySuccess.cachedInputTokens ?? 0;
      totalTokens = (inputTokens ?? 0) + (outputTokens ?? 0);
    }

    const costUsd = primarySuccess.estimatedCostUsd ?? null;
    const costInr = costUsd !== null ? parseFloat((costUsd * exchangeRate).toFixed(4)) : null;

    return {
      status: 'success',
      calls: calls.length,
      retries,
      model: primarySuccess.actualModel || model,
      latencyMs,
      inputTokens,
      outputTokens,
      cachedTokens,
      totalTokens,
      costUsd,
      costInr,
    };
  }

  /**
   * Aggregates token counts across stages without fabricating missing values
   */
  private calculateAggregatedTokens(
    ext: StageUsageDetail,
    grd: StageUsageDetail,
    calls: GeminiAttemptRecord[]
  ): {
    inputTokens: number | null;
    outputTokens: number | null;
    cachedTokens: number | null;
    totalTokens: number | null;
  } {
    if (calls.length === 0) {
      return { inputTokens: null, outputTokens: null, cachedTokens: null, totalTokens: null };
    }

    const successfulCalls = calls.filter((c) => c.status === 'success');
    if (successfulCalls.length === 0) {
      return { inputTokens: null, outputTokens: null, cachedTokens: null, totalTokens: null };
    }

    // If any successful call is missing token counts, do NOT fabricate 0
    const anyMissing = successfulCalls.some(
      (c) => c.inputTokens === null || c.inputTokens === undefined || c.outputTokens === null || c.outputTokens === undefined
    );

    if (anyMissing) {
      return { inputTokens: null, outputTokens: null, cachedTokens: null, totalTokens: null };
    }

    let inputTokens = 0;
    let outputTokens = 0;
    let cachedTokens = 0;

    if (ext.status === 'success' && ext.inputTokens !== null) {
      inputTokens += ext.inputTokens;
      outputTokens += ext.outputTokens || 0;
      cachedTokens += ext.cachedTokens || 0;
    }

    if (grd.status === 'success' && grd.inputTokens !== null) {
      inputTokens += grd.inputTokens;
      outputTokens += grd.outputTokens || 0;
      cachedTokens += grd.cachedTokens || 0;
    }

    // If both stages were not applicable/skipped, aggregate directly from successful calls
    if (ext.status !== 'success' && grd.status !== 'success') {
      for (const call of successfulCalls) {
        inputTokens += call.inputTokens || 0;
        outputTokens += call.outputTokens || 0;
        cachedTokens += call.cachedInputTokens || 0;
      }
    }

    return {
      inputTokens,
      outputTokens,
      cachedTokens,
      totalTokens: inputTokens + outputTokens,
    };
  }

  /**
   * Aggregates total USD and INR costs with strict calculation boundaries
   */
  private calculateTotalCosts(
    ext: StageUsageDetail,
    grd: StageUsageDetail,
    exchangeRate: number,
    calls: GeminiAttemptRecord[]
  ): {
    totalCostUsd: number | null;
    totalCostInr: number | null;
    isCostCalculable: boolean;
    uncalculatedReason: string | null;
  } {
    if (calls.length === 0) {
      return {
        totalCostUsd: null,
        totalCostInr: null,
        isCostCalculable: false,
        uncalculatedReason: 'NO_API_CALLS_RECORDED',
      };
    }

    const successfulCalls = calls.filter((c) => c.status === 'success');
    if (successfulCalls.length === 0) {
      return {
        totalCostUsd: null,
        totalCostInr: null,
        isCostCalculable: false,
        uncalculatedReason: 'NO_SUCCESSFUL_API_CALLS',
      };
    }

    let sumUsd = 0;
    let hasKnownCost = false;

    if (ext.status === 'success' && ext.costUsd !== null) {
      sumUsd += ext.costUsd;
      hasKnownCost = true;
    }

    if (grd.status === 'success' && grd.costUsd !== null) {
      sumUsd += grd.costUsd;
      hasKnownCost = true;
    }

    // Fallback directly to calls if stage categorization was not active (e.g. single stage)
    if (!hasKnownCost) {
      for (const call of successfulCalls) {
        if (call.estimatedCostUsd !== null) {
          sumUsd += call.estimatedCostUsd;
          hasKnownCost = true;
        }
      }
    }

    if (!hasKnownCost) {
      return {
        totalCostUsd: null,
        totalCostInr: null,
        isCostCalculable: false,
        uncalculatedReason: 'MISSING_TOKEN_METADATA_OR_PRICING',
      };
    }

    const roundedUsd = parseFloat(sumUsd.toFixed(6));
    const roundedInr = parseFloat((roundedUsd * exchangeRate).toFixed(4));

    return {
      totalCostUsd: roundedUsd,
      totalCostInr: roundedInr,
      isCostCalculable: true,
      uncalculatedReason: null,
    };
  }

  /**
   * Atomically writes metadata.json to private backend directory
   */
  private persistMetadataToDisk(metadata: EvaluationCostMetadata) {
    try {
      const jobDir = path.join(this.metadataBaseDir, metadata.evaluationId);
      if (!fs.existsSync(jobDir)) {
        fs.mkdirSync(jobDir, { recursive: true });
      }

      const jsonContent = JSON.stringify(metadata, null, 2);

      // 1. Write metadata.json inside evaluation directory (.data/evaluations/metadata/<jobId>/metadata.json)
      const primaryPath = path.join(jobDir, 'metadata.json');
      const tempPrimary = path.join(
        jobDir,
        `metadata.tmp.${Date.now()}_${crypto.randomBytes(3).toString('hex')}`
      );
      fs.writeFileSync(tempPrimary, jsonContent, 'utf-8');
      fs.renameSync(tempPrimary, primaryPath);

      // 2. Write direct job file (.data/evaluations/metadata/<jobId>.json)
      const flatPath = path.join(this.metadataBaseDir, `${metadata.evaluationId}.json`);
      const tempFlat = path.join(
        this.metadataBaseDir,
        `${metadata.evaluationId}.tmp.${Date.now()}_${crypto.randomBytes(3).toString('hex')}`
      );
      fs.writeFileSync(tempFlat, jsonContent, 'utf-8');
      fs.renameSync(tempFlat, flatPath);

      // 3. Write latest pointer (.data/evaluations/metadata/metadata.json)
      const latestPath = path.join(this.metadataBaseDir, 'metadata.json');
      const tempLatest = path.join(
        this.metadataBaseDir,
        `metadata.tmp.${Date.now()}_${crypto.randomBytes(3).toString('hex')}`
      );
      fs.writeFileSync(tempLatest, jsonContent, 'utf-8');
      fs.renameSync(tempLatest, latestPath);
    } catch (err) {
      console.error('[EvaluationMetadataService] Error writing evaluation metadata to disk:', err);
    }
  }

  /**
   * Emits structured evaluation cost and usage metrics exclusively to developer logs
   * with the exact prefix [ANATOMY GURU EVALUATION COST METADATA].
   * Kept strictly server-side; NEVER exposes student personal data, answers, or credentials.
   */
  private emitDeveloperLog(meta: EvaluationCostMetadata) {
    const costUsdStr = meta.totalCost.usd !== null ? `$${meta.totalCost.usd.toFixed(6)}` : 'N/A';
    const costInrStr = meta.totalCost.inr !== null ? `₹${meta.totalCost.inr.toFixed(4)}` : 'N/A';
    const extCostUsdStr = meta.stages.extraction.status === 'skipped'
      ? 'SKIPPED'
      : (meta.extractionCost.usd !== null ? `$${meta.extractionCost.usd.toFixed(6)}` : 'N/A');
    const extCostInrStr = meta.stages.extraction.status === 'skipped'
      ? 'SKIPPED'
      : (meta.extractionCost.inr !== null ? `₹${meta.extractionCost.inr.toFixed(4)}` : 'N/A');
    const grdCostUsdStr = meta.gradingCost.usd !== null ? `$${meta.gradingCost.usd.toFixed(6)}` : 'N/A';
    const grdCostInrStr = meta.gradingCost.inr !== null ? `₹${meta.gradingCost.inr.toFixed(4)}` : 'N/A';

    // Figure status: actual, estimated, partial, or unavailable
    let figureStatus: 'actual' | 'estimated' | 'partial' | 'unavailable' = 'unavailable';
    if (meta.zeroFabrication.isCostCalculable) {
      if (meta.zeroFabrication.isPartial) {
        figureStatus = 'partial';
      } else if (meta.zeroFabrication.dataSource === 'ACTUAL_API') {
        figureStatus = 'actual';
      } else {
        figureStatus = 'estimated';
      }
    } else if (meta.zeroFabrication.isPartial) {
      figureStatus = 'partial';
    } else {
      figureStatus = 'unavailable';
    }

    const extInTokens = meta.stages.extraction.inputTokens !== null ? meta.stages.extraction.inputTokens : 'null';
    const extOutTokens = meta.stages.extraction.outputTokens !== null ? meta.stages.extraction.outputTokens : 'null';
    const grdInTokens = meta.stages.grading.inputTokens !== null ? meta.stages.grading.inputTokens : 'null';
    const grdOutTokens = meta.stages.grading.outputTokens !== null ? meta.stages.grading.outputTokens : 'null';
    const cachedTokens = meta.tokens.cachedTokens !== null ? meta.tokens.cachedTokens : 'null';
    const totInTokens = meta.tokens.inputTokens !== null ? meta.tokens.inputTokens : 'null';
    const totOutTokens = meta.tokens.outputTokens !== null ? meta.tokens.outputTokens : 'null';

    console.log(
      `[ANATOMY GURU EVALUATION COST METADATA] ` +
      `evaluationId=${meta.evaluationId} ` +
      `status=${meta.evaluationStatus} ` +
      `models=${meta.modelsUsed.join(',')} ` +
      `totalApiCalls=${meta.apiCalls} (successful=${meta.successfulCalls},failed=${meta.failedCalls}) ` +
      `retries=${meta.retries} ` +
      `fallbacks=${meta.fallbacks} ` +
      `extractionTokens(in=${extInTokens},out=${extOutTokens}) ` +
      `gradingTokens(in=${grdInTokens},out=${grdOutTokens}) ` +
      `cachedTokens=${cachedTokens} ` +
      `totalTokens(in=${totInTokens},out=${totOutTokens}) ` +
      `extractionCost=${extCostUsdStr} (${extCostInrStr}) ` +
      `gradingCost=${grdCostUsdStr} (${grdCostInrStr}) ` +
      `totalCost=${costUsdStr} (${costInrStr}) ` +
      `exchangeRate=₹${meta.pricing.exchangeRateUsed} ` +
      `apiLatency=${meta.apiLatencyMs}ms ` +
      `totalEvaluationTime=${meta.latencyMs}ms ` +
      `figureStatus=${figureStatus} ` +
      `dataSource=${meta.zeroFabrication.dataSource} ` +
      `completeness=${meta.zeroFabrication.usageCompleteness} ` +
      `calculable=${meta.zeroFabrication.isCostCalculable} ` +
      `partial=${meta.zeroFabrication.isPartial}`
    );
  }

  /**
   * Retrieves developer metadata for a specific evaluation from disk or memory (Server-side inspection only)
   */
  public getMetadata(evaluationId: string): EvaluationCostMetadata | null {
    try {
      const primaryPath = path.join(this.metadataBaseDir, evaluationId, 'metadata.json');
      if (fs.existsSync(primaryPath)) {
        return JSON.parse(fs.readFileSync(primaryPath, 'utf-8')) as EvaluationCostMetadata;
      }

      const flatPath = path.join(this.metadataBaseDir, `${evaluationId}.json`);
      if (fs.existsSync(flatPath)) {
        return JSON.parse(fs.readFileSync(flatPath, 'utf-8')) as EvaluationCostMetadata;
      }
    } catch (e) {
      console.warn(`[EvaluationMetadataService] Could not read metadata for ${evaluationId}:`, e);
    }
    return null;
  }
}

export const evaluationMetadataService = new EvaluationMetadataService();
