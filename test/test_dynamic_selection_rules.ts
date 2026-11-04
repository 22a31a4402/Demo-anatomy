/**
 * Comprehensive Dynamic Selection Rules & Maximum Marks Calculation Test Suite
 *
 * Verifies:
 * 1. 70-Mark Mathematics Diploma Paper (MSBTE/State Board pattern):
 *    - Q1: Attempt any FIVE of the following : 10 (7 questions of 2m)
 *    - Q2: Attempt any THREE of the following : 12 (4 questions of 4m)
 *    - Q3: Attempt any THREE of the following : 12 (4 questions of 4m)
 *    - Q4: Attempt any THREE of the following : 12 (5 questions of 4m)
 *    - Q5: Attempt any TWO of the following : 12 (Branch a [6m], Branch b [3+3=6m], Branch c [3+3=6m])
 *    - Q6: Attempt any TWO of the following : 12 (Branch a [6m], Branch b [3+3=6m], Branch c [6m])
 *    - Total correctly calculated as 70 marks (naive sum is 102 marks). Discrepancy is 0.
 * 2. Student Evaluation Scoring with "Attempt any N":
 *    - Best N attempts awarded to student's advantage.
 *    - Excess attempts beyond N flagged as not counted toward final score.
 *    - All attempts and feedback preserved for review.
 * 3. Subject-Independent Marking Patterns across Examination Boards:
 *    - CBSE Class 12 Science (compulsory + internal OR choices + case studies)
 *    - University Engineering (Module-based choice architecture)
 *    - Medical / Life Sciences (Short notes selection rule)
 *    - Section-level selection rules
 * 4. Ambiguity and Discrepancy Detection:
 *    - Required attempts N > available branches M flagged for faculty review.
 *    - Stated group maximum marks mismatch flagged for faculty review.
 */

import {
  CanonicalQuestionKey,
  calculateCanonicalKeyMarks,
  detectAndNormalizeChoiceGroups,
  parseSelectionInstruction,
  resolveQuestionBranchId,
  CanonicalAnswerKey,
} from '../server/types';
import { EvaluationEngine } from '../server/evaluator';

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`  FAIL: ${message}`);
    throw new Error(`Assertion failed: ${message}`);
  }
}

async function runTests() {
  console.log('=== STARTING DYNAMIC SELECTION RULES & MARKS CALCULATION TESTS ===\n');

  // =========================================================================
  // TEST 1: Instruction Parser Unit Verification
  // =========================================================================
  console.log('Test 1: Academic Choice Instruction Parser');
  {
    const t1 = parseSelectionInstruction('Attempt any FIVE of the following : 10');
    assert(t1 !== null && t1.requiredAttempts === 5 && t1.groupMaxMarks === 10, 'Parse: Attempt any FIVE : 10');

    const t2 = parseSelectionInstruction('Attempt any THREE of the following : 12');
    assert(t2 !== null && t2.requiredAttempts === 3 && t2.groupMaxMarks === 12, 'Parse: Attempt any THREE : 12');

    const t3 = parseSelectionInstruction('Attempt any TWO of the following : 12');
    assert(t3 !== null && t3.requiredAttempts === 2 && t3.groupMaxMarks === 12, 'Parse: Attempt any TWO : 12');

    const t4 = parseSelectionInstruction('Answer any 4 questions out of 6 [20 marks]');
    assert(t4 !== null && t4.requiredAttempts === 4 && t4.groupMaxMarks === 20, 'Parse: Answer any 4 questions out of 6 [20 marks]');

    const t5 = parseSelectionInstruction('Answer any three questions of 5 marks each');
    assert(t5 !== null && t5.requiredAttempts === 3 && t5.groupMaxMarks === 15, 'Parse: 3 questions of 5 marks each');

    const t6 = parseSelectionInstruction('EITHER Part A OR Part B');
    assert(t6 !== null && t6.requiredAttempts === 1 && t6.ruleType === 'mutually_exclusive_or', 'Parse: EITHER OR');

    const t7 = parseSelectionInstruction('State and prove Pythagoras theorem');
    assert(t7 === null, 'Parse: Compulsory question returns null');

    console.log('  ✓ Instruction parser successfully handles digits, words, explicit marks, and per-question mark phrasing.\n');
  }

  // =========================================================================
  // TEST 2: Uploaded 70-Mark Mathematics Diploma Paper
  // =========================================================================
  console.log('Test 2: Uploaded 70-Mark Mathematics Diploma Paper (math-diploma-question-paper.pdf)');
  {
    const mathQuestions: CanonicalQuestionKey[] = [
      // Q1: Attempt any FIVE of the following : 10 (7 questions of 2m)
      { questionId: '1', questionText: 'Attempt any FIVE of the following : 10', maxMarks: 10, referenceAnswer: '', expectedConcepts: [], acceptableAlternatives: [], markingCriteria: [] },
      { questionId: '1.a', subquestionId: 'a', parentQuestionId: '1', questionText: 'If f(x) = x^3 - 5x^2 - 4x + 20, show that f(0) = -2f(3)', maxMarks: 2, referenceAnswer: 'f(0)=20, f(3)=-10, so f(0)=-2f(3)', expectedConcepts: [], acceptableAlternatives: [], markingCriteria: [] },
      { questionId: '1.b', subquestionId: 'b', parentQuestionId: '1', questionText: 'State whether f(x) = (x^3+sin x)/(x^2+1) is odd or even', maxMarks: 2, referenceAnswer: 'f(-x) = -f(x), hence odd', expectedConcepts: [], acceptableAlternatives: [], markingCriteria: [] },
      { questionId: '1.c', subquestionId: 'c', parentQuestionId: '1', questionText: 'Find dy/dx if y = (x^2+1)^5', maxMarks: 2, referenceAnswer: '10x(x^2+1)^4', expectedConcepts: [], acceptableAlternatives: [], markingCriteria: [] },
      { questionId: '1.d', subquestionId: 'd', parentQuestionId: '1', questionText: 'Evaluate int(x^2 + 2^x + 1/x)dx', maxMarks: 2, referenceAnswer: 'x^3/3 + 2^x/ln2 + ln|x| + c', expectedConcepts: [], acceptableAlternatives: [], markingCriteria: [] },
      { questionId: '1.e', subquestionId: 'e', parentQuestionId: '1', questionText: 'Evaluate int(sin^2(2x))dx', maxMarks: 2, referenceAnswer: 'x/2 - sin(4x)/8 + c', expectedConcepts: [], acceptableAlternatives: [], markingCriteria: [] },
      { questionId: '1.f', subquestionId: 'f', parentQuestionId: '1', questionText: 'Find area under y=e^x from x=0 to x=2', maxMarks: 2, referenceAnswer: 'e^2 - 1', expectedConcepts: [], acceptableAlternatives: [], markingCriteria: [] },
      { questionId: '1.g', subquestionId: 'g', parentQuestionId: '1', questionText: 'Find root of x^3-2x-5=0 using Bisection method', maxMarks: 2, referenceAnswer: 'Root approx 2.09', expectedConcepts: [], acceptableAlternatives: [], markingCriteria: [] },

      // Q2: Attempt any THREE of the following : 12 (4 questions of 4m)
      { questionId: '2', questionText: 'Attempt any THREE of the following : 12', maxMarks: 12, referenceAnswer: '', expectedConcepts: [], acceptableAlternatives: [], markingCriteria: [] },
      { questionId: '2.a', subquestionId: 'a', parentQuestionId: '2', questionText: 'Find dy/dx if x^2 + y^2 = 4xy', maxMarks: 4, referenceAnswer: 'dy/dx = (2y-x)/(y-2x)', expectedConcepts: [], acceptableAlternatives: [], markingCriteria: [] },
      { questionId: '2.b', subquestionId: 'b', parentQuestionId: '2', questionText: 'If x=a(theta+sin theta), y=a(1-cos theta) find dy/dx at theta=pi/2', maxMarks: 4, referenceAnswer: 'dy/dx = 1', expectedConcepts: [], acceptableAlternatives: [], markingCriteria: [] },
      { questionId: '2.c', subquestionId: 'c', parentQuestionId: '2', questionText: 'A manufacturer can sell x items at price p=250-x/100...', maxMarks: 4, referenceAnswer: 'Optimal production and max profit calculation', expectedConcepts: [], acceptableAlternatives: [], markingCriteria: [] },
      { questionId: '2.d', subquestionId: 'd', parentQuestionId: '2', questionText: 'Find radius of curvature for y=e^x at (0,1)', maxMarks: 4, referenceAnswer: 'rho = 2*sqrt(2)', expectedConcepts: [], acceptableAlternatives: [], markingCriteria: [] },

      // Q3: Attempt any THREE of the following : 12 (4 questions of 4m)
      { questionId: '3', questionText: 'Attempt any THREE of the following : 12', maxMarks: 12, referenceAnswer: '', expectedConcepts: [], acceptableAlternatives: [], markingCriteria: [] },
      { questionId: '3.a', subquestionId: 'a', parentQuestionId: '3', questionText: 'Find equation of tangent and normal to y=x^3-2x^2+4 at (2,4)', maxMarks: 4, referenceAnswer: 'Tangent: 4x-y-4=0, Normal: x+4y-18=0', expectedConcepts: [], acceptableAlternatives: [], markingCriteria: [] },
      { questionId: '3.b', subquestionId: 'b', parentQuestionId: '3', questionText: 'Divide 80 into two parts such that their product is maximum', maxMarks: 4, referenceAnswer: 'Parts are 40 and 40', expectedConcepts: [], acceptableAlternatives: [], markingCriteria: [] },
      { questionId: '3.c', subquestionId: 'c', parentQuestionId: '3', questionText: 'Evaluate int(dx/(x^2+4x+13))', maxMarks: 4, referenceAnswer: '(1/3)arctan((x+2)/3) + c', expectedConcepts: [], acceptableAlternatives: [], markingCriteria: [] },
      { questionId: '3.d', subquestionId: 'd', parentQuestionId: '3', questionText: 'Evaluate int(x*e^(2x)dx)', maxMarks: 4, referenceAnswer: '(e^(2x)/4)*(2x-1) + c', expectedConcepts: [], acceptableAlternatives: [], markingCriteria: [] },

      // Q4: Attempt any THREE of the following : 12 (5 questions of 4m)
      { questionId: '4', questionText: 'Attempt any THREE of the following : 12', maxMarks: 12, referenceAnswer: '', expectedConcepts: [], acceptableAlternatives: [], markingCriteria: [] },
      { questionId: '4.a', subquestionId: 'a', parentQuestionId: '4', questionText: 'Evaluate int(cos x/(1+sin^2 x))dx', maxMarks: 4, referenceAnswer: 'arctan(sin x) + c', expectedConcepts: [], acceptableAlternatives: [], markingCriteria: [] },
      { questionId: '4.b', subquestionId: 'b', parentQuestionId: '4', questionText: 'Evaluate int_0^(pi/2) sqrt(sin x)/(sqrt(sin x)+sqrt(cos x))dx', maxMarks: 4, referenceAnswer: 'pi/4', expectedConcepts: [], acceptableAlternatives: [], markingCriteria: [] },
      { questionId: '4.c', subquestionId: 'c', parentQuestionId: '4', questionText: 'Evaluate int(dx/(2+3cos x))', maxMarks: 4, referenceAnswer: 'Substitution tan(x/2)', expectedConcepts: [], acceptableAlternatives: [], markingCriteria: [] },
      { questionId: '4.d', subquestionId: 'd', parentQuestionId: '4', questionText: 'Find area bounded by y^2=4x and y=2x', maxMarks: 4, referenceAnswer: 'Area = 1/3', expectedConcepts: [], acceptableAlternatives: [], markingCriteria: [] },
      { questionId: '4.e', subquestionId: 'e', parentQuestionId: '4', questionText: 'Solve differential equation (1+x^2)dy - (1+y^2)dx = 0', maxMarks: 4, referenceAnswer: 'arctan y - arctan x = c', expectedConcepts: [], acceptableAlternatives: [], markingCriteria: [] },

      // Q5: Attempt any TWO of the following : 12
      // (a) 6m, (b) has (i) 3m + (ii) 3m = 6m, (c) has (i) 3m + (ii) 3m = 6m
      { questionId: '5', questionText: 'Attempt any TWO of the following : 12', maxMarks: 12, referenceAnswer: '', expectedConcepts: [], acceptableAlternatives: [], markingCriteria: [] },
      { questionId: '5.a', subquestionId: 'a', parentQuestionId: '5', questionText: 'Find area bounded by curves y^2=4x and x^2=4y', maxMarks: 6, referenceAnswer: 'Area = 16/3 sq units', expectedConcepts: [], acceptableAlternatives: [], markingCriteria: [] },
      { questionId: '5.b.i', subquestionId: 'b.i', parentQuestionId: '5', questionText: 'Form differential equation eliminating A, B from y=A cos mx + B sin mx', maxMarks: 3, referenceAnswer: 'd^2y/dx^2 + m^2 y = 0', expectedConcepts: [], acceptableAlternatives: [], markingCriteria: [] },
      { questionId: '5.b.ii', subquestionId: 'b.ii', parentQuestionId: '5', questionText: 'Solve dy/dx + y cot x = csc x', maxMarks: 3, referenceAnswer: 'y sin x = x + c', expectedConcepts: [], acceptableAlternatives: [], markingCriteria: [] },
      { questionId: '5.c.i', subquestionId: 'c.i', parentQuestionId: '5', questionText: 'A wire 36cm bent into rectangle of max area. Find dimensions', maxMarks: 3, referenceAnswer: 'Square 9cm x 9cm', expectedConcepts: [], acceptableAlternatives: [], markingCriteria: [] },
      { questionId: '5.c.ii', subquestionId: 'c.ii', parentQuestionId: '5', questionText: 'Cost function C(x) analysis', maxMarks: 3, referenceAnswer: 'Marginal cost analysis', expectedConcepts: [], acceptableAlternatives: [], markingCriteria: [] },

      // Q6: Attempt any TWO of the following : 12
      // (a) 6m, (b) has (i) 3m + (ii) 3m = 6m, (c) 6m
      { questionId: '6', questionText: 'Attempt any TWO of the following : 12', maxMarks: 12, referenceAnswer: '', expectedConcepts: [], acceptableAlternatives: [], markingCriteria: [] },
      { questionId: '6.a', subquestionId: 'a', parentQuestionId: '6', questionText: 'Find root of x^3-x-1=0 using Newton-Raphson method', maxMarks: 6, referenceAnswer: 'Root approx 1.3247', expectedConcepts: [], acceptableAlternatives: [], markingCriteria: [] },
      { questionId: '6.b.i', subquestionId: 'b.i', parentQuestionId: '6', questionText: 'Solve by Gauss Elimination: x+y+z=6, 3x-y+2z=7, 2x+3y-z=5', maxMarks: 3, referenceAnswer: 'x=1, y=2, z=3', expectedConcepts: [], acceptableAlternatives: [], markingCriteria: [] },
      { questionId: '6.b.ii', subquestionId: 'b.ii', parentQuestionId: '6', questionText: 'Solve by Jacobi method', maxMarks: 3, referenceAnswer: 'Iterative solution', expectedConcepts: [], acceptableAlternatives: [], markingCriteria: [] },
      { questionId: '6.c', subquestionId: 'c', parentQuestionId: '6', questionText: 'Find root of x^3-4x-9=0 using Regula-Falsi method', maxMarks: 6, referenceAnswer: 'Root approx 2.706', expectedConcepts: [], acceptableAlternatives: [], markingCriteria: [] },
    ];

    const result = calculateCanonicalKeyMarks(mathQuestions, 70);

    console.log(`  Printed Max Marks: ${result.printedMaxMarks}`);
    console.log(`  Calculated Total Marks: ${result.calculatedTotalMarks}`);
    console.log(`  Difference: ${result.difference}`);
    console.log(`  Discrepancy: ${result.hasDiscrepancy}`);
    console.log(`  Discrepancy Messages:`, result.discrepancyMessages);
    console.log(`  Offending Questions:`, result.offendingQuestions);
    console.log(`  Selection Rules detected: ${result.selectionRules?.length || 0}`);

    assert(result.calculatedTotalMarks === 70, `Calculated total marks must be exactly 70 (got ${result.calculatedTotalMarks})`);
    assert(!result.hasDiscrepancy, 'Must not have discrepancy against printed 70 marks');
    assert(result.difference === 0, `Difference must be 0 (got ${result.difference})`);
    assert(Boolean(result.selectionRules && result.selectionRules.length === 6), 'Must detect 6 selection rules (Q1 to Q6)');

    // Verify individual rules
    const q1Rule = result.selectionRules?.find((r) => r.groupId === 'selection_group_1');
    assert(Boolean(q1Rule?.requiredAttempts === 5 && q1Rule?.totalAvailable === 7 && q1Rule?.calculatedGroupMaxMarks === 10), 'Q1 rule: 5 of 7 = 10m');

    const q5Rule = result.selectionRules?.find((r) => r.groupId === 'selection_group_5');
    assert(Boolean(q5Rule?.requiredAttempts === 2 && q5Rule?.totalAvailable === 3 && q5Rule?.calculatedGroupMaxMarks === 12), 'Q5 rule: 2 of 3 branches = 12m');
    assert(Boolean(q5Rule?.branchIds.includes('5.a') && q5Rule?.branchIds.includes('5.b') && q5Rule?.branchIds.includes('5.c')), 'Q5 branches: 5.a, 5.b, 5.c');

    console.log('  ✓ 70-Mark Mathematics Diploma Paper correctly and deterministically calculated as exactly 70 marks without hardcoded totals!\n');
  }

  // =========================================================================
  // TEST 3: Student Evaluation with "Attempt any N" (Best Attempts Awarded)
  // =========================================================================
  console.log('Test 3: Student Evaluation Scoring with "Attempt any N" and Excess Attempts');
  {
    const engine = new EvaluationEngine();
    const canonicalKey: CanonicalAnswerKey = {
      id: 'test_ak_math_70',
      examId: 'exam_math_70',
      title: 'Mathematics Diploma Exam',
      sourceMode: 'uploaded',
      version: 1,
      status: 'approved',
      totalMaxMarks: 70,
      printedMaxMarks: 70,
      metadata: { institutionId: 'inst_1', createdBy: 'prof_1', createdAt: Date.now(), updatedAt: Date.now() },
      questions: detectAndNormalizeChoiceGroups([
        // Q1: Attempt any FIVE of the following : 10 (7 questions of 2m)
        { questionId: '1', questionText: 'Attempt any FIVE of the following : 10', maxMarks: 10, referenceAnswer: '', expectedConcepts: [], acceptableAlternatives: [], markingCriteria: [] },
        { questionId: '1.a', subquestionId: 'a', parentQuestionId: '1', questionText: 'Q1.a', maxMarks: 2, referenceAnswer: '', expectedConcepts: [], acceptableAlternatives: [], markingCriteria: [] },
        { questionId: '1.b', subquestionId: 'b', parentQuestionId: '1', questionText: 'Q1.b', maxMarks: 2, referenceAnswer: '', expectedConcepts: [], acceptableAlternatives: [], markingCriteria: [] },
        { questionId: '1.c', subquestionId: 'c', parentQuestionId: '1', questionText: 'Q1.c', maxMarks: 2, referenceAnswer: '', expectedConcepts: [], acceptableAlternatives: [], markingCriteria: [] },
        { questionId: '1.d', subquestionId: 'd', parentQuestionId: '1', questionText: 'Q1.d', maxMarks: 2, referenceAnswer: '', expectedConcepts: [], acceptableAlternatives: [], markingCriteria: [] },
        { questionId: '1.e', subquestionId: 'e', parentQuestionId: '1', questionText: 'Q1.e', maxMarks: 2, referenceAnswer: '', expectedConcepts: [], acceptableAlternatives: [], markingCriteria: [] },
        { questionId: '1.f', subquestionId: 'f', parentQuestionId: '1', questionText: 'Q1.f', maxMarks: 2, referenceAnswer: '', expectedConcepts: [], acceptableAlternatives: [], markingCriteria: [] },
        { questionId: '1.g', subquestionId: 'g', parentQuestionId: '1', questionText: 'Q1.g', maxMarks: 2, referenceAnswer: '', expectedConcepts: [], acceptableAlternatives: [], markingCriteria: [] },

        // Q5: Attempt any TWO of the following : 12 (3 branches of 6m)
        { questionId: '5', questionText: 'Attempt any TWO of the following : 12', maxMarks: 12, referenceAnswer: '', expectedConcepts: [], acceptableAlternatives: [], markingCriteria: [] },
        { questionId: '5.a', subquestionId: 'a', parentQuestionId: '5', questionText: 'Q5.a', maxMarks: 6, referenceAnswer: '', expectedConcepts: [], acceptableAlternatives: [], markingCriteria: [] },
        { questionId: '5.b.i', subquestionId: 'b.i', parentQuestionId: '5', questionText: 'Q5.b.i', maxMarks: 3, referenceAnswer: '', expectedConcepts: [], acceptableAlternatives: [], markingCriteria: [] },
        { questionId: '5.b.ii', subquestionId: 'b.ii', parentQuestionId: '5', questionText: 'Q5.b.ii', maxMarks: 3, referenceAnswer: '', expectedConcepts: [], acceptableAlternatives: [], markingCriteria: [] },
        { questionId: '5.c.i', subquestionId: 'c.i', parentQuestionId: '5', questionText: 'Q5.c.i', maxMarks: 3, referenceAnswer: '', expectedConcepts: [], acceptableAlternatives: [], markingCriteria: [] },
        { questionId: '5.c.ii', subquestionId: 'c.ii', parentQuestionId: '5', questionText: 'Q5.c.ii', maxMarks: 3, referenceAnswer: '', expectedConcepts: [], acceptableAlternatives: [], markingCriteria: [] },
      ]),
    };

    // Scenario: Student attempts 6 subquestions in Q1 (permitted: 5)
    // Awards: 1.a: 2/2, 1.b: 2/2, 1.c: 1/2, 1.d: 2/2, 1.e: 2/2, 1.f: 2/2
    // Top 5 scoring: a, b, d, e, f (each 2m) -> 10/10 marks awarded.
    // 1.c (1m) is excess and must be flagged as not counted.
    // In Q5: Student attempts 5.a (5/6), 5.b (3+3=6/6), 5.c (2+1=3/6)
    // Permitted: 2 branches.
    // Top 2 branches: 5.b (6) and 5.a (5) -> 11/12 marks awarded.
    // 5.c (3) is excess and must be flagged as not counted.
    const studentFeedback: any[] = [
      { qNo: '1.a', marks: 2, maxMarks: 2, isCorrect: true, feedbackPoints: [] },
      { qNo: '1.b', marks: 2, maxMarks: 2, isCorrect: true, feedbackPoints: [] },
      { qNo: '1.c', marks: 1, maxMarks: 2, isCorrect: false, feedbackPoints: [] },
      { qNo: '1.d', marks: 2, maxMarks: 2, isCorrect: true, feedbackPoints: [] },
      { qNo: '1.e', marks: 2, maxMarks: 2, isCorrect: true, feedbackPoints: [] },
      { qNo: '1.f', marks: 2, maxMarks: 2, isCorrect: true, feedbackPoints: [] },

      { qNo: '5.a', marks: 5, maxMarks: 6, isCorrect: true, feedbackPoints: [] },
      { qNo: '5.b.i', marks: 3, maxMarks: 3, isCorrect: true, feedbackPoints: [] },
      { qNo: '5.b.ii', marks: 3, maxMarks: 3, isCorrect: true, feedbackPoints: [] },
      { qNo: '5.c.i', marks: 2, maxMarks: 3, isCorrect: false, feedbackPoints: [] },
      { qNo: '5.c.ii', marks: 1, maxMarks: 3, isCorrect: false, feedbackPoints: [] },
    ];

    const finalMarks = engine.calculateStudentFinalMarks(studentFeedback, canonicalKey);

    console.log(`  Student Total Score: ${finalMarks.totalScore} / ${finalMarks.maxScore}`);

    // Q1 top 5 = 10m, Q5 top 2 branches = 11m -> Expected total: 21m
    assert(finalMarks.totalScore === 21, `Expected totalScore to be 21 (got ${finalMarks.totalScore})`);

    // Check feedback annotations: 1.c should be flagged as not counted
    const q1c = studentFeedback.find((q) => q.qNo === '1.c');
    assert(q1c?.isFlagged === true, '1.c must be flagged as excess attempt');
    assert(q1c?.notes?.includes('Not counted toward final score'), '1.c notes must state not counted');

    // 5.c subparts should be flagged as not counted
    const q5ci = studentFeedback.find((q) => q.qNo === '5.c.i');
    const q5cii = studentFeedback.find((q) => q.qNo === '5.c.ii');
    assert(q5ci?.isFlagged === true && q5cii?.isFlagged === true, '5.c subparts must be flagged as excess attempt');
    assert(q5ci?.notes?.includes('Not counted toward final score'), '5.c.i notes must state not counted');

    // Counted items must be marked as counted
    const q5a = studentFeedback.find((q) => q.qNo === '5.a');
    assert(q5a?.notes?.includes('Counted toward final score'), '5.a notes must state counted toward final score');

    console.log('  ✓ Evaluator awarded best attempts to student advantage (21/22 marks) and flagged excess choices with full explanations.\n');
  }

  // =========================================================================
  // TEST 4: Diverse Subject Patterns across Examination Boards
  // =========================================================================
  console.log('Test 4: Diverse Subject Patterns across Examination Boards');
  {
    // Pattern A: CBSE Class 12 Science (compulsory section + internal choice OR questions)
    const cbseQuestions: CanonicalQuestionKey[] = [
      { questionId: '1', section: 'Section A', questionText: 'MCQ 1', maxMarks: 1, referenceAnswer: '', expectedConcepts: [], acceptableAlternatives: [], markingCriteria: [] },
      { questionId: '2', section: 'Section A', questionText: 'MCQ 2', maxMarks: 1, referenceAnswer: '', expectedConcepts: [], acceptableAlternatives: [], markingCriteria: [] },
      { questionId: '3', section: 'Section B', questionText: 'Describe Biot-Savart law', maxMarks: 2, referenceAnswer: '', expectedConcepts: [], acceptableAlternatives: [], markingCriteria: [] },
      { questionId: '4', section: 'Section B', questionText: 'State Ampere circuital law OR State Gauss law for magnetism', maxMarks: 2, referenceAnswer: '', expectedConcepts: [], acceptableAlternatives: [], markingCriteria: [] },
      { questionId: '4_OR', section: 'Section B', questionText: 'State Gauss law for magnetism', maxMarks: 2, referenceAnswer: '', expectedConcepts: [], acceptableAlternatives: [], markingCriteria: [] },
    ];
    const cbseRes = calculateCanonicalKeyMarks(cbseQuestions, 6);
    assert(cbseRes.calculatedTotalMarks === 6, `CBSE pattern: expected 6 marks, got ${cbseRes.calculatedTotalMarks}`);
    assert(!cbseRes.hasDiscrepancy, 'CBSE pattern should have no discrepancy');

    // Pattern B: Engineering Module Paper (100 Marks: 5 Modules, choose 1 full question per Module)
    const engQuestions: CanonicalQuestionKey[] = [
      // Module 1: Answer Q1 OR Q2 (20 marks each)
      { questionId: '1', section: 'Module 1', questionText: 'Design a FIR filter using Hamming window', maxMarks: 20, referenceAnswer: '', expectedConcepts: [], acceptableAlternatives: [], markingCriteria: [] },
      { questionId: '2', section: 'Module 1', questionText: 'Design an IIR Butterworth filter', maxMarks: 20, isAlternative: true, alternativeGroup: 'mod1_choice', referenceAnswer: '', expectedConcepts: [], acceptableAlternatives: [], markingCriteria: [] },

      // Module 2: Answer Q3 OR Q4 (20 marks each)
      { questionId: '3', section: 'Module 2', questionText: 'Explain FFT Decimation-in-Time algorithm', maxMarks: 20, referenceAnswer: '', expectedConcepts: [], acceptableAlternatives: [], markingCriteria: [] },
      { questionId: '4', section: 'Module 2', questionText: 'Explain FFT Decimation-in-Frequency algorithm', maxMarks: 20, isAlternative: true, alternativeGroup: 'mod2_choice', referenceAnswer: '', expectedConcepts: [], acceptableAlternatives: [], markingCriteria: [] },

      // Module 3: Answer Q5 OR Q6 (20 marks each)
      { questionId: '5', section: 'Module 3', questionText: 'Derive DFT properties', maxMarks: 20, referenceAnswer: '', expectedConcepts: [], acceptableAlternatives: [], markingCriteria: [] },
      { questionId: '6', section: 'Module 3', questionText: 'Compute circular convolution using DFT-IDFT', maxMarks: 20, isAlternative: true, alternativeGroup: 'mod3_choice', referenceAnswer: '', expectedConcepts: [], acceptableAlternatives: [], markingCriteria: [] },

      // Module 4: Answer Q7 OR Q8 (20 marks each)
      { questionId: '7', section: 'Module 4', questionText: 'Architecture of TMS320C67X DSP processor', maxMarks: 20, referenceAnswer: '', expectedConcepts: [], acceptableAlternatives: [], markingCriteria: [] },
      { questionId: '8', section: 'Module 4', questionText: 'Addressing modes of DSP processor', maxMarks: 20, isAlternative: true, alternativeGroup: 'mod4_choice', referenceAnswer: '', expectedConcepts: [], acceptableAlternatives: [], markingCriteria: [] },

      // Module 5: Answer Q9 OR Q10 (20 marks each)
      { questionId: '9', section: 'Module 5', questionText: 'Implementation of dual-tone multi-frequency (DTMF) detection', maxMarks: 20, referenceAnswer: '', expectedConcepts: [], acceptableAlternatives: [], markingCriteria: [] },
      { questionId: '10', section: 'Module 5', questionText: 'Implementation of digital audio reverberation algorithm', maxMarks: 20, isAlternative: true, alternativeGroup: 'mod5_choice', referenceAnswer: '', expectedConcepts: [], acceptableAlternatives: [], markingCriteria: [] },
    ];
    // In engQuestions: Pair Q1 with Q2, Q3 with Q4, etc.
    engQuestions[0].isAlternative = true;
    engQuestions[0].alternativeGroup = 'mod1_choice';
    engQuestions[2].isAlternative = true;
    engQuestions[2].alternativeGroup = 'mod2_choice';
    engQuestions[4].isAlternative = true;
    engQuestions[4].alternativeGroup = 'mod3_choice';
    engQuestions[6].isAlternative = true;
    engQuestions[6].alternativeGroup = 'mod4_choice';
    engQuestions[8].isAlternative = true;
    engQuestions[8].alternativeGroup = 'mod5_choice';

    const engRes = calculateCanonicalKeyMarks(engQuestions, 100);
    assert(engRes.calculatedTotalMarks === 100, `Engineering module paper: expected 100 marks, got ${engRes.calculatedTotalMarks}`);
    assert(!engRes.hasDiscrepancy, 'Engineering module paper: must have no discrepancy');

    // Pattern C: Medical / Life Sciences Short Notes: "Write short notes on any FOUR [5 marks each]"
    const medQuestions: CanonicalQuestionKey[] = [
      { questionId: '1', questionText: 'Describe cardiac cycle and ventricular pressure changes in detail', maxMarks: 20, referenceAnswer: '', expectedConcepts: [], acceptableAlternatives: [], markingCriteria: [] },
      { questionId: '2', questionText: 'Write short notes on any FOUR of the following : 20', maxMarks: 20, referenceAnswer: '', expectedConcepts: [], acceptableAlternatives: [], markingCriteria: [] },
      { questionId: '2.a', subquestionId: 'a', parentQuestionId: '2', questionText: 'Surfactant and its physiological significance', maxMarks: 5, referenceAnswer: '', expectedConcepts: [], acceptableAlternatives: [], markingCriteria: [] },
      { questionId: '2.b', subquestionId: 'b', parentQuestionId: '2', questionText: 'Glomerular filtration rate and its regulation', maxMarks: 5, referenceAnswer: '', expectedConcepts: [], acceptableAlternatives: [], markingCriteria: [] },
      { questionId: '2.c', subquestionId: 'c', parentQuestionId: '2', questionText: 'Refractory period of cardiac muscle', maxMarks: 5, referenceAnswer: '', expectedConcepts: [], acceptableAlternatives: [], markingCriteria: [] },
      { questionId: '2.d', subquestionId: 'd', parentQuestionId: '2', questionText: 'Functions of basal ganglia', maxMarks: 5, referenceAnswer: '', expectedConcepts: [], acceptableAlternatives: [], markingCriteria: [] },
      { questionId: '2.e', subquestionId: 'e', parentQuestionId: '2', questionText: 'Mechanism of hearing', maxMarks: 5, referenceAnswer: '', expectedConcepts: [], acceptableAlternatives: [], markingCriteria: [] },
      { questionId: '2.f', subquestionId: 'f', parentQuestionId: '2', questionText: 'Juxtaglomerular apparatus', maxMarks: 5, referenceAnswer: '', expectedConcepts: [], acceptableAlternatives: [], markingCriteria: [] },
    ];
    // Total: Q1 (20) + Q2 (4 of 6 x 5m = 20) = 40 marks
    const medRes = calculateCanonicalKeyMarks(medQuestions, 40);
    assert(medRes.calculatedTotalMarks === 40, `Medical short notes: expected 40 marks, got ${medRes.calculatedTotalMarks}`);
    assert(!medRes.hasDiscrepancy, 'Medical short notes: must have no discrepancy');

    console.log('  ✓ Subject-independent patterns (CBSE, Engineering Modules, Medical Short Notes) calculated deterministically with 100% accuracy.\n');
  }

  // =========================================================================
  // TEST 5: Ambiguity and Inconsistency Detection
  // =========================================================================
  console.log('Test 5: Ambiguity and Inconsistency Detection (Flagging for Faculty Review)');
  {
    // Case A: Instruction requires more attempts than available choices (e.g. attempt 4 out of 3)
    const impossibleChoiceQuestions: CanonicalQuestionKey[] = [
      { questionId: '1', questionText: 'Attempt any FOUR of the following : 16', maxMarks: 16, referenceAnswer: '', expectedConcepts: [], acceptableAlternatives: [], markingCriteria: [] },
      { questionId: '1.a', subquestionId: 'a', parentQuestionId: '1', questionText: 'Sub 1', maxMarks: 4, referenceAnswer: '', expectedConcepts: [], acceptableAlternatives: [], markingCriteria: [] },
      { questionId: '1.b', subquestionId: 'b', parentQuestionId: '1', questionText: 'Sub 2', maxMarks: 4, referenceAnswer: '', expectedConcepts: [], acceptableAlternatives: [], markingCriteria: [] },
      { questionId: '1.c', subquestionId: 'c', parentQuestionId: '1', questionText: 'Sub 3', maxMarks: 4, referenceAnswer: '', expectedConcepts: [], acceptableAlternatives: [], markingCriteria: [] },
    ];
    const impRes = calculateCanonicalKeyMarks(impossibleChoiceQuestions);
    assert(impRes.hasAmbiguousChoices, 'Must flag impossible choice (N=4 > M=3) for faculty review');
    assert(impRes.ambiguousChoices.some((c) => c.includes('instruction requires 4 attempts, but only 3 choice branches exist')), 'Contains informative warning');

    // Case B: Stated group max marks mismatch (e.g. stated 15m, but 2 choices of 5m sum to 10m)
    const mismatchChoiceQuestions: CanonicalQuestionKey[] = [
      { questionId: '2', questionText: 'Attempt any TWO of the following : 15', maxMarks: 15, referenceAnswer: '', expectedConcepts: [], acceptableAlternatives: [], markingCriteria: [] },
      { questionId: '2.a', subquestionId: 'a', parentQuestionId: '2', questionText: 'Sub 1', maxMarks: 5, referenceAnswer: '', expectedConcepts: [], acceptableAlternatives: [], markingCriteria: [] },
      { questionId: '2.b', subquestionId: 'b', parentQuestionId: '2', questionText: 'Sub 2', maxMarks: 5, referenceAnswer: '', expectedConcepts: [], acceptableAlternatives: [], markingCriteria: [] },
      { questionId: '2.c', subquestionId: 'c', parentQuestionId: '2', questionText: 'Sub 3', maxMarks: 5, referenceAnswer: '', expectedConcepts: [], acceptableAlternatives: [], markingCriteria: [] },
    ];
    const misRes = calculateCanonicalKeyMarks(mismatchChoiceQuestions);
    assert(misRes.hasAmbiguousChoices, 'Must flag group max mismatch (15 vs 10) for faculty review');
    assert(misRes.ambiguousChoices.some((c) => c.includes('differs from sum of top 2 choices')), 'Contains group max mismatch explanation');

    // Case C: Unassigned question with OR prompt
    const unassignedOrQuestions: CanonicalQuestionKey[] = [
      { questionId: '10', questionText: 'Describe cell division OR explain meiosis', maxMarks: 5, referenceAnswer: '', expectedConcepts: [], acceptableAlternatives: [], markingCriteria: [] },
    ];
    const unassignedRes = calculateCanonicalKeyMarks(unassignedOrQuestions);
    assert(unassignedRes.hasAmbiguousChoices, 'Must flag unassigned question with alternative prompt');

    console.log('  ✓ Ambiguities and structural inconsistencies flagged for faculty review without silently guessing.\n');
  }

  console.log('=== ALL DYNAMIC SELECTION RULES TESTS PASSED SUCCESSFULLY! ===');
}

runTests().catch((err) => {
  console.error('Test run failed:', err);
  process.exit(1);
});
