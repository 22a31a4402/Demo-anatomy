/**
 * Cryptographic Evaluation Cache Service for NextGen Eval
 *
 * Implements Stage B & Stage G:
 * - Deterministic, collision-resistant SHA-256 fingerprinting
 * - Full-content cryptographic hashing over every byte/character of:
 *   - Student answer script (entire text and entire visual base64 buffer)
 *   - Question paper (complete text/base64, name, MIME type)
 *   - Answer key (complete text/base64, name, MIME type)
 *   - Faculty notes (complete text/base64, name, MIME type)
 *   - Evaluation mode ('with-manual' vs 'without-manual')
 *   - Prompt version and Model ID
 *   - Generation settings (temperature, seed)
 *   - Institution ID for tenant isolation
 * - Enforces authorization checks before serving cached results
 * - Atomic disk persistence and cache eviction policies
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { config } from './config';
import { EvaluationReport, StudentExtractedScript, CanonicalAnswerKey } from './types';
import { UserContext } from './auth';

export const CACHE_PROMPT_VERSION = 'nextgen_eval_engine_v4.1_hardened';

export interface CacheEntry {
  cacheKey: string;
  report: EvaluationReport;
  timestamp: number;
  modelUsed: string;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens?: number | null;
  estimatedCostSaved: number | null;
  institutionId?: string;
  createdBy?: string;
}

export class EvaluationCacheService {
  private memoryCache = new Map<string, CacheEntry>();
  private extractionMemoryCache = new Map<string, StudentExtractedScript>();
  private cacheDir: string;
  public totalRequests = 0;
  public cacheHits = 0;

  constructor() {
    this.cacheDir = path.join(config.dataDir, 'cache');
    try {
      if (!fs.existsSync(this.cacheDir)) {
        fs.mkdirSync(this.cacheDir, { recursive: true });
      }
    } catch (e) {
      console.warn('[CacheService] Failed creating disk cache dir:', e);
    }
  }

  /**
   * Generates a deterministic SHA-256 fingerprint by hashing 100% of the contents
   * of all grading-relevant documents with canonical unambiguous delimiters.
   */
  public generateFingerprint(payload: {
    sourceDoc: { text?: string; base64?: string; name?: string; mimeType?: string };
    questionPaper?: { text?: string; base64?: string; name?: string; mimeType?: string };
    answerKey?: { text?: string; base64?: string; name?: string; mimeType?: string };
    facultyNotes?: { text?: string; base64?: string; name?: string; mimeType?: string } | null;
    mode: string;
    model: string;
    generationSettings?: { temperature?: number; seed?: number };
    institutionId?: string;
  }): string {
    const hash = crypto.createHash('sha256');

    // 1. Static Metadata & Prompt Version
    hash.update(`PROMPT_VERSION:${CACHE_PROMPT_VERSION}\n`);
    hash.update(`MODE:${payload.mode || 'with-manual'}\n`);
    hash.update(`MODEL:${payload.model || config.primaryModel}\n`);
    hash.update(`INSTITUTION:${payload.institutionId || 'inst_aarshiv_01'}\n`);

    const temp = payload.generationSettings?.temperature ?? 0;
    const seed = payload.generationSettings?.seed ?? 42;
    hash.update(`GEN_SETTINGS:temp=${temp}:seed=${seed}\n`);

    // 2. Full Hashing of Source Document (Student Script)
    const src = payload.sourceDoc || {};
    hash.update(`SRC_NAME:${src.name || ''}\n`);
    hash.update(`SRC_MIME:${src.mimeType || ''}\n`);
    if (src.text) {
      hash.update(`SRC_TEXT_LEN:${src.text.length}\n`);
      hash.update(src.text);
      hash.update('\n');
    }
    if (src.base64) {
      // Digest 100% of the student's base64 document buffer to catch even 1-byte mutations
      hash.update(`SRC_B64_LEN:${src.base64.length}\n`);
      hash.update(src.base64);
      hash.update('\n');
    }
    const studentName = (payload as any).studentName;
    if (studentName) {
      hash.update(`STUDENT_NAME:${studentName}\n`);
    }

    // 3. Full Hashing of Question Paper (direct payload or from canonical answer key)
    const qp = payload.questionPaper || (payload as any).canonicalAnswerKey?.sourceQuestionPaperDoc;
    if (qp) {
      hash.update(`QP_NAME:${qp.name || ''}\n`);
      hash.update(`QP_MIME:${qp.mimeType || ''}\n`);
      if (qp.text) {
        hash.update(`QP_TEXT_LEN:${qp.text.length}\n`);
        hash.update(qp.text);
        hash.update('\n');
      }
      if (qp.base64) {
        hash.update(`QP_B64_LEN:${qp.base64.length}\n`);
        hash.update(qp.base64);
        hash.update('\n');
      }
    }

    // 4. Full Hashing of Answer Key (Canonical or Raw Document)
    if ((payload as any).canonicalAnswerKey) {
      const cak = (payload as any).canonicalAnswerKey;
      hash.update(`CANONICAL_AK_ID:${cak.id}\n`);
      hash.update(`CANONICAL_AK_VERSION:${cak.version}\n`);
      hash.update(`CANONICAL_AK_STATUS:${cak.status}\n`);
      hash.update(`CANONICAL_AK_TOTAL:${cak.totalMaxMarks}\n`);
      if (cak.printedMaxMarks !== undefined) {
        hash.update(`CANONICAL_AK_PRINTED:${cak.printedMaxMarks}\n`);
      }
      if (Array.isArray(cak.questions)) {
        for (const q of cak.questions) {
          const concepts = Array.isArray(q.expectedConcepts) ? q.expectedConcepts.join('|') : '';
          const alts = Array.isArray(q.acceptableAlternatives) ? q.acceptableAlternatives.join('|') : '';
          const criteria = Array.isArray(q.markingCriteria) ? q.markingCriteria.join('|') : '';
          const altRule = q.isAlternative ? `alt:${q.alternativeGroup || ''}` : '';
          const selRule = q.selectionGroup ? `sel:${q.selectionGroup}:${q.requiredAttempts || 1}` : '';
          hash.update(
            `Q:${q.questionId}:${q.maxMarks}:${q.referenceAnswer || ''}:${concepts}:${alts}:${criteria}:${altRule}:${selRule}\n`
          );
        }
      }
    } else if (payload.answerKey) {
      const ak = payload.answerKey;
      hash.update(`AK_NAME:${ak.name || ''}\n`);
      hash.update(`AK_MIME:${ak.mimeType || ''}\n`);
      if (ak.text) {
        hash.update(`AK_TEXT_LEN:${ak.text.length}\n`);
        hash.update(ak.text);
        hash.update('\n');
      }
      if (ak.base64) {
        hash.update(`AK_B64_LEN:${ak.base64.length}\n`);
        hash.update(ak.base64);
        hash.update('\n');
      }
    }

    // 5. Full Hashing of Faculty Notes (only if mode is 'with-manual')
    if (payload.mode === 'with-manual' && payload.facultyNotes) {
      const fn = payload.facultyNotes;
      hash.update(`FN_NAME:${fn.name || ''}\n`);
      hash.update(`FN_MIME:${fn.mimeType || ''}\n`);
      if (fn.text) {
        hash.update(`FN_TEXT_LEN:${fn.text.length}\n`);
        hash.update(fn.text);
        hash.update('\n');
      }
      if (fn.base64) {
        hash.update(`FN_B64_LEN:${fn.base64.length}\n`);
        hash.update(fn.base64);
        hash.update('\n');
      }
    }

    return hash.digest('hex');
  }

  /**
   * Retrieves a cached report if valid, unexpired, and caller is authorized
   */
  public get(key: string, userContext?: UserContext | null): CacheEntry | null {
    this.totalRequests++;

    const checkEntry = (entry: CacheEntry): CacheEntry | null => {
      // TTL verification
      if (Date.now() - entry.timestamp > config.cacheTtlMs) {
        return null;
      }

      // Authorization verification:
      // If userContext is passed, verify tenant isolation
      if (userContext && userContext.role !== 'operator') {
        const cachedInst = entry.institutionId || 'inst_aarshiv_01';
        if (cachedInst !== userContext.institutionId) {
          console.warn(`[CacheService] Unauthorized cache access attempt across institutions: user=${userContext.institutionId}, cached=${cachedInst}`);
          return null;
        }

        // Cross-user isolation: evaluators can only access evaluations they created
        if (userContext.role === 'evaluator') {
          if (entry.createdBy && entry.createdBy !== userContext.userId) {
            console.warn(`[CacheService] Unauthorized cache access attempt across evaluators: user=${userContext.userId}, cached=${entry.createdBy}`);
            return null;
          }
        }
      }

      this.cacheHits++;
      return entry;
    };

    // 1. Check memory cache
    const memEntry = this.memoryCache.get(key);
    if (memEntry) {
      const valid = checkEntry(memEntry);
      if (valid) return valid;
      this.memoryCache.delete(key);
    }

    // 2. Check disk cache
    try {
      const filePath = path.join(this.cacheDir, `${key}.json`);
      if (fs.existsSync(filePath)) {
        const data = fs.readFileSync(filePath, 'utf-8');
        const entry = JSON.parse(data) as CacheEntry;
        const valid = checkEntry(entry);
        if (valid) {
          this.memoryCache.set(key, valid);
          return valid;
        } else {
          try {
            fs.unlinkSync(filePath);
          } catch {}
        }
      }
    } catch (e) {
      console.warn('[CacheService] Failed reading disk cache:', e);
    }

    return null;
  }

  /**
   * Stores a successfully validated evaluation report into the cache
   */
  public set(entry: CacheEntry): void {
    this.memoryCache.set(entry.cacheKey, entry);
    try {
      const tempPath = path.join(this.cacheDir, `${entry.cacheKey}.tmp.${Date.now()}`);
      const filePath = path.join(this.cacheDir, `${entry.cacheKey}.json`);
      fs.writeFileSync(tempPath, JSON.stringify(entry, null, 2), 'utf-8');
      try {
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      } catch {}
      fs.renameSync(tempPath, filePath);
    } catch (e) {
      console.warn('[CacheService] Failed persisting to disk cache:', e);
    }
  }

  public getStats() {
    const hitRate = this.totalRequests > 0 ? (this.cacheHits / this.totalRequests) * 100 : 0;
    return {
      totalRequests: this.totalRequests,
      cacheHits: this.cacheHits,
      hitRatePercent: parseFloat(hitRate.toFixed(2)),
      memoryEntriesCount: this.memoryCache.size,
    };
  }

  public clear(): void {
    this.memoryCache.clear();
    this.extractionMemoryCache.clear();
  }

  /**
   * Generates a deterministic fingerprint for student script extraction
   */
  public generateExtractionFingerprint(
    sourceDoc: { text?: string; base64?: string; name?: string; mimeType?: string },
    canonicalKey: CanonicalAnswerKey
  ): string {
    const hash = crypto.createHash('sha256');
    hash.update('EXTRACTION_V1|');
    hash.update(String(sourceDoc.name || '') + '|');
    hash.update(String(sourceDoc.text || '') + '|');
    if (sourceDoc.base64) {
      hash.update(String(sourceDoc.base64.length) + '|');
      hash.update(sourceDoc.base64 + '|');
    }
    hash.update(String(canonicalKey.id || '') + '|');
    hash.update(String(canonicalKey.version || 1));
    return hash.digest('hex');
  }

  /**
   * Retrieves previously completed Stage 1 extraction so grading can resume without repeating it
   */
  public getExtractedScript(cacheKey: string): StudentExtractedScript | null {
    if (this.extractionMemoryCache.has(cacheKey)) {
      return this.extractionMemoryCache.get(cacheKey)!;
    }
    try {
      const filePath = path.join(this.cacheDir, `ext_${cacheKey}.json`);
      if (fs.existsSync(filePath)) {
        const raw = fs.readFileSync(filePath, 'utf-8');
        const script = JSON.parse(raw) as StudentExtractedScript;
        if (script && Array.isArray(script.answers) && script.answers.length > 0) {
          this.extractionMemoryCache.set(cacheKey, script);
          return script;
        }
      }
    } catch (e) {
      console.warn('[CacheService] Failed reading cached extraction:', e);
    }
    return null;
  }

  /**
   * Persists verified Stage 1 extraction result
   */
  public saveExtractedScript(cacheKey: string, script: StudentExtractedScript): void {
    this.extractionMemoryCache.set(cacheKey, script);
    try {
      const tempPath = path.join(this.cacheDir, `ext_${cacheKey}.tmp.${Date.now()}`);
      const filePath = path.join(this.cacheDir, `ext_${cacheKey}.json`);
      fs.writeFileSync(tempPath, JSON.stringify(script, null, 2), 'utf-8');
      try {
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      } catch {}
      fs.renameSync(tempPath, filePath);
    } catch (e) {
      console.warn('[CacheService] Failed saving cached extraction to disk:', e);
    }
  }
}

export const evaluationCache = new EvaluationCacheService();
