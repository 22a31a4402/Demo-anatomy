/**
 * Immutable Usage & Cost Telemetry Ledger for NextGen Eval
 *
 * Implements Phase 2 Requirements:
 * - Records every Gemini request attempt, retry, and fallback with granular usage metadata
 * - Strict classification of data sources: ACTUAL_API, SIMULATED_MOCK, IMPORTED_BILLED, UNKNOWN
 * - Per-evaluation aggregation with retry/fallback cost separation and stage breakdowns
 * - Batch statistics (mean, median, P90/P95 with sample size disclosure)
 * - Multi-tenant isolation and atomic file persistence
 * - Zero storage of student personal answers, prompts, or sensitive credentials
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { config } from './config';
import { UserContext } from './auth';
import {
  calculateCallCost,
  ACTIVE_PRICING_VERSION,
  CostCalculationResult,
} from './pricing';

export type UsageSourceType =
  | 'ACTUAL_API'        // Verified token counts from real Gemini / Vertex AI response metadata
  | 'SIMULATED_MOCK'    // Simulated token counts produced by offline mock provider / benchmark
  | 'IMPORTED_BILLED'   // Reconciled billing figures imported from Google Cloud Billing exports
  | 'UNKNOWN';          // Missing metadata from API response

export type PipelineStage =
  | 'preprocessing'
  | 'grading'
  | 'validating'
  | 'assembling_report'
  | 'extraction'
  | 'student_extraction'
  | 'answer_key_generation'
  | 'answer_key_extraction'
  | 'correction'
  | 'escalation';

export interface GeminiAttemptRecord {
  callId: string;
  jobId: string;
  correlationId: string;
  institutionId: string;
  pipelineStage: PipelineStage;
  requestedModel: string;
  actualModel: string;
  attemptNumber: number;
  isFallback: boolean;
  status: 'success' | 'failed' | 'timeout' | 'cancelled';
  errorCategory?: string;
  latencyMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  totalTokens: number | null;
  usageSource: UsageSourceType;
  estimatedCostUsd: number | null;
  estimatedCostInr: number | null;
  pricingVersion: string;
  pricingTierUsed: string | null;
  timestamp: number;
}

export interface EvaluationUsageSummary {
  jobId: string;
  institutionId: string;
  correlationId: string;
  totalCalls: number;
  successfulCalls: number;
  failedCalls: number;
  retriedCalls: number;
  fallbackCalls: number;
  totalInputTokens: number | null;
  totalOutputTokens: number | null;
  totalCachedTokens: number | null;
  totalTokens: number | null;
  totalEstimatedCostUsd: number | null;
  totalEstimatedCostInr: number | null;
  retryAndFallbackCostUsd: number | null;
  stageBreakdown: Record<string, { calls: number; costUsd: number; tokens: number }>;
  modelsUsed: string[];
  pricingVersion: string;
  exchangeRateUsed: number;
  usageCompleteness: 'COMPLETE' | 'PARTIAL' | 'UNAVAILABLE';
  dataSource: UsageSourceType;
  calls: GeminiAttemptRecord[];
  createdAt: number;
  updatedAt: number;
}

export interface BatchUsageFilter {
  institutionId?: string;
  startDate?: number;
  endDate?: number;
  dataSource?: UsageSourceType;
}

export interface BatchUsageStatistics {
  institutionId: string;
  sampleSize: number;
  dateRange: { start: string; end: string };
  totalEvaluations: number;
  totalApiCalls: number;
  averageCallsPerEvaluation: number;
  retryRatePercent: number;
  fallbackRatePercent: number;
  failureRatePercent: number;
  tokenTotals: {
    input: number;
    output: number;
    cached: number;
    total: number;
  };
  costs: {
    totalUsd: number;
    totalInr: number;
    meanCostUsd: number;
    meanCostInr: number;
    medianCostUsd: number;
    medianCostInr: number;
    p90CostUsd: number | null;
    p95CostUsd: number | null;
    sampleSizeSufficientForPercentiles: boolean;
  };
  stageDistribution: Record<string, { callCount: number; totalCostUsd: number }>;
  modelDistribution: Record<string, { callCount: number; totalCostUsd: number }>;
  usageCompleteness: {
    completeCount: number;
    partialCount: number;
    unavailableCount: number;
  };
  dataSource: UsageSourceType | 'MIXED';
}

export class UsageLedgerService {
  private ledgerDir: string;
  private memoryLedger = new Map<string, EvaluationUsageSummary>();

  constructor() {
    this.ledgerDir = path.join(config.dataDir, 'usage_ledger');
    try {
      if (!fs.existsSync(this.ledgerDir)) {
        fs.mkdirSync(this.ledgerDir, { recursive: true });
      }
      this.loadSavedLedgers();
    } catch (e) {
      console.warn('[UsageLedger] Directory initialization note:', e);
    }
  }

  private loadSavedLedgers() {
    try {
      const files = fs.readdirSync(this.ledgerDir);
      let loaded = 0;
      for (const file of files) {
        if (file.endsWith('.json') && !file.includes('.tmp.')) {
          try {
            const raw = fs.readFileSync(path.join(this.ledgerDir, file), 'utf-8');
            const summary = JSON.parse(raw) as EvaluationUsageSummary;
            if (summary.jobId) {
              this.memoryLedger.set(summary.jobId, summary);
              loaded++;
            }
          } catch (fileErr) {
            console.warn(`[UsageLedger] Corrupted ledger file skipped: ${file}`, fileErr);
          }
        }
      }
      console.log(`[UsageLedger] Initialized with ${loaded} evaluation usage summaries.`);
    } catch (e) {
      console.warn('[UsageLedger] Error loading existing ledgers:', e);
    }
  }

  private persistSummary(summary: EvaluationUsageSummary) {
    const finalPath = path.join(this.ledgerDir, `${summary.jobId}.json`);
    const tempPath = path.join(
      this.ledgerDir,
      `${summary.jobId}.tmp.${Date.now()}_${crypto.randomBytes(3).toString('hex')}`
    );

    try {
      fs.writeFileSync(tempPath, JSON.stringify(summary, null, 2), 'utf-8');
      fs.renameSync(tempPath, finalPath);
    } catch (e) {
      console.error(`[UsageLedger] Failed persisting usage summary for job ${summary.jobId}:`, e);
      try {
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      } catch {}
    }
  }

  /**
   * Records a single Gemini attempt in the immutable audit ledger
   */
  public recordAttempt(params: {
    jobId: string;
    correlationId: string;
    institutionId: string;
    pipelineStage: PipelineStage;
    requestedModel: string;
    actualModel?: string;
    attemptNumber: number;
    isFallback: boolean;
    status: 'success' | 'failed' | 'timeout' | 'cancelled';
    errorCategory?: string;
    latencyMs: number;
    inputTokens?: number | null;
    outputTokens?: number | null;
    cachedInputTokens?: number | null;
    usageSource?: UsageSourceType;
    pricingVersion?: string;
    customUsdToInrRate?: number;
  }): GeminiAttemptRecord {
    const callId = `call_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
    const actualModel = params.actualModel || params.requestedModel;
    const usageSource: UsageSourceType = params.usageSource || 'ACTUAL_API';

    // Calculate cost via central pricing module
    const costResult: CostCalculationResult = calculateCallCost({
      model: actualModel,
      inputTokens: params.inputTokens ?? null,
      outputTokens: params.outputTokens ?? null,
      cachedInputTokens: params.cachedInputTokens ?? null,
      pricingVersion: params.pricingVersion,
      customUsdToInrRate: params.customUsdToInrRate,
    });

    const totalTokens =
      params.inputTokens !== null && params.inputTokens !== undefined &&
      params.outputTokens !== null && params.outputTokens !== undefined
        ? params.inputTokens + params.outputTokens
        : null;

    const record: GeminiAttemptRecord = {
      callId,
      jobId: params.jobId,
      correlationId: params.correlationId,
      institutionId: params.institutionId || 'inst_aarshiv_01',
      pipelineStage: params.pipelineStage,
      requestedModel: params.requestedModel,
      actualModel,
      attemptNumber: params.attemptNumber,
      isFallback: params.isFallback,
      status: params.status,
      errorCategory: params.errorCategory,
      latencyMs: params.latencyMs,
      inputTokens: params.inputTokens ?? null,
      outputTokens: params.outputTokens ?? null,
      cachedInputTokens: params.cachedInputTokens ?? null,
      totalTokens,
      usageSource,
      estimatedCostUsd: costResult.totalCostUsd,
      estimatedCostInr: costResult.totalCostInr,
      pricingVersion: costResult.pricingVersion,
      pricingTierUsed: costResult.rateDetails ? costResult.rateDetails.modelId : null,
      timestamp: Date.now(),
    };

    // Update evaluation aggregated summary
    let summary = this.memoryLedger.get(params.jobId);
    if (!summary) {
      summary = {
        jobId: params.jobId,
        institutionId: record.institutionId,
        correlationId: params.correlationId,
        totalCalls: 0,
        successfulCalls: 0,
        failedCalls: 0,
        retriedCalls: 0,
        fallbackCalls: 0,
        totalInputTokens: null,
        totalOutputTokens: null,
        totalCachedTokens: null,
        totalTokens: null,
        totalEstimatedCostUsd: null,
        totalEstimatedCostInr: null,
        retryAndFallbackCostUsd: null,
        stageBreakdown: {},
        modelsUsed: [],
        pricingVersion: record.pricingVersion,
        exchangeRateUsed: costResult.exchangeRateUsed,
        usageCompleteness: 'COMPLETE',
        dataSource: usageSource,
        calls: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      this.memoryLedger.set(params.jobId, summary);
    }

    // Append record
    summary.calls.push(record);
    summary.updatedAt = Date.now();

    // Recompute aggregates
    this.recomputeSummary(summary);
    this.persistSummary(summary);

    return record;
  }

  private recomputeSummary(summary: EvaluationUsageSummary) {
    summary.totalCalls = summary.calls.length;
    summary.successfulCalls = summary.calls.filter((c) => c.status === 'success').length;
    summary.failedCalls = summary.calls.filter((c) => c.status === 'failed' || c.status === 'timeout').length;
    summary.retriedCalls = summary.calls.filter((c) => c.attemptNumber > 1).length;
    summary.fallbackCalls = summary.calls.filter((c) => c.isFallback).length;

    const uniqueModels = new Set<string>();
    summary.calls.forEach((c) => uniqueModels.add(c.actualModel));
    summary.modelsUsed = Array.from(uniqueModels);

    let hasMissingTokens = false;
    let hasKnownTokens = false;
    let sumInput = 0;
    let sumOutput = 0;
    let sumCached = 0;

    let hasUncalculatedCost = false;
    let sumCostUsd = 0;
    let sumCostInr = 0;
    let retryFallbackCostUsd = 0;

    const stages: Record<string, { calls: number; costUsd: number; tokens: number }> = {};
    const sources = new Set<UsageSourceType>();

    for (const call of summary.calls) {
      sources.add(call.usageSource);

      // Token aggregation
      if (call.status === 'success') {
        if (call.inputTokens === null || call.outputTokens === null) {
          hasMissingTokens = true;
        } else {
          hasKnownTokens = true;
          sumInput += call.inputTokens;
          sumOutput += call.outputTokens;
          sumCached += call.cachedInputTokens || 0;
        }
      } else {
        // Failed / timeout attempt: accumulate tokens if any partial usage was reported
        if (call.inputTokens !== null && call.outputTokens !== null) {
          hasKnownTokens = true;
          sumInput += call.inputTokens;
          sumOutput += call.outputTokens;
          sumCached += call.cachedInputTokens || 0;
        }
      }

      // Cost aggregation
      if (call.status === 'success') {
        if (call.estimatedCostUsd === null) {
          hasUncalculatedCost = true;
        } else {
          sumCostUsd += call.estimatedCostUsd;
          sumCostInr += call.estimatedCostInr || 0;

          if (call.attemptNumber > 1 || call.isFallback) {
            retryFallbackCostUsd += call.estimatedCostUsd;
          }
        }
      } else {
        if (call.estimatedCostUsd !== null && call.estimatedCostUsd > 0) {
          sumCostUsd += call.estimatedCostUsd;
          sumCostInr += call.estimatedCostInr || 0;
          retryFallbackCostUsd += call.estimatedCostUsd;
        }
      }

      // Stage breakdown
      if (!stages[call.pipelineStage]) {
        stages[call.pipelineStage] = { calls: 0, costUsd: 0, tokens: 0 };
      }
      stages[call.pipelineStage].calls++;
      stages[call.pipelineStage].costUsd = parseFloat(
        (stages[call.pipelineStage].costUsd + (call.estimatedCostUsd || 0)).toFixed(6)
      );
      stages[call.pipelineStage].tokens += call.totalTokens || 0;
    }

    summary.stageBreakdown = stages;

    // Determine completeness
    if (!hasMissingTokens && hasKnownTokens) {
      summary.totalInputTokens = sumInput;
      summary.totalOutputTokens = sumOutput;
      summary.totalCachedTokens = sumCached;
      summary.totalTokens = sumInput + sumOutput;
      summary.usageCompleteness = 'COMPLETE';
    } else if (hasKnownTokens && hasMissingTokens) {
      summary.totalInputTokens = sumInput;
      summary.totalOutputTokens = sumOutput;
      summary.totalCachedTokens = sumCached;
      summary.totalTokens = sumInput + sumOutput;
      summary.usageCompleteness = 'PARTIAL';
    } else {
      summary.totalInputTokens = null;
      summary.totalOutputTokens = null;
      summary.totalCachedTokens = null;
      summary.totalTokens = null;
      summary.usageCompleteness = 'UNAVAILABLE';
    }

    if (!hasUncalculatedCost) {
      summary.totalEstimatedCostUsd = parseFloat(sumCostUsd.toFixed(6));
      summary.totalEstimatedCostInr = parseFloat(sumCostInr.toFixed(4));
    } else if (sumCostUsd > 0) {
      // Partially estimated
      summary.totalEstimatedCostUsd = parseFloat(sumCostUsd.toFixed(6));
      summary.totalEstimatedCostInr = parseFloat(sumCostInr.toFixed(4));
    } else {
      summary.totalEstimatedCostUsd = null;
      summary.totalEstimatedCostInr = null;
    }

    summary.retryAndFallbackCostUsd = parseFloat(retryFallbackCostUsd.toFixed(6));

    // Data source determination
    if (sources.size === 1) {
      summary.dataSource = Array.from(sources)[0];
    } else if (sources.has('ACTUAL_API')) {
      summary.dataSource = 'ACTUAL_API';
    } else if (sources.has('SIMULATED_MOCK')) {
      summary.dataSource = 'SIMULATED_MOCK';
    } else {
      summary.dataSource = 'UNKNOWN';
    }
  }

  /**
   * Retrieves usage summary for an evaluation with strict multi-tenant authorization
   */
  public getJobUsageSummary(jobId: string, userContext?: UserContext | null): EvaluationUsageSummary | null {
    const summary = this.memoryLedger.get(jobId);
    if (!summary) return null;

    if (userContext && userContext.role !== 'operator') {
      if (summary.institutionId !== userContext.institutionId) {
        return null; // Tenant isolation
      }
    }

    return summary;
  }

  /**
   * Aggregates batch-level usage metrics across authorized jobs
   */
  public getBatchStatistics(filter: BatchUsageFilter, userContext?: UserContext | null): BatchUsageStatistics {
    const targetInstitution =
      userContext && userContext.role !== 'operator' ? userContext.institutionId : filter.institutionId;

    let items = Array.from(this.memoryLedger.values());

    if (targetInstitution && targetInstitution !== 'all') {
      items = items.filter((item) => item.institutionId === targetInstitution);
    }

    if (filter.startDate) {
      items = items.filter((item) => item.createdAt >= filter.startDate!);
    }
    if (filter.endDate) {
      items = items.filter((item) => item.createdAt <= filter.endDate!);
    }
    if (filter.dataSource) {
      items = items.filter((item) => item.dataSource === filter.dataSource);
    }

    const totalEvals = items.length;
    let totalCalls = 0;
    let retriedCalls = 0;
    let fallbackCalls = 0;
    let failedCalls = 0;

    let totalInput = 0;
    let totalOutput = 0;
    let totalCached = 0;

    let totalCostUsd = 0;
    let totalCostInr = 0;

    const costsUsdList: number[] = [];
    const costsInrList: number[] = [];

    const stages: Record<string, { callCount: number; totalCostUsd: number }> = {};
    const models: Record<string, { callCount: number; totalCostUsd: number }> = {};

    let completeCount = 0;
    let partialCount = 0;
    let unavailableCount = 0;
    const sources = new Set<UsageSourceType>();

    for (const item of items) {
      sources.add(item.dataSource);
      totalCalls += item.totalCalls;
      retriedCalls += item.retriedCalls;
      fallbackCalls += item.fallbackCalls;
      failedCalls += item.failedCalls;

      if (item.totalInputTokens !== null) totalInput += item.totalInputTokens;
      if (item.totalOutputTokens !== null) totalOutput += item.totalOutputTokens;
      if (item.totalCachedTokens !== null) totalCached += item.totalCachedTokens;

      if (item.totalEstimatedCostUsd !== null) {
        totalCostUsd += item.totalEstimatedCostUsd;
        costsUsdList.push(item.totalEstimatedCostUsd);
      }
      if (item.totalEstimatedCostInr !== null) {
        totalCostInr += item.totalEstimatedCostInr;
        costsInrList.push(item.totalEstimatedCostInr);
      }

      if (item.usageCompleteness === 'COMPLETE') completeCount++;
      else if (item.usageCompleteness === 'PARTIAL') partialCount++;
      else unavailableCount++;

      for (const call of item.calls) {
        // Stage distribution
        if (!stages[call.pipelineStage]) {
          stages[call.pipelineStage] = { callCount: 0, totalCostUsd: 0 };
        }
        stages[call.pipelineStage].callCount++;
        stages[call.pipelineStage].totalCostUsd = parseFloat(
          (stages[call.pipelineStage].totalCostUsd + (call.estimatedCostUsd || 0)).toFixed(6)
        );

        // Model distribution
        if (!models[call.actualModel]) {
          models[call.actualModel] = { callCount: 0, totalCostUsd: 0 };
        }
        models[call.actualModel].callCount++;
        models[call.actualModel].totalCostUsd = parseFloat(
          (models[call.actualModel].totalCostUsd + (call.estimatedCostUsd || 0)).toFixed(6)
        );
      }
    }

    // Sort costs for median and percentiles
    costsUsdList.sort((a, b) => a - b);
    costsInrList.sort((a, b) => a - b);

    const meanCostUsd = totalEvals > 0 ? parseFloat((totalCostUsd / totalEvals).toFixed(6)) : 0;
    const meanCostInr = totalEvals > 0 ? parseFloat((totalCostInr / totalEvals).toFixed(4)) : 0;

    const medianCostUsd =
      costsUsdList.length > 0 ? parseFloat(costsUsdList[Math.floor(costsUsdList.length / 2)].toFixed(6)) : 0;
    const medianCostInr =
      costsInrList.length > 0 ? parseFloat(costsInrList[Math.floor(costsInrList.length / 2)].toFixed(4)) : 0;

    // Percentiles strictly require sufficient sample size (min 10)
    const isSampleSufficient = costsUsdList.length >= 10;
    let p90CostUsd: number | null = null;
    let p95CostUsd: number | null = null;

    if (isSampleSufficient) {
      const idx90 = Math.floor(costsUsdList.length * 0.9);
      const idx95 = Math.floor(costsUsdList.length * 0.95);
      p90CostUsd = parseFloat(costsUsdList[Math.min(idx90, costsUsdList.length - 1)].toFixed(6));
      p95CostUsd = parseFloat(costsUsdList[Math.min(idx95, costsUsdList.length - 1)].toFixed(6));
    }

    const dataSourceResult: UsageSourceType | 'MIXED' =
      sources.size === 1 ? Array.from(sources)[0] : sources.size > 1 ? 'MIXED' : 'UNKNOWN';

    return {
      institutionId: targetInstitution || 'all',
      sampleSize: totalEvals,
      dateRange: {
        start: filter.startDate ? new Date(filter.startDate).toISOString() : 'beginning',
        end: filter.endDate ? new Date(filter.endDate).toISOString() : new Date().toISOString(),
      },
      totalEvaluations: totalEvals,
      totalApiCalls: totalCalls,
      averageCallsPerEvaluation: totalEvals > 0 ? parseFloat((totalCalls / totalEvals).toFixed(2)) : 0,
      retryRatePercent: totalCalls > 0 ? parseFloat(((retriedCalls / totalCalls) * 100).toFixed(2)) : 0,
      fallbackRatePercent: totalCalls > 0 ? parseFloat(((fallbackCalls / totalCalls) * 100).toFixed(2)) : 0,
      failureRatePercent: totalCalls > 0 ? parseFloat(((failedCalls / totalCalls) * 100).toFixed(2)) : 0,
      tokenTotals: {
        input: totalInput,
        output: totalOutput,
        cached: totalCached,
        total: totalInput + totalOutput,
      },
      costs: {
        totalUsd: parseFloat(totalCostUsd.toFixed(6)),
        totalInr: parseFloat(totalCostInr.toFixed(4)),
        meanCostUsd,
        meanCostInr,
        medianCostUsd,
        medianCostInr,
        p90CostUsd,
        p95CostUsd,
        sampleSizeSufficientForPercentiles: isSampleSufficient,
      },
      stageDistribution: stages,
      modelDistribution: models,
      usageCompleteness: {
        completeCount,
        partialCount,
        unavailableCount,
      },
      dataSource: dataSourceResult,
    };
  }

  public clear(): void {
    this.memoryLedger.clear();
  }
}

export const usageLedger = new UsageLedgerService();
