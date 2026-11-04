/**
 * Centralized Server Configuration for NextGen Eval Dedicated Backend
 */

import dotenv from 'dotenv';

dotenv.config();

if (typeof (process as any).loadEnvFile === 'function') {
  try {
    (process as any).loadEnvFile();
  } catch {
    // Ignore if .env is missing or already loaded
  }
}

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  geminiApiKey: process.env.GEMINI_API_KEY || process.env.API_KEY || process.env.VITE_GEMINI_API_KEY || '',
  // Primary model and fallback chain (using verified live models)
  primaryModel: process.env.GEMINI_MODEL || 'gemini-3.8-flash',
  fallbackModels: ['gemini-flash-latest', 'gemini-3.1-flash-lite', 'gemini-2.5-flash'],
  // Concurrency & Rate Limiting
  maxConcurrentEvaluations: parseInt(process.env.MAX_CONCURRENT_EVALS || '4', 10),
  maxRetriesPerModel: 2,
  requestTimeoutMs: parseInt(process.env.REQUEST_TIMEOUT_MS || '180000', 10), // 180s default for large evaluations
  // Token Pricing per 1M tokens (Gemini 2.5 / 3.x Flash tier)
  pricing: {
    inputPerMillion: 0.075,  // $0.075 per 1M input tokens
    outputPerMillion: 0.30,  // $0.30 per 1M output tokens
  },
  // Cache TTL: 7 days
  cacheTtlMs: 7 * 24 * 60 * 60 * 1000,
  // Persistent data directory (uses /tmp on serverless environments like Netlify / Lambda)
  dataDir: process.env.DATA_DIR || (process.env.NETLIFY || process.env.AWS_LAMBDA_FUNCTION_NAME ? '/tmp/.data/evaluations' : './.data/evaluations'),
  // Environment
  isProduction: process.env.NODE_ENV === 'production',
  // Server-Side Authentication Keys (Distinct from GEMINI_API_KEY)
  operatorApiKey: process.env.OPERATOR_API_KEY || 'nextgen_op_sec_token_9921',
  adminApiKey: process.env.ADMIN_API_KEY || 'nextgen_admin_sec_token_7733',
  instructorApiKey: process.env.INSTRUCTOR_API_KEY || 'nextgen_inst_sec_token_4412',
  evaluatorApiKey: process.env.EVALUATOR_API_KEY || 'nextgen_eval_sec_token_1188',
  authSecret: process.env.AUTH_SECRET || 'nextgen_auth_secret_key_8841',
};
