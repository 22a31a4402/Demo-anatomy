/**
 * Authoritative Canonical Answer Key Service for NextGen Eval
 *
 * Implements Two Explicit Answer-Key Preparation Modes:
 * Mode 1: "Generate Answer Key Using AI" (from Question Paper + Exam Metadata)
 * Mode 2: "Upload Existing Answer Key" (from Model Answer / Marking Scheme Document)
 *
 * Requirements:
 * - Shared canonical data model (CanonicalAnswerKey & CanonicalQuestionKey)
 * - Review and approval workflow (draft / needs_review -> approved)
 * - Strict rejection of unapproved keys in grading pipeline
 * - Bumping version and resetting approval upon editing an approved key
 * - Rejection of invalid/missing/zero maxMarks upon approval
 * - Flagging missing questions and numbering discrepancies
 * - Atomic persistence in .data/evaluations/answer_keys/
 * - Multi-tenant isolation by institutionId
 * - Zero fabricated fallback grades or synthetic 10/10 data
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import {
  CanonicalAnswerKey,
  CanonicalQuestionKey,
  AnswerKeySourceMode,
  AnswerKeyStatus,
  getCompleteQuestionIdentifier,
  calculateCanonicalKeyMarks,
  MarksValidationResult,
} from './types';
export { getCompleteQuestionIdentifier };
import { UserContext } from './auth';
import { callGeminiWithFallback, canonicalAnswerKeySchema } from './geminiClient';
import { isVisualEvidenceNeeded } from './documentProcessor';
import { config } from './config';

export function computeQuestionPaperFingerprint(doc?: DocumentPayload): string {
  if (!doc) return '';
  const hash = crypto.createHash('sha256');
  if (doc.name) hash.update(`NAME:${doc.name}\n`);
  if (doc.mimeType) hash.update(`MIME:${doc.mimeType}\n`);
  if (doc.text) {
    hash.update(`TEXT_LEN:${doc.text.length}\n`);
    hash.update(doc.text);
    hash.update('\n');
  }
  if (doc.base64) {
    hash.update(`B64_LEN:${doc.base64.length}\n`);
    hash.update(doc.base64);
    hash.update('\n');
  }
  return hash.digest('hex');
}

/**
 * Computes deterministic cryptographic SHA-256 hash of Question Paper + Answer Key pair
 * Identifies document pairs using full content hashes, not filenames.
 */
export function computeReferencePairHash(qpDoc?: DocumentPayload, akDoc?: DocumentPayload): string {
  if (!qpDoc && !akDoc) return '';
  const hash = crypto.createHash('sha256');
  hash.update('REFERENCE_PAIR_V2\n');
  if (qpDoc) {
    if (qpDoc.text) {
      hash.update(`QP_TEXT_LEN:${qpDoc.text.length}\n`);
      hash.update(qpDoc.text);
      hash.update('\n');
    }
    if (qpDoc.base64) {
      hash.update(`QP_B64_LEN:${qpDoc.base64.length}\n`);
      hash.update(qpDoc.base64);
      hash.update('\n');
    }
  }
  if (akDoc) {
    if (akDoc.text) {
      hash.update(`AK_TEXT_LEN:${akDoc.text.length}\n`);
      hash.update(akDoc.text);
      hash.update('\n');
    }
    if (akDoc.base64) {
      hash.update(`AK_B64_LEN:${akDoc.base64.length}\n`);
      hash.update(akDoc.base64);
      hash.update('\n');
    }
  }
  return hash.digest('hex');
}

export class AnswerKeyValidationError extends Error {
  public code = 'ANSWER_KEY_VALIDATION_ERROR';
  constructor(message: string) {
    super(message);
    this.name = 'AnswerKeyValidationError';
  }
}

export interface DocumentPayload {
  name: string;
  text?: string;
  base64?: string;
  mimeType?: string;
}

export interface GenerateFromQpParams {
  questionPaper: DocumentPayload;
  title: string;
  subject?: string;
  grade?: string;
  totalMaxMarks?: number;
  metadata: {
    institutionId: string;
    createdBy: string;
  };
}

export interface ExtractFromUploadedParams {
  answerKeyDoc: DocumentPayload;
  questionPaperDoc?: DocumentPayload;
  title: string;
  subject?: string;
  grade?: string;
  totalMaxMarks?: number;
  metadata: {
    institutionId: string;
    createdBy: string;
  };
}

export class AnswerKeyService {
  private storageDir: string;
  private cache: Map<string, CanonicalAnswerKey> = new Map();

  constructor() {
    this.storageDir = path.join(config.dataDir, 'answer_keys');
    try {
      if (!fs.existsSync(this.storageDir)) {
        fs.mkdirSync(this.storageDir, { recursive: true });
      }
    } catch (e) {
      console.warn('[AnswerKeyService] Read-only or inaccessible storage directory, using in-memory store:', e);
    }
    this.loadAllFromDisk();
  }

  private loadAllFromDisk(): void {
    const candidateDirs = Array.from(
      new Set([
        this.storageDir,
        path.join(process.cwd(), '.data', 'evaluations', 'answer_keys'),
        path.join(process.cwd(), '..', '.data', 'evaluations', 'answer_keys'),
      ])
    );

    for (const dir of candidateDirs) {
      try {
        if (!fs.existsSync(dir)) continue;
        const files = fs.readdirSync(dir);
        for (const file of files) {
          if (file.endsWith('.json')) {
            const filePath = path.join(dir, file);
            try {
              const raw = fs.readFileSync(filePath, 'utf-8');
              const parsed: CanonicalAnswerKey = JSON.parse(raw);
              if (parsed && parsed.id && !this.cache.has(parsed.id)) {
                if (!parsed.questionPaperFingerprint && parsed.sourceQuestionPaperDoc) {
                  parsed.questionPaperFingerprint = computeQuestionPaperFingerprint(parsed.sourceQuestionPaperDoc);
                }
                if (!parsed.referencePairHash && parsed.sourceQuestionPaperDoc && parsed.sourceAnswerKeyDoc) {
                  parsed.referencePairHash = computeReferencePairHash(parsed.sourceQuestionPaperDoc, parsed.sourceAnswerKeyDoc);
                }
                this.cache.set(parsed.id, parsed);
              }
            } catch (e) {
              console.error(`[AnswerKeyService] Failed to load key file ${file}:`, e);
            }
          }
        }
      } catch (err) {
        console.warn(`[AnswerKeyService] Warning scanning dir ${dir}:`, err);
      }
    }
  }

  private saveToDisk(key: CanonicalAnswerKey): void {
    this.cache.set(key.id, key);
    if (!key.questionPaperFingerprint && key.sourceQuestionPaperDoc) {
      key.questionPaperFingerprint = computeQuestionPaperFingerprint(key.sourceQuestionPaperDoc);
    }
    if (!key.referencePairHash && key.sourceQuestionPaperDoc && key.sourceAnswerKeyDoc) {
      key.referencePairHash = computeReferencePairHash(key.sourceQuestionPaperDoc, key.sourceAnswerKeyDoc);
    }

    try {
      if (!fs.existsSync(this.storageDir)) {
        fs.mkdirSync(this.storageDir, { recursive: true });
      }
      const filePath = path.join(this.storageDir, `${key.id}.json`);
      const tmpPath = `${filePath}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(key, null, 2), 'utf-8');
      try {
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      } catch {}
      fs.renameSync(tmpPath, filePath);
    } catch (err) {
      console.warn('[AnswerKeyService] Could not write key to disk (read-only filesystem). Key kept in memory cache:', err);
    }
  }

  /**
   * Mode 1: Generate Answer Key Using AI
   * Extracts questions, suggests reference answers, expected concepts, alternatives, and marking criteria.
   * Flags ambiguous questions or missing marks.
   * Starts in 'draft' or 'needs_review' status.
   */
  public async generateFromQuestionPaper(params: GenerateFromQpParams): Promise<CanonicalAnswerKey> {
    const { questionPaper, title, subject, grade, totalMaxMarks, metadata } = params;

    if (!questionPaper || (!questionPaper.text && !questionPaper.base64)) {
      throw new AnswerKeyValidationError('Question paper content (text or visual document) is required.');
    }

    const totalStart = Date.now();
    const correlationId = `ak_gen_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const id = `ak_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;

    // STAGE 1: PDF & Document Preparation
    const prepStart = Date.now();
    const contentsParts: any[] = [];
    const qpText = questionPaper.text ? questionPaper.text.trim() : '';
    const textSufficient = qpText.length >= 50 && !isVisualEvidenceNeeded(questionPaper);
    const approxDocKb = questionPaper.base64 ? Math.round((questionPaper.base64.length * 3) / 4 / 1024) : 0;

    if (textSufficient) {
      // Extracted text is comprehensive and sufficient: optimize token usage
      contentsParts.push({
        text: `--- OFFICIAL QUESTION PAPER ---\n${qpText}\n\n`,
      });
    } else {
      // Text is insufficient, missing, or contains diagrams, math, chemistry, code, tables, or scanned content
      if (qpText.length > 0) {
        contentsParts.push({
          text: `--- OFFICIAL QUESTION PAPER (Extracted Text Index) ---\n${qpText}\n\n`,
        });
      }
      if (questionPaper.base64 && questionPaper.mimeType) {
        contentsParts.push({ text: `DOCUMENT_START: OFFICIAL QUESTION PAPER (Visual)` });
        contentsParts.push({
          inlineData: {
            data: questionPaper.base64,
            mimeType: questionPaper.mimeType,
          },
        });
        contentsParts.push({ text: `DOCUMENT_END: OFFICIAL QUESTION PAPER` });
      }
    }

    contentsParts.push({
      text: `TASK: Generate a comprehensive, authoritative, structured Answer Key for this Question Paper.
Exam Title: "${title}"
${subject ? `Subject: "${subject}"` : ''}
${grade ? `Grade / Academic Level: "${grade}"` : ''}
${totalMaxMarks ? `Target Total Marks: ${totalMaxMarks}` : ''}

CRITICAL QUESTION AND MARKS EXTRACTION REQUIREMENTS:
1. Extract EVERY question, sub-question, section, question number, and assigned marks exactly as printed.
2. Preserve hierarchical numbering such as 1, 1.1, 1.2, 2(a), 2(b), etc. accurately.
3. Extract explicit printed maximum marks for the entire question paper (printedMaxMarks, e.g. 80, 100) if stated in the header or instructions.
4. Extract section-wise maximum marks and section names (e.g. "Section A", "Part I").
5. Never assume, infer, or invent marks when missing or unclear. Flag uncertain values in flaggedIssue for faculty review.
6. Distinguish selection rules and alternative questions:
   - "Attempt any N of the following : marks" instructions (e.g. "Attempt any FIVE of the following : 10"):
     * Set selectionGroup, requiredAttempts (N), and groupMaxMarks.
   - Mutually exclusive OR choices (e.g. "Answer Q5 OR Q6", "Either 2(a) OR 2(b)"):
     * Set isAlternative: true and alternativeGroup: "Q5_OR_Q6" (or equivalent group identifier).
7. If a parent question (e.g. "Question 2" - 10 marks) has sub-questions (e.g. 2.1 - 4 marks, 2.2 - 6 marks):
   - Set isParentHeader: true on the container question so its marks are not counted twice.
   - Set parentQuestionId: "2" on sub-questions 2.1 and 2.2.

SUBJECT-INDEPENDENT REQUIREMENTS ACROSS ACADEMIC DISCIPLINES:
- NextGen Eval supports question papers across mathematics, physical sciences, chemical sciences, biological & medical sciences, engineering, computer science, commerce, economics, languages, literature, humanities, and social sciences.
- Do NOT make assumptions based on any particular subject. Model answers, expected concepts, alternative formulations, and marking rubrics must faithfully reflect the actual subject and question:
  * Mathematics / Physics: Preserve mathematical notation, equations, calculus/algebraic derivations, step-by-step proofs, formulas, and numeric calculations. Provide criteria for partial credit on intermediate steps.
  * Computer Science / Engineering: Preserve code snippets, algorithms, data structures, flowcharts, circuit schematics, logic gates, and edge cases. Award credit for functional correctness regardless of formatting.
  * Chemistry: Preserve balanced chemical equations, stoichiometry, reaction mechanisms, molecular structures, reagents, and conditions.
  * Commerce / Economics: Preserve ledger accounts, journal entries, balance sheet equations, supply/demand curve analysis, and financial formulas.
  * Languages & Humanities: Preserve textual citations, thesis statements, thematic analysis, grammatical/linguistic standards, and structured essay points.
  * Medicine & Life Sciences: Preserve physiological pathways, cellular mechanisms, terminology, and labelled illustrations.

CRITICAL ACADEMIC INSTRUCTIONS:
1. Extract ALL questions and subquestions hierarchically (e.g. "1", "1.1", "2.a", "3").
2. Extract the exact explicit maximum marks (maxMarks) specified for each question.
   - If maximum marks are NOT explicitly provided in the question paper, set maxMarks to 0 or null and set flaggedIssue to "Missing maximum marks in question paper - instructor review required".
   - NEVER invent marks or default missing marks to 1!
3. For each question, provide:
   - referenceAnswer: concise, high-density authoritative model answer containing all core factual points, steps, formulas, code, or clinical facts without verbose conversational filler.
   - expectedConcepts: key essential points student must demonstrate.
   - acceptableAlternatives: valid equivalent methods or formulations for fair grading.
   - markingCriteria: step-by-step partial credit breakdown.
   - diagramReferences: name of any required diagrams, illustrations, charts, or schematics.
   - flaggedIssue: flag any question ambiguity or missing information honestly.

Return ONLY a valid JSON object matching the canonicalAnswerKeySchema.`,
    });

    const systemInstruction = `You are an expert academic curriculum and examination specialist for Aarshiv AI NextGen Eval.
Your responsibility is to analyze question papers and generate authoritative, rigorous answer keys across all academic disciplines (Mathematics, Science, Medicine, Engineering, Computer Science, Commerce, Languages, Humanities, and other fields).
You maintain absolute academic integrity: never fabricate missing marks, faithfully preserve subject-specific content and notation, and always flag ambiguities for human instructor review.
Output must be strictly raw JSON with no Markdown wrapping.`;

    const prepDurationMs = Date.now() - prepStart;
    const approxPayloadKb = Math.round(JSON.stringify(contentsParts).length / 1024);
    console.log(
      `[AnswerKeyService][${correlationId}][Stage 1: PDF Prep] Prepared "${questionPaper.name}" in ${prepDurationMs}ms (approxDocSize: ${approxDocKb}KB, textChars: ${qpText.length}, visualEvidenceRetained: ${!textSufficient}, requestPayload: ${approxPayloadKb}KB)`
    );

    // STAGE 2: Gemini Request Dispatch
    const candidateModels = Array.from(new Set([config.primaryModel, ...config.fallbackModels]))
      .filter((m) => m !== 'gemini-3.8-flash' && m !== 'gemini-flash-latest');
    if (candidateModels.length === 0) candidateModels.push('gemini-2.5-flash');

    const timeoutBudget = config.requestTimeoutMs < 5000 ? config.requestTimeoutMs : Math.max(config.requestTimeoutMs, 180000);
    console.log(
      `[AnswerKeyService][${correlationId}][Stage 2: Gemini Request] Initiating answer key generation across candidate models [${candidateModels.join(', ')}] with canonicalAnswerKeySchema, thinkingBudget=0, timeout=${timeoutBudget}ms...`
    );

    const geminiResult = await callGeminiWithFallback(
      contentsParts,
      systemInstruction,
      correlationId,
      {
        jobId: id,
        institutionId: metadata.institutionId,
        pipelineStage: 'answer_key_generation',
        candidateModels,
        responseSchema: canonicalAnswerKeySchema,
        thinkingBudget: 0,
        timeoutMs: timeoutBudget,
      }
    );

    console.log(
      `[AnswerKeyService][${correlationId}][Stage 2: Gemini Completed] Response received from model "${geminiResult.modelUsed}" in ${geminiResult.latencyMs}ms. Tokens: in=${geminiResult.inputTokens ?? 'N/A'}/out=${geminiResult.outputTokens ?? 'N/A'}/cached=${geminiResult.cachedInputTokens ?? 'N/A'}, retries=${geminiResult.retries}, fallbacks=${geminiResult.fallbackCallsCount}`
    );

    // STAGE 3: Response Parsing
    const parseStart = Date.now();
    let parsedResult: any;
    try {
      const rawReportText = typeof (geminiResult.report as any) === 'string'
        ? (geminiResult.report as any)
        : JSON.stringify(geminiResult.report);

      parsedResult = typeof geminiResult.report === 'object' && geminiResult.report !== null && 'questions' in geminiResult.report
        ? geminiResult.report
        : JSON.parse(rawReportText);
    } catch (e: any) {
      throw new Error(`Failed to parse AI-generated answer key response: ${e.message}`);
    }

    const rawQuestions: any[] = Array.isArray(parsedResult.questions) ? parsedResult.questions : [];
    const parseDurationMs = Date.now() - parseStart;
    console.log(
      `[AnswerKeyService][${correlationId}][Stage 3: Response Parsing] Parsed JSON response in ${parseDurationMs}ms. Identified ${rawQuestions.length} questions.`
    );

    if (rawQuestions.length === 0) {
      throw new AnswerKeyValidationError('AI model could not identify any questions in the provided question paper.');
    }

    // STAGE 4: Validation & Canonical Normalization
    const valStart = Date.now();

    const canonicalQuestions: CanonicalQuestionKey[] = [];
    const warnings: string[] = Array.isArray(parsedResult.warnings) ? parsedResult.warnings : [];
    const seenIds = new Set<string>();
    let hasFlaggedIssues = false;

    for (let i = 0; i < rawQuestions.length; i++) {
      const q = rawQuestions[i];
      const completeId = getCompleteQuestionIdentifier(q) || `${i + 1}`;
      let maxM = Number(q.maxMarks);

      let flagged = q.flaggedIssue ? String(q.flaggedIssue).trim() : undefined;

      const isParentHeader = Boolean(q.isParentHeader);
      if (!isParentHeader && (!Number.isFinite(maxM) || maxM <= 0)) {
        maxM = 0;
        flagged = flagged || 'Missing maximum marks in question paper - faculty review required.';
        hasFlaggedIssues = true;
        warnings.push(`Question ${completeId}: Missing explicit maximum marks.`);
      }

      if (seenIds.has(completeId)) {
        hasFlaggedIssues = true;
        warnings.push(`Duplicate question number "${completeId}" detected.`);
        flagged = flagged || `Duplicate question identifier "${completeId}".`;
      } else {
        seenIds.add(completeId);
      }

      if (flagged) {
        hasFlaggedIssues = true;
      }

      canonicalQuestions.push({
        questionId: completeId,
        subquestionId: q.subquestionId ? String(q.subquestionId).trim() : undefined,
        parentQuestionId: q.parentQuestionId ? String(q.parentQuestionId).trim() : undefined,
        section: q.section ? String(q.section).trim() : undefined,
        isAlternative: Boolean(q.isAlternative),
        alternativeGroup: q.alternativeGroup ? String(q.alternativeGroup).trim() : undefined,
        selectionGroup: q.selectionGroup ? String(q.selectionGroup).trim() : (q.alternativeGroup ? String(q.alternativeGroup).trim() : undefined),
        requiredAttempts: typeof q.requiredAttempts === 'number' && Number.isFinite(q.requiredAttempts) ? q.requiredAttempts : undefined,
        groupRule: q.groupRule as any,
        groupMaxMarks: typeof q.groupMaxMarks === 'number' && Number.isFinite(q.groupMaxMarks) ? q.groupMaxMarks : undefined,
        branchId: q.branchId ? String(q.branchId).trim() : undefined,
        isParentHeader,
        questionText: q.questionText ? String(q.questionText).trim() : undefined,
        maxMarks: maxM,
        referenceAnswer: String(q.referenceAnswer || q.expectedAnswer || 'Suggested model answer to be reviewed.').trim(),
        expectedConcepts: Array.isArray(q.expectedConcepts) ? q.expectedConcepts.map(String) : [],
        acceptableAlternatives: Array.isArray(q.acceptableAlternatives) ? q.acceptableAlternatives.map(String) : [],
        markingCriteria: Array.isArray(q.markingCriteria) ? q.markingCriteria.map(String) : [],
        diagramReferences: Array.isArray(q.diagramReferences) ? q.diagramReferences.map(String) : [],
        confidence: typeof q.confidence === 'number' ? q.confidence : 0.9,
        flaggedIssue: flagged,
      });
    }

    const paperPrintedMax = Number(parsedResult.printedMaxMarks) > 0
      ? Number(parsedResult.printedMaxMarks)
      : (totalMaxMarks && totalMaxMarks > 0
        ? totalMaxMarks
        : (Number(parsedResult.totalMaxMarks) > 0 ? Number(parsedResult.totalMaxMarks) : undefined));

    const marksValidation: MarksValidationResult = calculateCanonicalKeyMarks(canonicalQuestions, paperPrintedMax);

    if (marksValidation.hasDiscrepancy) {
      hasFlaggedIssues = true;
      for (const msg of marksValidation.discrepancyMessages) {
        if (!warnings.includes(msg)) {
          warnings.push(msg);
        }
      }
    }

    const initialStatus: AnswerKeyStatus = (hasFlaggedIssues || marksValidation.hasDiscrepancy) ? 'needs_review' : 'draft';

    const canonicalKey: CanonicalAnswerKey = {
      id,
      examId: `exam_${Date.now()}`,
      title: title || 'Academic Examination Answer Key',
      subject,
      grade,
      sourceMode: 'ai_generated',
      version: 1,
      status: initialStatus,
      printedMaxMarks: paperPrintedMax,
      totalMaxMarks: marksValidation.calculatedTotalMarks,
      marksValidation,
      selectionRules: marksValidation.selectionRules,
      questions: canonicalQuestions,
      warnings: warnings.length > 0 ? warnings : undefined,
      metadata: {
        institutionId: metadata.institutionId,
        createdBy: metadata.createdBy,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        sourceDocName: questionPaper.name,
      },
      questionPaperFingerprint: computeQuestionPaperFingerprint(questionPaper),
      sourceQuestionPaperDoc: questionPaper,
    };

    this.saveToDisk(canonicalKey);
    const valDurationMs = Date.now() - valStart;
    const totalDurationMs = Date.now() - totalStart;
    console.log(
      `[AnswerKeyService][${correlationId}][Stage 4: Validation Complete] Validated ${canonicalQuestions.length} canonical questions in ${valDurationMs}ms (totalMaxMarks: ${canonicalKey.totalMaxMarks}, printedMax: ${canonicalKey.printedMaxMarks}, status: ${initialStatus}). Total pipeline elapsed: ${totalDurationMs}ms.`
    );
    return canonicalKey;
  }

  /**
   * Mode 2: Upload Existing Answer Key
   * Parses official answer key document, extracts model answers and marking criteria,
   * cross-references against question paper (if provided), flags discrepancies,
   * starts in 'draft' or 'needs_review' status.
   */
  public async extractFromUploadedKey(params: ExtractFromUploadedParams): Promise<CanonicalAnswerKey> {
    const { answerKeyDoc, questionPaperDoc, title, subject, grade, totalMaxMarks, metadata } = params;

    if (!answerKeyDoc || (!answerKeyDoc.text && !answerKeyDoc.base64)) {
      throw new AnswerKeyValidationError('Answer key document content (text or visual document) is required.');
    }

    const pairHash = computeReferencePairHash(questionPaperDoc, answerKeyDoc);
    if (pairHash) {
      const existingApproved = this.findApprovedKeyForReferencePair(questionPaperDoc, answerKeyDoc, {
        userId: metadata.createdBy,
        role: 'instructor',
        institutionId: metadata.institutionId,
        name: 'System',
      });
      if (existingApproved) {
        console.log(
          `[AnswerKeyService] Reusing existing approved canonical answer key for reference pair hash ${pairHash} (${existingApproved.id}, v${existingApproved.version}). Skipping duplicate extraction.`
        );
        return existingApproved;
      }
    }

    const correlationId = `ak_ext_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const id = `ak_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;

    // Assemble parts for Gemini
    const contentsParts: any[] = [];

    // Add Answer Key Document
    const akText = answerKeyDoc.text ? answerKeyDoc.text.trim() : '';
    const akTextSufficient = akText.length >= 50 && !isVisualEvidenceNeeded(answerKeyDoc);

    if (akTextSufficient) {
      contentsParts.push({
        text: `--- OFFICIAL UPLOADED ANSWER KEY DOCUMENT ---\n${akText}\n\n`,
      });
    } else {
      if (akText.length > 0) {
        contentsParts.push({
          text: `--- OFFICIAL UPLOADED ANSWER KEY DOCUMENT (Extracted Text Index) ---\n${akText}\n\n`,
        });
      }
      if (answerKeyDoc.base64 && answerKeyDoc.mimeType) {
        contentsParts.push({ text: `DOCUMENT_START: OFFICIAL ANSWER KEY (Visual)` });
        contentsParts.push({
          inlineData: {
            data: answerKeyDoc.base64,
            mimeType: answerKeyDoc.mimeType,
          },
        });
        contentsParts.push({ text: `DOCUMENT_END: OFFICIAL ANSWER KEY` });
      }
    }

    // Add optional Question Paper for cross-referencing
    if (questionPaperDoc) {
      const qpRefText = questionPaperDoc.text ? questionPaperDoc.text.trim() : '';
      const qpRefTextSufficient = qpRefText.length >= 50 && !isVisualEvidenceNeeded(questionPaperDoc);

      if (qpRefTextSufficient) {
        contentsParts.push({
          text: `--- REFERENCE QUESTION PAPER (FOR CROSS-VALIDATION) ---\n${qpRefText}\n\n`,
        });
      } else {
        if (qpRefText.length > 0) {
          contentsParts.push({
            text: `--- REFERENCE QUESTION PAPER (Extracted Text Index) ---\n${qpRefText}\n\n`,
          });
        }
        if (questionPaperDoc.base64 && questionPaperDoc.mimeType) {
          contentsParts.push({ text: `DOCUMENT_START: REFERENCE QUESTION PAPER (Visual)` });
          contentsParts.push({
            inlineData: {
              data: questionPaperDoc.base64,
              mimeType: questionPaperDoc.mimeType,
            },
          });
          contentsParts.push({ text: `DOCUMENT_END: REFERENCE QUESTION PAPER` });
        }
      }
    }

    contentsParts.push({
      text: `TASK: Extract and validate a structured Canonical Answer Key from the uploaded answer key document.
Exam Title: "${title}"
${subject ? `Subject: "${subject}"` : ''}
${grade ? `Grade / Academic Level: "${grade}"` : ''}
${totalMaxMarks ? `Target Total Marks: ${totalMaxMarks}` : ''}
${questionPaperDoc ? 'NOTE: A question paper was provided. Cross-reference every question number between the Question Paper and the Answer Key!' : ''}

SUBJECT-INDEPENDENT REQUIREMENTS ACROSS ACADEMIC DISCIPLINES:
- NextGen Eval supports question papers across mathematics, physical sciences, chemical sciences, biological & medical sciences, engineering, computer science, commerce, economics, languages, literature, humanities, and social sciences.
- Preserve subject-specific content including mathematical notation, equations, diagrams, tables, chemical structures, code, flowcharts, labelled illustrations, and descriptive text.
- Do NOT make assumptions based on a particular subject.

CRITICAL EXTRACTION & VALIDATION RULES:
1. Extract question numbering, subquestions, and sections exactly as defined.
2. Extract the model answer / reference solution for each question with complete technical depth.
3. Extract maximum marks for each question. If missing, set maxMarks to 0 and flag in flaggedIssue.
4. Extract expected answer concepts, acceptable alternatives, and marking rubric points reflecting the actual question and subject.
5. If any question requires or references a diagram, graph, table, flowchart, circuit, or illustration, record it in diagramReferences.
6. If Question Paper was provided:
   - Identify any questions present in the Question Paper but MISSING from the Answer Key!
   - Identify any question numbering mismatches.
   - If a question is missing an answer or has conflicting numbering, set flaggedIssue with detailed explanation.
7. If any mark allocations are ambiguous or split unclearly, flag them in flaggedIssue.

Return ONLY a valid JSON object matching this schema:
{
  "examTitle": "${title}",
  "totalMaxMarks": number,
  "warnings": string[],
  "questions": [
    {
      "questionId": string,
      "subquestionId": string | null,
      "questionText": string,
      "maxMarks": number,
      "referenceAnswer": string,
      "expectedConcepts": string[],
      "acceptableAlternatives": string[],
      "markingCriteria": string[],
      "diagramReferences": string[],
      "confidence": number,
      "flaggedIssue": string | null
    }
  ]
}`,
    });

    const systemInstruction = `You are an expert academic curriculum parsing specialist for Aarshiv AI NextGen Eval.
Extract and validate structured answer keys with high fidelity across all academic disciplines.
Faithfully preserve mathematical notation, equations, diagrams, tables, chemical structures, code, flowcharts, labelled illustrations, and descriptive text.
Flag missing answers, missing marks, or question number discrepancies honestly.
Output must be strictly raw JSON with no Markdown wrapping.`;

    const candidateModels = Array.from(new Set([config.primaryModel, ...config.fallbackModels]))
      .filter((m) => m !== 'gemini-3.8-flash' && m !== 'gemini-flash-latest');
    if (candidateModels.length === 0) candidateModels.push('gemini-2.5-flash');

    const timeoutBudget = config.requestTimeoutMs < 5000 ? config.requestTimeoutMs : Math.max(config.requestTimeoutMs, 180000);

    const geminiResult = await callGeminiWithFallback(
      contentsParts,
      systemInstruction,
      correlationId,
      {
        jobId: id,
        institutionId: metadata.institutionId,
        pipelineStage: 'answer_key_extraction',
        candidateModels,
        responseSchema: canonicalAnswerKeySchema,
        thinkingBudget: 0,
        timeoutMs: timeoutBudget,
      }
    );

    let parsedResult: any;
    try {
      const rawReportText = typeof (geminiResult.report as any) === 'string'
        ? (geminiResult.report as any)
        : JSON.stringify(geminiResult.report);

      parsedResult = typeof geminiResult.report === 'object' && geminiResult.report !== null && 'questions' in geminiResult.report
        ? geminiResult.report
        : JSON.parse(rawReportText);
    } catch (e: any) {
      throw new Error(`Failed to parse extracted answer key response: ${e.message}`);
    }

    const rawQuestions: any[] = Array.isArray(parsedResult.questions) ? parsedResult.questions : [];
    if (rawQuestions.length === 0) {
      throw new AnswerKeyValidationError('Could not extract any questions from the uploaded answer key document.');
    }

    const canonicalQuestions: CanonicalQuestionKey[] = [];
    const warnings: string[] = Array.isArray(parsedResult.warnings) ? parsedResult.warnings : [];
    const seenIds = new Set<string>();
    let hasFlaggedIssues = false;

    for (let i = 0; i < rawQuestions.length; i++) {
      const q = rawQuestions[i];
      const completeId = getCompleteQuestionIdentifier(q) || `${i + 1}`;
      let maxM = Number(q.maxMarks);

      let flagged = q.flaggedIssue ? String(q.flaggedIssue).trim() : undefined;

      const isParentHeader = Boolean(q.isParentHeader);
      if (!isParentHeader && (!Number.isFinite(maxM) || maxM <= 0)) {
        maxM = 0;
        flagged = flagged || 'Missing or invalid maximum marks in uploaded answer key.';
        hasFlaggedIssues = true;
        warnings.push(`Question ${completeId}: Missing maximum marks.`);
      }

      if (seenIds.has(completeId)) {
        hasFlaggedIssues = true;
        warnings.push(`Duplicate question number "${completeId}" detected.`);
        flagged = flagged || `Duplicate question identifier "${completeId}".`;
      } else {
        seenIds.add(completeId);
      }

      if (flagged) {
        hasFlaggedIssues = true;
      }

      canonicalQuestions.push({
        questionId: completeId,
        subquestionId: q.subquestionId ? String(q.subquestionId).trim() : undefined,
        parentQuestionId: q.parentQuestionId ? String(q.parentQuestionId).trim() : undefined,
        section: q.section ? String(q.section).trim() : undefined,
        isAlternative: Boolean(q.isAlternative),
        alternativeGroup: q.alternativeGroup ? String(q.alternativeGroup).trim() : undefined,
        selectionGroup: q.selectionGroup ? String(q.selectionGroup).trim() : (q.alternativeGroup ? String(q.alternativeGroup).trim() : undefined),
        requiredAttempts: typeof q.requiredAttempts === 'number' && Number.isFinite(q.requiredAttempts) ? q.requiredAttempts : undefined,
        groupRule: q.groupRule as any,
        groupMaxMarks: typeof q.groupMaxMarks === 'number' && Number.isFinite(q.groupMaxMarks) ? q.groupMaxMarks : undefined,
        branchId: q.branchId ? String(q.branchId).trim() : undefined,
        isParentHeader,
        questionText: q.questionText ? String(q.questionText).trim() : undefined,
        maxMarks: maxM,
        referenceAnswer: String(q.referenceAnswer || q.expectedAnswer || 'Model answer from uploaded document.').trim(),
        expectedConcepts: Array.isArray(q.expectedConcepts) ? q.expectedConcepts.map(String) : [],
        acceptableAlternatives: Array.isArray(q.acceptableAlternatives) ? q.acceptableAlternatives.map(String) : [],
        markingCriteria: Array.isArray(q.markingCriteria) ? q.markingCriteria.map(String) : [],
        diagramReferences: Array.isArray(q.diagramReferences) ? q.diagramReferences.map(String) : [],
        confidence: typeof q.confidence === 'number' ? q.confidence : 0.95,
        flaggedIssue: flagged,
      });
    }

    const paperPrintedMax = Number(parsedResult.printedMaxMarks) > 0
      ? Number(parsedResult.printedMaxMarks)
      : (totalMaxMarks && totalMaxMarks > 0
        ? totalMaxMarks
        : (Number(parsedResult.totalMaxMarks) > 0 ? Number(parsedResult.totalMaxMarks) : undefined));

    const marksValidation: MarksValidationResult = calculateCanonicalKeyMarks(canonicalQuestions, paperPrintedMax);

    if (marksValidation.hasDiscrepancy) {
      hasFlaggedIssues = true;
      for (const msg of marksValidation.discrepancyMessages) {
        if (!warnings.includes(msg)) {
          warnings.push(msg);
        }
      }
    }

    const initialStatus: AnswerKeyStatus = (hasFlaggedIssues || marksValidation.hasDiscrepancy) ? 'needs_review' : 'draft';

    const canonicalKey: CanonicalAnswerKey = {
      id,
      examId: `exam_${Date.now()}`,
      title: title || 'Academic Examination Answer Key',
      subject,
      grade,
      sourceMode: 'uploaded',
      version: 1,
      status: initialStatus,
      printedMaxMarks: paperPrintedMax,
      totalMaxMarks: marksValidation.calculatedTotalMarks,
      marksValidation,
      selectionRules: marksValidation.selectionRules,
      questions: canonicalQuestions,
      warnings: warnings.length > 0 ? warnings : undefined,
      metadata: {
        institutionId: metadata.institutionId,
        createdBy: metadata.createdBy,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        sourceDocName: answerKeyDoc.name,
      },
      questionPaperFingerprint: questionPaperDoc ? computeQuestionPaperFingerprint(questionPaperDoc) : undefined,
      referencePairHash: pairHash || undefined,
      sourceQuestionPaperDoc: questionPaperDoc,
      sourceAnswerKeyDoc: answerKeyDoc,
    };

    this.saveToDisk(canonicalKey);
    return canonicalKey;
  }

  /**
   * Retrieves an answer key with multi-tenant access control
   */
  public getAnswerKey(id: string, user?: UserContext): CanonicalAnswerKey | null {
    const key = this.cache.get(id);
    if (!key) return null;

    if (user && user.role !== 'operator' && user.institutionId !== key.metadata.institutionId) {
      return null;
    }
    return key;
  }

  /**
   * Finds an existing approved canonical key matching the full content hash of the (Question Paper + Answer Key) pair.
   * Enables persistent reference reuse across all students without repeating extraction.
   */
  public findApprovedKeyForReferencePair(
    questionPaper?: DocumentPayload,
    answerKey?: DocumentPayload,
    user?: UserContext
  ): CanonicalAnswerKey | null {
    if (!questionPaper && !answerKey) return null;
    const pairHash = computeReferencePairHash(questionPaper, answerKey);
    if (!pairHash) return null;

    const all = Array.from(this.cache.values());
    const matching = all.filter((k) => {
      if (k.status !== 'approved') return false;
      if (user && user.role !== 'operator' && k.metadata.institutionId !== user.institutionId) return false;

      if (k.referencePairHash && k.referencePairHash === pairHash) {
        return true;
      }
      if (k.sourceQuestionPaperDoc && k.sourceAnswerKeyDoc) {
        const kPairHash = k.referencePairHash || computeReferencePairHash(k.sourceQuestionPaperDoc, k.sourceAnswerKeyDoc);
        if (kPairHash === pairHash) return true;
      }
      return false;
    });

    if (matching.length === 0) return null;
    return matching.sort(
      (a, b) => (b.metadata.approvedAt || b.metadata.updatedAt) - (a.metadata.approvedAt || a.metadata.updatedAt)
    )[0];
  }

  /**
   * Persistently maps a question paper to its approved canonical answer key.
   * Enables users to directly upload student answer scripts on subsequent visits
   * without regenerating or re-uploading the answer key.
   */
  public findApprovedKeyForQuestionPaper(
    questionPaper: DocumentPayload,
    user: UserContext
  ): CanonicalAnswerKey | null {
    const targetFingerprint = computeQuestionPaperFingerprint(questionPaper);
    if (!targetFingerprint) return null;

    const all = Array.from(this.cache.values());
    const matching = all.filter((k) => {
      if (k.status !== 'approved') return false;
      if (user.role !== 'operator' && k.metadata.institutionId !== user.institutionId) return false;

      if (k.questionPaperFingerprint && k.questionPaperFingerprint === targetFingerprint) {
        return true;
      }
      if (k.sourceQuestionPaperDoc) {
        const kFp = k.questionPaperFingerprint || computeQuestionPaperFingerprint(k.sourceQuestionPaperDoc);
        if (kFp === targetFingerprint) return true;
        if (questionPaper.name && k.sourceQuestionPaperDoc.name === questionPaper.name) {
          if (questionPaper.text && k.sourceQuestionPaperDoc.text && questionPaper.text.trim() === k.sourceQuestionPaperDoc.text.trim()) {
            return true;
          }
          if (questionPaper.base64 && k.sourceQuestionPaperDoc.base64 && questionPaper.base64 === k.sourceQuestionPaperDoc.base64) {
            return true;
          }
        }
      }
      return false;
    });

    if (matching.length === 0) return null;
    return matching.sort((a, b) => (b.metadata.approvedAt || b.metadata.updatedAt) - (a.metadata.approvedAt || a.metadata.updatedAt))[0];
  }

  /**
   * Retrieves the most recently approved canonical answer key for the user's institution
   */
  public getLatestApprovedKey(user: UserContext): CanonicalAnswerKey | null {
    const all = Array.from(this.cache.values());
    const approved = all.filter((k) => {
      if (k.status !== 'approved') return false;
      if (user.role !== 'operator' && k.metadata.institutionId !== user.institutionId) return false;
      return true;
    });

    if (approved.length === 0) return null;
    return approved.sort((a, b) => (b.metadata.approvedAt || b.metadata.updatedAt) - (a.metadata.approvedAt || a.metadata.updatedAt))[0];
  }

  public listAnswerKeys(user: UserContext): CanonicalAnswerKey[] {
    const all = Array.from(this.cache.values());
    if (user.role === 'operator') {
      return all.sort((a, b) => b.metadata.updatedAt - a.metadata.updatedAt);
    }
    return all
      .filter((k) => k.metadata.institutionId === user.institutionId)
      .sort((a, b) => b.metadata.updatedAt - a.metadata.updatedAt);
  }

  /**
   * Updates an answer key.
   * If the key was previously 'approved', editing it bumps the version and resets status to 'draft'!
   */
  public updateAnswerKey(
    id: string,
    updates: Partial<CanonicalAnswerKey>,
    user: UserContext
  ): CanonicalAnswerKey {
    const existing = this.getAnswerKey(id, user);
    if (!existing) {
      throw new AnswerKeyValidationError(`Answer key ${id} not found or access denied.`);
    }

    const wasApproved = existing.status === 'approved';
    const newVersion = wasApproved ? existing.version + 1 : existing.version;
    const newStatus: AnswerKeyStatus = wasApproved ? 'draft' : (updates.status || existing.status);

    const updatedQuestions = updates.questions ? [...updates.questions] : existing.questions;

    if (updates.questions) {
      const seenUpdateIds = new Set<string>();
      for (let idx = 0; idx < updatedQuestions.length; idx++) {
        const q = updatedQuestions[idx];
        const completeId = getCompleteQuestionIdentifier(q);
        if (!completeId) {
          throw new AnswerKeyValidationError(`Question at index ${idx} is missing a question identifier.`);
        }
        if (seenUpdateIds.has(completeId)) {
          throw new AnswerKeyValidationError(`Duplicate question number "${completeId}" detected. Every question must have a unique identifier.`);
        }
        seenUpdateIds.add(completeId);
        q.questionId = completeId;
      }
    }

    const printedMaxMarks = updates.printedMaxMarks !== undefined
      ? updates.printedMaxMarks
      : existing.printedMaxMarks;

    // Deterministically calculate question totals, section totals, and discrepancy
    const marksValidation = calculateCanonicalKeyMarks(updatedQuestions, printedMaxMarks);

    const updatedKey: CanonicalAnswerKey = {
      ...existing,
      ...updates,
      id: existing.id,
      version: newVersion,
      status: newStatus,
      printedMaxMarks,
      totalMaxMarks: marksValidation.calculatedTotalMarks,
      marksValidation,
      questions: updatedQuestions,
      metadata: {
        ...existing.metadata,
        updatedAt: Date.now(),
        approvedAt: wasApproved ? undefined : existing.metadata.approvedAt,
        approvedBy: wasApproved ? undefined : existing.metadata.approvedBy,
      },
    };

    this.saveToDisk(updatedKey);
    return updatedKey;
  }

  /**
   * Explicitly approves an answer key.
   * Validates:
   * 1. Questions array is non-empty.
   * 2. Every question has valid questionId and referenceAnswer.
   * 3. Every question has maxMarks > 0 and is a finite number! Rejects missing or 0 marks.
   * 4. Sum consistency.
   * 5. Sets status to 'approved', approvedAt, approvedBy.
   */
  public approveAnswerKey(
    id: string,
    user: UserContext,
    notes?: string
  ): CanonicalAnswerKey {
    const existing = this.getAnswerKey(id, user);
    if (!existing) {
      throw new AnswerKeyValidationError(`Answer key ${id} not found or access denied.`);
    }

    if (!existing.questions || existing.questions.length === 0) {
      throw new AnswerKeyValidationError('Cannot approve an answer key with no questions.');
    }

    const seenIds = new Set<string>();
    const approvedQuestions: CanonicalQuestionKey[] = [];
    for (let idx = 0; idx < existing.questions.length; idx++) {
      const q = existing.questions[idx];
      const completeId = getCompleteQuestionIdentifier(q);
      if (!completeId) {
        throw new AnswerKeyValidationError(`Cannot approve answer key: Question at index ${idx} is missing a question identifier.`);
      }

      if (seenIds.has(completeId)) {
        throw new AnswerKeyValidationError(`Cannot approve answer key: Duplicate question number "${completeId}" detected. Every question must have a unique identifier.`);
      }
      seenIds.add(completeId);

      const maxM = Number(q.maxMarks);
      if (!q.isParentHeader && (!Number.isFinite(maxM) || maxM <= 0)) {
        throw new AnswerKeyValidationError(
          `Cannot approve answer key: Question ${completeId} has invalid or missing maximum marks (${q.maxMarks}). All questions must have positive maximum marks before approval.`
        );
      }

      if (!q.referenceAnswer || !String(q.referenceAnswer).trim()) {
        throw new AnswerKeyValidationError(
          `Cannot approve answer key: Question ${completeId} is missing a model/reference answer.`
        );
      }

      approvedQuestions.push({
        ...q,
        questionId: completeId,
      });
    }

    // Deterministically validate marks against printed maximum marks and log discrepancy if present
    const marksValidation = calculateCanonicalKeyMarks(existing.questions, existing.printedMaxMarks);
    if (marksValidation.hasDiscrepancy) {
      console.warn(
        `[AnswerKeyService] Answer key ${id} approved by faculty with marks discrepancy (calculated: ${marksValidation.calculatedTotalMarks}, printed: ${marksValidation.printedMaxMarks}): ${marksValidation.discrepancyMessages.join('; ')}`
      );
    }

    const approvedKey: CanonicalAnswerKey = {
      ...existing,
      status: 'approved',
      totalMaxMarks: marksValidation.calculatedTotalMarks,
      marksValidation,
      questions: approvedQuestions,
      warnings: undefined, // Cleared on faculty sign-off
      metadata: {
        ...existing.metadata,
        updatedAt: Date.now(),
        approvedAt: Date.now(),
        approvedBy: user.userId,
      },
    };

    this.saveToDisk(approvedKey);
    return approvedKey;
  }

  /**
   * Deletes an answer key
   */
  public deleteAnswerKey(id: string, user: UserContext): boolean {
    const existing = this.getAnswerKey(id, user);
    if (!existing) return false;

    this.cache.delete(id);
    const filePath = path.join(this.storageDir, `${id}.json`);
    if (fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
      } catch (e) {
        console.error(`[AnswerKeyService] Failed to delete file ${filePath}:`, e);
      }
    }
    return true;
  }
}

export const answerKeyService = new AnswerKeyService();
