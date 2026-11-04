/**
 * Stage 1 Extraction Engine for NextGen Eval
 *
 * Implements Stage 1 of the Two-Stage LLM Evaluation Architecture:
 * - Extracts student handwritten/printed answers into a question-wise student-answer JSON
 * - Preserves question numbering, subquestions, marks, diagrams, formulas, and visual evidence
 * - Validates extracted JSON and flags uncertain/missing content instead of fabricating
 * - Reuses the approved exam reference across all students
 */

import { Type } from '@google/genai';
import {
  CanonicalAnswerKey,
  StudentExtractedScript,
  StudentExtractedAnswer,
  getCompleteQuestionIdentifier,
} from './types';
import { callGeminiWithFallback, GeminiCallOptions } from './geminiClient';
import { UserContext } from './auth';

export class ExtractionValidationError extends Error {
  public code = 'EXTRACTION_VALIDATION_ERROR';
  constructor(message: string) {
    super(message);
    this.name = 'ExtractionValidationError';
  }
}

export interface DocumentPayload {
  name: string;
  text?: string;
  base64?: string;
  mimeType?: string;
}

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

export class StudentExtractor {
  /**
   * Stage 1: Extracts student script into structured question-wise JSON
   */
  public async extractStudentAnswers(
    sourceDoc: DocumentPayload,
    canonicalKey: CanonicalAnswerKey,
    correlationId: string,
    options?: GeminiCallOptions & { fallbackStudentName?: string }
  ): Promise<StudentExtractedScript> {
    if (!sourceDoc || (!sourceDoc.text && !sourceDoc.base64)) {
      throw new ExtractionValidationError('Student answer script is missing or empty.');
    }

    const contentsParts: any[] = [];

    // 1. Expected Questions Metadata from Canonical Key
    const expectedQuestionsSummary = canonicalKey.questions.map((q) => ({
      questionId: q.questionId,
      subquestionId: q.subquestionId || null,
      maxMarks: q.maxMarks,
      questionText: q.questionText || '',
      requiresDiagram: Boolean(q.diagramReferences && q.diagramReferences.length > 0),
    }));

    contentsParts.push({
      text: `--- APPROVED EXAM REFERENCE (EXPECTED QUESTIONS) ---
Exam Title: ${canonicalKey.title}
Total Max Marks: ${canonicalKey.totalMaxMarks}
Expected Questions:
${JSON.stringify(expectedQuestionsSummary, null, 2)}
`,
    });

    // 2. Student Answer Script Content
    if (sourceDoc.text && sourceDoc.text.trim().length > 30) {
      contentsParts.push({
        text: `--- STUDENT ANSWER SCRIPT (TEXT CONTENT) ---\n${sourceDoc.text.trim()}\n`,
      });
    }

    if (sourceDoc.base64 && sourceDoc.mimeType) {
      contentsParts.push({
        text: `DOCUMENT_START: STUDENT ACTUAL WRITTEN SCRIPT (Visual Multimodal Document)`,
      });
      contentsParts.push({
        inlineData: {
          data: sourceDoc.base64,
          mimeType: sourceDoc.mimeType,
        },
      });
      contentsParts.push({ text: `DOCUMENT_END: STUDENT ACTUAL WRITTEN SCRIPT` });
    }

    // 3. Extraction Instructions
    contentsParts.push({
      text: `Perform Stage 1 Extraction of the student's written/printed answer sheet across academic disciplines.
Task:
1. Extract student answers question by question matching the Expected Questions list.
2. For each question:
   - Identify questionId (e.g. "1", "2.a", "2.b")
   - If the student attempted the question, extract verbatim studentAnswerText and set isAttempted: true.
   - If the student skipped or omitted the question, set isAttempted: false and studentAnswerText: "[Not Attempted]".
   - If the student drew any diagram, flowchart, chart, graph, circuit schematic, chemical structure, geometry figure, table, or illustration, provide an objective, detailed diagramDescription describing what was drawn, labels, components, connections, values, and arrows.
   - If the student wrote mathematical derivations, calculus/algebraic steps, or chemical equations, list them in formulas array.
   - If the handwriting is ambiguous, faint, scratched out, or difficult to decipher, DO NOT GUESS OR FABRICATE! Set flaggedUncertain: true and describe the ambiguity in flaggedIssue.
   - Provide confidence score (0.0 to 1.0).
3. If visual diagrams, drawings, equations, code blocks, tables, or hand-drawn sketches are present, or whenever text extraction cannot faithfully represent the original content, set visualEvidenceRetained: true so visual proof is preserved for grading.

Return ONLY a valid JSON object matching the studentExtractionSchema.`,
    });

    const systemInstruction = `You are a high-precision academic script extraction specialist for Aarshiv AI NextGen Eval.
Extract student responses across all academic disciplines (Mathematics, Science, Medicine, Engineering, Computer Science, Commerce, Languages, Humanities) with total fidelity.
Preserve subject-specific content including mathematical notation, equations, diagrams, tables, chemical structures, code, flowcharts, labelled illustrations, and descriptive text.
Flag unreadable or uncertain answers honestly.
NEVER fabricate missing answers or synthetic scores.`;

    const geminiResult = await callGeminiWithFallback(
      contentsParts,
      systemInstruction,
      `ext_${correlationId}`,
      {
        ...options,
        responseSchema: studentExtractionSchema,
        pipelineStage: 'student_extraction',
      }
    );

    const rawScript = geminiResult.report as any;
    return this.validateAndNormalizeExtractedScript(
      rawScript,
      canonicalKey,
      options?.fallbackStudentName || 'Student',
      sourceDoc
    );
  }

  /**
   * Validates extracted script JSON, ensures complete question coverage against canonical key,
   * flags unattempted/uncertain questions, and verifies data integrity.
   */
  public validateAndNormalizeExtractedScript(
    raw: any,
    canonicalKey: CanonicalAnswerKey,
    fallbackStudentName: string,
    sourceDoc?: DocumentPayload
  ): StudentExtractedScript {
    if (!raw || typeof raw !== 'object') {
      throw new ExtractionValidationError('Extraction failed: Result is not a structured JSON object.');
    }

    const studentName = String(raw.studentName || fallbackStudentName || 'Student').trim();
    const examTitle = String(raw.examTitle || canonicalKey.title).trim();
    const warnings: string[] = Array.isArray(raw.warnings) ? raw.warnings.map(String) : [];
    const unmappedContent: string[] = Array.isArray(raw.unmappedContent)
      ? raw.unmappedContent.map(String)
      : [];

    const rawAnswers: any[] = Array.isArray(raw.answers) ? raw.answers : [];

    // Helper to normalize question keys for robust lookup (handles "1", "Q1", "Question 1", "2.a", "2(a)", "2a")
    const normalizeQKey = (key: string): string => {
      return String(key || '')
        .trim()
        .toLowerCase()
        .replace(/^(question|q)[\s.:_-]*/i, '')
        .replace(/[()[\]]/g, '')
        .replace(/[-_.\s]+/g, '');
    };

    // Map of extracted answers by multiple indexed keys
    const extractedMap = new Map<string, any>();
    for (const a of rawAnswers) {
      if (a) {
        if (a.questionId) {
          const rawId = String(a.questionId).trim();
          extractedMap.set(rawId, a);
          extractedMap.set(rawId.toLowerCase(), a);
          extractedMap.set(normalizeQKey(rawId), a);
        }
        const completeAId = getCompleteQuestionIdentifier(a);
        if (completeAId) {
          extractedMap.set(completeAId, a);
          extractedMap.set(completeAId.toLowerCase(), a);
          extractedMap.set(normalizeQKey(completeAId), a);
        }
      }
    }

    const normalizedAnswers: StudentExtractedAnswer[] = [];
    let hasVisualEvidence = Boolean(raw.visualEvidenceRetained);

    // Ensure complete question coverage matching the canonical answer key
    for (const q of canonicalKey.questions) {
      const qId = q.questionId;
      const completeQId = getCompleteQuestionIdentifier(q);
      const extracted =
        extractedMap.get(qId) ||
        extractedMap.get(qId.toLowerCase()) ||
        extractedMap.get(normalizeQKey(qId)) ||
        (completeQId ? extractedMap.get(completeQId) : undefined) ||
        (completeQId ? extractedMap.get(completeQId.toLowerCase()) : undefined) ||
        (completeQId ? extractedMap.get(normalizeQKey(completeQId)) : undefined);

      if (extracted) {
        const rawText = extracted.studentAnswerText ? String(extracted.studentAnswerText).trim() : '';
        const isBlankOrUnattempted =
          rawText === '' ||
          /^\[?(not attempted|unattempted|omitted|blank|left blank|skipped|nil|na|none)\]?$/i.test(rawText);

        // Robust attempted check: if student text has >15 characters and isn't a blank flag, treat as attempted
        const isAttempted = !isBlankOrUnattempted && (Boolean(extracted.isAttempted) || rawText.length > 15);
        const flaggedUncertain = Boolean(extracted.flaggedUncertain);
        const flaggedIssue = extracted.flaggedIssue ? String(extracted.flaggedIssue).trim() : undefined;
        const diagramDesc = extracted.diagramDescription ? String(extracted.diagramDescription).trim() : undefined;
        const formulas = Array.isArray(extracted.formulas) ? extracted.formulas.map(String) : [];
        const pageRefs = Array.isArray(extracted.pageReferences) ? extracted.pageReferences.map(Number) : [];
        const confidence = typeof extracted.confidence === 'number' ? extracted.confidence : 0.95;

        if (diagramDesc) {
          hasVisualEvidence = true;
        }

        normalizedAnswers.push({
          questionId: qId,
          subquestionId: q.subquestionId || extracted.subquestionId || undefined,
          studentAnswerText: isAttempted ? rawText : '[Not Attempted]',
          diagramDescription: diagramDesc,
          formulas: formulas.length > 0 ? formulas : undefined,
          pageReferences: pageRefs.length > 0 ? pageRefs : undefined,
          isAttempted,
          confidence,
          flaggedUncertain,
          flaggedIssue,
          visualEvidenceBase64: hasVisualEvidence ? sourceDoc?.base64 : undefined,
          visualEvidenceMimeType: hasVisualEvidence ? sourceDoc?.mimeType : undefined,
        });
      } else {
        // Question from exam was not found in student script -> mark unattempted honestly
        warnings.push(`Question ${qId} not identified in student submission (marked unattempted).`);
        normalizedAnswers.push({
          questionId: qId,
          subquestionId: q.subquestionId,
          studentAnswerText: '[Not Attempted]',
          isAttempted: false,
          confidence: 1.0,
        });
      }
    }

    return {
      studentName,
      examTitle,
      answers: normalizedAnswers,
      unmappedContent: unmappedContent.length > 0 ? unmappedContent : undefined,
      warnings: warnings.length > 0 ? warnings : undefined,
      visualEvidenceRetained: hasVisualEvidence,
      extractedAt: Date.now(),
    };
  }
}

export const studentExtractor = new StudentExtractor();
