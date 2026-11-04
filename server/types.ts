/**
 * Backend Data Contracts and Types for NextGen Eval
 */

export type JobStatus =
  | 'queued'
  | 'preprocessing'
  | 'grading'
  | 'validating'
  | 'assembling_report'
  | 'completed'
  | 'failed'
  | 'needs_review'
  | 'cancelled';

export type EvaluationMode = 'with-manual' | 'without-manual';

export type UserRole = 'operator' | 'admin' | 'instructor' | 'evaluator';

export type AnswerKeySourceMode = 'ai_generated' | 'uploaded';
export type AnswerKeyStatus = 'draft' | 'needs_review' | 'approved';

/**
 * Resolves the complete, unique question identifier for a question item.
 * Preserves hierarchical numbering (e.g. "1", "1.1", "1.2", "2.1", "2.a", "Section A - 1.1").
 * Prevents treating sub-questions (e.g. "1.1", "1.2") as their parent number ("1").
 * Allows parent questions ("1") and their sub-questions ("1.1", "1.2") to coexist.
 */
export function getCompleteQuestionIdentifier(q?: {
  questionId?: string | number | null;
  subquestionId?: string | number | null;
  qNo?: string | number | null;
} | null): string {
  if (!q) return '';

  const rawId = q.questionId !== undefined && q.questionId !== null
    ? String(q.questionId).trim()
    : q.qNo !== undefined && q.qNo !== null
    ? String(q.qNo).trim()
    : '';

  const rawSubId = q.subquestionId !== undefined && q.subquestionId !== null
    ? String(q.subquestionId).trim()
    : '';

  if (!rawId && !rawSubId) return '';
  if (!rawSubId) return rawId;
  if (!rawId) return rawSubId;

  // If rawId already includes rawSubId (e.g. rawId = "1.1" and rawSubId = "1" or "1.1")
  if (
    (rawId === rawSubId && /[.\-_\(\)\[\]]/.test(rawId)) ||
    rawId.endsWith(`.${rawSubId}`) ||
    rawId.endsWith(`(${rawSubId})`) ||
    rawId.endsWith(`-${rawSubId}`) ||
    rawId.endsWith(`_${rawSubId}`)
  ) {
    return rawId;
  }

  // If rawSubId already includes rawId as a prefix (e.g. rawId = "1" and rawSubId = "1.1")
  if (
    rawSubId.startsWith(`${rawId}.`) ||
    rawSubId.startsWith(`${rawId}(`) ||
    rawSubId.startsWith(`${rawId}-`) ||
    rawSubId.startsWith(`${rawId}_`)
  ) {
    return rawSubId;
  }

  // Form hierarchical identifier without duplicating delimiters
  if (
    rawSubId.startsWith('.') ||
    rawSubId.startsWith('(') ||
    rawSubId.startsWith('[') ||
    rawSubId.startsWith('-') ||
    rawSubId.startsWith('_')
  ) {
    return `${rawId}${rawSubId}`;
  }

  return `${rawId}.${rawSubId}`;
}

export type SelectionRuleType = 'attempt_any_n' | 'mutually_exclusive_or';

export interface SelectionRule {
  groupId: string;
  ruleType: SelectionRuleType;
  requiredAttempts: number;
  totalAvailable: number;
  groupMaxMarks?: number;
  calculatedGroupMaxMarks?: number;
  instruction?: string;
  parentQuestionId?: string;
  section?: string;
  branchIds: string[];
}

export interface CanonicalQuestionKey {
  questionId: string;
  subquestionId?: string;
  parentQuestionId?: string;
  section?: string;
  isAlternative?: boolean;
  alternativeGroup?: string;
  selectionGroup?: string;
  requiredAttempts?: number;
  groupRule?: SelectionRuleType;
  groupMaxMarks?: number;
  branchId?: string;
  isParentHeader?: boolean;
  questionText?: string;
  maxMarks: number;
  referenceAnswer: string;
  expectedConcepts: string[];
  acceptableAlternatives: string[];
  markingCriteria: string[];
  diagramReferences?: string[];
  confidence?: number;
  flaggedIssue?: string;
}

export interface SectionMarksSummary {
  sectionName: string;
  questionCount: number;
  printedMaxMarks?: number;
  calculatedTotalMarks: number;
}

export interface MarksValidationResult {
  hasDiscrepancy: boolean;
  printedMaxMarks?: number;
  calculatedTotalMarks: number;
  difference: number;
  message?: string;
  discrepancyMessages: string[];
  offendingQuestions: string[];
  sectionTotals: Record<string, number>;
  sections: SectionMarksSummary[];
  ambiguousChoices: string[];
  hasAmbiguousChoices: boolean;
  selectionRules?: SelectionRule[];
}

export interface ParsedSelectionInstruction {
  requiredAttempts: number;
  groupMaxMarks?: number;
  ruleType: SelectionRuleType;
  rawInstruction: string;
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
};

/**
 * Parses academic instructions specifying choice constraints, e.g.:
 * - "Attempt any FIVE of the following : 10"
 * - "Attempt any THREE of the following : 12"
 * - "Attempt any TWO of the following : 12"
 * - "Answer any 4 questions out of 6 [20 marks]"
 * - "Answer any one question"
 * - "EITHER ... OR"
 */
export function parseSelectionInstruction(instructionText?: string | null): ParsedSelectionInstruction | null {
  if (!instructionText || typeof instructionText !== 'string') return null;
  const text = instructionText.trim();
  if (!text) return null;

  const anyNRegex = /\b(?:attempt|answer|solve|choose|select|write(?:\s+short\s+notes)?(?:\s+on)?|notes?\s+on)\s+any\s+(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|[0-9]+)\b/i;
  const anyNQuestionsRegex = /\bany\s+(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|[0-9]+)\s+(?:of\s+the\s+following|questions?|sub-?questions?|parts?|items?|topics?)\b/i;
  const answerNRegex = /\b(?:attempt|answer|solve|choose|select)\s+(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|[0-9]+)\s+questions?\s+(?:out\s+of|from)\b/i;

  let match = text.match(anyNRegex) || text.match(anyNQuestionsRegex) || text.match(answerNRegex);
  if (!match) {
    const eitherOrRegex = /\b(?:either\s+.+?\s+or|answer\s+any\s+one|attempt\s+either|internal\s+choice)\b/i;
    if (eitherOrRegex.test(text)) {
      return {
        requiredAttempts: 1,
        ruleType: 'mutually_exclusive_or',
        rawInstruction: text,
      };
    }
    return null;
  }

  const numToken = match[1].toLowerCase();
  const n = NUMBER_WORDS[numToken] ?? parseInt(numToken, 10);
  if (!Number.isFinite(n) || n <= 0) return null;

  let explicitMarks: number | undefined = undefined;
  // Match ": 10", ": 12", "[12 Marks]", "(12 marks)", "- 10 Marks", etc.
  const marksMatch = text.match(/[:\-–—]\s*([0-9]+(?:\.[0-9]+)?)\s*(?:marks?|m)?\s*$/i) ||
                     text.match(/[\[\(]\s*([0-9]+(?:\.[0-9]+)?)\s*(?:marks?|m)?\s*[\]\)]\s*$/i);
  if (marksMatch) {
    const val = parseFloat(marksMatch[1]);
    if (Number.isFinite(val) && val > 0) {
      explicitMarks = val;
    }
  }

  // Match "each question carries X marks" or "X marks each"
  if (explicitMarks === undefined) {
    const eachMarksMatch = text.match(/([0-9]+(?:\.[0-9]+)?)\s*marks?\s+each\b/i) ||
                           text.match(/\beach\s+(?:carries|carrying|worth)\s+([0-9]+(?:\.[0-9]+)?)\s*marks?\b/i);
    if (eachMarksMatch) {
      const perQuestion = parseFloat(eachMarksMatch[1]);
      if (Number.isFinite(perQuestion) && perQuestion > 0) {
        explicitMarks = n * perQuestion;
      }
    }
  }

  return {
    requiredAttempts: n,
    groupMaxMarks: explicitMarks,
    ruleType: n === 1 ? 'mutually_exclusive_or' : 'attempt_any_n',
    rawInstruction: text,
  };
}

/**
 * Resolves the choice branch identifier for a subquestion under a parent question or group.
 * Groups multi-level nested subparts (e.g. 5.b.i and 5.b.ii) under their parent branch (5.b).
 */
export function resolveQuestionBranchId(
  q: {
    questionId: string;
    subquestionId?: string;
    parentQuestionId?: string;
    branchId?: string;
  },
  parentQuestionId?: string
): string {
  if (q.branchId && q.branchId.trim()) {
    return q.branchId.trim();
  }

  const effectiveParentId = (q.parentQuestionId || parentQuestionId || '').trim();
  const rawSubId = (q.subquestionId || '').trim();
  const rawQId = (q.questionId || '').trim();

  // If subquestionId is present, extract top-level option token, e.g. "b.i" -> "b", "(b)(i)" -> "b", "a" -> "a"
  if (rawSubId) {
    const subMatch = rawSubId.match(/^[\(\[\s]*([a-zA-Z0-9]+)/);
    if (subMatch) {
      const branchKey = subMatch[1].toLowerCase();
      return effectiveParentId ? `${effectiveParentId}.${branchKey}` : branchKey;
    }
  }

  // If questionId starts with parentId prefix, e.g. "5.b.i" or "5(b)(i)" or "5.a"
  if (effectiveParentId && rawQId.startsWith(effectiveParentId)) {
    const remainder = rawQId.slice(effectiveParentId.length).trim();
    const branchMatch = remainder.match(/^[\.\-_\(\[\s]*([a-zA-Z0-9]+)/);
    if (branchMatch) {
      return `${effectiveParentId}.${branchMatch[1].toLowerCase()}`;
    }
  }

  // If questionId has a dot/bracket pattern, e.g. "5.b.1" -> "5.b"
  const dotParts = rawQId.split(/[\.\-_]+/);
  if (dotParts.length >= 2) {
    if (dotParts.length > 2) {
      return `${dotParts[0]}.${dotParts[1].toLowerCase()}`;
    }
    return rawQId;
  }

  return rawQId;
}

/**
 * Detects and normalizes selection rules and alternative choice groups across academic papers.
 * Supports:
 * - "Attempt any N" instructions from parent questions or section headers
 * - Explicit OR/EITHER alternatives
 * - Nested questions and subparts without parent-child double counting
 * - Compulsory questions
 * 
 * Preserves every question and alternative for student evaluation.
 */
export function detectAndNormalizeChoiceGroups<
  T extends {
    questionId: string;
    subquestionId?: string;
    parentQuestionId?: string;
    section?: string;
    questionText?: string;
    referenceAnswer?: string;
    isAlternative?: boolean;
    alternativeGroup?: string;
    selectionGroup?: string;
    requiredAttempts?: number;
    groupRule?: SelectionRuleType;
    groupMaxMarks?: number;
    branchId?: string;
    isParentHeader?: boolean;
    maxMarks?: number;
    flaggedIssue?: string;
  }
>(inputQuestions: T[]): T[] {
  if (!Array.isArray(inputQuestions) || inputQuestions.length === 0) {
    return [];
  }

  // Shallow copy to preserve input immutability
  const questions: T[] = inputQuestions.map((q) => ({ ...q }));

  // Helper regexes for explicit OR choices
  const orIdRegex = /(?:^|[\s\._\-\(\[])OR(?:[\s\._\-\)\]]|$)/i;
  const choiceIdRegex = /(?:^|[\s\._\-\(\[])(?:ALTERNATIVE|CHOICE|OPTION\s*[2B])(?:[\s\._\-\)\]]|$)/i;
  const orPrefixRegex = /^[\s\-\*]*(?:(?:EITHER\s+(?:PART\s+)?[A-Z0-9]+|OR|\[OR\]|\(OR\)|--\s*OR\s*--)[\s:\-\.]+|OR\s*$)/i;
  const orStandaloneLineRegex = /(?:^|[\r\n])\s*(?:OR|\[OR\]|\(OR\)|--\s*OR\s*--)\s*(?:[\r\n:\-\.]|$)/i;
  const eitherOrRegex = /\b(?:EITHER\s+.+?\s+OR|ANSWER\s+ANY\s+ONE|INTERNAL\s+CHOICE|ATTEMPT\s+EITHER)\b/i;

  let groupCounter = 1;

  // 1. Detect parent question instruction-based selection groups
  // e.g. "Attempt any FIVE of the following : 10", "Attempt any THREE of the following : 12", "Attempt any TWO : 12"
  for (const parent of questions) {
    const pText = parent.questionText || '';
    const parsed = parseSelectionInstruction(pText);
    if (!parsed) continue;

    const pId = parent.questionId.trim();
    // Find all children belonging to this parent
    const children = questions.filter(
      (c) =>
        c !== parent &&
        (c.parentQuestionId === pId ||
          (c.questionId !== pId &&
            (c.questionId.startsWith(pId + '.') ||
             c.questionId.startsWith(pId + '(') ||
             c.questionId.startsWith(pId + '-') ||
             c.questionId.startsWith(pId + '_'))))
    );

    if (children.length > 0) {
      parent.isParentHeader = true;
      const groupId = `selection_group_${pId}`;
      parent.selectionGroup = groupId;
      parent.groupRule = parsed.ruleType;
      parent.requiredAttempts = parsed.requiredAttempts;
      parent.groupMaxMarks = parsed.groupMaxMarks;

      for (const child of children) {
        child.parentQuestionId = pId;
        child.selectionGroup = groupId;
        child.requiredAttempts = parsed.requiredAttempts;
        child.groupRule = parsed.ruleType;
        child.groupMaxMarks = parsed.groupMaxMarks;
        child.branchId = resolveQuestionBranchId(child, pId);
        // Retain backward compatibility:
        child.alternativeGroup = groupId;
        child.isAlternative = true;
      }
    }
  }

  // 2. Detect section-level instruction-based selection rules
  const sectionQuestions = new Map<string, T[]>();
  for (const q of questions) {
    const sec = (q.section || '').trim();
    if (sec) {
      if (!sectionQuestions.has(sec)) sectionQuestions.set(sec, []);
      sectionQuestions.get(sec)!.push(q);
    }
  }

  for (const [secName, secQs] of sectionQuestions.entries()) {
    const secParsed = parseSelectionInstruction(secName);
    if (secParsed && secQs.length > 0) {
      const unassigned = secQs.filter((q) => !q.selectionGroup && !q.isParentHeader);
      if (unassigned.length > 0) {
        const secGroupId = `section_group_${secName.replace(/[^a-zA-Z0-9]/g, '_')}`;
        for (const q of unassigned) {
          q.selectionGroup = secGroupId;
          q.groupRule = secParsed.ruleType;
          q.requiredAttempts = secParsed.requiredAttempts;
          q.groupMaxMarks = secParsed.groupMaxMarks;
          q.branchId = resolveQuestionBranchId(q);
          q.alternativeGroup = secGroupId;
          q.isAlternative = true;
        }
      }
    }
  }

  // 3. Detect explicit OR / EITHER alternatives for questions not already in a parent selection group
  for (let i = 0; i < questions.length; i++) {
    const curr = questions[i];
    if (curr.selectionGroup) continue;

    const currId = (curr.questionId || '').trim();
    const currSubId = (curr.subquestionId || '').trim();
    const currText = (curr.questionText || '').trim();
    const currSec = (curr.section || 'General').trim();

    // If already properly grouped with an alternativeGroup, normalize
    if (curr.isAlternative && curr.alternativeGroup) {
      curr.alternativeGroup = curr.alternativeGroup.trim();
      curr.selectionGroup = curr.alternativeGroup;
      curr.requiredAttempts = curr.requiredAttempts || 1;
      curr.groupRule = curr.groupRule || 'mutually_exclusive_or';
      curr.branchId = curr.branchId || resolveQuestionBranchId(curr);
      continue;
    }

    // Check 1: Sibling / paired question ID indicator: e.g. "3" and "3 (OR)" or "3_OR" or "3.OR"
    const hasOrInId = orIdRegex.test(currId) || orIdRegex.test(currSubId) || choiceIdRegex.test(currId);
    if (hasOrInId) {
      const baseClean = currId
        .replace(/[\s\._\-\(\[]*OR[\s\._\-\)\]]*/gi, '')
        .replace(/[\s\._\-\(\[]*ALTERNATIVE[\s\._\-\)\]]*/gi, '')
        .replace(/[\s\._\-\(\[]*CHOICE[\s\._\-\)\]]*/gi, '')
        .trim();

      const companionIdx = questions.findIndex(
        (other, idx) =>
          idx !== i &&
          ((curr.section && other.section ? other.section.trim() === currSec : true) &&
            ((baseClean && other.questionId.trim() === baseClean) ||
              other.questionId.trim().startsWith(baseClean + '.') ||
              other.questionId.trim() === `${baseClean} (Option 1)` ||
              other.questionId.trim() === `${baseClean}A` ||
              idx === i - 1))
      );

      const grpName = `choice_group_${baseClean || currSec.replace(/\s+/g, '_')}_${groupCounter++}`;
      curr.isAlternative = true;
      curr.alternativeGroup = grpName;
      curr.selectionGroup = grpName;
      curr.requiredAttempts = 1;
      curr.groupRule = 'mutually_exclusive_or';
      curr.branchId = resolveQuestionBranchId(curr);

      if (companionIdx !== -1) {
        const companion = questions[companionIdx];
        companion.isAlternative = true;
        if (!companion.alternativeGroup) {
          companion.alternativeGroup = grpName;
          companion.selectionGroup = grpName;
          companion.requiredAttempts = 1;
          companion.groupRule = 'mutually_exclusive_or';
          companion.branchId = resolveQuestionBranchId(companion);
        } else {
          curr.alternativeGroup = companion.alternativeGroup;
          curr.selectionGroup = companion.selectionGroup || companion.alternativeGroup;
        }
      } else {
        curr.flaggedIssue = curr.flaggedIssue
          ? `${curr.flaggedIssue} | Question indicates OR choice but companion question was not found.`
          : 'Question indicates OR choice but companion question was not found. Faculty review required.';
      }
      continue;
    }

    // Check 2: Explicit OR prefix or standalone OR in question text (e.g. "OR: Describe...", "(OR) Explain...")
    const hasOrPrefix = orPrefixRegex.test(currText) || orStandaloneLineRegex.test(currText);
    if (hasOrPrefix) {
      let companionIdx = -1;
      for (let prevIdx = i - 1; prevIdx >= 0; prevIdx--) {
        const prevSec = (questions[prevIdx].section || 'General').trim();
        if (prevSec === currSec && !questions[prevIdx].isParentHeader) {
          companionIdx = prevIdx;
          break;
        }
      }

      if (companionIdx !== -1) {
        const companion = questions[companionIdx];
        const baseKey = companion.alternativeGroup || `choice_group_${companion.questionId}_${curr.questionId}`;
        companion.isAlternative = true;
        companion.alternativeGroup = baseKey;
        companion.selectionGroup = baseKey;
        companion.requiredAttempts = 1;
        companion.groupRule = 'mutually_exclusive_or';
        companion.branchId = resolveQuestionBranchId(companion);

        curr.isAlternative = true;
        curr.alternativeGroup = baseKey;
        curr.selectionGroup = baseKey;
        curr.requiredAttempts = 1;
        curr.groupRule = 'mutually_exclusive_or';
        curr.branchId = resolveQuestionBranchId(curr);
      } else {
        curr.flaggedIssue = curr.flaggedIssue
          ? `${curr.flaggedIssue} | Question has OR prefix but no preceding companion question found in section.`
          : 'Question has OR prefix but no preceding companion question found in section. Faculty review required.';
      }
      continue;
    }

    // Check 3: "EITHER ... OR" within question text
    if (eitherOrRegex.test(currText)) {
      if (i + 1 < questions.length) {
        const nextQ = questions[i + 1];
        const nextSec = (nextQ.section || 'General').trim();
        const nextText = (nextQ.questionText || '').trim();
        if (
          nextSec === currSec &&
          (orPrefixRegex.test(nextText) || orIdRegex.test(nextQ.questionId) || nextText.toLowerCase().includes('or '))
        ) {
          const grpName = `choice_group_${curr.questionId}_${nextQ.questionId}`;
          curr.isAlternative = true;
          curr.alternativeGroup = grpName;
          curr.selectionGroup = grpName;
          curr.requiredAttempts = 1;
          curr.groupRule = 'mutually_exclusive_or';
          curr.branchId = resolveQuestionBranchId(curr);

          nextQ.isAlternative = true;
          nextQ.alternativeGroup = grpName;
          nextQ.selectionGroup = grpName;
          nextQ.requiredAttempts = 1;
          nextQ.groupRule = 'mutually_exclusive_or';
          nextQ.branchId = resolveQuestionBranchId(nextQ);
          continue;
        }
      }
    }
  }

  // Audit choice and selection groups for integrity & flag mismatched marks
  const groups: Record<string, T[]> = {};
  for (const q of questions) {
    const grp = (q.selectionGroup || (q.isAlternative ? q.alternativeGroup : undefined))?.trim();
    if (grp) {
      if (!groups[grp]) groups[grp] = [];
      groups[grp].push(q);
    }
  }

  for (const [grpName, members] of Object.entries(groups)) {
    const firstMember = members[0];
    const isOrGroup = firstMember.groupRule === 'mutually_exclusive_or' || firstMember.requiredAttempts === 1;

    // Distinct branches in this group
    const distinctBranches = new Set(members.map((m) => m.branchId || resolveQuestionBranchId(m, m.parentQuestionId)));

    if (isOrGroup) {
      if (distinctBranches.size < 2) {
        for (const m of members) {
          if (!m.flaggedIssue?.includes('choice')) {
            m.flaggedIssue = m.flaggedIssue
              ? `${m.flaggedIssue} | Single-option choice group flagged. Review choice configuration.`
              : `Single-option choice group (${grpName}) flagged. Faculty review required.`;
          }
        }
      } else {
        // Calculate branch sums
        const branchSums: number[] = [];
        for (const bId of distinctBranches) {
          const bSum = members
            .filter((m) => (m.branchId || resolveQuestionBranchId(m, m.parentQuestionId)) === bId && !m.isParentHeader)
            .reduce((sum, m) => sum + (Number(m.maxMarks) || 0), 0);
          branchSums.push(parseFloat(bSum.toFixed(2)));
        }
        const firstMark = branchSums[0];
        const hasMismatch = branchSums.some((mk) => Math.abs(mk - firstMark) > 0.05);
        if (hasMismatch) {
          for (const m of members) {
            const warn = `Ambiguous choice structure: options in choice group ${grpName} have unequal maximum marks (${branchSums.join(' vs ')}). Faculty review required.`;
            if (!m.flaggedIssue?.includes('unequal maximum marks')) {
              m.flaggedIssue = m.flaggedIssue ? `${m.flaggedIssue} | ${warn}` : warn;
            }
          }
        }
      }
    }
  }

  return questions;
}

/**
 * Deterministically calculates question totals, section totals, and flags any discrepancy
 * against explicitly printed maximum marks.
 * 
 * Rules:
 * 1. "Attempt any N": calculates group marks dynamically based on required attempts N and group instructions.
 * 2. Explicit OR alternatives (N = 1): counts only one permitted alternative, not their sum.
 * 3. Parent questions whose child subquestions carry marks do NOT have their header marks counted twice.
 * 4. Compulsory questions: counted fully.
 * 5. Deterministically checks total against printed maximum marks; flags inconsistencies for faculty review.
 */
export function calculateCanonicalKeyMarks(
  rawQuestions: CanonicalQuestionKey[],
  printedMaxMarks?: number
): MarksValidationResult {
  const questions = detectAndNormalizeChoiceGroups(rawQuestions);

  const sectionTotals: Record<string, number> = {};
  const sectionCounts: Record<string, number> = {};
  const offendingQuestions: string[] = [];
  const discrepancyMessages: string[] = [];
  const ambiguousChoices: string[] = [];
  const selectionRules: SelectionRule[] = [];

  const qMap = new Map<string, CanonicalQuestionKey>();
  for (const q of questions) {
    const qKey = getCompleteQuestionIdentifier(q);
    if (qKey) {
      qMap.set(qKey, q);
    }
    if (q.questionId && !q.subquestionId) {
      qMap.set(q.questionId.trim(), q);
    }
  }

  const orSuffixRegex = /(?:^|[\s\._\-\(\[])(?:OR|ALTERNATIVE|CHOICE|OPTION\s*[2B])(?:[\s\._\-\)\]]|$)/i;

  // Identify parents that have child sub-questions
  const parentIds = new Set<string>();
  for (const q of questions) {
    if (q.isParentHeader) {
      parentIds.add(q.questionId.trim());
      const qKey = getCompleteQuestionIdentifier(q);
      if (qKey) parentIds.add(qKey);
    }
    if (q.subquestionId && q.questionId) {
      parentIds.add(q.questionId.trim());
    }
    if (q.parentQuestionId) {
      parentIds.add(q.parentQuestionId.trim());
    }
    const qKey = getCompleteQuestionIdentifier(q);
    const qId = (q.questionId || '').trim();
    if (!orSuffixRegex.test(qKey) && !orSuffixRegex.test(qId)) {
      const match = qKey.match(/^([0-9a-zA-Z]+)[\.\(\-]/);
      if (match) {
        const parentCandidate = match[1];
        if (qMap.has(parentCandidate)) {
          parentIds.add(parentCandidate);
        }
      }
    }
  }

  const isParentContainerWithChildren = (q: CanonicalQuestionKey): boolean => {
    if (q.subquestionId) return false;
    if (q.isParentHeader) return true;

    const qKey = getCompleteQuestionIdentifier(q);
    const qId = (q.questionId || '').trim();
    const isContainer = parentIds.has(qId) || parentIds.has(qKey);
    if (!isContainer) return false;

    const children = questions.filter(
      (child) =>
        child !== q &&
        !orSuffixRegex.test(child.questionId) &&
        !orSuffixRegex.test(getCompleteQuestionIdentifier(child)) &&
        (
          child.parentQuestionId === qId ||
          child.parentQuestionId === qKey ||
          (child.questionId === qId && Boolean(child.subquestionId)) ||
          (child.questionId !== qId && (
            child.questionId.startsWith(qId + '.') ||
            child.questionId.startsWith(qId + '(') ||
            child.questionId.startsWith(qId + '-')
          ))
        )
    );
    return children.reduce((sum, c) => sum + (Number(c.maxMarks) || 0), 0) > 0;
  };

  // Resolve effective group for each question
  const getEffectiveGroup = (q: CanonicalQuestionKey): string | undefined => {
    if (q.selectionGroup) return q.selectionGroup.trim();
    if (q.isAlternative && q.alternativeGroup) return q.alternativeGroup.trim();

    if (q.parentQuestionId && qMap.has(q.parentQuestionId.trim())) {
      const parent = qMap.get(q.parentQuestionId.trim())!;
      if (parent.selectionGroup) return parent.selectionGroup.trim();
      if (parent.isAlternative && parent.alternativeGroup) return parent.alternativeGroup.trim();
    }
    const qKey = getCompleteQuestionIdentifier(q);
    const match = qKey.match(/^([0-9a-zA-Z]+)[\.\(\_\-]/);
    if (match && qMap.has(match[1])) {
      const parent = qMap.get(match[1])!;
      if (parent.selectionGroup) return parent.selectionGroup.trim();
      if (parent.isAlternative && parent.alternativeGroup) return parent.alternativeGroup.trim();
    }
    return undefined;
  };

  // Group questions by selection group
  const groupQuestionsMap = new Map<string, CanonicalQuestionKey[]>();
  const questionGroupMap = new Map<string, string>();

  for (const q of questions) {
    const grp = getEffectiveGroup(q);
    if (grp) {
      const qKey = getCompleteQuestionIdentifier(q);
      questionGroupMap.set(qKey, grp);
      if (q.questionId && !q.subquestionId) {
        questionGroupMap.set(q.questionId.trim(), grp);
      }
      if (!groupQuestionsMap.has(grp)) {
        groupQuestionsMap.set(grp, []);
      }
      groupQuestionsMap.get(grp)!.push(q);
    }
  }

  // Pre-calculate maximum marks for each selection group
  const groupCalculatedMaxMarks: Record<string, number> = {};

  for (const [grp, grpQuestions] of groupQuestionsMap.entries()) {
    // Collect rule configuration
    const nonContainerQs = grpQuestions.filter((q) => !isParentContainerWithChildren(q));
    const sampleQ = nonContainerQs[0] || grpQuestions[0];
    const parentQ = sampleQ?.parentQuestionId ? qMap.get(sampleQ.parentQuestionId) : undefined;

    const reqAttempts = sampleQ?.requiredAttempts || parentQ?.requiredAttempts || 1;
    const ruleType: SelectionRuleType = sampleQ?.groupRule || parentQ?.groupRule || (reqAttempts > 1 ? 'attempt_any_n' : 'mutually_exclusive_or');
    const groupMaxMarks = sampleQ?.groupMaxMarks ?? parentQ?.groupMaxMarks;

    // Group non-container questions by branch
    const branches = new Map<string, CanonicalQuestionKey[]>();
    for (const q of nonContainerQs) {
      const branchId = q.branchId || resolveQuestionBranchId(q, q.parentQuestionId);
      if (!branches.has(branchId)) {
        branches.set(branchId, []);
      }
      branches.get(branchId)!.push(q);
    }

    const branchMarksList: { branchId: string; marks: number }[] = [];
    for (const [branchId, branchQuestions] of branches.entries()) {
      let branchSum = 0;
      for (const bq of branchQuestions) {
        branchSum += Number(bq.maxMarks) || 0;
      }
      branchSum = parseFloat(branchSum.toFixed(2));
      branchMarksList.push({ branchId, marks: branchSum });
    }

    // Sort branch marks descending
    branchMarksList.sort((a, b) => b.marks - a.marks);
    const totalAvailable = branches.size;

    // Calculate sum of top N branches
    const topNBranches = branchMarksList.slice(0, Math.min(reqAttempts, totalAvailable));
    const topNSum = parseFloat(topNBranches.reduce((sum, b) => sum + b.marks, 0).toFixed(2));

    let effectiveGroupMax: number;
    if (groupMaxMarks !== undefined && Number.isFinite(groupMaxMarks) && groupMaxMarks > 0) {
      effectiveGroupMax = groupMaxMarks;
      if (Math.abs(topNSum - groupMaxMarks) > 0.05 && totalAvailable >= reqAttempts) {
        const breakdown = branchMarksList.map((b) => `${b.branchId}: ${b.marks}m`).join(' vs ');
        const warn = `Selection group "${grp}": explicit group maximum marks (${groupMaxMarks}m) differs from sum of top ${reqAttempts} choices (${topNSum}m, branches: ${breakdown}). Using explicit group max (${groupMaxMarks}m); faculty review recommended.`;
        discrepancyMessages.push(warn);
        ambiguousChoices.push(warn);
      }
    } else {
      effectiveGroupMax = topNSum;
      if (branchMarksList.length > 1) {
        const distinctMarks = new Set(branchMarksList.map((b) => b.marks));
        if (distinctMarks.size > 1) {
          const breakdown = branchMarksList.map((b) => `${b.branchId}: ${b.marks}m`).join(' vs ');
          const warn = `Selection group "${grp}": choices have unequal maximum marks (${breakdown}). Counted top ${reqAttempts} highest choices (${topNSum}m); faculty review recommended.`;
          discrepancyMessages.push(warn);
          ambiguousChoices.push(warn);
        }
      }
    }

    groupCalculatedMaxMarks[grp] = effectiveGroupMax;

    // Ambiguity checks
    if (reqAttempts > totalAvailable && totalAvailable > 0) {
      const msg = `Selection group "${grp}": instruction requires ${reqAttempts} attempts, but only ${totalAvailable} choice branches exist. Faculty review required.`;
      offendingQuestions.push(grp);
      discrepancyMessages.push(msg);
      ambiguousChoices.push(msg);
    } else if (ruleType === 'mutually_exclusive_or' && totalAvailable < 2) {
      const singleQId = branches.values().next().value?.[0]?.questionId || grp;
      offendingQuestions.push(singleQId);
      const msg = `Alternative group "${grp}" contains only one choice branch (${singleQId}). Missing mutually exclusive partner choice. Flagged for faculty review.`;
      discrepancyMessages.push(msg);
      ambiguousChoices.push(msg);
      const singleQ = qMap.get(singleQId);
      if (singleQ && !singleQ.flaggedIssue) {
        singleQ.flaggedIssue = `Alternative choice in group "${grp}" is missing its mutually exclusive partner.`;
      }
    }

    selectionRules.push({
      groupId: grp,
      ruleType,
      requiredAttempts: reqAttempts,
      totalAvailable,
      groupMaxMarks,
      calculatedGroupMaxMarks: effectiveGroupMax,
      instruction: parentQ?.questionText || sampleQ?.questionText,
      parentQuestionId: sampleQ?.parentQuestionId,
      section: sampleQ?.section,
      branchIds: Array.from(branches.keys()),
    });
  }

  // Flag ambiguous choice text in unassigned questions
  for (const q of questions) {
    if (isParentContainerWithChildren(q)) continue;
    const qKey = getCompleteQuestionIdentifier(q);
    const qId = (q.questionId || '').trim();
    const grp = questionGroupMap.get(qKey) || questionGroupMap.get(qId);
    if (!grp) {
      const text = ((q.questionText || '') + ' ' + (q.referenceAnswer || '')).toLowerCase();
      if (/\b(or|either|choice|optional|any one)\b/i.test(text) && !q.isAlternative && !q.selectionGroup) {
        offendingQuestions.push(qKey || qId);
        const msg = `Ambiguous choice in Question ${qKey || qId}: Question prompt/text suggests an alternative choice ("OR"), but question is not assigned to a choice group. Flagged for faculty review.`;
        discrepancyMessages.push(msg);
        ambiguousChoices.push(msg);
        if (!q.flaggedIssue) {
          q.flaggedIssue = 'Ambiguous choice: Question text suggests alternative choice (OR) but is not assigned to a choice group.';
        }
      }
    }
    if (q.flaggedIssue && q.flaggedIssue.includes('Ambiguous choice structure')) {
      if (!discrepancyMessages.includes(q.flaggedIssue)) {
        discrepancyMessages.push(q.flaggedIssue);
      }
      offendingQuestions.push(q.questionId);
    }
  }

  let calculatedGrandTotal = 0;
  const groupsSeen = new Set<string>();

  for (const q of questions) {
    const sec = (q.section || 'General').trim();
    if (!sectionTotals[sec]) {
      sectionTotals[sec] = 0;
      sectionCounts[sec] = 0;
    }
    sectionCounts[sec]++;

    const qKey = getCompleteQuestionIdentifier(q);
    const qId = (q.questionId || '').trim();
    const marks = Number(q.maxMarks) || 0;

    // Deduplicate parent container headers whose child sub-questions carry marks
    if (isParentContainerWithChildren(q)) {
      continue;
    }

    // Missing marks check for non-container questions
    if (!Number.isFinite(marks) || marks <= 0) {
      offendingQuestions.push(qKey || qId);
      discrepancyMessages.push('Question ' + (qKey || qId) + ' has missing or unassigned marks.');
    }

    // Selection / Alternative groups: count dynamically per group
    const grp = questionGroupMap.get(qKey) || questionGroupMap.get(qId);
    if (grp) {
      if (!groupsSeen.has(grp)) {
        groupsSeen.add(grp);
        const grpMarks = groupCalculatedMaxMarks[grp] !== undefined ? groupCalculatedMaxMarks[grp] : marks;
        sectionTotals[sec] = parseFloat((sectionTotals[sec] + grpMarks).toFixed(2));
        calculatedGrandTotal = parseFloat((calculatedGrandTotal + grpMarks).toFixed(2));
      }
      continue;
    }

    // Standard compulsory question
    sectionTotals[sec] = parseFloat((sectionTotals[sec] + marks).toFixed(2));
    calculatedGrandTotal = parseFloat((calculatedGrandTotal + marks).toFixed(2));
  }

  const sections: SectionMarksSummary[] = Object.keys(sectionTotals).map((name) => ({
    sectionName: name,
    questionCount: sectionCounts[name] || 0,
    calculatedTotalMarks: sectionTotals[name],
  }));

  let hasDiscrepancy = discrepancyMessages.length > 0;
  let difference = 0;
  let message = undefined;

  if (typeof printedMaxMarks === 'number' && printedMaxMarks > 0) {
    difference = parseFloat((calculatedGrandTotal - printedMaxMarks).toFixed(2));
    if (Math.abs(difference) > 0.05) {
      hasDiscrepancy = true;
      if (difference > 0) {
        message = `Question paper explicitly states ${printedMaxMarks} maximum marks, but extracted questions total ${calculatedGrandTotal} marks (+${difference} discrepancy). Check alternative (OR) choices or selection rules.`;
        discrepancyMessages.unshift(message);
      } else {
        message = `Question paper explicitly states ${printedMaxMarks} maximum marks, but extracted questions total only ${calculatedGrandTotal} marks (${difference} discrepancy). Check for missing questions or unassigned marks.`;
        discrepancyMessages.unshift(message);
      }
    }
  }

  return {
    hasDiscrepancy,
    printedMaxMarks,
    calculatedTotalMarks: calculatedGrandTotal,
    difference,
    message,
    discrepancyMessages: Array.from(new Set(discrepancyMessages)),
    offendingQuestions: Array.from(new Set(offendingQuestions)),
    sectionTotals,
    sections,
    ambiguousChoices: Array.from(new Set(ambiguousChoices)),
    hasAmbiguousChoices: ambiguousChoices.length > 0,
    selectionRules,
  };
}

export interface CanonicalAnswerKey {
  id: string;
  examId: string;
  title: string;
  subject?: string;
  grade?: string;
  sourceMode: AnswerKeySourceMode;
  version: number;
  status: AnswerKeyStatus;
  totalMaxMarks: number;
  printedMaxMarks?: number;
  marksValidation?: MarksValidationResult;
  selectionRules?: SelectionRule[];
  questions: CanonicalQuestionKey[];
  warnings?: string[];
  questionPaperFingerprint?: string;
  referencePairHash?: string;
  metadata: {
    institutionId: string;
    createdBy: string;
    createdAt: number;
    updatedAt: number;
    approvedAt?: number;
    approvedBy?: string;
    sourceDocName?: string;
  };
  sourceQuestionPaperDoc?: {
    name: string;
    text?: string;
    base64?: string;
    mimeType?: string;
  };
  sourceAnswerKeyDoc?: {
    name: string;
    text?: string;
    base64?: string;
    mimeType?: string;
  };
}

export interface QuestionFeedback {
  qNo: string;
  questionId?: string;
  feedbackPoints: string[];
  marks: number;
  maxMarks: number;
  isCorrect: boolean;
  isFlagged?: boolean;
  flaggedComment?: string;
  notes?: string;
}

export interface GeneralFeedbackSection {
  overallPerformance: string[];
  mcqs: string[];
  contentAccuracy: string[];
  completenessOfAnswers: string[];
  presentationDiagrams: string[];
  investigations: string[];
  attemptingQuestions: string[];
  actionPoints: string[];
}

export interface EvaluationReport {
  id?: string;
  studentName: string;
  testTitle: string;
  testTopics: string;
  testDate: string;
  totalScore: number;
  maxScore: number;
  questions: QuestionFeedback[];
  generalFeedback: GeneralFeedbackSection;
  timestamp?: number;
  evaluatedByModel?: string;
  answerKeyId?: string;
  answerKeyVersion?: number;
  answerKeySourceMode?: AnswerKeySourceMode;
}

export interface JobMetrics {
  correlationId: string;
  startTime: number;
  endTime?: number;
  totalLatencyMs?: number;
  preprocessingLatencyMs?: number;
  geminiLatencyMs?: number;
  validationLatencyMs?: number;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cachedInputTokens?: number | null;
  estimatedCostUsd?: number | null;
  estimatedCostInr?: number | null;
  pricingVersion?: string;
  usageCompleteness?: 'COMPLETE' | 'PARTIAL' | 'UNAVAILABLE';
  usageSource?: string;
  usageSummary?: any;
  cacheHit: boolean;
  retriesCount: number;
  fallbackCallsCount?: number;
  modelUsed?: string;
}

export interface StudentExtractedAnswer {
  questionId: string;
  subquestionId?: string;
  studentAnswerText: string;
  diagramDescription?: string;
  formulas?: string[];
  pageReferences?: number[];
  isAttempted: boolean;
  confidence: number;
  flaggedUncertain?: boolean;
  flaggedIssue?: string;
  visualEvidenceBase64?: string;
  visualEvidenceMimeType?: string;
}

export interface StudentExtractedScript {
  studentName: string;
  examTitle?: string;
  answers: StudentExtractedAnswer[];
  unmappedContent?: string[];
  warnings?: string[];
  visualEvidenceRetained: boolean;
  extractedAt: number;
}

export interface EvaluationJob {
  id: string;
  correlationId: string;
  studentName: string;
  testTitle?: string;
  status: JobStatus;
  progressPercent: number;
  currentStepMessage: string;
  mode: EvaluationMode;
  institutionId?: string;
  createdBy?: string;
  creatorRole?: UserRole;
  createdAt: number;
  updatedAt: number;
  report?: EvaluationReport;
  draftReport?: any;
  extractedScript?: StudentExtractedScript;
  error?: string;
  errorCategory?: string;
  statusCode?: number;
  isRetryable?: boolean;
  metrics: JobMetrics;
  answerKeyId?: string;
  answerKeyVersion?: number;
  answerKeySourceMode?: AnswerKeySourceMode;
  canonicalAnswerKey?: CanonicalAnswerKey;
  inputPayload: {
    sourceDoc: {
      name: string;
      text?: string;
      base64?: string;
      mimeType?: string;
    };
    questionPaper?: {
      name: string;
      text?: string;
      base64?: string;
      mimeType?: string;
    };
    answerKey?: {
      name: string;
      text?: string;
      base64?: string;
      mimeType?: string;
    };
    answerKeyId?: string;
    canonicalAnswerKey?: CanonicalAnswerKey;
    facultyNotes?: {
      name: string;
      text?: string;
      base64?: string;
      mimeType?: string;
    } | null;
  };
}
