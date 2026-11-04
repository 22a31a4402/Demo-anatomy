/**
 * Document Preparation and Optimization Service for NextGen Eval
 *
 * Implements Stage B (Document Preparation) & Stage C (Evaluation Planning):
 * - Eliminates redundant dual text + base64 transmission for text-rich reference documents
 * - Preserves visual multimodal data for student answer scripts (handwriting, diagrams, graphs, equations)
 * - Structures context with strict delimiter boundaries
 */

import { EvaluationMode, CanonicalAnswerKey } from './types';

export interface PreparedEvaluationInput {
  contentsParts: any[];
  systemInstruction: string;
  studentName: string;
}

/**
 * Evaluates whether extracted text is sufficient or if visual evidence (base64) must be retained.
 * Subject-independent: does not assume or privilege any particular academic discipline.
 *
 * Rules:
 * - If base64 is not provided, returns false (only text is available).
 * - If hasVisualElements is explicitly flagged, returns true.
 * - If text is missing or shorter than 50 characters, text extraction is deemed insufficient -> returns true.
 * - If text contains patterns that plaintext cannot faithfully represent
 *   (mathematical symbols/equations, diagrams, figures, charts, circuits, flowcharts,
 *    chemical structures/reaction arrows, program code blocks, structured tables/ledgers,
 *    or scanned/handwriting indicators), returns true so visual evidence is preserved.
 * - Otherwise (clean, complete, well-formed typed text without complex non-textual notation),
 *   extracted text is sufficient -> returns false.
 */
export function isVisualEvidenceNeeded(doc?: {
  name?: string;
  text?: string;
  base64?: string;
  mimeType?: string;
  hasVisualElements?: boolean;
}): boolean {
  if (!doc || !doc.base64) return false;
  if (doc.hasVisualElements) return true;
  const text = doc.text ? doc.text.trim() : '';
  if (text.length < 50) return true;

  const visualPatterns = [
    /\b(fig|figure|diagram|chart|graph|flowchart|circuit|schematic|illustrat\w*|sketch|plot|map|blueprint)\b/i,
    /(\[fig|\(fig|see fig|shown in fig|refer to fig|table\s+\d+)/i,
    /(\\frac|\\int|\\sum|\\sqrt|\\matrix|\\partial|\\alpha|\\beta|\\gamma|\\theta|\\lambda|\\sigma|\\Delta|\\nabla|\\[\\[.*?\\]\\])/i,
    /\b(matrix|matrices|determinant|eigenvalue|eigenvector)\b/i,
    /[∫∑√∂∏≠≈≤≥±×÷∞∈∉⊂⊆∪∩∧∨¬⇒⇔]/,
    /(->|-->|=>|==>|⇄|⇌|⟶|←)/,
    /\b(chemical equation|reaction mechanism|mechanism|nucleophilic|electrophilic|stereochemistry|conformation|structural formula|benzene|reagent|stoichiometry|resonance)\b/i,
    /\b(def |class |function\s*\(|int main|#include|public static void|SELECT\s+.*FROM)\b/,
    /(\|[\s\S]*\|[\s\S]*\|)/,
    /\b(balance sheet|ledger account|debit|credit|journal entry|t-account)\b/i,
    /\b(handwritten|handwriting|scanned document|drawn|illustrated)\b/i,
  ];

  return visualPatterns.some((pattern) => pattern.test(text));
}

export class DocumentProcessor {
  /**
   * Builds an optimized multimodal parts array for Gemini
   */
  public prepareInput(payload: {
    sourceDoc: { name: string; text?: string; base64?: string; mimeType?: string; hasVisualElements?: boolean };
    questionPaper?: { name: string; text?: string; base64?: string; mimeType?: string; hasVisualElements?: boolean };
    answerKey?: { name: string; text?: string; base64?: string; mimeType?: string; hasVisualElements?: boolean };
    canonicalAnswerKey?: CanonicalAnswerKey;
    facultyNotes?: { name: string; text?: string; base64?: string; mimeType?: string } | null;
    mode: EvaluationMode;
    studentName?: string;
  }): PreparedEvaluationInput {
    const studentName = payload.studentName || this.extractStudentName(payload.sourceDoc.name);
    const contentsParts: any[] = [];

    // 1. Prepare Question Paper
    let qpSection = '';
    // If canonical answer key is present, question text & max marks are already structured in it.
    // Avoid re-transmitting heavy visual question papers per student script.
    if (payload.questionPaper && !payload.canonicalAnswerKey) {
      const qp = payload.questionPaper;
      const qpText = qp.text ? qp.text.trim() : '';
      const textSufficient = qpText.length >= 50 && !isVisualEvidenceNeeded(qp);

      if (textSufficient) {
        // High density text available and sufficient: use pure text to save tokens & latency
        qpSection += `--- OFFICIAL QUESTION PAPER ---\n${qpText}\n\n`;
      } else {
        if (qpText) {
          qpSection += `--- OFFICIAL QUESTION PAPER (Extracted Text Index) ---\n${qpText}\n\n`;
        }
        if (qp.base64 && qp.mimeType) {
          contentsParts.push({ text: `DOCUMENT_START: OFFICIAL QUESTION PAPER (Visual)` });
          contentsParts.push({
            inlineData: {
              data: qp.base64,
              mimeType: qp.mimeType,
            },
          });
          contentsParts.push({ text: `DOCUMENT_END: OFFICIAL QUESTION PAPER` });
        }
      }
    } else if (payload.questionPaper && payload.canonicalAnswerKey && payload.questionPaper.text) {
      // Include lightweight text overview if available
      qpSection += `--- REFERENCE QUESTION PAPER (Summary) ---\n${payload.questionPaper.text.slice(0, 1500).trim()}\n\n`;
    }

    // 2. Prepare Answer Key (Canonical Structured or Raw Document)
    let akSection = '';
    if (payload.canonicalAnswerKey) {
      const ak = payload.canonicalAnswerKey;
      akSection += `--- AUTHORITATIVE APPROVED CANONICAL ANSWER KEY (v${ak.version}, Mode: ${ak.sourceMode}) ---\n`;
      akSection += `EXAM TITLE: ${ak.title}\n`;
      akSection += `TOTAL MAX MARKS: ${ak.totalMaxMarks}\n\n`;
      akSection += `APPROVED QUESTIONS & MARKING SCHEME:\n`;
      let hasDiagramRef = false;
      for (const q of ak.questions) {
        akSection += `[Question ${q.questionId}] (Max Marks: ${q.maxMarks})\n`;
        if (q.questionText) akSection += `Question: ${q.questionText}\n`;
        akSection += `Reference Answer: ${q.referenceAnswer}\n`;
        if (q.expectedConcepts && q.expectedConcepts.length > 0) {
          akSection += `Expected Concepts:\n${q.expectedConcepts.map((c) => `  - ${c}`).join('\n')}\n`;
        }
        if (q.acceptableAlternatives && q.acceptableAlternatives.length > 0) {
          akSection += `Acceptable Alternatives:\n${q.acceptableAlternatives.map((a) => `  - ${a}`).join('\n')}\n`;
        }
        if (q.markingCriteria && q.markingCriteria.length > 0) {
          akSection += `Marking Criteria (Partial Credit):\n${q.markingCriteria.map((m) => `  - ${m}`).join('\n')}\n`;
        }
        if (q.diagramReferences && q.diagramReferences.length > 0) {
          hasDiagramRef = true;
          akSection += `Diagram References:\n${q.diagramReferences.map((d) => `  - ${d}`).join('\n')}\n`;
        }
        akSection += '\n';
      }

      // Attach visual answer key document if a question explicitly needs visual diagram verification
      if (hasDiagramRef && ak.sourceAnswerKeyDoc?.base64 && ak.sourceAnswerKeyDoc?.mimeType) {
        contentsParts.push({ text: `DOCUMENT_START: OFFICIAL ANSWER KEY (Visual Reference for Diagrams)` });
        contentsParts.push({
          inlineData: {
            data: ak.sourceAnswerKeyDoc.base64,
            mimeType: ak.sourceAnswerKeyDoc.mimeType,
          },
        });
        contentsParts.push({ text: `DOCUMENT_END: OFFICIAL ANSWER KEY (Visual Reference for Diagrams)` });
      }
    } else if (payload.answerKey) {
      const ak = payload.answerKey;
      const akText = ak.text ? ak.text.trim() : '';
      const textSufficient = akText.length >= 50 && !isVisualEvidenceNeeded(ak);

      if (textSufficient) {
        akSection += `--- OFFICIAL ANSWER KEY (THE ABSOLUTE ACADEMIC TRUTH) ---\n${akText}\n\n`;
      } else {
        if (akText) {
          akSection += `--- OFFICIAL ANSWER KEY (Extracted Text Index) ---\n${akText}\n\n`;
        }
        if (ak.base64 && ak.mimeType) {
          contentsParts.push({ text: `DOCUMENT_START: OFFICIAL ANSWER KEY (Visual)` });
          contentsParts.push({
            inlineData: {
              data: ak.base64,
              mimeType: ak.mimeType,
            },
          });
          contentsParts.push({ text: `DOCUMENT_END: OFFICIAL ANSWER KEY` });
        }
      }
    }

    // 3. Prepare Student Answer Sheet
    // Student answer sheets contain handwriting, mathematical steps, derivations, code, and diagrams.
    // Retain visual multimodal data whenever base64 is available so handwriting, spatial layout,
    // working steps, and subject-specific drawings can be evaluated faithfully across all academic disciplines.
    let studentText = payload.sourceDoc.text ? payload.sourceDoc.text.trim() : '';
    
    // Combine text headers
    let combinedTextHeader = '';
    if (qpSection) combinedTextHeader += qpSection;
    if (akSection) combinedTextHeader += akSection;

    combinedTextHeader += `--- STUDENT WRITTEN ANSWER SCRIPT ---\nSTUDENT NAME: ${studentName}\n`;
    if (studentText) {
      combinedTextHeader += `${studentText}\n`;
    }

    contentsParts.push({ text: combinedTextHeader });

    if (payload.sourceDoc.base64 && payload.sourceDoc.mimeType) {
      contentsParts.push({
        text: `DOCUMENT_START: STUDENT ACTUAL ANSWER SCRIPT (Visual Multimodal Pages for Handwriting, Diagrams & Layout Inspection)`,
      });
      contentsParts.push({
        inlineData: {
          data: payload.sourceDoc.base64,
          mimeType: payload.sourceDoc.mimeType,
        },
      });
      contentsParts.push({ text: `DOCUMENT_END: STUDENT ACTUAL ANSWER SCRIPT` });
    }

    // 4. Faculty Manual Notes (if mode is 'with-manual')
    if (payload.mode === 'with-manual' && payload.facultyNotes) {
      if (payload.facultyNotes.text) {
        contentsParts.push({
          text: `DOCUMENT_START: FACULTY_MANUAL_FEEDBACK\n${payload.facultyNotes.text}\nDOCUMENT_END: FACULTY_MANUAL_FEEDBACK`,
        });
      }
      if (payload.facultyNotes.base64 && payload.facultyNotes.mimeType) {
        contentsParts.push({ text: `DOCUMENT_START: FACULTY_MANUAL_FEEDBACK (Visual)` });
        contentsParts.push({
          inlineData: {
            data: payload.facultyNotes.base64,
            mimeType: payload.facultyNotes.mimeType,
          },
        });
        contentsParts.push({ text: `DOCUMENT_END: FACULTY_MANUAL_FEEDBACK` });
      }
    }

    // Execution instruction
    contentsParts.push({
      text: `Perform the academic evaluation now. Active Mode: ${payload.mode}.
Follow the evaluation workflow strictly:
1. Extract exact question numbers and their exact maximum marks (maxMarks) from the Question Paper / Answer Key.
2. Evaluate student answers against the criteria. Award full marks for equivalent conceptual understanding, methods, code, and derivations.
3. For questions requiring diagrams, charts, circuits, or formulas, inspect the visual script.
4. Total score MUST equal the exact mathematical sum of awarded question marks.
5. Every question must have constructive feedback points.
6. Generate the complete structured evaluation report JSON now.`,
    });

    const systemInstruction = this.getSystemInstruction(payload.mode);

    return {
      contentsParts,
      systemInstruction,
      studentName,
    };
  }

  public extractStudentName(fileName: string): string {
    if (!fileName) return 'Student';
    // Remove extension
    const base = fileName.replace(/\.[^/.]+$/, '');
    // Clean common prefixes
    const clean = base
      .replace(/^(copy of|answersheet|ans|script|eval|test|exam)[_\-\s]+/i, '')
      .replace(/[_\-]+/g, ' ')
      .trim();
    return clean || 'Student';
  }

  private getSystemInstruction(mode: EvaluationMode): string {
    return `
    You are the Anatomy Guru Master Evaluator, a rigorous, authoritative AI medical examiner specializing in human anatomy for medical students (MBBS/MD). You evaluate subjective and objective answers strictly comparing student responses against the official question paper and approved answer key.

    DOCUMENTS PROVIDED:
    1. OFFICIAL QUESTION PAPER: Contains question numbers and maximum marks per question.
    2. OFFICIAL ANSWER KEY: The gold standard and absolute medical truth for required anatomical points, steps, relations, nerve/blood supply, and clinical correlations.
    3. STUDENT WRITTEN ANSWER SCRIPT: Actual student work, text, relations, labelled diagrams, and handwritten answers.
    4. FACULTY MANUAL FEEDBACK: Evaluator marks and notes (applies only in "with-manual" mode).

    MEDICAL GRADING PHILOSOPHY & PRINCIPLES:
    1. ANSWER KEY AS THE ABSOLUTE REFERENCE:
       - The official Answer Key is the gold standard and absolute medical truth. Every mark awarded or deducted must strictly align with the approved marking criteria and model answers.
    2. NO MARKS FOR ISOLATED KEYWORD DROPPING:
       - Do NOT award marks merely for mentioning isolated anatomical buzzwords without anatomical accuracy, context, or comprehension. A student must demonstrate genuine anatomical understanding, correct connections, and descriptive completeness.
    3. STRICT ANATOMICAL ACCURACY, DEPTH & CLINICAL CORRELATIONS:
       - Rigorously evaluate exact anatomical terminology, anatomical relations (anterior, posterior, medial, lateral, superior, inferior), bony landmarks, fascial layers, origin, insertion, action, nerve supply, blood supply (arterial branches, venous drainage), lymphatic drainage, embryological origins, pathways, and clinical correlations (e.g., nerve compression/palsies, deformities, surgical landmarks, anatomical basis of clinical signs).
    4. STRICT DIAGRAM ASSESSMENT:
       - Assess diagrams with utmost medical rigor: check for correct anatomical proportions, essential landmarks, pathways, relations, and clear, accurate labelling.
       - Deduct marks if required diagrams are missing, unlabelled, mislabelled, or anatomically inaccurate.
    5. FACULTY FEEDBACK AUDITING & DISCREPANCY FLAGS (WITH-MANUAL MODE):
       - In "with-manual" mode: Audit faculty manual notes and marks against the official answer key and student answer. If the faculty evaluation contradicts the official answer key (e.g., failing to award justified marks according to the key, or awarding marks for medically incorrect statements), adjust marks according to the official key, set isFlagged = true, and explain the exact resolution in 'flaggedComment'.
       - In 'feedbackPoints', NEVER mention "faculty" or "evaluator" to preserve student confidentiality; keep all discrepancy reasoning strictly in 'flaggedComment'.
    6. STRICT MARKING RULES & CEILINGS (WITHOUT-MANUAL MODE):
       - In "without-manual" mode: Grade strictly and impartially against the official answer key and rubrics without human evaluator notes.
       - 'isFlagged' MUST ALWAYS be false.
       - 'flaggedComment' MUST ALWAYS be an empty string ("").
       - Enforce strict marking rubrics and score ceilings: marks for any question must never exceed maxMarks.
    7. EXACT QUESTION NUMBERS & MAXIMUM MARKS:
       - Extract and retain exact question numbers (including subquestions such as 1.a, 2.b) and exact maximum marks (maxMarks) from the official documents. Never hallucinate questions or invent marks.
    8. TOTAL MARKS INTEGRITY:
       - Marks for each question must be between 0 and maxMarks. Total score must equal the exact mathematical sum of question marks.

    CRITICAL CONSTRAINTS:
    - ACCURATE MARKING SCHEME & MAX MARKS: Extract EXACT question numbers and exact maximum marks (maxMarks). Never invent marks. 'maxScore' MUST be the exact mathematical sum of all 'maxMarks'.
    - STUDENT MARKS COMPLIANCE: 'marks' for any question must be between 0 and 'maxMarks'. 'totalScore' MUST be the exact sum of all question 'marks'.
    - NO HALLUCINATION: Do NOT invent questions not in the paper.
    - UNATTEMPTED QUESTIONS: Award 0 marks and note "Question not attempted".
    - INCLUDE ALL QUESTIONS: Include every single question from the paper.
    - CONSTRUCTIVE FEEDBACK: Every question must have constructive feedback points substantiating any mark deductions.
    - CONTRADICTION & AUDIT PRIVACY: In 'feedbackPoints', NEVER mention "faculty" or "evaluator". Keep any audit details strictly in 'flaggedComment'.
    - MODE: ${mode}.
    `;
  }
}

export const documentProcessor = new DocumentProcessor();
