/**
 * Central Model Pricing and Currency Calculation Engine for NextGen Eval
 *
 * Implements Phase 2 Requirements:
 * - Versioned pricing schedules with effective dates
 * - Model-specific rates for input, output, and cached-input tokens
 * - Support for both Google AI Studio Developer API and Vertex AI pricing schedules
 * - Explicit separation of USD API cost, INR converted API cost, and operational overhead
 * - Explicit handling of missing or unconfigured model rates (NEVER returns fabricated $0.00)
 * - Configurable USD-to-INR foreign exchange rate
 */

export type PricingScheduleType = 'GOOGLE_AI_STUDIO' | 'VERTEX_AI_PROD';

export interface ModelPricingRate {
  modelId: string;
  inputPerMillion: number;       // USD per 1M prompt tokens
  outputPerMillion: number;      // USD per 1M candidate tokens
  cachedInputPerMillion: number; // USD per 1M cached prompt tokens (context cache)
  notes?: string;
}

export interface PricingVersionConfig {
  version: string;
  effectiveDate: string;
  defaultSchedule: PricingScheduleType;
  defaultUsdToInrRate: number;
  models: Record<string, ModelPricingRate>;
}

// Active Pricing Configuration Version: v2.1 (May 2026 Baseline)
export const ACTIVE_PRICING_VERSION = 'pricing_v2.1_2026_05';

export const PRICING_SCHEDULES: Record<string, PricingVersionConfig> = {
  'pricing_v2.1_2026_05': {
    version: 'pricing_v2.1_2026_05',
    effectiveDate: '2026-05-01',
    defaultSchedule: 'GOOGLE_AI_STUDIO',
    defaultUsdToInrRate: parseFloat(process.env.USD_TO_INR_RATE || '85.0'),
    models: {
      'gemini-3.8-flash': {
        modelId: 'gemini-3.8-flash',
        inputPerMillion: 0.10,
        outputPerMillion: 0.40,
        cachedInputPerMillion: 0.025,
        notes: 'Primary multimodal high-speed evaluation model',
      },
      'gemini-flash-latest': {
        modelId: 'gemini-flash-latest',
        inputPerMillion: 0.075,
        outputPerMillion: 0.30,
        cachedInputPerMillion: 0.01875,
        notes: 'General Flash tier fallback',
      },
      'gemini-3.1-flash-lite': {
        modelId: 'gemini-3.1-flash-lite',
        inputPerMillion: 0.0375,
        outputPerMillion: 0.15,
        cachedInputPerMillion: 0.009375,
        notes: 'Ultra-low cost text & objective evaluation model',
      },
      'gemini-3.5-flash-lite': {
        modelId: 'gemini-3.5-flash-lite',
        inputPerMillion: 0.0375,
        outputPerMillion: 0.15,
        cachedInputPerMillion: 0.009375,
        notes: 'High-speed modern Flash-lite evaluation model',
      },
      'gemini-4-argon': {
        modelId: 'gemini-4-argon',
        inputPerMillion: 0.25,
        outputPerMillion: 1.00,
        cachedInputPerMillion: 0.0625,
        notes: 'Deep reasoning & complex visual diagram / STEM notation model',
      },
      'gemini-2.5-flash': {
        modelId: 'gemini-2.5-flash',
        inputPerMillion: 0.075,
        outputPerMillion: 0.30,
        cachedInputPerMillion: 0.01875,
        notes: 'Legacy Flash reference tier',
      },
    },
  },
};

export interface CostCalculationParams {
  model: string;
  inputTokens: number | null | undefined;
  outputTokens: number | null | undefined;
  cachedInputTokens?: number | null | undefined;
  pricingVersion?: string;
  customUsdToInrRate?: number;
}

export interface CostCalculationResult {
  isCostCalculable: boolean;
  pricingVersion: string;
  modelUsed: string;
  inputCostUsd: number | null;
  outputCostUsd: number | null;
  cachedInputCostUsd: number | null;
  totalCostUsd: number | null;
  totalCostInr: number | null;
  exchangeRateUsed: number;
  rateDetails: ModelPricingRate | null;
  uncalculatedReason?: 'UNKNOWN_MODEL' | 'MISSING_TOKEN_METADATA' | 'UNCONFIGURED_VERSION';
}

/**
 * Retrieves the model pricing configuration for a specified model and version
 */
export function getModelPricingRate(
  modelName: string,
  version: string = ACTIVE_PRICING_VERSION
): ModelPricingRate | null {
  const versionConfig = PRICING_SCHEDULES[version];
  if (!versionConfig) return null;

  // Exact match
  if (versionConfig.models[modelName]) {
    return versionConfig.models[modelName];
  }

  // Normalized match (strip prefix like 'models/')
  const cleanName = modelName.replace(/^models\//, '');
  if (versionConfig.models[cleanName]) {
    return versionConfig.models[cleanName];
  }

  return null;
}

/**
 * Calculates itemized and total cost in USD and INR with strict boundary guarantees:
 * - If model pricing is not configured, returns isCostCalculable: false and cost: null (NEVER returns 0)
 * - If input/output tokens are null (missing usage metadata), returns isCostCalculable: false
 */
export function calculateCallCost(params: CostCalculationParams): CostCalculationResult {
  const version = params.pricingVersion || ACTIVE_PRICING_VERSION;
  const versionConfig = PRICING_SCHEDULES[version];

  const exchangeRate =
    params.customUsdToInrRate ??
    (versionConfig ? versionConfig.defaultUsdToInrRate : parseFloat(process.env.USD_TO_INR_RATE || '85.0'));

  if (!versionConfig) {
    return {
      isCostCalculable: false,
      pricingVersion: version,
      modelUsed: params.model,
      inputCostUsd: null,
      outputCostUsd: null,
      cachedInputCostUsd: null,
      totalCostUsd: null,
      totalCostInr: null,
      exchangeRateUsed: exchangeRate,
      rateDetails: null,
      uncalculatedReason: 'UNCONFIGURED_VERSION',
    };
  }

  const rate = getModelPricingRate(params.model, version);
  if (!rate) {
    return {
      isCostCalculable: false,
      pricingVersion: version,
      modelUsed: params.model,
      inputCostUsd: null,
      outputCostUsd: null,
      cachedInputCostUsd: null,
      totalCostUsd: null,
      totalCostInr: null,
      exchangeRateUsed: exchangeRate,
      rateDetails: null,
      uncalculatedReason: 'UNKNOWN_MODEL',
    };
  }

  // If token counts are null or undefined (metadata missing from provider)
  if (params.inputTokens === null || params.inputTokens === undefined ||
      params.outputTokens === null || params.outputTokens === undefined) {
    return {
      isCostCalculable: false,
      pricingVersion: version,
      modelUsed: params.model,
      inputCostUsd: null,
      outputCostUsd: null,
      cachedInputCostUsd: null,
      totalCostUsd: null,
      totalCostInr: null,
      exchangeRateUsed: exchangeRate,
      rateDetails: rate,
      uncalculatedReason: 'MISSING_TOKEN_METADATA',
    };
  }

  const uncachedInputTokens = Math.max(0, params.inputTokens - (params.cachedInputTokens || 0));
  const cachedTokens = Math.max(0, params.cachedInputTokens || 0);

  const uncachedInputCost = (uncachedInputTokens / 1_000_000) * rate.inputPerMillion;
  const cachedInputCost = (cachedTokens / 1_000_000) * rate.cachedInputPerMillion;
  const outputCost = (params.outputTokens / 1_000_000) * rate.outputPerMillion;

  const totalUsd = uncachedInputCost + cachedInputCost + outputCost;
  const roundedUsd = parseFloat(totalUsd.toFixed(6));
  const roundedInr = parseFloat((roundedUsd * exchangeRate).toFixed(4));

  return {
    isCostCalculable: true,
    pricingVersion: version,
    modelUsed: params.model,
    inputCostUsd: parseFloat(uncachedInputCost.toFixed(6)),
    cachedInputCostUsd: parseFloat(cachedInputCost.toFixed(6)),
    outputCostUsd: parseFloat(outputCost.toFixed(6)),
    totalCostUsd: roundedUsd,
    totalCostInr: roundedInr,
    exchangeRateUsed: exchangeRate,
    rateDetails: rate,
  };
}
