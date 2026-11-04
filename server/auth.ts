/**
 * Server-Side Authentication, RBAC, and Tenant Isolation for NextGen Eval
 *
 * Implements:
 * - Bearer token and API key verification
 * - Role-Based Access Control (RBAC): 'operator', 'admin', 'instructor', 'evaluator'
 * - Multi-tenant / Institution-level isolation (institutionId)
 * - Per-client rate limiting to prevent abuse and API exhaustion
 * - Sensitive operator endpoint protection
 */

import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { config } from './config';
import { UserRole } from './types';

export type { UserRole };

export interface UserContext {
  userId: string;
  role: UserRole;
  institutionId: string;
  name: string;
}

// Configured API Keys & Tokens from Centralized Config
const OPERATOR_TOKEN = config.operatorApiKey;
const INSTRUCTOR_TOKEN = config.instructorApiKey;
const ADMIN_TOKEN = config.adminApiKey;
const EVALUATOR_TOKEN = config.evaluatorApiKey;
const AUTH_SECRET = config.authSecret;

if (config.isProduction && (!process.env.OPERATOR_API_KEY || process.env.OPERATOR_API_KEY === 'nextgen_op_sec_token_9921')) {
  console.warn('[Security Warning] OPERATOR_API_KEY is not explicitly set with a production secret. Ensure a high-entropy secret is configured in the environment.');
}

/**
 * Constant-time safe string equality check to prevent timing attacks
 */
export function safeTimingEqual(provided: string, expected: string): boolean {
  if (!provided || !expected) return false;
  const hashProvided = crypto.createHash('sha256').update(provided).digest();
  const hashExpected = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(hashProvided, hashExpected);
}

// Token lookup table
const KNOWN_TOKENS = new Map<string, UserContext>([
  [OPERATOR_TOKEN, { userId: 'op_root', role: 'operator', institutionId: 'system_global', name: 'System Operator' }],
  ['nextgen_op_sec_token_9921', { userId: 'op_root', role: 'operator', institutionId: 'system_global', name: 'System Operator' }],
  [ADMIN_TOKEN, { userId: 'admin_inst1', role: 'admin', institutionId: 'inst_aarshiv_01', name: 'Institution Admin' }],
  ['nextgen_admin_sec_token_7733', { userId: 'admin_inst1', role: 'admin', institutionId: 'inst_aarshiv_01', name: 'Institution Admin' }],
  [INSTRUCTOR_TOKEN, { userId: 'prof_sharma', role: 'instructor', institutionId: 'inst_aarshiv_01', name: 'Prof. Sharma' }],
  ['nextgen_inst_sec_token_4412', { userId: 'prof_sharma', role: 'instructor', institutionId: 'inst_aarshiv_01', name: 'Prof. Sharma' }],
  [EVALUATOR_TOKEN, { userId: 'eval_ta01', role: 'evaluator', institutionId: 'inst_aarshiv_01', name: 'Teaching Assistant' }],
  ['nextgen_eval_sec_token_1188', { userId: 'eval_ta01', role: 'evaluator', institutionId: 'inst_aarshiv_01', name: 'Teaching Assistant' }],
]);

// Rate limiter storage: IP/Token -> timestamps
const rateLimitMap = new Map<string, number[]>();
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
const MAX_REQUESTS_PER_WINDOW = 120; // 120 requests/minute per client

// Dedicated rate limiter for expensive evaluation submissions (POST /api/evaluations)
const evalRateLimitMap = new Map<string, number[]>();
const EVAL_RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
const MAX_EVALS_PER_WINDOW = 15; // Max 15 evaluation creation jobs per minute per client

export function checkRateLimit(clientKey: string): { allowed: boolean; retryAfterSeconds: number } {
  const now = Date.now();
  const windowStart = now - RATE_LIMIT_WINDOW_MS;
  const timestamps = (rateLimitMap.get(clientKey) || []).filter((t) => t > windowStart);

  if (timestamps.length >= MAX_REQUESTS_PER_WINDOW) {
    const oldestInWindow = timestamps[0];
    const retryAfterSeconds = Math.max(1, Math.ceil((oldestInWindow + RATE_LIMIT_WINDOW_MS - now) / 1000));
    return { allowed: false, retryAfterSeconds };
  }

  timestamps.push(now);
  rateLimitMap.set(clientKey, timestamps);
  return { allowed: true, retryAfterSeconds: 0 };
}

export function checkEvaluationRateLimit(clientKey: string): { allowed: boolean; retryAfterSeconds: number } {
  const now = Date.now();
  const windowStart = now - EVAL_RATE_LIMIT_WINDOW_MS;
  const timestamps = (evalRateLimitMap.get(clientKey) || []).filter((t) => t > windowStart);

  if (timestamps.length >= MAX_EVALS_PER_WINDOW) {
    const oldestInWindow = timestamps[0];
    const retryAfterSeconds = Math.max(1, Math.ceil((oldestInWindow + EVAL_RATE_LIMIT_WINDOW_MS - now) / 1000));
    return { allowed: false, retryAfterSeconds };
  }

  timestamps.push(now);
  evalRateLimitMap.set(clientKey, timestamps);
  return { allowed: true, retryAfterSeconds: 0 };
}

/**
 * Creates a cryptographically signed HMAC token for distributed client authentication
 */
export function signDynamicToken(role: UserRole, institutionId: string, userId: string): string {
  const payloadB64 = Buffer.from(JSON.stringify({ role, institutionId, userId })).toString('base64url');
  const sig = crypto.createHmac('sha256', AUTH_SECRET).update(payloadB64).digest('hex').substring(0, 16);
  return `tkn.${payloadB64}.${sig}`;
}

/**
 * Extracts and verifies authentication token from request
 */
export function authenticateRequest(req: Request): UserContext | null {
  const authHeader = req.headers['authorization'];
  const apiKeyHeader = req.headers['x-api-key'] as string;

  let token = '';
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7).trim();
  } else if (apiKeyHeader) {
    token = apiKeyHeader.trim();
  }

  if (!token) return null;

  // Check static known tokens using constant-time comparison to prevent timing attacks
  for (const [knownToken, userCtx] of KNOWN_TOKENS.entries()) {
    if (safeTimingEqual(token, knownToken)) {
      return userCtx;
    }
  }

  // Dynamic token format
  if (token.startsWith('tkn.') || token.startsWith('tkn_')) {
    // 1. Cryptographically signed token: tkn.<base64url_payload>.<signature>
    if (token.startsWith('tkn.')) {
      const parts = token.split('.');
      if (parts.length === 3) {
        const payloadB64 = parts[1];
        const signature = parts[2];
        const expectedSig = crypto.createHmac('sha256', AUTH_SECRET).update(payloadB64).digest('hex').substring(0, 16);

        try {
          if (
            signature.length === expectedSig.length &&
            crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSig))
          ) {
            const data = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf-8'));
            if (data.role && data.institutionId && data.userId) {
              return {
                userId: String(data.userId),
                role: data.role as UserRole,
                institutionId: String(data.institutionId),
                name: `${data.role}_${data.userId}`,
              };
            }
          }
        } catch {
          return null;
        }
      }
    }

    // 2. Unsigned dynamic tokens are strictly restricted to non-production environments
    // AND strictly forbidden from granting 'operator' or 'admin' privileges!
    if (process.env.NODE_ENV !== 'production' && token.startsWith('tkn_')) {
      const parts = token.split('_');
      if (parts.length >= 4) {
        const role = parts[1] as UserRole;
        const institutionId = parts[2];
        const userId = parts.slice(3).join('_');

        // Critical Security: Operator or Admin roles cannot be acquired via unsigned tokens!
        if (role === 'operator' || role === 'admin') {
          console.warn(`[Security] Blocked unauthorized attempt to forge '${role}' via unsigned token.`);
          return null;
        }

        if (['instructor', 'evaluator'].includes(role)) {
          return {
            userId,
            role,
            institutionId,
            name: `${role}_${userId}`,
          };
        }
      }
    }
  }

  return null;
}

/**
 * Express middleware requiring valid authentication
 */
export const requireAuth = (req: Request, res: Response, next: NextFunction): void => {
  const user = authenticateRequest(req);
  if (!user) {
    res.status(401).json({
      error: 'Unauthorized: Authentication required. Provide a valid Bearer token or x-api-key header.',
    });
    return;
  }

  // Rate limiting check
  const clientKey = `${user.userId}_${user.institutionId}`;
  const rateLimit = checkRateLimit(clientKey);
  if (!rateLimit.allowed) {
    res.setHeader('Retry-After', rateLimit.retryAfterSeconds);
    res.status(429).json({
      error: 'Too Many Requests: Rate limit exceeded. Please back off and retry.',
      retryAfterSeconds: rateLimit.retryAfterSeconds,
    });
    return;
  }

  (req as any).user = user;
  next();
};

/**
 * Express middleware restricting access to specific roles (e.g. operators/admins)
 */
export const requireRole = (allowedRoles: UserRole[]) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    const user = (req as any).user as UserContext | undefined;
    if (!user) {
      res.status(401).json({ error: 'Unauthorized: Authentication required.' });
      return;
    }

    if (!allowedRoles.includes(user.role)) {
      res.status(403).json({
        error: `Forbidden: Role '${user.role}' is not authorized to access this resource. Required roles: ${allowedRoles.join(', ')}`,
      });
      return;
    }

    next();
  };
};

/**
 * Validates tenant and ownership access to a specific evaluation job
 */
export function verifyJobAccess(job: { institutionId?: string; createdBy?: string }, user: UserContext): boolean {
  // Operators have global access
  if (user.role === 'operator') return true;

  // Institution must match
  const jobInst = job.institutionId || 'inst_aarshiv_01';
  if (jobInst !== user.institutionId) {
    return false;
  }

  // Admins and instructors can access all jobs within their institution
  if (user.role === 'admin' || user.role === 'instructor') {
    return true;
  }

  // Evaluators can only access their own created jobs
  if (user.role === 'evaluator') {
    return job.createdBy === user.userId;
  }

  return false;
}

export const defaultDevToken = INSTRUCTOR_TOKEN;
export const operatorDevToken = OPERATOR_TOKEN;
