/**
 * Resilient Server-Side Gemini Client for NextGen Eval
 *
 * Adheres strictly to @google/genai SDK guidelines:
 * - User-Agent: 'aistudio-build'
 * - Model aliases: gemini-3.8-flash, gemini-flash-latest, gemini-3.1-flash-lite
 * - Server-only execution
 * - Enforces request deadlines (requestTimeoutMs)
 * - Exponential backoff with jitter and bounded retries ONLY for eligible transient errors
 * - Automated fallback chain across compatible Flash models
 * - Zero logging of sensitive documents, prompts, or API credentials
 */

import fs from 'fs';
import path from 'path';
import { GoogleGenAI, Type } from '@google/genai';
import { config } from './config';
import { EvaluationReport } from './types';
import {
  usageLedger,
  PipelineStage,
  UsageSourceType,
  EvaluationUsageSummary,
} from './usageLedger';
import { calculateCallCost, ACTIVE_PRICING_VERSION } from './pricing';

let aiClientInstance: GoogleGenAI | null = null;

export const getGeminiClient = (): GoogleGenAI => {
  if (!aiClientInstance) {
    if (!config.geminiApiKey) {
      console.warn('[GeminiClient] Notice: GEMINI_API_KEY is not defined in process.env');
    }
    aiClientInstance = new GoogleGenAI({
      apiKey: config.geminiApiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });
  }
  return aiClientInstance;
};

// Response JSON Schema for academic evaluation report
export const evaluationReportSchema = {
  type: Type.OBJECT,
  properties: {
    studentName: { type: Type.STRING },
    testTitle: { type: Type.STRING },
    testTopics: { type: Type.STRING },
    testDate: { type: Type.STRING },
    questions: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          qNo: { type: Type.STRING },
          feedbackPoints: { type: Type.ARRAY, items: { type: Type.STRING } },
          marks: { type: Type.NUMBER },
          maxMarks: { type: Type.NUMBER },
          isCorrect: { type: Type.BOOLEAN },
          isFlagged: { type: Type.BOOLEAN },
          flaggedComment: {
            type: Type.STRING,
            description:
              'If isFlagged is true, provide a brief explanation of the discrepancy or contradiction resolved.',
          },
        },
        required: ['qNo', 'feedbackPoints', 'marks', 'maxMarks', 'isCorrect'],
      },
    },
    totalScore: { type: Type.NUMBER },
    maxScore: { type: Type.NUMBER },
    generalFeedback: {
      type: Type.OBJECT,
      properties: {
        overallPerformance: { type: Type.ARRAY, items: { type: Type.STRING } },
        mcqs: { type: Type.ARRAY, items: { type: Type.STRING } },
        contentAccuracy: { type: Type.ARRAY, items: { type: Type.STRING } },
        completenessOfAnswers: { type: Type.ARRAY, items: { type: Type.STRING } },
        presentationDiagrams: { type: Type.ARRAY, items: { type: Type.STRING } },
        investigations: { type: Type.ARRAY, items: { type: Type.STRING } },
        attemptingQuestions: { type: Type.ARRAY, items: { type: Type.STRING } },
        actionPoints: { type: Type.ARRAY, items: { type: Type.STRING } },
      },
      required: [
        'overallPerformance',
        'mcqs',
        'contentAccuracy',
        'completenessOfAnswers',
        'presentationDiagrams',
        'investigations',
        'attemptingQuestions',
        'actionPoints',
      ],
    },
  },
  required: [
    'studentName',
    'testTitle',
    'testTopics',
    'testDate',
    'totalScore',
    'maxScore',
    'questions',
    'generalFeedback',
  ],
};

// Response JSON Schema for academic answer key generation
export const canonicalAnswerKeySchema = {
  type: Type.OBJECT,
  properties: {
    examTitle: { type: Type.STRING },
    totalMaxMarks: { type: Type.NUMBER },
    printedMaxMarks: { type: Type.NUMBER },
    warnings: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
    },
    questions: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          questionId: { type: Type.STRING },
          subquestionId: { type: Type.STRING },
          parentQuestionId: { type: Type.STRING },
          section: { type: Type.STRING },
          isAlternative: { type: Type.BOOLEAN },
          alternativeGroup: { type: Type.STRING },
          selectionGroup: { type: Type.STRING },
          requiredAttempts: { type: Type.NUMBER },
          groupRule: { type: Type.STRING },
          groupMaxMarks: { type: Type.NUMBER },
          branchId: { type: Type.STRING },
          isParentHeader: { type: Type.BOOLEAN },
          questionText: { type: Type.STRING },
          maxMarks: { type: Type.NUMBER },
          referenceAnswer: { type: Type.STRING },
          expectedConcepts: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
          },
          acceptableAlternatives: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
          },
          markingCriteria: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
          },
          diagramReferences: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
          },
          confidence: { type: Type.NUMBER },
          flaggedIssue: { type: Type.STRING },
        },
        required: [
          'questionId',
          'questionText',
          'maxMarks',
          'referenceAnswer',
          'expectedConcepts',
          'markingCriteria',
        ],
      },
    },
  },
  required: ['questions'],
};

// Response JSON Schema for student answer script extraction (Stage 1)
export const studentExtractionSchema = {
  type: Type.OBJECT,
  properties: {
    studentName: { type: Type.STRING },
    examTitle: { type: Type.STRING },
    answers: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          questionId: { type: Type.STRING },
          subquestionId: { type: Type.STRING },
          studentAnswerText: { type: Type.STRING },
          diagramDescription: { type: Type.STRING },
          formulas: { type: Type.ARRAY, items: { type: Type.STRING } },
          pageReferences: { type: Type.ARRAY, items: { type: Type.NUMBER } },
          isAttempted: { type: Type.BOOLEAN },
          confidence: { type: Type.NUMBER },
          flaggedUncertain: { type: Type.BOOLEAN },
          flaggedIssue: { type: Type.STRING },
        },
        required: ['questionId', 'studentAnswerText', 'isAttempted'],
      },
    },
    unmappedContent: { type: Type.ARRAY, items: { type: Type.STRING } },
    warnings: { type: Type.ARRAY, items: { type: Type.STRING } },
    visualEvidenceRetained: { type: Type.BOOLEAN },
  },
  required: ['answers'],
};

// Circuit-breaker & Cooldown Store for Quota Exhaustion (429) & Overloaded Servers (503)
interface ModelCooldownInfo {
  until: number;
  reason: 'quota_exhausted' | 'server_unavailable_503';
  message: string;
}

const modelCooldowns = new Map<string, ModelCooldownInfo>();

const getCooldownFilePath = () => path.join(config.dataDir, 'model_cooldowns.json');

const loadCooldownsFromDisk = () => {
  try {
    const file = getCooldownFilePath();
    if (fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
      const now = Date.now();
      for (const [m, info] of Object.entries(data as Record<string, ModelCooldownInfo>)) {
        if (info && typeof info.until === 'number' && info.until > now) {
          modelCooldowns.set(m, info);
        }
      }
    }
  } catch {}
};

const saveCooldownsToDisk = () => {
  try {
    const file = getCooldownFilePath();
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const obj: Record<string, ModelCooldownInfo> = {};
    const now = Date.now();
    for (const [m, info] of modelCooldowns.entries()) {
      if (info && info.until > now) {
        obj[m] = info;
      }
    }
    fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf-8');
  } catch {}
};

// Initial load on startup
loadCooldownsFromDisk();

export const extractRetryDelayMs = (error: any): number | null => {
  try {
    const details = error?.details || error?.error?.details;
    if (Array.isArray(details)) {
      const retryInfo = details.find((d: any) => d?.retryDelay || d?.['@type']?.includes('RetryInfo'));
      if (retryInfo?.retryDelay) {
        const seconds = parseInt(String(retryInfo.retryDelay).replace('s', ''), 10);
        if (!isNaN(seconds) && seconds > 0) return seconds * 1000;
      }
    }
    const msg = String(error?.message || error || '');
    const match = msg.match(/retry in\s+(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:([\d.]+)s)?/i);
    if (match) {
      const hours = parseInt(match[1] || '0', 10);
      const minutes = parseInt(match[2] || '0', 10);
      const seconds = parseFloat(match[3] || '0');
      const totalMs = (hours * 3600 + minutes * 60 + seconds) * 1000;
      if (totalMs > 0) return totalMs;
    }
  } catch {}
  return null;
};

export const markModelQuotaExhausted = (modelName: string, reason = 'Daily quota exhausted', durationMs = 3600000) => {
  const until = Date.now() + durationMs;
  const cleanReason = typeof reason === 'string' && reason.length > 120 ? reason.slice(0, 120) + '...' : reason;
  modelCooldowns.set(modelName, {
    until,
    reason: 'quota_exhausted',
    message: cleanReason,
  });

  // If gemini-3.8-flash hit daily free tier quota, mark gemini-flash-latest as well (shares same quota bucket)
  if (modelName === 'gemini-3.8-flash' && !modelCooldowns.has('gemini-flash-latest')) {
    modelCooldowns.set('gemini-flash-latest', {
      until,
      reason: 'quota_exhausted',
      message: 'Linked free-tier quota pool exhausted',
    });
  } else if (modelName === 'gemini-flash-latest' && !modelCooldowns.has('gemini-3.8-flash')) {
    modelCooldowns.set('gemini-3.8-flash', {
      until,
      reason: 'quota_exhausted',
      message: 'Linked free-tier quota pool exhausted',
    });
  }

  saveCooldownsToDisk();
  console.log(
    `[GeminiClient] Model "${modelName}" marked on quota cooldown until ${new Date(until).toISOString()}. Switching to next fallback model.`
  );
};

export const markModelUnavailable = (modelName: string, reason = 'Server overloaded (503)', durationMs = 60000) => {
  const until = Date.now() + durationMs;
  modelCooldowns.set(modelName, {
    until,
    reason: 'server_unavailable_503',
    message: reason,
  });
  saveCooldownsToDisk();
  console.log(
    `[GeminiClient] Model "${modelName}" marked temporarily unavailable (503) for ${durationMs}ms.`
  );
};

export const isModelInCooldown = (modelName: string): boolean => {
  const cd = modelCooldowns.get(modelName);
  if (!cd) return false;
  if (Date.now() >= cd.until) {
    modelCooldowns.delete(modelName);
    saveCooldownsToDisk();
    return false;
  }
  return true;
};

export const resetModelCooldowns = () => {
  modelCooldowns.clear();
  try {
    const file = getCooldownFilePath();
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch {}
};

export const getModelCooldownStatus = (): Record<string, { until: number; reason: string; remainingMs: number }> => {
  const res: Record<string, any> = {};
  const now = Date.now();
  for (const [model, info] of modelCooldowns.entries()) {
    if (now < info.until) {
      res[model] = {
        until: info.until,
        reason: info.reason,
        remainingMs: info.until - now,
      };
    } else {
      modelCooldowns.delete(model);
    }
  }
  return res;
};

/**
 * Detects whether an error represents non-retryable daily or plan quota exhaustion
 */
export const isDailyQuotaExhaustion = (error: any): boolean => {
  const status = error?.status || error?.code || error?.statusCode;
  const msg = String(error?.message || error || '').toLowerCase();

  const is429OrQuota =
    status === 429 ||
    msg.includes('429') ||
    msg.includes('resource_exhausted') ||
    msg.includes('quota') ||
    msg.includes('rate limit');

  if (is429OrQuota) {
    if (
      msg.includes('per day') ||
      msg.includes('requests per day') ||
      msg.includes('generaterequestsperday') ||
      msg.includes('free tier') ||
      msg.includes('exceeded your current quota') ||
      msg.includes('check your plan and billing') ||
      msg.includes('quota metric') ||
      msg.includes('quotametric') ||
      msg.includes('quotaid') ||
      msg.includes('retry in')
    ) {
      return true;
    }
  }
  return false;
};

/**
 * Detects whether an error represents a 429 rate limit or quota exhaustion condition
 */
export const is429OrQuotaError = (error: any): boolean => {
  const status = error?.status || error?.code || error?.statusCode;
  const msg = String(error?.message || error || '').toLowerCase();
  return (
    status === 429 ||
    msg.includes('429') ||
    msg.includes('resource_exhausted') ||
    msg.includes('quota') ||
    msg.includes('rate limit')
  );
};

/**
 * Detects whether an error represents a 503 high demand / service overloaded condition
 */
export const is503Error = (error: any): boolean => {
  const status = error?.status || error?.code || error?.statusCode;
  const msg = String(error?.message || error || '').toLowerCase();
  return (
    status === 503 ||
    msg.includes('503') ||
    msg.includes('unavailable') ||
    msg.includes('high demand') ||
    msg.includes('overloaded') ||
    msg.includes('service unavailable')
  );
};

/**
 * Identifies if an error is an eligible transient failure suitable for retry
 */
export const isRetryableError = (error: any): boolean => {
  const status = error?.status || error?.code || error?.statusCode;
  const msg = String(error?.message || error || '').toLowerCase();

  // Non-retryable client errors
  if (status === 400 || status === 401 || status === 403 || status === 404) return false;
  if (msg.includes('api_key') || msg.includes('permission_denied') || msg.includes('unauthorized')) return false;

  // Daily quota exhaustion on a specific model cannot be solved by retrying seconds later;
  // immediately step to the next model in the candidate fallback chain.
  if (isDailyQuotaExhaustion(error)) {
    return false;
  }

  // Retryable server or network conditions
  if (is503Error(error) || status === 500 || status === 429 || status === 408) return true;
  if (msg.includes('500') || msg.includes('internal error')) return true;
  if (msg.includes('429') || msg.includes('resource_exhausted') || msg.includes('rate limit') || msg.includes('quota')) return true;
  if (msg.includes('econnreset') || msg.includes('etimedout') || msg.includes('timeout') || msg.includes('network error') || msg.includes('fetch failed')) return true;
  // Detect HTML responses and JSON syntax errors when upstream proxy/Gemini returns HTML 503
  if (msg.includes('<!doctype') || msg.includes('<html') || (msg.includes('unexpected token') && msg.includes('<')) || msg.includes('is not valid json')) return true;

  return false;
};

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface GeminiCallOptions {
  jobId?: string;
  institutionId?: string;
  pipelineStage?: PipelineStage;
  pricingVersion?: string;
  customUsdToInrRate?: number;
  dataSourceOverride?: UsageSourceType;
  model?: string;
  candidateModels?: string[];
  responseSchema?: any;
  thinkingBudget?: number;
  timeoutMs?: number;
}

export interface GeminiCallResult {
  report: any;
  modelUsed: string;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens?: number | null;
  estimatedCostUsd: number | null;
  estimatedCostInr: number | null;
  pricingVersion: string;
  usageCompleteness: 'COMPLETE' | 'PARTIAL' | 'UNAVAILABLE';
  usageSource: UsageSourceType;
  retries: number;
  fallbackCallsCount: number;
  latencyMs: number;
  usageSummary?: EvaluationUsageSummary | null;
}

export type MockGeminiGenerateFn = (params: {
  model: string;
  contentsParts: any[];
  systemInstruction: string;
  correlationId: string;
}) => Promise<{
  text: string;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    cachedContentTokenCount?: number;
  };
}>;

let mockGenerateFn: MockGeminiGenerateFn | null = null;

/**
 * Injects a mock Gemini provider for offline testing of retries, timeouts, and fallbacks
 */
export const setMockGeminiProvider = (fn: MockGeminiGenerateFn | null) => {
  mockGenerateFn = fn;
  resetModelCooldowns();
};

/**
 * Invokes Gemini with strict overall request deadline, bounded exponential backoff with jitter,
 * automated model fallback, and granular per-attempt usage ledger recording.
 */
export const callGeminiWithFallback = async (
  contentsParts: any[],
  systemInstruction: string,
  correlationId: string,
  options?: GeminiCallOptions
): Promise<GeminiCallResult> => {
  if (!config.geminiApiKey && !mockGenerateFn) {
    throw new Error('GEMINI_API_KEY is not configured on the server. Academic evaluations cannot proceed without an API key.');
  }

  const ai = !mockGenerateFn ? getGeminiClient() : null;
  const rawCandidates = options?.candidateModels || Array.from(new Set(options?.model ? [options.model, ...config.fallbackModels] : [config.primaryModel, ...config.fallbackModels]));
  const allCandidates = Array.from(new Set(rawCandidates)).filter(Boolean);

  // Filter models that are not currently in cooldown (e.g. 429 quota exhausted or 503 overloaded)
  const activeCandidates = allCandidates.filter((m) => !isModelInCooldown(m));
  const candidateModels = activeCandidates.length > 0 ? activeCandidates : allCandidates;

  const jobId = options?.jobId || `job_${correlationId}`;
  const institutionId = options?.institutionId || 'inst_aarshiv_01';
  const pipelineStage = options?.pipelineStage || 'grading';
  const pricingVersion = options?.pricingVersion || ACTIVE_PRICING_VERSION;
  const customUsdToInrRate = options?.customUsdToInrRate;

  let lastError: any = null;
  let totalRetries = 0;
  let fallbackCallsCount = 0;
  const overallStart = Date.now();
  const overallTimeoutMs = options?.timeoutMs !== undefined ? options.timeoutMs : Math.max(config.requestTimeoutMs, 180000);
  const overallDeadline = overallStart + overallTimeoutMs;
  const individualCallTimeoutMs = 60000; // 60s max per single API attempt
  const modelTimeSpent: Record<string, number> = {};

  for (let modelIdx = 0; modelIdx < candidateModels.length; modelIdx++) {
    const modelName = candidateModels[modelIdx];
    const isFallback = modelIdx > 0;
    if (isFallback) {
      fallbackCallsCount++;
    }

    for (let attempt = 0; attempt <= config.maxRetriesPerModel; attempt++) {
      const remainingBeforeAttempt = overallDeadline - Date.now();
      if (remainingBeforeAttempt <= 0) {
        usageLedger.recordAttempt({
          jobId,
          correlationId,
          institutionId,
          pipelineStage,
          requestedModel: modelName,
          actualModel: modelName,
          attemptNumber: attempt + 1,
          isFallback,
          status: 'timeout',
          errorCategory: 'OVERALL_DEADLINE_EXCEEDED',
          latencyMs: Date.now() - overallStart,
          inputTokens: null,
          outputTokens: null,
          cachedInputTokens: null,
          usageSource: mockGenerateFn ? 'SIMULATED_MOCK' : 'UNKNOWN',
          pricingVersion,
          customUsdToInrRate,
        });

        throw new Error(
          `Overall evaluation deadline exceeded (${overallTimeoutMs}ms) during evaluation of model ${modelName}.`
        );
      }

      if (attempt > 0) {
        totalRetries++;
        // Short bounded backoff for 503 so we don't stall when a model is overloaded
        let backoffDelay: number;
        if (is503Error(lastError)) {
          const jitter = Math.random() * 200;
          backoffDelay = Math.min(500 + jitter, 1000);
        } else {
          // Bounded exponential backoff with random jitter
          const baseBackoff = 1000 * Math.pow(2, attempt - 1);
          const jitter = Math.random() * 500;
          backoffDelay = Math.min(baseBackoff + jitter, 6000);
        }

        if (Date.now() + backoffDelay >= overallDeadline) {
          usageLedger.recordAttempt({
            jobId,
            correlationId,
            institutionId,
            pipelineStage,
            requestedModel: modelName,
            actualModel: modelName,
            attemptNumber: attempt + 1,
            isFallback,
            status: 'timeout',
            errorCategory: 'BACKOFF_DEADLINE_EXCEEDED',
            latencyMs: Date.now() - overallStart,
            inputTokens: null,
            outputTokens: null,
            cachedInputTokens: null,
            usageSource: mockGenerateFn ? 'SIMULATED_MOCK' : 'UNKNOWN',
            pricingVersion,
            customUsdToInrRate,
          });

          throw new Error(
            `Overall evaluation deadline (${overallTimeoutMs}ms) would be exceeded during retry backoff for model ${modelName}.`
          );
        }

        console.warn(
          `[GeminiClient][${correlationId}] Transient error. Retrying attempt ${attempt}/${config.maxRetriesPerModel} for ${modelName} after ${Math.round(backoffDelay)}ms...`
        );
        await delay(backoffDelay);
      }

      const callStart = Date.now();
      try {
        console.log(`[GeminiClient][${correlationId}] Calling ${modelName} (attempt ${attempt + 1})...`);
        const timeRemainingInBudget = overallDeadline - Date.now();
        const remainingForCall = Math.min(individualCallTimeoutMs, Math.max(100, timeRemainingInBudget));

        let timeoutHandle: any;
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(() => {
            reject(new Error(`Gemini call deadline exceeded (${remainingForCall}ms per-call timeout, ${overallTimeoutMs}ms total budget)`));
          }, remainingForCall);
        });

        const executeCall = async () => {
          if (mockGenerateFn) {
            return await mockGenerateFn({
              model: modelName,
              contentsParts,
              systemInstruction,
              correlationId,
            });
          }

          // Dynamically resolve response schema based on explicit option or pipeline stage
          const schema =
            options?.responseSchema !== undefined
              ? options.responseSchema
              : pipelineStage === 'answer_key_generation' || pipelineStage === 'answer_key_extraction'
              ? canonicalAnswerKeySchema
              : pipelineStage === 'student_extraction' || pipelineStage === 'extraction'
              ? studentExtractionSchema
              : evaluationReportSchema;

          const generateConfig: any = {
            systemInstruction,
            temperature: 0,
            seed: 42,
            responseMimeType: 'application/json',
          };

          if (schema) {
            generateConfig.responseSchema = schema;
          }

          // Configure thinkingBudget to avoid token bloat on structured outputs (only for models that support it, e.g. 2.5 series)
          const supportsThinking = modelName.includes('2.5');
          if (supportsThinking) {
            if (typeof options?.thinkingBudget === 'number') {
              generateConfig.thinkingConfig = {
                thinkingBudget: options.thinkingBudget,
              };
            } else if (
              pipelineStage === 'answer_key_generation' ||
              pipelineStage === 'answer_key_extraction' ||
              pipelineStage === 'student_extraction' ||
              pipelineStage === 'grading'
            ) {
              // For structured extractions, answer keys, and grading, set thinkingBudget to 0 to eliminate 4000+ chain-of-thought tokens and avoid 120s timeouts
              generateConfig.thinkingConfig = {
                thinkingBudget: 0,
              };
            }
          }

          return await ai!.models.generateContent({
            model: modelName,
            contents: [{ parts: contentsParts }],
            config: generateConfig,
          });
        };

        const response = await Promise.race([executeCall(), timeoutPromise]).finally(() => {
          if (timeoutHandle) clearTimeout(timeoutHandle);
        });

        const latencyMs = Date.now() - callStart;
        modelTimeSpent[modelName] = (modelTimeSpent[modelName] || 0) + latencyMs;
        const text = response.text;
        if (!text || text.trim().length === 0) {
          throw new Error(`Empty response received from Gemini model ${modelName}`);
        }

        let parsed: any;
        try {
          parsed = JSON.parse(text);
        } catch (jsonErr: any) {
          throw new Error(`Failed to parse Gemini response as JSON: ${jsonErr?.message}`);
        }

        if (typeof parsed === 'object' && parsed !== null) {
          parsed.evaluatedByModel = modelName;
        }

        // Token usage accounting from API metadata
        const usageMeta = (response as any).usageMetadata;
        const hasPromptTokens = typeof usageMeta?.promptTokenCount === 'number';
        const hasCandidatesTokens = typeof usageMeta?.candidatesTokenCount === 'number';

        const inputTokens = hasPromptTokens ? usageMeta.promptTokenCount : null;
        const outputTokens = hasCandidatesTokens ? usageMeta.candidatesTokenCount : null;
        const cachedInputTokens =
          typeof usageMeta?.cachedContentTokenCount === 'number'
            ? usageMeta.cachedContentTokenCount
            : (hasPromptTokens ? 0 : null);

        let usageSource: UsageSourceType;
        if (options?.dataSourceOverride) {
          usageSource = options.dataSourceOverride;
        } else if (!hasPromptTokens && !hasCandidatesTokens) {
          usageSource = 'UNKNOWN';
        } else if (mockGenerateFn) {
          usageSource = 'SIMULATED_MOCK';
        } else if (hasPromptTokens && hasCandidatesTokens) {
          usageSource = 'ACTUAL_API';
        } else {
          usageSource = 'UNKNOWN';
        }

        // Record attempt in audit ledger
        usageLedger.recordAttempt({
          jobId,
          correlationId,
          institutionId,
          pipelineStage,
          requestedModel: modelName,
          actualModel: modelName,
          attemptNumber: attempt + 1,
          isFallback,
          status: 'success',
          latencyMs,
          inputTokens,
          outputTokens,
          cachedInputTokens,
          usageSource,
          pricingVersion,
          customUsdToInrRate,
        });

        // Calculate itemized and total cost
        const costCalc = calculateCallCost({
          model: modelName,
          inputTokens,
          outputTokens,
          cachedInputTokens,
          pricingVersion,
          customUsdToInrRate,
        });

        const summary = usageLedger.getJobUsageSummary(jobId);

        console.log(
          `[GeminiClient][${correlationId}] Successfully evaluated with ${modelName}. Latency: ${latencyMs}ms, Model latency summary: [${Object.entries(modelTimeSpent).map(([m, ms]) => `${m}: ${ms}ms`).join(', ')}], Tokens: in=${inputTokens ?? 'N/A'}/out=${outputTokens ?? 'N/A'}/cached=${cachedInputTokens ?? 'N/A'}, EstCost: $${costCalc.totalCostUsd ?? 'N/A'} (₹${costCalc.totalCostInr ?? 'N/A'})`
        );

        return {
          report: parsed,
          modelUsed: modelName,
          inputTokens,
          outputTokens,
          cachedInputTokens,
          estimatedCostUsd: costCalc.totalCostUsd,
          estimatedCostInr: costCalc.totalCostInr,
          pricingVersion,
          usageCompleteness:
            inputTokens !== null && outputTokens !== null ? 'COMPLETE' : 'UNAVAILABLE',
          usageSource,
          retries: totalRetries,
          fallbackCallsCount,
          latencyMs: Date.now() - overallStart,
          usageSummary: summary,
        };
      } catch (err: any) {
        lastError = err;
        const attemptLatency = Date.now() - callStart;
        modelTimeSpent[modelName] = (modelTimeSpent[modelName] || 0) + attemptLatency;
        const retryable = isRetryableError(err);
        const isTimeout =
          String(err?.message || '').toLowerCase().includes('deadline exceeded') ||
          String(err?.message || '').toLowerCase().includes('timeout');

        let errorCategory = 'TRANSIENT_SERVER';
        const msg = String(err?.message || '').toLowerCase();
        if (isTimeout) errorCategory = 'TIMEOUT';
        else if (msg.includes('429') || msg.includes('rate limit') || msg.includes('quota'))
          errorCategory = 'RATE_LIMIT';
        else if (msg.includes('json')) errorCategory = 'PARSING_ERROR';
        else if (msg.includes('empty response')) errorCategory = 'EMPTY_RESPONSE';
        else if (msg.includes('400') || msg.includes('invalid')) errorCategory = 'CLIENT_ERROR';

        // Record failed attempt in audit ledger
        usageLedger.recordAttempt({
          jobId,
          correlationId,
          institutionId,
          pipelineStage,
          requestedModel: modelName,
          actualModel: modelName,
          attemptNumber: attempt + 1,
          isFallback,
          status: isTimeout ? 'timeout' : 'failed',
          errorCategory,
          latencyMs: attemptLatency,
          inputTokens: null,
          outputTokens: null,
          cachedInputTokens: null,
          usageSource: mockGenerateFn ? 'SIMULATED_MOCK' : 'UNKNOWN',
          pricingVersion,
          customUsdToInrRate,
        });

        const isQuota429 = isDailyQuotaExhaustion(err);
        const isTransient429 = is429OrQuotaError(err);
        const is503Condition = is503Error(err);

        const cleanErrMsg = isQuota429
          ? 'Free tier daily request quota exhausted'
          : is503Condition
          ? 'Service temporarily overloaded (503)'
          : String(err?.message || err).replace(/[\r\n]+/g, ' ').slice(0, 150);

        console.log(
          `[GeminiClient][${correlationId}] Model ${modelName} attempt ${attempt + 1} (${cleanErrMsg}). Retryable: ${retryable}`
        );

        if (isQuota429) {
          // Immediately mark model in quota exhaustion cooldown so subsequent calls skip it immediately
          const retryDelayMs = extractRetryDelayMs(err) || 3600000;
          markModelQuotaExhausted(modelName, cleanErrMsg, retryDelayMs);
          break; // Never retry daily quota exhaustion
        }

        if (isTransient429) {
          // For transient 429, allow at most 1 bounded retry; if it persists, mark in cooldown and advance to next model
          if (attempt >= 1) {
            markModelQuotaExhausted(modelName, cleanErrMsg, 300000);
            break;
          }
        }

        if (is503Condition) {
          // For 503, allow bounded 1 retry with short backoff, then mark temporarily unavailable and advance to next model
          if (attempt >= 1) {
            markModelUnavailable(modelName, cleanErrMsg, 60000);
            break;
          }
        }

        // If error is not retryable or max retries reached for this model, break to try next fallback model
        if (!retryable || attempt === config.maxRetriesPerModel) {
          break;
        }
      }
    }
  }

  const is503 =
    candidateModels.every((m) => isRetryableError(lastError)) ||
    lastError?.statusCode === 503 ||
    lastError?.status === 503 ||
    isRetryableError(lastError) ||
    /503|high demand|unavailable|overloaded/i.test(lastError?.message || '') ||
    /<!doctype|<html|unexpected token '<'|is not valid json/i.test(lastError?.message || '');

  console.warn(
    `[GeminiClient][${correlationId}] Fallback chain exhausted across candidate models. Time spent per model: ${Object.entries(modelTimeSpent).map(([m, ms]) => `${m}: ${ms}ms`).join(', ')}`
  );

  const finalError: any = new Error(
    `Evaluation failed across candidate models (${candidateModels.join(', ')}). Last error: ${lastError?.message || lastError}`
  );
  finalError.name = 'GeminiExhaustedError';
  finalError.statusCode = is503 ? 503 : 500;
  finalError.category = is503 ? 'Gemini Server Temporarily Busy (503)' : 'Evaluation Failure';
  finalError.retryable = is503;
  finalError.candidateModels = candidateModels;
  finalError.lastError = lastError;
  throw finalError;
};
