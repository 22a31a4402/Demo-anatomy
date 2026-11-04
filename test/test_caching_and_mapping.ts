/**
 * Targeted Verification Suite for NextGen Eval Caching & Answer-Key Persistence
 *
 * Verifies:
 * 1. Persistent evaluation caching & short-circuiting of Gemini API on re-evaluating unchanged student script.
 * 2. Persistent mapping of Question Paper to approved Answer Key & subsequent direct student evaluation.
 * 3. Cache key invalidation when student script, QP, answer key version, or rubrics change.
 * 4. Persistence across server restarts and cross-user / cross-institution data isolation.
 */

import fs from 'fs';
import path from 'path';
import { evaluationCache } from '../server/cache';
import { answerKeyService } from '../server/answerKeyService';
import { evaluationEngine } from '../server/evaluator';
import { setMockGeminiProvider } from '../server/geminiClient';
import { UserContext } from '../server/auth';
import { EvaluationJob } from '../server/types';

let passed = 0;
let total = 0;

function assert(condition: boolean, msg: string) {
  total++;
  if (!condition) {
    console.error(`❌ FAIL: ${msg}`);
    throw new Error(`Assertion failed: ${msg}`);
  }
  passed++;
  console.log(`✅ PASS: ${msg}`);
}

async function runVerification() {
  console.log('========================================================================');
  console.log(' VERIFICATION: CACHING & ANSWER-KEY PERSISTENCE IN NEXTGEN EVAL');
  console.log('========================================================================\n');

  let geminiApiCallCount = 0;

  // Mock Gemini Provider
  setMockGeminiProvider(async ({ correlationId }) => {
    geminiApiCallCount++;
    console.log(`  [MockGemini] API Call #${geminiApiCallCount} received for correlationId: ${correlationId}`);

    // If answer key extraction/generation
    if (correlationId.startsWith('ak_gen_') || correlationId.startsWith('ak_ext_')) {
      return {
        text: JSON.stringify({
          examTitle: 'Cardiovascular Physiology Exam',
          totalMaxMarks: 20,
          printedMaxMarks: 20,
          warnings: [],
          questions: [
            {
              questionId: '1',
              maxMarks: 10,
              questionText: 'Describe the cardiac conduction system.',
              referenceAnswer: 'SA node generates impulses traveling to AV node, Bundle of His, and Purkinje fibers.',
              expectedConcepts: ['SA Node', 'AV Node', 'Bundle of His', 'Purkinje Fibers'],
              acceptableAlternatives: ['Sinoatrial node', 'Atrioventricular node'],
              markingCriteria: ['Award 5 marks for node sequence', 'Award 5 marks for impulse pathway'],
            },
            {
              questionId: '2',
              maxMarks: 10,
              questionText: 'Explain the Frank-Starling law of the heart.',
              referenceAnswer: 'Stroke volume increases in response to an increase in the end-diastolic volume.',
              expectedConcepts: ['End-diastolic volume', 'Myocardial stretch', 'Stroke volume'],
              acceptableAlternatives: ['Starling relationship'],
              markingCriteria: ['Award 5 marks for definition', 'Award 5 marks for physiological significance'],
            },
          ],
        }),
        usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 400 },
      };
    }

    // Stage 1 student extraction
    if (correlationId.startsWith('ext_')) {
      return {
        text: JSON.stringify({
          studentName: 'Aarav Patel',
          examTitle: 'Cardiovascular Physiology Exam',
          answers: [
            {
              questionId: '1',
              studentAnswerText: 'The cardiac impulse begins at the SA node, reaches the AV node, travels through the Bundle of His and reaches the Purkinje fibers.',
              isAttempted: true,
              confidence: 0.95,
            },
            {
              questionId: '2',
              studentAnswerText: 'Frank-Starling law states that the stroke volume of the heart increases with increased preload (end-diastolic volume).',
              isAttempted: true,
              confidence: 0.95,
            },
          ],
          visualEvidenceRetained: false,
        }),
        usageMetadata: { promptTokenCount: 1200, candidatesTokenCount: 300 },
      };
    }

    // Stage 2 grading
    return {
      text: JSON.stringify({
        studentName: 'Aarav Patel',
        testTitle: 'Cardiovascular Physiology Exam',
        testTopics: 'Cardiac Cycle',
        testDate: '2026-11-01',
        totalScore: 20,
        maxScore: 20,
        questions: [
          {
            qNo: '1',
            marks: 10,
            maxMarks: 10,
            isCorrect: true,
            feedbackPoints: ['Accurately detailed all components of the conduction system.'],
          },
          {
            qNo: '2',
            marks: 10,
            maxMarks: 10,
            isCorrect: true,
            feedbackPoints: ['Correctly explained the Frank-Starling mechanism.'],
          },
        ],
        generalFeedback: {
          overallPerformance: ['Outstanding physiological comprehension demonstrated.'],
        },
      }),
      usageMetadata: { promptTokenCount: 1500, candidatesTokenCount: 500 },
    };
  });

  const instUser: UserContext = {
    userId: 'prof_mehta',
    role: 'instructor',
    institutionId: 'inst_cardio_med_01',
    name: 'Prof. Mehta',
  };

  const sampleQpDoc = {
    name: 'QP_Cardiovascular_Physiology.pdf',
    text: 'Cardiovascular Physiology Final Exam. Q1: Conduction system (10m). Q2: Frank-Starling law (10m). Total: 20m.',
    base64: Buffer.from('PDF_DUMMY_QP_CARDIO_V1_CONTENT_STREAM_TEST_BYTES').toString('base64'),
    mimeType: 'application/pdf',
  };

  const sampleStudentDoc = {
    name: 'Student_Aarav_Patel_Answer_Script.pdf',
    text: 'Aarav Patel - Ans 1: SA node -> AV node -> Bundle of His -> Purkinje fibers. Ans 2: Frank-Starling law connects stroke volume with EDV.',
    base64: Buffer.from('PDF_DUMMY_STUDENT_SCRIPT_AARAV_V1_BYTES').toString('base64'),
    mimeType: 'application/pdf',
  };

  // -----------------------------------------------------------------------
  // REQUIREMENT 2 VERIFICATION: Question Paper Mapping & Direct Upload
  // -----------------------------------------------------------------------
  console.log('--- REQUIREMENT 2: Question Paper -> Answer Key Mapping & Direct Upload ---');

  // Step 2.1: Generate answer key from question paper
  const generatedKey = await answerKeyService.generateFromQuestionPaper({
    questionPaper: sampleQpDoc,
    title: 'Cardiovascular Physiology Exam',
    subject: 'Physiology',
    totalMaxMarks: 20,
    metadata: {
      institutionId: instUser.institutionId,
      createdBy: instUser.userId,
    },
  });

  assert(generatedKey.status === 'draft', 'Answer key is initially generated in draft status.');
  assert(Boolean(generatedKey.questionPaperFingerprint), 'Answer key stores questionPaperFingerprint.');

  // Step 2.2: Approve answer key
  const approvedKey = answerKeyService.approveAnswerKey(generatedKey.id, instUser, 'Approved by Cardiology HOD');
  assert(approvedKey.status === 'approved', 'Answer key successfully approved.');

  // Step 2.3: Lookup approved answer key by question paper document
  const mappedKey = answerKeyService.findApprovedKeyForQuestionPaper(sampleQpDoc, instUser);
  assert(mappedKey !== null, 'findApprovedKeyForQuestionPaper successfully located mapped key.');
  assert(mappedKey?.id === approvedKey.id, 'Mapped answer key ID matches approved key ID.');
  assert(mappedKey?.status === 'approved', 'Mapped answer key is approved and locked.');

  // Step 2.4: Latest approved key lookup for institution
  const latestApproved = answerKeyService.getLatestApprovedKey(instUser);
  assert(latestApproved !== null && latestApproved.id === approvedKey.id, 'getLatestApprovedKey returns approved key for institution.');

  // -----------------------------------------------------------------------
  // REQUIREMENT 1 VERIFICATION: Persistent Caching & Short-Circuiting
  // -----------------------------------------------------------------------
  console.log('\n--- REQUIREMENT 1: Persistent Evaluation Caching & API Short-Circuiting ---');

  geminiApiCallCount = 0;

  // First evaluation: Student script evaluated against approved key
  const job1: EvaluationJob = {
    id: 'job_eval_test_01',
    correlationId: 'corr_test_01',
    status: 'queued',
    progressPercent: 0,
    currentStepMessage: 'Queued',
    mode: 'without-manual',
    studentName: 'Aarav Patel',
    testTitle: 'Cardiovascular Physiology Exam',
    institutionId: instUser.institutionId,
    createdBy: instUser.userId,
    creatorRole: instUser.role,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    answerKeyId: approvedKey.id,
    answerKeyVersion: approvedKey.version,
    canonicalAnswerKey: approvedKey,
    metrics: { correlationId: 'corr_test_01', startTime: Date.now(), cacheHit: false, retriesCount: 0 },
    inputPayload: {
      sourceDoc: sampleStudentDoc,
      questionPaper: sampleQpDoc,
      canonicalAnswerKey: approvedKey,
    },
  };

  const report1 = await evaluationEngine.evaluate(job1);
  assert(report1.totalScore === 20, 'First evaluation completed successfully with score 20.');
  assert(job1.metrics.cacheHit === false, 'First evaluation was a cache miss (new script).');
  const initialApiCalls = geminiApiCallCount;
  assert(initialApiCalls > 0, `First evaluation invoked Gemini API (calls: ${initialApiCalls}).`);

  // Subsequent visit: Re-evaluating unchanged student script with NO re-uploaded question paper (relying on mapped key)
  const job2: EvaluationJob = {
    id: 'job_eval_test_02',
    correlationId: 'corr_test_02',
    status: 'queued',
    progressPercent: 0,
    currentStepMessage: 'Queued',
    mode: 'without-manual',
    studentName: 'Aarav Patel',
    testTitle: 'Cardiovascular Physiology Exam',
    institutionId: instUser.institutionId,
    createdBy: instUser.userId,
    creatorRole: instUser.role,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    answerKeyId: approvedKey.id,
    answerKeyVersion: approvedKey.version,
    canonicalAnswerKey: approvedKey,
    metrics: { correlationId: 'corr_test_02', startTime: Date.now(), cacheHit: false, retriesCount: 0 },
    inputPayload: {
      sourceDoc: sampleStudentDoc,
      // Note: questionPaper is omitted here to simulate direct student script upload on subsequent visit!
      canonicalAnswerKey: approvedKey,
    },
  };

  const report2 = await evaluationEngine.evaluate(job2);
  assert(report2.totalScore === 20, 'Second evaluation returned identical verified score 20.');
  assert(job2.metrics.cacheHit === true, 'Second evaluation was a CACHE HIT.');
  assert(geminiApiCallCount === initialApiCalls, `Zero Gemini API calls made on cache hit (API calls remained ${initialApiCalls}).`);

  // -----------------------------------------------------------------------
  // REQUIREMENT 3 VERIFICATION: Cache Key Composition & Invalidation
  // -----------------------------------------------------------------------
  console.log('\n--- REQUIREMENT 3: Cache Key Composition & Safe Invalidation ---');

  const baseFp = evaluationCache.generateFingerprint({
    sourceDoc: sampleStudentDoc,
    questionPaper: sampleQpDoc,
    canonicalAnswerKey: approvedKey,
    mode: 'without-manual',
    model: 'gemini-3.8-flash',
    institutionId: instUser.institutionId,
    studentName: 'Aarav Patel',
  } as any);

  // Invalidation Test 3.1: Student Script change
  const modifiedStudentDoc = {
    ...sampleStudentDoc,
    text: sampleStudentDoc.text + ' [Added extra answer line]',
  };
  const fpStudentModified = evaluationCache.generateFingerprint({
    sourceDoc: modifiedStudentDoc,
    questionPaper: sampleQpDoc,
    canonicalAnswerKey: approvedKey,
    mode: 'without-manual',
    model: 'gemini-3.8-flash',
    institutionId: instUser.institutionId,
    studentName: 'Aarav Patel',
  } as any);
  assert(baseFp !== fpStudentModified, 'Mutating student script text invalidates cache key.');

  // Invalidation Test 3.2: Question Paper change
  const modifiedQpDoc = {
    ...sampleQpDoc,
    text: sampleQpDoc.text + ' [Modified exam question prompt]',
  };
  const fpQpModified = evaluationCache.generateFingerprint({
    sourceDoc: sampleStudentDoc,
    questionPaper: modifiedQpDoc,
    canonicalAnswerKey: approvedKey,
    mode: 'without-manual',
    model: 'gemini-3.8-flash',
    institutionId: instUser.institutionId,
    studentName: 'Aarav Patel',
  } as any);
  assert(baseFp !== fpQpModified, 'Mutating question paper invalidates cache key.');

  // Invalidation Test 3.3: Answer Key Version / Rubric change
  const updatedKey = answerKeyService.updateAnswerKey(
    approvedKey.id,
    {
      questions: approvedKey.questions.map((q) =>
        q.questionId === '1'
          ? { ...q, markingCriteria: ['Award 10 marks only for complete clinical explanation'] }
          : q
      ),
    },
    instUser
  );
  assert(updatedKey.version === 2, 'Editing approved answer key bumped version to 2.');
  assert(updatedKey.status === 'draft', 'Editing approved answer key reset status to draft.');

  const fpAkUpdated = evaluationCache.generateFingerprint({
    sourceDoc: sampleStudentDoc,
    questionPaper: sampleQpDoc,
    canonicalAnswerKey: updatedKey,
    mode: 'without-manual',
    model: 'gemini-3.8-flash',
    institutionId: instUser.institutionId,
    studentName: 'Aarav Patel',
  } as any);
  assert(baseFp !== fpAkUpdated, 'Updating answer key version/rubric invalidates cache key.');

  // Invalidation Test 3.4: Evaluation Mode change
  const fpModeChanged = evaluationCache.generateFingerprint({
    sourceDoc: sampleStudentDoc,
    questionPaper: sampleQpDoc,
    canonicalAnswerKey: approvedKey,
    mode: 'with-manual',
    facultyNotes: { name: 'notes.txt', text: 'Faculty strictness note' },
    model: 'gemini-3.8-flash',
    institutionId: instUser.institutionId,
    studentName: 'Aarav Patel',
  } as any);
  assert(baseFp !== fpModeChanged, 'Switching evaluation mode invalidates cache key.');

  // -----------------------------------------------------------------------
  // REQUIREMENT 4 VERIFICATION: Persistence Across Restarts & Isolation
  // -----------------------------------------------------------------------
  console.log('\n--- REQUIREMENT 4: Persistence Across Restarts & Tenant/User Isolation ---');

  // Verify disk persistence by checking that the cache file exists on disk
  const diskCacheFilePath = path.join(process.cwd(), '.data', 'evaluations', 'cache', `${baseFp}.json`);
  assert(fs.existsSync(diskCacheFilePath), 'Evaluation cache file was written to disk.');

  // Simulate server restart: clear memory cache completely
  evaluationCache.clear();

  // Retrieve from disk after simulated restart
  const loadedAfterRestart = evaluationCache.get(baseFp, instUser);
  assert(loadedAfterRestart !== null, 'Evaluation report successfully loaded from disk after memory clear (server restart).');
  assert(loadedAfterRestart?.report.studentName === 'Aarav Patel', 'Report content perfectly preserved across server restarts.');

  // Test Cross-Institution Isolation
  const otherInstUser: UserContext = {
    userId: 'prof_sharma',
    role: 'instructor',
    institutionId: 'inst_different_university_99',
    name: 'Prof. Sharma',
  };
  const crossInstAttempt = evaluationCache.get(baseFp, otherInstUser);
  assert(crossInstAttempt === null, 'Tenant Isolation: User from another institution CANNOT access cached evaluation (returns null).');

  // Test Cross-User Isolation for Evaluator role
  const evaluatorUser1: UserContext = {
    userId: 'eval_ta_01',
    role: 'evaluator',
    institutionId: instUser.institutionId,
    name: 'Teaching Assistant 1',
  };
  const evaluatorUser2: UserContext = {
    userId: 'eval_ta_02',
    role: 'evaluator',
    institutionId: instUser.institutionId,
    name: 'Teaching Assistant 2',
  };

  // Cache an entry belonging to evaluator 1
  const evaluatorFp = 'test_evaluator_isolation_fp_' + Date.now();
  evaluationCache.set({
    cacheKey: evaluatorFp,
    report: report1,
    timestamp: Date.now(),
    modelUsed: 'gemini-3.8-flash',
    inputTokens: 1000,
    outputTokens: 400,
    estimatedCostSaved: 0.0001,
    institutionId: instUser.institutionId,
    createdBy: evaluatorUser1.userId,
  });

  const eval1Access = evaluationCache.get(evaluatorFp, evaluatorUser1);
  assert(eval1Access !== null, 'Evaluator 1 can access their own cached evaluation.');

  const eval2Access = evaluationCache.get(evaluatorFp, evaluatorUser2);
  assert(eval2Access === null, 'User Isolation: Evaluator 2 CANNOT access Evaluator 1 cached evaluation.');

  // Clean up test cache entry
  try {
    const testFile = path.join(process.cwd(), '.data', 'evaluations', 'cache', `${evaluatorFp}.json`);
    if (fs.existsSync(testFile)) fs.unlinkSync(testFile);
  } catch { }

  // Clean up created answer key
  answerKeyService.deleteAnswerKey(approvedKey.id, instUser);

  setMockGeminiProvider(null);

  console.log('\n========================================================================');
  console.log(` ALL VERIFICATION TESTS PASSED: ${passed}/${total}`);
  console.log('========================================================================\n');
}

runVerification().catch((err) => {
  console.error('Verification failed:', err);
  process.exit(1);
});
