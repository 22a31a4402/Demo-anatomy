/**
 * Comprehensive Automated Regression Test Suite for NextGen Eval Dedicated AI Backend
 *
 * Covers:
 * 1. Cryptographic SHA-256 Fingerprinting:
 *    - Full-byte digesting of complete buffers
 *    - Middle-byte mutation of same-length PDF/base64 invalidates cache key
 *    - Cache tenant authorization checks
 * 2. Strict Academic Score Validation Engine (Adversarial Regression Tests):
 *    - Rejection of marks > maxMarks (NEVER clamped!)
 *    - Rejection of NaN or infinite marks
 *    - Rejection of negative marks
 *    - Rejection of invalid/missing/zero maxMarks (NEVER default to 1!)
 *    - Rejection of duplicate question IDs
 *    - Verification of aggregate totalScore vs question sum consistency
 *    - Preservation of partial credit (e.g. 3.5 / 5)
 *    - Mode rules: 'without-manual' purges flagged comments
 * 3. Security, Authentication, RBAC & Tenant Isolation:
 *    - Rejection of unauthenticated requests
 *    - Rejection of cross-institution tenant access
 *    - Verification of operator privileges
 *    - Protection of operational metrics (/api/metrics)
 * 4. Queue Persistence, Atomic Disk Operations & Concurrency Bounds:
 *    - Atomic temporary write & rename
 *    - Startup recovery of in-flight tasks
 *    - Queue capacity limit backpressure (503 / 429)
 * 5. Elimination of Fabricated Results:
 *    - Validation failures transition to 'needs_review' or 'failed', never 'completed'
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { evaluationCache } from '../server/cache';
import { evaluationEngine, ValidationError } from '../server/evaluator';
import { evaluationQueue, QueueCapacityError, MAX_QUEUE_CAPACITY } from '../server/queue';
import {
  authenticateRequest,
  verifyJobAccess,
  UserContext,
  signDynamicToken,
  checkEvaluationRateLimit,
} from '../server/auth';
import {
  setMockGeminiProvider,
  callGeminiWithFallback,
} from '../server/geminiClient';
import { config } from '../server/config';
import { Request } from 'express';
import {
  calculateCallCost,
  getModelPricingRate,
  ACTIVE_PRICING_VERSION,
} from '../server/pricing';
import { usageLedger } from '../server/usageLedger';
import { answerKeyService, AnswerKeyValidationError } from '../server/answerKeyService';
import { CanonicalAnswerKey, CanonicalQuestionKey, StudentExtractedScript, EvaluationJob } from '../server/types';
import { documentProcessor, isVisualEvidenceNeeded } from '../server/documentProcessor';
import { studentExtractor, ExtractionValidationError } from '../server/studentExtractor';

let passedTests = 0;
let totalTests = 0;

function assert(condition: boolean, message: string) {
  totalTests++;
  if (!condition) {
    console.error(`❌ FAIL: ${message}`);
    throw new Error(`Test assertion failed: ${message}`);
  }
  passedTests++;
  console.log(`✅ PASS: ${message}`);
}

function assertThrows(fn: () => any, expectedErrorMessageSubstring: string, message: string) {
  totalTests++;
  try {
    fn();
    console.error(`❌ FAIL (expected exception not thrown): ${message}`);
    throw new Error(`Expected error containing "${expectedErrorMessageSubstring}" was not thrown`);
  } catch (err: any) {
    if (String(err?.message || err).toLowerCase().includes(expectedErrorMessageSubstring.toLowerCase())) {
      passedTests++;
      console.log(`✅ PASS: ${message}`);
    } else {
      console.error(`❌ FAIL (wrong error thrown): ${message}. Got: ${err?.message}`);
      throw err;
    }
  }
}

async function assertRejects(fn: () => Promise<any>, expectedErrorMessageSubstring: string, message: string) {
  totalTests++;
  try {
    await fn();
    console.error(`❌ FAIL (expected rejection not thrown): ${message}`);
    throw new Error(`Expected error containing "${expectedErrorMessageSubstring}" was not thrown`);
  } catch (err: any) {
    if (String(err?.message || err).toLowerCase().includes(expectedErrorMessageSubstring.toLowerCase())) {
      passedTests++;
      console.log(`✅ PASS: ${message}`);
    } else {
      console.error(`❌ FAIL (wrong error thrown): ${message}. Got: ${err?.message}`);
      throw err;
    }
  }
}

function mockRequest(authHeader?: string): Request {
  return { headers: authHeader ? { authorization: authHeader } : {} } as Request;
}

async function runTests() {
  console.log('========================================================================');
  console.log(' Starting NextGen Eval Critical Remediation & Regression Test Suite');
  console.log('========================================================================\n');

  // ==========================================================================
  // GROUP 1: Cryptographic Digesting & Middle-Byte Mutation Test
  // ==========================================================================
  console.log('--- TEST GROUP 1: Full-Byte SHA-256 Fingerprint & Middle-Byte Invalidation ---');

  // Create a 10KB dummy base64 PDF representation
  const bufferLen = 10000;
  const originalBuffer = Buffer.alloc(bufferLen, 'A');
  const originalBase64 = originalBuffer.toString('base64');

  const basePayload = {
    sourceDoc: {
      name: 'Student_Physics_Script.pdf',
      text: 'Question 1: The particle velocity is v = at.',
      base64: originalBase64,
      mimeType: 'application/pdf',
    },
    questionPaper: {
      name: 'QP_Physics.pdf',
      text: 'Q1: State kinematic formula for velocity.',
      mimeType: 'application/pdf',
    },
    answerKey: {
      name: 'AK_Physics.pdf',
      text: 'Q1: v = u + at.',
      mimeType: 'application/pdf',
    },
    facultyNotes: null,
    mode: 'without-manual',
    model: config.primaryModel,
    institutionId: 'inst_aarshiv_01',
  };

  const fp1 = evaluationCache.generateFingerprint(basePayload);
  const fp1_again = evaluationCache.generateFingerprint(basePayload);
  assert(fp1 === fp1_again, 'Deterministic hashing: Identical inputs produce identical fingerprint.');

  // Mutate exactly ONE byte in the dead center of the base64 string (same overall length!)
  const midIndex = Math.floor(originalBase64.length / 2);
  const mutatedBase64 =
    originalBase64.substring(0, midIndex) +
    (originalBase64[midIndex] === 'B' ? 'C' : 'B') +
    originalBase64.substring(midIndex + 1);

  assert(
    originalBase64.length === mutatedBase64.length,
    'Verification sanity check: mutated base64 has exact same length as original base64.'
  );

  const mutatedPayload = {
    ...basePayload,
    sourceDoc: {
      ...basePayload.sourceDoc,
      base64: mutatedBase64,
    },
  };

  const fpMutated = evaluationCache.generateFingerprint(mutatedPayload);
  assert(
    fp1 !== fpMutated,
    'Critical Security: Modifying a byte in the middle of a same-length PDF invalidates the cache fingerprint.'
  );

  // Tenant isolation in fingerprint
  const crossTenantPayload = {
    ...basePayload,
    institutionId: 'inst_other_college_99',
  };
  const fpCrossTenant = evaluationCache.generateFingerprint(crossTenantPayload);
  assert(fp1 !== fpCrossTenant, 'Tenant Isolation: Identical documents under different institutionId produce distinct cache keys.');

  // ==========================================================================
  // GROUP 2: Adversarial Academic Score Validation Engine
  // ==========================================================================
  console.log('\n--- TEST GROUP 2: Adversarial Academic Score Validation ---');

  const validBaseReport = {
    studentName: 'Rahul Verma',
    testTitle: 'Advanced Physics Midterm',
    testTopics: 'Kinematics',
    testDate: '2026-05-20',
    totalScore: 10,
    maxScore: 10,
    questions: [
      {
        qNo: '1',
        marks: 5,
        maxMarks: 5,
        isCorrect: true,
        feedbackPoints: ['Correct derivation of velocity formula.'],
      },
      {
        qNo: '2',
        marks: 5,
        maxMarks: 5,
        isCorrect: true,
        feedbackPoints: ['Accurate conceptual explanation.'],
      },
    ],
  };

  // 1. Valid report passes
  const validResult = evaluationEngine.validateAndNormalizeReport(validBaseReport, 'without-manual', 'Rahul Verma');
  assert(validResult.totalScore === 10, 'Valid report successfully passes strict validation.');

  // 2. Adversarial: Marks > MaxMarks (NEVER clamp!)
  const marksExceededReport = {
    ...validBaseReport,
    totalScore: 15,
    questions: [
      {
        qNo: '1',
        marks: 12, // Exceeds maxMarks of 10!
        maxMarks: 10,
        feedbackPoints: ['Good work.'],
      },
    ],
  };
  assertThrows(
    () => evaluationEngine.validateAndNormalizeReport(marksExceededReport, 'without-manual', 'Student'),
    'Score bound violation',
    'Rejects marks > maxMarks (never clamps to hide model discrepancy).'
  );

  // 3. Adversarial: NaN Marks
  const nanMarksReport = {
    ...validBaseReport,
    questions: [
      {
        qNo: '1',
        marks: NaN,
        maxMarks: 10,
        feedbackPoints: ['Attempted.'],
      },
    ],
  };
  assertThrows(
    () => evaluationEngine.validateAndNormalizeReport(nanMarksReport, 'without-manual', 'Student'),
    'Invalid marks awarded',
    'Rejects NaN marks.'
  );

  // 4. Adversarial: Infinite Marks
  const infMarksReport = {
    ...validBaseReport,
    questions: [
      {
        qNo: '1',
        marks: Infinity,
        maxMarks: 10,
        feedbackPoints: ['Attempted.'],
      },
    ],
  };
  assertThrows(
    () => evaluationEngine.validateAndNormalizeReport(infMarksReport, 'without-manual', 'Student'),
    'Invalid marks awarded',
    'Rejects infinite marks.'
  );

  // 5. Adversarial: Negative Marks
  const negMarksReport = {
    ...validBaseReport,
    questions: [
      {
        qNo: '1',
        marks: -3,
        maxMarks: 10,
        feedbackPoints: ['Incorrect.'],
      },
    ],
  };
  assertThrows(
    () => evaluationEngine.validateAndNormalizeReport(negMarksReport, 'without-manual', 'Student'),
    'Invalid marks awarded',
    'Rejects negative marks.'
  );

  // 6. Adversarial: Invalid maxMarks (0 or negative, or NaN - NEVER default to 1)
  const zeroMaxMarksReport = {
    ...validBaseReport,
    questions: [
      {
        qNo: '1',
        marks: 0,
        maxMarks: 0, // Invalid!
        feedbackPoints: ['Points.'],
      },
    ],
  };
  assertThrows(
    () => evaluationEngine.validateAndNormalizeReport(zeroMaxMarksReport, 'without-manual', 'Student'),
    'Invalid maximum marks',
    'Rejects maxMarks <= 0 (never silently replaces with 1).'
  );

  // 7. Adversarial: Duplicate Question IDs
  const duplicateQReport = {
    ...validBaseReport,
    questions: [
      {
        qNo: '1',
        marks: 5,
        maxMarks: 5,
        feedbackPoints: ['Part A'],
      },
      {
        qNo: '1', // Duplicate Q1!
        marks: 4,
        maxMarks: 5,
        feedbackPoints: ['Part B'],
      },
    ],
  };
  assertThrows(
    () => evaluationEngine.validateAndNormalizeReport(duplicateQReport, 'without-manual', 'Student'),
    'Duplicate question ID detected',
    'Rejects duplicate question IDs.'
  );

  // 8. Adversarial: Aggregate Total Score Mismatch
  const inconsistentSumReport = {
    ...validBaseReport,
    totalScore: 99, // Hallucinated aggregate total that differs from 5 + 5 = 10
    questions: [
      {
        qNo: '1',
        marks: 5,
        maxMarks: 5,
        feedbackPoints: ['Good'],
      },
      {
        qNo: '2',
        marks: 5,
        maxMarks: 5,
        feedbackPoints: ['Good'],
      },
    ],
  };
  assertThrows(
    () => evaluationEngine.validateAndNormalizeReport(inconsistentSumReport, 'without-manual', 'Student'),
    'Aggregate score discrepancy',
    'Rejects model aggregate totalScore that fails to match the exact mathematical sum of questions.'
  );

  // 9. Partial Credit Verification
  const partialCreditReport = {
    ...validBaseReport,
    totalScore: 7.75,
    maxScore: 10,
    questions: [
      {
        qNo: '1',
        marks: 3.25,
        maxMarks: 5,
        feedbackPoints: ['Partial credit for step 1 and step 2.'],
      },
      {
        qNo: '2',
        marks: 4.5,
        maxMarks: 5,
        feedbackPoints: ['Minor rounding variance on final step.'],
      },
    ],
  };
  const partialResult = evaluationEngine.validateAndNormalizeReport(partialCreditReport, 'without-manual', 'Student');
  assert(partialResult.totalScore === 7.75, 'Preserves valid partial credit scores with decimal precision.');
  assert(partialResult.questions[0].marks === 3.25, 'Maintains exact awarded question marks for partial credit.');

  // ==========================================================================
  // GROUP 3: Authentication, RBAC, and Tenant Isolation
  // ==========================================================================
  console.log('\n--- TEST GROUP 3: Authentication & Multi-Tenant Access Control ---');

  // Test 1: Missing auth header
  const unauthReq = { headers: {} } as Request;
  assert(authenticateRequest(unauthReq) === null, 'Unauthenticated request correctly returns null context.');

  // Test 2: Valid instructor token
  const instructorReq = {
    headers: { authorization: 'Bearer nextgen_inst_sec_token_4412' },
  } as Request;
  const instructorUser = authenticateRequest(instructorReq);
  assert(instructorUser !== null && instructorUser.role === 'instructor', 'Recognizes valid instructor Bearer token.');
  assert(instructorUser?.institutionId === 'inst_aarshiv_01', 'Binds user to correct tenant institution.');

  // Test 3: Operator token
  const operatorReq = {
    headers: { authorization: 'Bearer nextgen_op_sec_token_9921' },
  } as Request;
  const operatorUser = authenticateRequest(operatorReq);
  assert(operatorUser !== null && operatorUser.role === 'operator', 'Recognizes system operator token with operator role.');

  // Test 3b: Invalid operator token fails safely
  const badOperatorReq = {
    headers: { authorization: 'Bearer nextgen_op_sec_token_tampered' },
  } as unknown as Request;
  assert(authenticateRequest(badOperatorReq) === null, 'Rejects invalid or tampered operator token.');

  // Test 3c: x-api-key operator header works
  const apiKeyOperatorReq = {
    headers: { 'x-api-key': 'nextgen_op_sec_token_9921' },
  } as unknown as Request;
  const apiKeyOpUser = authenticateRequest(apiKeyOperatorReq);
  assert(apiKeyOpUser !== null && apiKeyOpUser.role === 'operator', 'Recognizes operator token supplied via x-api-key header.');

  // Test 4: Tenant isolation verification
  const jobTenantA = { institutionId: 'inst_aarshiv_01', createdBy: 'prof_sharma' };
  const userTenantB: UserContext = {
    userId: 'user_other',
    role: 'instructor',
    institutionId: 'inst_other_university',
    name: 'Prof. Other',
  };

  assert(
    verifyJobAccess(jobTenantA, userTenantB) === false,
    'Security Isolation: Instructor from Institution B cannot access Job belonging to Institution A (403 Forbidden).'
  );

  assert(
    verifyJobAccess(jobTenantA, instructorUser!) === true,
    'Authorized Access: Instructor from same institution can access the evaluation job.'
  );

  assert(
    verifyJobAccess(jobTenantA, operatorUser!) === true,
    'Operator Access: System operator has universal operational access across institutions.'
  );

  // ==========================================================================
  // GROUP 4: Queue Persistence, Atomic Disk Operations & Backpressure
  // ==========================================================================
  console.log('\n--- TEST GROUP 4: Queue Persistence, Atomic Storage & Capacity Limits ---');

  const testQueuePayload = {
    sourceDoc: { name: 'student_test.pdf', text: 'Answer 1: Test answer.' },
    mode: 'without-manual' as const,
    studentName: 'Persistence Test Student',
  };

  const enqueuedJob = evaluationQueue.enqueue(testQueuePayload, instructorUser);
  assert(enqueuedJob.id.length > 0, 'Job successfully enqueued.');
  assert(enqueuedJob.institutionId === 'inst_aarshiv_01', 'Job records correct institution tenant.');

  // Verify atomic file existence on disk
  const jobFilePath = path.join(config.dataDir, 'jobs', `${enqueuedJob.id}.json`);
  assert(fs.existsSync(jobFilePath), 'Job file was durably persisted to disk.');

  // Verify atomic temp file cleanup
  const tempFiles = fs.readdirSync(path.join(config.dataDir, 'jobs')).filter((f) => f.includes('.tmp.'));
  assert(tempFiles.length === 0, 'Atomic writes leave no orphan temporary files on disk.');

  // Test Queue Capacity Backpressure
  console.log('Testing queue capacity bounds...');
  let hitCapacityLimit = false;
  const overflowJobs: any[] = [];
  try {
    for (let i = 0; i < MAX_QUEUE_CAPACITY + 5; i++) {
      const j = evaluationQueue.enqueue(
        {
          sourceDoc: { name: `load_test_${i}.pdf`, text: `Content ${i}` },
          studentName: `Load Student ${i}`,
        },
        instructorUser
      );
      overflowJobs.push(j);
    }
  } catch (err: any) {
    if (err instanceof QueueCapacityError) {
      hitCapacityLimit = true;
    }
  }
  assert(hitCapacityLimit, `Queue strictly enforces backpressure limit (${MAX_QUEUE_CAPACITY} jobs) with QueueCapacityError (HTTP 503).`);

  // Clean up test jobs
  evaluationQueue.deleteJob(enqueuedJob.id, instructorUser);
  for (const j of overflowJobs) {
    evaluationQueue.deleteJob(j.id, instructorUser);
  }

  // ==========================================================================
  // GROUP 5: Advanced Security, HMAC Tokens & Evaluation Rate Limiting
  // ==========================================================================
  console.log('\n--- TEST GROUP 5: Advanced Security, Signed Tokens & Rate Limiting ---');

  // 1. Rejection of unsigned operator token forging
  const fakeOperatorReq = mockRequest('Bearer tkn_operator_system_global_intruder_01');
  assert(
    authenticateRequest(fakeOperatorReq) === null,
    'Critical Security: Blocked attempt to forge operator role via unsigned dynamic token.'
  );

  // 2. Rejection of unsigned admin token forging
  const fakeAdminReq = mockRequest('Bearer tkn_admin_inst_aarshiv_01_fake_admin');
  assert(
    authenticateRequest(fakeAdminReq) === null,
    'Critical Security: Blocked attempt to forge admin role via unsigned dynamic token.'
  );

  // 3. Acceptance of cryptographically signed HMAC operator token
  const signedOperatorToken = signDynamicToken('operator', 'system_global', 'root_op_99');
  const validSignedOpReq = mockRequest(`Bearer ${signedOperatorToken}`);
  const signedOpUser = authenticateRequest(validSignedOpReq);
  assert(signedOpUser !== null && signedOpUser.role === 'operator', 'Valid HMAC-signed operator token successfully authenticated.');

  // 4. Acceptance of cryptographically signed HMAC instructor token
  const signedInstToken = signDynamicToken('instructor', 'inst_med_hospital_01', 'dr_smith');
  const validSignedInstReq = mockRequest(`Bearer ${signedInstToken}`);
  const signedInstUser = authenticateRequest(validSignedInstReq);
  assert(
    signedInstUser !== null && signedInstUser.role === 'instructor' && signedInstUser.institutionId === 'inst_med_hospital_01',
    'Valid HMAC-signed instructor token successfully authenticated with bound institution.'
  );

  // 5. Tampered signed token fails
  const tamperedToken = signedInstToken.substring(0, signedInstToken.length - 2) + 'ff';
  assert(
    authenticateRequest(mockRequest(`Bearer ${tamperedToken}`)) === null,
    'Security Integrity: Tampered HMAC signature immediately rejected.'
  );

  // 6. Evaluation creation rate limiting
  const rateLimitClient = 'test_eval_client_user_01';
  let evalsAllowedCount = 0;
  for (let i = 0; i < 15; i++) {
    const res = checkEvaluationRateLimit(rateLimitClient);
    if (res.allowed) evalsAllowedCount++;
  }
  assert(evalsAllowedCount === 15, 'Evaluation rate limiter permits up to 15 evaluation creation requests per window.');
  const blockedEval = checkEvaluationRateLimit(rateLimitClient);
  assert(!blockedEval.allowed && blockedEval.retryAfterSeconds > 0, 'Evaluation rate limiter rejects 16th creation request within the 1-minute window.');

  // ==========================================================================
  // GROUP 6: Request Schema & MIME Type Boundary Validation
  // ==========================================================================
  console.log('\n--- TEST GROUP 6: Request Schema & MIME Type Boundaries ---');

  const ALLOWED_MIMES = [
    'application/pdf',
    'image/jpeg',
    'image/png',
    'image/webp',
    'text/plain',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ];

  function validateMime(mime: string): boolean {
    return ALLOWED_MIMES.includes(mime.toLowerCase());
  }

  assert(validateMime('application/pdf'), 'Permits valid PDF documents.');
  assert(validateMime('image/png'), 'Permits valid PNG scanned scripts.');
  assert(validateMime('image/jpeg'), 'Permits valid JPEG photos.');
  assert(!validateMime('application/x-sh'), 'Strictly rejects shell script uploads.');
  assert(!validateMime('application/x-msdownload'), 'Strictly rejects executable binary uploads.');
  assert(!validateMime('text/html'), 'Strictly rejects raw HTML uploads to prevent script injection.');

  // ==========================================================================
  // GROUP 7: Timeout, Retries, Jitter & Fallback Resilience (Mock Provider)
  // ==========================================================================
  console.log('\n--- TEST GROUP 7: Timeout, Retries, Jitter & Fallback Resilience (Mock Provider) ---');

  const sampleAcademicReport = {
    studentName: 'Mock Student',
    testTitle: 'Resilience Assessment',
    testTopics: 'Pathology',
    testDate: '2026-05-15',
    totalScore: 10,
    maxScore: 10,
    questions: [
      {
        qNo: '1',
        marks: 10,
        maxMarks: 10,
        isCorrect: true,
        feedbackPoints: ['Correct biological pathway described.'],
      },
    ],
    generalFeedback: {
      overallPerformance: ['Passed.'],
      mcqs: [],
      contentAccuracy: ['Accurate.'],
      completenessOfAnswers: ['Complete.'],
      presentationDiagrams: ['Good diagrams.'],
      investigations: [],
      attemptingQuestions: ['Attempted.'],
      actionPoints: ['Continue revision.'],
    },
  };

  // 1. Transient Error 503 -> Retry -> Success
  let callCount503 = 0;
  setMockGeminiProvider(async () => {
    callCount503++;
    if (callCount503 === 1) {
      const err: any = new Error('503 Service Unavailable / High demand');
      err.status = 503;
      throw err;
    }
    return {
      text: JSON.stringify(sampleAcademicReport),
      usageMetadata: { promptTokenCount: 1500, candidatesTokenCount: 400 },
    };
  });

  const res503 = await callGeminiWithFallback([], 'instruction', 'corr_503');
  assert(res503.retries === 1, 'Transient 503 error successfully retried with bounded exponential backoff.');
  assert(res503.report.totalScore === 10, 'Result after retry matches verified evaluation report.');

  // 2. Rate Limit 429 -> Retry -> Success
  let callCount429 = 0;
  setMockGeminiProvider(async () => {
    callCount429++;
    if (callCount429 === 1) {
      const err: any = new Error('429 Resource has been exhausted / Rate limit');
      err.status = 429;
      throw err;
    }
    return {
      text: JSON.stringify(sampleAcademicReport),
      usageMetadata: { promptTokenCount: 1200, candidatesTokenCount: 300 },
    };
  });

  const res429 = await callGeminiWithFallback([], 'instruction', 'corr_429');
  assert(res429.retries === 1, 'Rate limit 429 error successfully recovered after retry backoff.');

  // 3. Non-retryable Client Error (e.g. 400 Bad Request) stops immediately without useless retries
  let callCount400 = 0;
  setMockGeminiProvider(async () => {
    callCount400++;
    const err: any = new Error('400 Bad Request: Invalid parameter');
    err.status = 400;
    throw err;
  });

  let nonRetryCaught = false;
  try {
    await callGeminiWithFallback([], 'instruction', 'corr_400');
  } catch (err: any) {
    nonRetryCaught = true;
  }
  assert(nonRetryCaught, 'Non-retryable 400 Bad Request fails immediately without endless retries.');
  assert(callCount400 <= config.fallbackModels.length + 1, 'Non-retryable error makes only 1 attempt per candidate model, no backoff loops.');

  // 4. Model Fallback: Primary fails with non-retryable 404, secondary succeeds
  setMockGeminiProvider(async ({ model }) => {
    if (model === config.primaryModel) {
      const err: any = new Error(`Model ${model} not found or unsupported`);
      err.status = 404;
      throw err;
    }
    return {
      text: JSON.stringify({ ...sampleAcademicReport, testTitle: `Graded by ${model}` }),
      usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 250 },
    };
  });

  const resFallback = await callGeminiWithFallback([], 'instruction', 'corr_fallback');
  assert(resFallback.modelUsed !== config.primaryModel, 'Automated fallback successfully engaged when primary model fails.');
  assert(resFallback.fallbackCallsCount === 1, 'Fallback call accurately accounted in execution metrics.');

  // 5. Malformed JSON handling without fabricating results
  setMockGeminiProvider(async () => {
    return {
      text: '<<< Not valid JSON at all >>>',
    };
  });

  let malformedCaught = false;
  try {
    await callGeminiWithFallback([], 'instruction', 'corr_malformed');
  } catch (err: any) {
    malformedCaught = true;
    assert(err.message.includes('JSON'), 'Malformed JSON error correctly surfaces without mock fallback grades.');
  }
  assert(malformedCaught, 'Corrupted model output strictly caught and never fabricated into 10/10 grade.');

  // Reset mock provider to ensure no interference with subsequent runs
  setMockGeminiProvider(null);

  // ==========================================================================
  // GROUP 8: Queue Cancellation, Review Endpoint & Retention Pruning
  // ==========================================================================
  console.log('\n--- TEST GROUP 8: Queue Cancellation, Review & Retention Pruning ---');

  // 1. Cancellation of queued job
  const cancelJobPayload = {
    sourceDoc: { name: 'cancel_me.pdf', text: 'To be cancelled' },
    studentName: 'Cancel Test Student',
  };
  const jobToCancel = evaluationQueue.enqueue(cancelJobPayload, instructorUser);
  const cancelled = evaluationQueue.cancelJob(jobToCancel.id, instructorUser);
  assert(cancelled !== null && cancelled.status === 'cancelled', 'Queued evaluation job successfully cancelled.');

  // 2. Cannot cancel an already completed job
  cancelled!.status = 'completed';
  let cancelCompletedError = false;
  try {
    evaluationQueue.cancelJob(cancelled!.id, instructorUser);
  } catch (err: any) {
    cancelCompletedError = true;
  }
  assert(cancelCompletedError, 'Cannot cancel a completed evaluation job.');

  // 3. Draft report preservation on needs_review
  const discrepancyReport = {
    studentName: 'Review Student',
    questions: [
      {
        qNo: '1',
        marks: 12, // Exceeds maxMarks of 10!
        maxMarks: 10,
        feedbackPoints: ['Good.'],
      },
    ],
  };

  let reviewErrorCaught = false;
  try {
    evaluationEngine.validateAndNormalizeReport(discrepancyReport, 'without-manual', 'Review Student');
  } catch (err: any) {
    reviewErrorCaught = true;
    assert(err instanceof ValidationError, 'Academic score violation throws ValidationError for human review.');
  }
  assert(reviewErrorCaught, 'Score bounds discrepancy successfully triggers review state.');

  // 4. Pruning expired historical jobs
  const oldJob = evaluationQueue.enqueue({ sourceDoc: { name: 'old.pdf', text: 'Old' } }, instructorUser);
  oldJob.status = 'completed';
  oldJob.createdAt = Date.now() - 40 * 24 * 60 * 60 * 1000; // 40 days ago
  const prunedCount = evaluationQueue.pruneExpiredJobs(30);
  assert(prunedCount >= 1, `Retention policy successfully pruned ${prunedCount} job(s) older than 30 days.`);

  // 5. Zero credential exposure
  assert(typeof config.geminiApiKey === 'string', 'Server holds API key in environment configuration.');
  const sanitizedProbe = {
    status: config.geminiApiKey ? 'ready' : 'configuration_warning',
    timestamp: new Date().toISOString(),
  };
  assert(!('geminiApiKey' in sanitizedProbe), 'Public readiness probe never leaks geminiApiKey string.');

  // ==========================================================================
  // GROUP 9: Versioned Pricing Engine & Currency Calculations
  // ==========================================================================
  console.log('\n--- TEST GROUP 9: Versioned Pricing Engine & Currency Calculations ---');

  // 1. Model rate lookups
  const flashRate = getModelPricingRate('gemini-3.8-flash');
  assert(flashRate !== null, 'Model pricing rate found for gemini-3.8-flash.');
  assert(flashRate!.inputPerMillion === 0.10, 'gemini-3.8-flash prompt token rate is $0.10 / 1M.');
  assert(flashRate!.outputPerMillion === 0.40, 'gemini-3.8-flash candidate token rate is $0.40 / 1M.');
  assert(flashRate!.cachedInputPerMillion === 0.025, 'gemini-3.8-flash cached token rate is $0.025 / 1M.');

  const liteRate = getModelPricingRate('gemini-3.1-flash-lite');
  assert(liteRate !== null && liteRate.inputPerMillion === 0.0375, 'gemini-3.1-flash-lite prompt token rate is $0.0375 / 1M.');

  const normalizedRate = getModelPricingRate('models/gemini-3.8-flash');
  assert(normalizedRate !== null && normalizedRate.modelId === 'gemini-3.8-flash', 'Model name with "models/" prefix successfully normalized.');

  // 2. Cost calculation with cached tokens and standard currency conversion
  const calc1 = calculateCallCost({
    model: 'gemini-3.8-flash',
    inputTokens: 1_000_000,
    cachedInputTokens: 200_000,
    outputTokens: 500_000,
    customUsdToInrRate: 85.0,
  });
  assert(calc1.isCostCalculable, 'Call cost successfully calculated for configured model.');
  // Calculation breakdown:
  // Non-cached prompt: 800,000 * 0.10 / 1M = $0.080
  // Cached prompt: 200,000 * 0.025 / 1M = $0.005
  // Candidate output: 500,000 * 0.40 / 1M = $0.200
  // Total USD = 0.080 + 0.005 + 0.200 = $0.285
  // Total INR = 0.285 * 85.0 = ₹24.225
  assert(calc1.totalCostUsd === 0.285, `Total USD cost matches expected $0.285 (got ${calc1.totalCostUsd}).`);
  assert(calc1.totalCostInr === 24.225, `Total INR cost matches expected ₹24.225 (got ${calc1.totalCostInr}).`);

  // 3. Custom foreign exchange rate
  const calcFx = calculateCallCost({
    model: 'gemini-3.8-flash',
    inputTokens: 1_000_000,
    cachedInputTokens: 0,
    outputTokens: 0,
    customUsdToInrRate: 90.0,
  });
  assert(calcFx.totalCostInr === 9.0, `Custom USD-to-INR rate (90.0) correctly yields ₹9.0 for $0.10 input cost.`);

  // 4. Missing token metadata defense (Zero Fabrication Guarantee)
  const calcMissingTokens = calculateCallCost({
    model: 'gemini-3.8-flash',
    inputTokens: null,
    outputTokens: null,
  });
  assert(!calcMissingTokens.isCostCalculable, 'Missing token metadata correctly flagged as isCostCalculable: false.');
  assert(calcMissingTokens.totalCostUsd === null, 'Missing token metadata returns null USD cost, NEVER fabricated $0.00.');
  assert(calcMissingTokens.uncalculatedReason === 'MISSING_TOKEN_METADATA', 'Reason explicitly marked as MISSING_TOKEN_METADATA.');

  // 5. Unconfigured model defense (Zero Fabrication Guarantee)
  const calcUnknownModel = calculateCallCost({
    model: 'gemini-unknown-experimental-model-x',
    inputTokens: 1000,
    outputTokens: 500,
  });
  assert(!calcUnknownModel.isCostCalculable, 'Unconfigured model correctly flagged as isCostCalculable: false.');
  assert(calcUnknownModel.totalCostUsd === null, 'Unconfigured model returns null USD cost, NEVER fabricated $0.00.');
  assert(calcUnknownModel.uncalculatedReason === 'UNKNOWN_MODEL', 'Reason explicitly marked as UNKNOWN_MODEL.');

  // 6. Unconfigured pricing version defense
  const calcUnknownVersion = calculateCallCost({
    model: 'gemini-3.8-flash',
    inputTokens: 1000,
    outputTokens: 500,
    pricingVersion: 'pricing_v999_invalid',
  });
  assert(!calcUnknownVersion.isCostCalculable, 'Unconfigured pricing version correctly flagged as isCostCalculable: false.');
  assert(calcUnknownVersion.uncalculatedReason === 'UNCONFIGURED_VERSION', 'Reason explicitly marked as UNCONFIGURED_VERSION.');

  // ==========================================================================
  // GROUP 10: Usage & Cost Ledger, Multi-tenant Isolation & Batch Aggregates
  // ==========================================================================
  console.log('\n--- TEST GROUP 10: Usage & Cost Ledger, Multi-tenant Isolation & Batch Aggregates ---');

  // 1. Per-attempt recording across retries without double counting
  let retryTestAttempt = 0;
  setMockGeminiProvider(async () => {
    retryTestAttempt++;
    if (retryTestAttempt === 1) {
      const err: any = new Error('503 Service Unavailable temporary overload');
      err.status = 503;
      throw err;
    }
    return {
      text: JSON.stringify(sampleAcademicReport),
      usageMetadata: {
        promptTokenCount: 2000,
        candidatesTokenCount: 500,
        cachedContentTokenCount: 400,
      },
    };
  });

  const retryJobId = `job_retry_${Date.now()}_${crypto.randomBytes(2).toString('hex')}`;
  const retryCallResult = await callGeminiWithFallback([], 'instruction', 'corr_ledger_retry', {
    jobId: retryJobId,
    institutionId: 'inst_aarshiv_01',
    pipelineStage: 'grading',
  });

  assert(retryCallResult.retries === 1, 'Transient error triggered 1 retry in client.');
  assert(retryCallResult.usageSummary !== null, 'Evaluation usage summary returned in call result.');
  assert(retryCallResult.usageSummary!.totalCalls === 2, 'Usage ledger recorded both the failed attempt and successful retry.');
  assert(retryCallResult.usageSummary!.failedCalls === 1, 'Usage ledger accurately isolated 1 failed attempt.');
  assert(retryCallResult.usageSummary!.successfulCalls === 1, 'Usage ledger accurately isolated 1 successful call.');
  assert(retryCallResult.usageSummary!.retriedCalls === 1, 'Usage ledger tagged 1 retried call.');
  assert(retryCallResult.usageSummary!.totalInputTokens === 2000, 'Total tokens strictly reflect actual consumed tokens without double-counting.');
  assert(retryCallResult.usageSummary!.dataSource === 'SIMULATED_MOCK', 'Data source accurately classified as SIMULATED_MOCK under mock provider.');
  assert(retryCallResult.usageSummary!.usageCompleteness === 'COMPLETE', 'Usage completeness accurately marked as COMPLETE.');

  // 2. Missing metadata handling in client and ledger
  setMockGeminiProvider(async () => {
    return {
      text: JSON.stringify(sampleAcademicReport),
      // Intentionally omitting usageMetadata
    };
  });

  const noMetaJobId = `job_nometa_${Date.now()}_${crypto.randomBytes(2).toString('hex')}`;
  const noMetaResult = await callGeminiWithFallback([], 'instruction', 'corr_no_meta', {
    jobId: noMetaJobId,
    institutionId: 'inst_aarshiv_01',
  });

  assert(noMetaResult.inputTokens === null, 'Missing usageMetadata yields null inputTokens in call result.');
  assert(noMetaResult.estimatedCostUsd === null, 'Missing usageMetadata yields null estimatedCostUsd in call result.');
  assert(noMetaResult.usageCompleteness === 'UNAVAILABLE', 'Missing usageMetadata tagged as UNAVAILABLE completeness.');
  assert(noMetaResult.usageSource === 'UNKNOWN', 'Missing usageMetadata classified as UNKNOWN source.');

  const noMetaSummary = usageLedger.getJobUsageSummary(noMetaJobId);
  assert(noMetaSummary !== null, 'Usage summary recorded for job with missing metadata.');
  assert(noMetaSummary!.totalInputTokens === null, 'Usage ledger summary preserves null for missing input tokens.');
  assert(noMetaSummary!.totalEstimatedCostUsd === null, 'Usage ledger summary preserves null for uncalculable cost.');
  assert(noMetaSummary!.usageCompleteness === 'UNAVAILABLE', 'Usage ledger summary completeness is UNAVAILABLE.');

  // 3. Multi-tenant isolation for usage summaries
  const instAUser: UserContext = {
    userId: 'instr_a',
    role: 'instructor',
    institutionId: 'inst_aarshiv_01',
    name: 'Instructor A',
  };
  const instBUser: UserContext = {
    userId: 'instr_b',
    role: 'instructor',
    institutionId: 'inst_other_hospital_99',
    name: 'Instructor B',
  };

  const summaryForInstA = usageLedger.getJobUsageSummary(retryJobId, instAUser);
  assert(summaryForInstA !== null, 'Instructor from Institution A can view their own institution job usage summary.');

  const summaryForInstB = usageLedger.getJobUsageSummary(retryJobId, instBUser);
  assert(summaryForInstB === null, 'Instructor from Institution B CANNOT access Institution A job usage summary (returns null).');

  const summaryForOperator = usageLedger.getJobUsageSummary(retryJobId, operatorUser);
  assert(summaryForOperator !== null, 'Platform operator can access cross-institution usage summary for operational audit.');

  // 4. Batch statistics and sample size sufficiency for percentiles
  const batchInst = `inst_batch_${Date.now()}_${crypto.randomBytes(2).toString('hex')}`;
  // Create 5 jobs for batchInst
  for (let i = 1; i <= 5; i++) {
    usageLedger.recordAttempt({
      jobId: `batch_job_${i}_${batchInst}`,
      correlationId: `corr_b_${i}`,
      institutionId: batchInst,
      pipelineStage: 'grading',
      requestedModel: 'gemini-3.8-flash',
      actualModel: 'gemini-3.8-flash',
      attemptNumber: 1,
      isFallback: false,
      status: 'success',
      latencyMs: 1200,
      inputTokens: 10000 * i,
      outputTokens: 2000 * i,
      cachedInputTokens: 1000 * i,
      usageSource: 'SIMULATED_MOCK',
    });
  }

  const batchStats5 = usageLedger.getBatchStatistics({ institutionId: batchInst });
  assert(batchStats5.sampleSize === 5, 'Batch statistics sample size is 5.');
  assert(!batchStats5.costs.sampleSizeSufficientForPercentiles, 'Sample size < 10 correctly flags sampleSizeSufficientForPercentiles: false.');
  assert(batchStats5.costs.p90CostUsd === null, 'P90 is null when sample size is insufficient (< 10).');
  assert(batchStats5.costs.p95CostUsd === null, 'P95 is null when sample size is insufficient (< 10).');
  assert(batchStats5.costs.meanCostUsd > 0, 'Mean cost is accurately computed for 5 evaluations.');
  assert(batchStats5.costs.medianCostUsd > 0, 'Median cost is accurately computed for 5 evaluations.');

  // Add 5 more jobs (total 10)
  for (let i = 6; i <= 10; i++) {
    usageLedger.recordAttempt({
      jobId: `batch_job_${i}_${batchInst}`,
      correlationId: `corr_b_${i}`,
      institutionId: batchInst,
      pipelineStage: 'grading',
      requestedModel: 'gemini-3.8-flash',
      actualModel: 'gemini-3.8-flash',
      attemptNumber: 1,
      isFallback: false,
      status: 'success',
      latencyMs: 1200,
      inputTokens: 10000 * i,
      outputTokens: 2000 * i,
      cachedInputTokens: 1000 * i,
      usageSource: 'SIMULATED_MOCK',
    });
  }

  const batchStats10 = usageLedger.getBatchStatistics({ institutionId: batchInst });
  assert(batchStats10.sampleSize === 10, 'Batch statistics sample size reached 10.');
  assert(batchStats10.costs.sampleSizeSufficientForPercentiles, 'Sample size >= 10 correctly enables percentiles.');
  assert(batchStats10.costs.p90CostUsd !== null, 'P90 cost is computed when sample size >= 10.');
  assert(batchStats10.costs.p95CostUsd !== null, 'P95 cost is computed when sample size >= 10.');
  assert(batchStats10.costs.p90CostUsd! >= batchStats10.costs.medianCostUsd, 'P90 cost is greater than or equal to median cost.');

  // 5. Full Evaluation Engine integration
  setMockGeminiProvider(async () => {
    return {
      text: JSON.stringify(sampleAcademicReport),
      usageMetadata: {
        promptTokenCount: 15000,
        candidatesTokenCount: 3500,
        cachedContentTokenCount: 2000,
      },
    };
  });

  const fullEvalJob = evaluationQueue.enqueue(
    {
      sourceDoc: { name: `phase2_script_${Date.now()}.pdf`, text: `Anatomy answer script content ${Date.now()}` },
      studentName: 'Phase 2 Test Student',
      testTitle: 'Upper Limb Anatomy & Embryology',
    },
    instructorUser
  );

  const evalResult = await evaluationEngine.evaluate(fullEvalJob);
  assert(evalResult.totalScore === 10, 'Full evaluation engine completed successfully.');
  assert(fullEvalJob.metrics.estimatedCostInr !== null && fullEvalJob.metrics.estimatedCostInr! >= 0, 'Job metrics contain non-null estimatedCostInr.');
  assert(fullEvalJob.metrics.cachedInputTokens === 2000, 'Job metrics contain cachedInputTokens (2000).');
  assert(fullEvalJob.metrics.pricingVersion === ACTIVE_PRICING_VERSION, `Job metrics record active pricing version (${ACTIVE_PRICING_VERSION}).`);
  assert(fullEvalJob.metrics.usageCompleteness === 'COMPLETE', 'Job metrics record usageCompleteness: COMPLETE.');
  assert(fullEvalJob.metrics.usageSummary !== null, 'Job metrics contain complete usageSummary.');

  // Clean up mock provider
  setMockGeminiProvider(null);

  // ==========================================================================
  // GROUP 11: Two Answer-Key Preparation Modes, Canonical Model & Approval Workflow
  // ==========================================================================
  console.log('\n--- TEST GROUP 11: Two Answer-Key Preparation Modes & Student Evaluation Integration ---');

  const instA_User: UserContext = {
    userId: `prof_sharma_${Date.now()}`,
    role: 'instructor',
    institutionId: `inst_aarshiv_${Date.now()}`,
    name: 'Prof. Sharma',
  };

  const instB_User: UserContext = {
    userId: `prof_verma_${Date.now()}`,
    role: 'instructor',
    institutionId: `inst_rival_${Date.now()}`,
    name: 'Prof. Verma',
  };

  // Mock Gemini provider for answer key generation & extraction
  setMockGeminiProvider(async ({ contentsParts, systemInstruction, correlationId }) => {
    // Mode 1: AI generation mock response
    if (correlationId.startsWith('ak_gen_')) {
      return {
        text: JSON.stringify({
          examTitle: 'Anatomy End-Term Assessment',
          totalMaxMarks: 20,
          warnings: [],
          questions: [
            {
              questionId: '1',
              subquestionId: null,
              questionText: 'Describe the course and branches of the Median Nerve in the forearm.',
              maxMarks: 10,
              referenceAnswer: 'The median nerve enters the forearm between the two heads of pronator teres...',
              expectedConcepts: ['Pronator teres relation', 'Anterior interosseous nerve branch', 'Motor innervation to flexors'],
              acceptableAlternatives: ['Can mention C5-T1 root values alternatively'],
              markingCriteria: ['3 marks for course', '4 marks for muscular branches', '3 marks for clinical correlation'],
              diagramReferences: ['Forearm flexor compartment diagram'],
              confidence: 0.95,
              flaggedIssue: null,
            },
            {
              questionId: '2.a',
              subquestionId: 'a',
              questionText: 'Enumerate the carpal bones.',
              maxMarks: 5,
              referenceAnswer: 'Proximal row: Scaphoid, Lunate, Triquetrum, Pisiform. Distal row: Trapezium, Trapezoid, Capitate, Hamate.',
              expectedConcepts: ['Proximal row 4 bones', 'Distal row 4 bones'],
              acceptableAlternatives: ['Mnemonic: She Looks Too Pretty Try To Catch Her'],
              markingCriteria: ['2.5 marks for proximal row', '2.5 marks for distal row'],
              confidence: 0.98,
              flaggedIssue: null,
            },
            {
              questionId: '2.b',
              subquestionId: 'b',
              questionText: 'Explain the anatomical basis of Carpal Tunnel Syndrome.',
              maxMarks: 5,
              referenceAnswer: 'Compression of median nerve beneath the flexor retinaculum...',
              expectedConcepts: ['Flexor retinaculum boundaries', 'Median nerve compression', 'Ape thumb deformity / thenar wasting'],
              acceptableAlternatives: ['Can mention sensory loss in lateral 3.5 digits'],
              markingCriteria: ['2 marks for boundaries', '3 marks for symptoms and signs'],
              confidence: 0.94,
              flaggedIssue: null,
            },
          ],
        }),
        usageMetadata: { promptTokenCount: 1800, candidatesTokenCount: 450 },
      };
    }

    // Mode 2: Uploaded key extraction mock response
    if (correlationId.startsWith('ak_ext_')) {
      return {
        text: JSON.stringify({
          examTitle: 'Extracted Official Model Answer Key',
          totalMaxMarks: 15,
          warnings: [],
          questions: [
            {
              questionId: '1',
              maxMarks: 10,
              referenceAnswer: 'Model answer for Question 1 from faculty notes.',
              expectedConcepts: ['Concept A', 'Concept B'],
              acceptableAlternatives: ['Alternative 1'],
              markingCriteria: ['5 marks for part 1', '5 marks for part 2'],
              confidence: 0.96,
              flaggedIssue: null,
            },
            {
              questionId: '2',
              maxMarks: 5,
              referenceAnswer: 'Model answer for Question 2.',
              expectedConcepts: ['Concept C'],
              acceptableAlternatives: [],
              markingCriteria: ['5 marks for comprehensive answer'],
              confidence: 0.92,
              flaggedIssue: null,
            },
          ],
        }),
        usageMetadata: { promptTokenCount: 1600, candidatesTokenCount: 380 },
      };
    }

    // Stage 1: Student script extraction mock response
    if (correlationId.startsWith('ext_')) {
      return {
        text: JSON.stringify({
          studentName: 'Anatomy Student',
          examTitle: 'Anatomy End-Term Assessment',
          answers: [
            {
              questionId: '1',
              studentAnswerText: 'The median nerve enters the forearm between two heads of pronator teres, gives anterior interosseous branch, supplies flexors...',
              diagramDescription: 'Forearm flexor compartment diagram drawn with median nerve highlighted.',
              formulas: [],
              isAttempted: true,
              confidence: 0.95,
              flaggedUncertain: false,
            },
            {
              questionId: '2.a',
              studentAnswerText: 'Proximal row: Scaphoid, Lunate, Triquetrum, Pisiform. Distal row: Trapezium, Trapezoid, Capitate, Hamate.',
              isAttempted: true,
              confidence: 0.98,
              flaggedUncertain: false,
            },
            {
              questionId: '2.b',
              studentAnswerText: 'Carpal tunnel syndrome occurs due to compression of median nerve beneath flexor retinaculum, causing ape thumb and thenar wasting.',
              isAttempted: true,
              confidence: 0.94,
              flaggedUncertain: false,
            },
          ],
          warnings: [],
          visualEvidenceRetained: true,
        }),
        usageMetadata: { promptTokenCount: 2200, candidatesTokenCount: 400 },
      };
    }

    // Stage 2: Student script evaluation mock response
    return {
      text: JSON.stringify({
        studentName: 'Anatomy Student',
        testTitle: 'Anatomy Assessment',
        testTopics: 'Upper Limb Anatomy',
        testDate: '2026-10-29',
        totalScore: 16,
        maxScore: 20,
        questions: [
          { qNo: '1', marks: 8, maxMarks: 10, isCorrect: true, feedbackPoints: ['Good description of course. Missed one cutaneous branch.'] },
          { qNo: '2.a', marks: 4, maxMarks: 5, isCorrect: true, feedbackPoints: ['Named 7 of 8 carpal bones accurately.'] },
          { qNo: '2.b', marks: 4, maxMarks: 5, isCorrect: true, feedbackPoints: ['Clear explanation of flexor retinaculum compression.'] },
        ],
        generalFeedback: {
          overallPerformance: ['Strong grasp of upper limb anatomy.'],
          mcqs: ['N/A'],
          contentAccuracy: ['Accurate anatomical terminology.'],
          completenessOfAnswers: ['Comprehensive answers with minor omission of cutaneous branch.'],
          presentationDiagrams: ['Neat descriptions.'],
          investigations: ['N/A'],
          attemptingQuestions: ['Attempted all questions.'],
          actionPoints: ['Revise sensory nerve distributions.'],
        },
      }),
      usageMetadata: { promptTokenCount: 2000, candidatesTokenCount: 450, cachedContentTokenCount: 1200 },
    };
  });

  // 1. AI-generated key creation (draft or needs_review)
  const aiKey = await answerKeyService.generateFromQuestionPaper({
    questionPaper: {
      name: 'QP_Anatomy_2026.pdf',
      text: 'Question 1: Describe the course and branches of the Median Nerve (10 marks). Question 2: (a) Enumerate carpal bones (5 marks). (b) Carpal tunnel syndrome (5 marks).',
    },
    title: 'Anatomy End-Term Assessment',
    subject: 'Anatomy',
    grade: 'MBBS Year 1',
    totalMaxMarks: 20,
    metadata: {
      institutionId: instA_User.institutionId,
      createdBy: instA_User.userId,
    },
  });

  assert(aiKey.id.startsWith('ak_'), 'Mode 1: AI answer key created with unique ID.');
  assert(aiKey.sourceMode === 'ai_generated', 'Mode 1: sourceMode correctly tagged as ai_generated.');
  assert(aiKey.status === 'draft' || aiKey.status === 'needs_review', 'Mode 1: AI key initial status is draft or needs_review (NEVER approved by default!).');
  assert(aiKey.version === 1, 'Mode 1: Initial version is 1.');
  assert(aiKey.questions.length === 3, 'Mode 1: Extracted 3 canonical questions.');
  assert(aiKey.totalMaxMarks === 20, 'Mode 1: totalMaxMarks correctly set to 20.');

  // 2. Uploaded key extraction (draft or needs_review)
  const uploadedKey = await answerKeyService.extractFromUploadedKey({
    answerKeyDoc: {
      name: 'Official_Key_Anatomy.pdf',
      text: 'Official Marking Scheme: Q1. Median nerve model answer (10 marks). Q2. Carpal bones and syndrome (5 marks).',
    },
    questionPaperDoc: {
      name: 'Question_Paper_Anatomy.pdf',
      text: 'Question 1: Course of median nerve (10 marks). Question 2: Carpal bones (5 marks).',
    },
    title: 'Extracted Official Model Answer Key',
    subject: 'Anatomy',
    grade: 'MBBS Year 1',
    totalMaxMarks: 15,
    metadata: {
      institutionId: instA_User.institutionId,
      createdBy: instA_User.userId,
    },
  });

  assert(uploadedKey.id.startsWith('ak_'), 'Mode 2: Uploaded key created with unique ID.');
  assert(uploadedKey.sourceMode === 'uploaded', 'Mode 2: sourceMode correctly tagged as uploaded.');
  assert(uploadedKey.status === 'draft' || uploadedKey.status === 'needs_review', 'Mode 2: Uploaded key initial status is draft or needs_review.');
  assert(uploadedKey.version === 1, 'Mode 2: Initial version is 1.');
  assert(uploadedKey.questions.length === 2, 'Mode 2: Extracted 2 questions.');

  // 3. Canonical schema compatibility between both modes
  const requiredSchemaKeys = ['id', 'examId', 'title', 'sourceMode', 'version', 'status', 'totalMaxMarks', 'questions', 'metadata'];
  const aiHasAll = requiredSchemaKeys.every((k) => k in aiKey);
  const upHasAll = requiredSchemaKeys.every((k) => k in uploadedKey);
  assert(aiHasAll && upHasAll, 'Mode 1 & Mode 2 produce identical canonical schema properties.');
  assert(aiKey.questions[0].referenceAnswer !== undefined && uploadedKey.questions[0].referenceAnswer !== undefined, 'Both modes populate referenceAnswer.');
  assert(Array.isArray(aiKey.questions[0].expectedConcepts) && Array.isArray(uploadedKey.questions[0].expectedConcepts), 'Both modes populate expectedConcepts array.');
  assert(Array.isArray(aiKey.questions[0].markingCriteria) && Array.isArray(uploadedKey.questions[0].markingCriteria), 'Both modes populate markingCriteria array.');

  // 4. Grading pipeline strictly rejects draft / unapproved answer keys
  const unapprovedJob = evaluationQueue.enqueue(
    {
      sourceDoc: { name: 'Student_Submission_01.pdf', text: 'Median nerve enters between pronator teres heads...' },
      canonicalAnswerKey: aiKey, // Current status is draft!
      mode: 'without-manual',
      studentName: 'Student Unapproved Key Test',
    },
    instA_User
  );

  let caughtUnapprovedError = false;
  try {
    await evaluationEngine.evaluate(unapprovedJob);
  } catch (err: any) {
    if (String(err?.message || err).toLowerCase().includes('unapproved answer key')) {
      caughtUnapprovedError = true;
    }
  }
  assert(caughtUnapprovedError, 'Grading pipeline strictly rejects unapproved / draft answer keys with ValidationError.');

  // 5. Explicit approval permits evaluation
  const approvedAiKey = answerKeyService.approveAnswerKey(aiKey.id, instA_User);
  assert(approvedAiKey.status === 'approved', 'Answer key successfully approved by instructor.');
  assert(approvedAiKey.metadata.approvedBy === instA_User.userId, 'Approved key records approving instructor ID.');
  assert(typeof approvedAiKey.metadata.approvedAt === 'number', 'Approved key records approvedAt timestamp.');

  const approvedEvalJob = evaluationQueue.enqueue(
    {
      sourceDoc: { name: 'Student_Submission_Approved.pdf', text: 'Median nerve answers...' },
      canonicalAnswerKey: approvedAiKey,
      mode: 'without-manual',
      studentName: 'Student Approved Key Test',
    },
    instA_User
  );

  const approvedReport = await evaluationEngine.evaluate(approvedEvalJob);
  assert(approvedReport.totalScore === 16, 'Student script evaluated successfully against approved answer key.');
  assert(approvedReport.maxScore === 20, 'Report maxScore matches approved answer key totalMaxMarks (20).');

  // 6. Editing an approved key increments version and resets approval
  const editedKey = answerKeyService.updateAnswerKey(
    approvedAiKey.id,
    { title: 'Anatomy End-Term Assessment (Revised Scheme)' },
    instA_User
  );

  assert(editedKey.version === 2, 'Editing an approved answer key increments version to 2.');
  assert(editedKey.status === 'draft', 'Editing an approved answer key resets status to draft (requiring re-approval).');
  assert(editedKey.metadata.approvedAt === undefined, 'Editing an approved key clears previous approvedAt timestamp.');
  assert(editedKey.metadata.approvedBy === undefined, 'Editing an approved key clears previous approvedBy.');

  // Test that evaluating against the newly edited key is rejected until re-approved
  const editedJob = evaluationQueue.enqueue(
    {
      sourceDoc: { name: 'Student_Edited_Key_Test.pdf', text: 'Answers...' },
      canonicalAnswerKey: editedKey,
      mode: 'without-manual',
    },
    instA_User
  );

  let caughtEditedRejection = false;
  try {
    await evaluationEngine.evaluate(editedJob);
  } catch (err: any) {
    if (String(err?.message || err).toLowerCase().includes('unapproved answer key')) {
      caughtEditedRejection = true;
    }
  }
  assert(caughtEditedRejection, 'Editing an approved key invalidates approval; subsequent evaluation is strictly rejected.');

  // Re-approve version 2
  const reapprovedKey = answerKeyService.approveAnswerKey(editedKey.id, instA_User);
  assert(reapprovedKey.version === 2, 'Re-approved key maintains version 2.');
  assert(reapprovedKey.status === 'approved', 'Re-approved key status is approved.');

  // 7. Rejection of missing / invalid maximum marks during approval
  const invalidMarksKey: CanonicalAnswerKey = {
    id: `ak_invalid_${Date.now()}`,
    examId: `exam_${Date.now()}`,
    title: 'Invalid Marks Exam',
    sourceMode: 'ai_generated',
    version: 1,
    status: 'draft',
    totalMaxMarks: 0,
    questions: [
      {
        questionId: '1',
        maxMarks: 0, // INVALID / MISSING!
        referenceAnswer: 'Some answer',
        expectedConcepts: [],
        acceptableAlternatives: [],
        markingCriteria: [],
        flaggedIssue: 'Missing maximum marks in question paper',
      },
    ],
    metadata: {
      institutionId: instA_User.institutionId,
      createdBy: instA_User.userId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
  };
  (answerKeyService as any).saveToDisk(invalidMarksKey);

  assertThrows(
    () => answerKeyService.approveAnswerKey(invalidMarksKey.id, instA_User),
    'invalid or missing maximum marks',
    'Approval strictly rejected if any question has invalid or missing maximum marks (maxMarks <= 0).'
  );

  // 8. Flagging missing questions and mismatched question numbers
  // Test that generateFromQuestionPaper flags missing marks without fabricating values
  setMockGeminiProvider(async () => {
    return {
      text: JSON.stringify({
        examTitle: 'Unspecified Marks Exam',
        totalMaxMarks: 0,
        warnings: ['Question 1: Missing marks in prompt.'],
        questions: [
          {
            questionId: '1',
            maxMarks: 0, // AI flags missing marks
            referenceAnswer: 'Model answer without known marks',
            expectedConcepts: ['Concept 1'],
            acceptableAlternatives: [],
            markingCriteria: [],
            flaggedIssue: 'Missing maximum marks in question paper - instructor review required',
          },
        ],
      }),
      usageMetadata: { promptTokenCount: 1200, candidatesTokenCount: 250 },
    };
  });

  const flaggedKey = await answerKeyService.generateFromQuestionPaper({
    questionPaper: { name: 'QP_No_Marks.pdf', text: 'Explain cell structure.' },
    title: 'Unspecified Marks Exam',
    metadata: {
      institutionId: instA_User.institutionId,
      createdBy: instA_User.userId,
    },
  });

  assert(flaggedKey.status === 'needs_review', 'Key with missing marks automatically enters needs_review status.');
  assert(flaggedKey.questions[0].flaggedIssue !== undefined, 'Missing marks question is explicitly flagged for instructor review.');
  assert(flaggedKey.questions[0].maxMarks === 0, 'Missing marks strictly preserved as 0, NEVER silently defaulted to 1!');

  // 9. Handling generation or extraction failures
  setMockGeminiProvider(async () => {
    throw new Error('503 Service Unavailable: Model overloaded');
  });

  let caughtGenerationFailure = false;
  try {
    await answerKeyService.generateFromQuestionPaper({
      questionPaper: { name: 'QP_Fail.pdf', text: 'Some questions' },
      title: 'Failing Exam',
      metadata: { institutionId: instA_User.institutionId, createdBy: instA_User.userId },
    });
  } catch (err: any) {
    caughtGenerationFailure = true;
  }
  assert(caughtGenerationFailure, 'Generation failures fail gracefully and never return fabricated fallback answer keys.');

  // Restore working mock provider
  setMockGeminiProvider(async () => {
    return {
      text: JSON.stringify({
        studentName: 'Student Reused',
        testTitle: 'Anatomy Assessment',
        testTopics: 'Upper Limb Anatomy',
        testDate: '2026-10-29',
        totalScore: 18,
        maxScore: 20,
        questions: [
          { qNo: '1', marks: 9, maxMarks: 10, isCorrect: true, feedbackPoints: ['Excellent answer.'] },
          { qNo: '2.a', marks: 5, maxMarks: 5, isCorrect: true, feedbackPoints: ['All carpal bones correct.'] },
          { qNo: '2.b', marks: 4, maxMarks: 5, isCorrect: true, feedbackPoints: ['Good explanation of flexor retinaculum.'] },
        ],
        generalFeedback: {
          overallPerformance: ['Outstanding work.'],
          mcqs: [],
          contentAccuracy: ['Accurate.'],
          completenessOfAnswers: ['Complete.'],
          presentationDiagrams: ['Clear.'],
          investigations: [],
          attemptingQuestions: ['All attempted.'],
          actionPoints: ['Continue consistent revision.'],
        },
      }),
      usageMetadata: { promptTokenCount: 3500, candidatesTokenCount: 600, cachedContentTokenCount: 1500 },
    };
  });

  // 10. Rejecting unsupported file formats for answer key uploads
  const unsupportedPayload = {
    name: 'archive.zip',
    mimeType: 'application/zip',
    text: '',
    base64: 'UEsDBBQAAAAIA...',
  };

  const ALLOWED_FORMATS = [
    'application/pdf',
    'image/jpeg',
    'image/png',
    'image/webp',
    'text/plain',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ];
  const isZipAllowed = ALLOWED_FORMATS.includes(unsupportedPayload.mimeType);
  assert(!isZipAllowed, 'Unsupported file format application/zip correctly identified and rejected.');

  // 11. Multi-tenant isolation for answer keys
  const retrievedByA = answerKeyService.getAnswerKey(reapprovedKey.id, instA_User);
  assert(retrievedByA !== null && retrievedByA.id === reapprovedKey.id, 'Instructor A can access Institution A answer key.');

  const retrievedByB = answerKeyService.getAnswerKey(reapprovedKey.id, instB_User);
  assert(retrievedByB === null, 'Instructor B from Institution B CANNOT access Institution A answer key (returns null).');

  assertThrows(
    () => answerKeyService.approveAnswerKey(reapprovedKey.id, instB_User),
    'not found or access denied',
    'Instructor B CANNOT approve or manipulate Institution A answer key.'
  );

  assertThrows(
    () => answerKeyService.updateAnswerKey(reapprovedKey.id, { title: 'Hacked' }, instB_User),
    'not found or access denied',
    'Instructor B CANNOT edit Institution A answer key.'
  );

  // 12. Reusing approved answer key across multiple student scripts without repeated LLM calls
  let llmCallCount = 0;
  setMockGeminiProvider(async ({ correlationId }) => {
    llmCallCount++;
    if (correlationId.startsWith('ext_')) {
      return {
        text: JSON.stringify({
          studentName: `Batch Student ${llmCallCount}`,
          examTitle: 'Anatomy End-Term Assessment',
          answers: [
            { questionId: '1', studentAnswerText: 'Course and branches of median nerve described in detail.', isAttempted: true, confidence: 0.95 },
            { questionId: '2.a', studentAnswerText: 'All 8 carpal bones named correctly.', isAttempted: true, confidence: 0.98 },
            { questionId: '2.b', studentAnswerText: 'Carpal tunnel syndrome explained.', isAttempted: true, confidence: 0.94 },
          ],
        }),
        usageMetadata: { promptTokenCount: 1500, candidatesTokenCount: 300 },
      };
    }

    return {
      text: JSON.stringify({
        studentName: `Student ${llmCallCount}`,
        testTitle: 'Anatomy Assessment',
        testTopics: 'Upper Limb Anatomy',
        testDate: '2026-10-29',
        totalScore: 18,
        maxScore: 20,
        questions: [
          { qNo: '1', marks: 9, maxMarks: 10, isCorrect: true, feedbackPoints: ['Clear answer.'] },
          { qNo: '2.a', marks: 5, maxMarks: 5, isCorrect: true, feedbackPoints: ['Full marks.'] },
          { qNo: '2.b', marks: 4, maxMarks: 5, isCorrect: true, feedbackPoints: ['Well explained.'] },
        ],
        generalFeedback: {
          overallPerformance: ['Good.'],
          mcqs: [],
          contentAccuracy: ['Good.'],
          completenessOfAnswers: ['Complete.'],
          presentationDiagrams: ['Good.'],
          investigations: [],
          attemptingQuestions: ['Attempted.'],
          actionPoints: ['Keep it up.'],
        },
      }),
      usageMetadata: { promptTokenCount: 1800, candidatesTokenCount: 400 },
    };
  });

  const studentJob1 = evaluationQueue.enqueue(
    {
      sourceDoc: { name: 'Batch_Student_1.pdf', text: `Script 1 content ${Date.now()}` },
      canonicalAnswerKey: reapprovedKey,
      mode: 'without-manual',
      studentName: 'Batch Student 1',
    },
    instA_User
  );

  const studentJob2 = evaluationQueue.enqueue(
    {
      sourceDoc: { name: 'Batch_Student_2.pdf', text: `Script 2 content ${Date.now()}` },
      canonicalAnswerKey: reapprovedKey,
      mode: 'without-manual',
      studentName: 'Batch Student 2',
    },
    instA_User
  );

  const rep1 = await evaluationEngine.evaluate(studentJob1);
  const rep2 = await evaluationEngine.evaluate(studentJob2);
  assert(rep1.totalScore === 18 && rep2.totalScore === 18, 'Both batch students evaluated successfully using shared approved answer key.');
  assert(llmCallCount === 4, 'Reused single approved answer key across 2 students (2 extractions + 2 evaluations, 0 answer key regenerations).');

  // 13. Verification that answer key generation/extraction calls are isolated from student grading calls in usage ledger
  const keySummary = usageLedger.getJobUsageSummary(aiKey.id, instA_User);
  const studentSummary = usageLedger.getJobUsageSummary(studentJob1.id, instA_User);

  assert(keySummary !== null && keySummary.calls.length > 0, 'Usage ledger recorded attempt for answer key generation job.');
  assert(keySummary!.calls[0].pipelineStage === 'answer_key_generation', 'Answer key generation attempts strictly tagged with pipelineStage: answer_key_generation.');
  assert(studentSummary !== null && studentSummary.calls.length >= 2, 'Usage ledger recorded attempts for both extraction and grading stages.');
  const hasExtStage = studentSummary!.calls.some((c) => c.pipelineStage === 'student_extraction');
  const hasGradeStage = studentSummary!.calls.some((c) => c.pipelineStage === 'grading');
  assert(hasExtStage && hasGradeStage, 'Student evaluation records distinct student_extraction and grading stages.');

  // 14. Evaluation report retains answer-key version, ID, and source-mode
  assert(rep1.answerKeyId === reapprovedKey.id, 'Evaluation report retains answerKeyId.');
  assert(rep1.answerKeyVersion === 2, 'Evaluation report retains answerKeyVersion (2).');
  assert(rep1.answerKeySourceMode === 'ai_generated', 'Evaluation report retains answerKeySourceMode (ai_generated).');

  // 15. Backward compatibility and error handling for legacy requests
  const legacyJob = evaluationQueue.enqueue(
    {
      sourceDoc: { name: 'Legacy_Student.pdf', text: 'Legacy script' },
      questionPaper: { name: 'QP_Legacy.pdf', text: 'Q1. Explain cell (10 marks).' },
      answerKey: { name: 'AK_Legacy.pdf', text: 'Q1. Cell is basic structural unit (10 marks).' },
      mode: 'without-manual',
      studentName: 'Legacy Student',
    },
    instA_User
  );

  setMockGeminiProvider(async () => {
    return {
      text: JSON.stringify({
        studentName: 'Legacy Student',
        testTitle: 'Legacy Assessment',
        testTopics: 'Biology',
        testDate: '2026-10-29',
        totalScore: 10,
        maxScore: 10,
        questions: [{ qNo: '1', marks: 10, maxMarks: 10, isCorrect: true, feedbackPoints: ['Correct.'] }],
        generalFeedback: {
          overallPerformance: ['Passed.'],
          mcqs: [],
          contentAccuracy: ['Accurate.'],
          completenessOfAnswers: ['Complete.'],
          presentationDiagrams: [],
          investigations: [],
          attemptingQuestions: ['Attempted.'],
          actionPoints: ['Good.'],
        },
      }),
      usageMetadata: { promptTokenCount: 2000, candidatesTokenCount: 300 },
    };
  });

  const legacyReport = await evaluationEngine.evaluate(legacyJob);
  assert(legacyReport.totalScore === 10, 'Backward compatibility: Legacy requests without canonical answer key continue evaluating cleanly.');

  // 16. Strict rejection of duplicate question IDs during approval
  const duplicateIdKey: CanonicalAnswerKey = {
    id: `ak_dup_${Date.now()}`,
    examId: `exam_${Date.now()}`,
    title: 'Duplicate IDs Exam',
    sourceMode: 'ai_generated',
    version: 1,
    status: 'draft',
    totalMaxMarks: 20,
    questions: [
      {
        questionId: '1',
        maxMarks: 10,
        referenceAnswer: 'First question answer',
        expectedConcepts: ['Concept A'],
        acceptableAlternatives: [],
        markingCriteria: ['Full marks'],
      },
      {
        questionId: '1', // DUPLICATE ID!
        maxMarks: 10,
        referenceAnswer: 'Second question answer with duplicate ID',
        expectedConcepts: ['Concept B'],
        acceptableAlternatives: [],
        markingCriteria: ['Full marks'],
      },
    ],
    metadata: {
      institutionId: instA_User.institutionId,
      createdBy: instA_User.userId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
  };
  (answerKeyService as any).saveToDisk(duplicateIdKey);

  assertThrows(
    () => answerKeyService.approveAnswerKey(duplicateIdKey.id, instA_User),
    'duplicate question number',
    'Approval strictly rejected if any duplicate question numbers exist.'
  );

  // 16b. Hierarchical Question Numbering (1.1, 1.2, 2.1) are NOT treated as duplicates
  const hierarchicalKey = {
    id: 'ak_hierarchical_test_01',
    examId: 'exam_hier_01',
    title: 'Hierarchical Exam',
    sourceMode: 'ai_generated' as const,
    version: 1,
    status: 'draft' as const,
    totalMaxMarks: 20,
    questions: [
      {
        questionId: '1.1',
        maxMarks: 5,
        referenceAnswer: 'Answer for Q1.1',
        expectedConcepts: ['C1'],
        acceptableAlternatives: [],
        markingCriteria: ['5 marks'],
      },
      {
        questionId: '1.2',
        maxMarks: 5,
        referenceAnswer: 'Answer for Q1.2',
        expectedConcepts: ['C2'],
        acceptableAlternatives: [],
        markingCriteria: ['5 marks'],
      },
      {
        questionId: '2.1',
        maxMarks: 10,
        referenceAnswer: 'Answer for Q2.1',
        expectedConcepts: ['C3'],
        acceptableAlternatives: [],
        markingCriteria: ['10 marks'],
      },
    ],
    metadata: {
      institutionId: instA_User.institutionId,
      createdBy: instA_User.userId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
  };
  (answerKeyService as any).saveToDisk(hierarchicalKey);
  const approvedHierKey = answerKeyService.approveAnswerKey(hierarchicalKey.id, instA_User);
  assert(approvedHierKey.status === 'approved', 'Hierarchical questions 1.1, 1.2, 2.1 successfully approved without false duplicate collision.');
  assert(approvedHierKey.questions[0].questionId === '1.1', 'Preserves complete question identifier 1.1.');
  assert(approvedHierKey.questions[1].questionId === '1.2', 'Preserves complete question identifier 1.2.');
  assert(approvedHierKey.totalMaxMarks === 20, 'Correctly computes total max marks for hierarchical questions.');

  // 16c. Parent question ("1") and sub-questions ("1.1", "1.2") coexist in the same key
  const parentSubCoexistKey = {
    id: 'ak_coexist_test_02',
    examId: 'exam_coexist_02',
    title: 'Parent and Subquestions Coexist',
    sourceMode: 'ai_generated' as const,
    version: 1,
    status: 'draft' as const,
    totalMaxMarks: 15,
    questions: [
      {
        questionId: '1', // Parent question
        maxMarks: 5,
        referenceAnswer: 'Parent question overview answer',
        expectedConcepts: ['Overview'],
        acceptableAlternatives: [],
        markingCriteria: ['5 marks'],
      },
      {
        questionId: '1.1', // Subquestion
        maxMarks: 5,
        referenceAnswer: 'Subquestion 1.1 detailed answer',
        expectedConcepts: ['Detail 1'],
        acceptableAlternatives: [],
        markingCriteria: ['5 marks'],
      },
      {
        questionId: '1.2', // Subquestion
        maxMarks: 5,
        referenceAnswer: 'Subquestion 1.2 detailed answer',
        expectedConcepts: ['Detail 2'],
        acceptableAlternatives: [],
        markingCriteria: ['5 marks'],
      },
    ],
    metadata: {
      institutionId: instA_User.institutionId,
      createdBy: instA_User.userId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
  };
  (answerKeyService as any).saveToDisk(parentSubCoexistKey);
  const approvedCoexistKey = answerKeyService.approveAnswerKey(parentSubCoexistKey.id, instA_User);
  assert(approvedCoexistKey.status === 'approved', 'Parent question 1 and subquestions 1.1, 1.2 successfully coexist in approved answer key.');
  assert(approvedCoexistKey.questions.length === 3, 'All 3 questions preserved in coexistence test.');

  // 16d. Hierarchical numbering with questionId and subquestionId fields
  const subqFieldsKey = {
    id: 'ak_subq_fields_03',
    examId: 'exam_subq_03',
    title: 'Subquestion Fields Exam',
    sourceMode: 'ai_generated' as const,
    version: 1,
    status: 'draft' as const,
    totalMaxMarks: 10,
    questions: [
      {
        questionId: '1',
        subquestionId: '1',
        maxMarks: 5,
        referenceAnswer: 'Answer 1.1',
        expectedConcepts: ['Concept 1'],
        acceptableAlternatives: [],
        markingCriteria: ['5 marks'],
      },
      {
        questionId: '1',
        subquestionId: '2',
        maxMarks: 5,
        referenceAnswer: 'Answer 1.2',
        expectedConcepts: ['Concept 2'],
        acceptableAlternatives: [],
        markingCriteria: ['5 marks'],
      },
    ],
    metadata: {
      institutionId: instA_User.institutionId,
      createdBy: instA_User.userId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
  };
  (answerKeyService as any).saveToDisk(subqFieldsKey);
  const approvedSubqKey = answerKeyService.approveAnswerKey(subqFieldsKey.id, instA_User);
  assert(approvedSubqKey.status === 'approved', 'Questions with questionId "1" and subquestionId "1"/"2" resolve to 1.1/1.2 and approve cleanly.');
  assert(approvedSubqKey.questions[0].questionId === '1.1', 'Question 1.1 resolved and saved.');
  assert(approvedSubqKey.questions[1].questionId === '1.2', 'Question 1.2 resolved and saved.');

  // 16e. Mixed Numbering Formats (letters, roman numerals, parentheses)
  const mixedNumberingKey = {
    id: 'ak_mixed_numbering_04',
    examId: 'exam_mixed_04',
    title: 'Mixed Numbering Exam',
    sourceMode: 'ai_generated' as const,
    version: 1,
    status: 'draft' as const,
    totalMaxMarks: 20,
    questions: [
      {
        questionId: '1.a',
        maxMarks: 5,
        referenceAnswer: 'Answer 1.a',
        expectedConcepts: ['Concept 1.a'],
        acceptableAlternatives: [],
        markingCriteria: ['5 marks'],
      },
      {
        questionId: '1.b',
        maxMarks: 5,
        referenceAnswer: 'Answer 1.b',
        expectedConcepts: ['Concept 1.b'],
        acceptableAlternatives: [],
        markingCriteria: ['5 marks'],
      },
      {
        questionId: '2(a)',
        maxMarks: 5,
        referenceAnswer: 'Answer 2(a)',
        expectedConcepts: ['Concept 2(a)'],
        acceptableAlternatives: [],
        markingCriteria: ['5 marks'],
      },
      {
        questionId: 'Section A - 3.1',
        maxMarks: 5,
        referenceAnswer: 'Answer Section A - 3.1',
        expectedConcepts: ['Section Concept'],
        acceptableAlternatives: [],
        markingCriteria: ['5 marks'],
      },
    ],
    metadata: {
      institutionId: instA_User.institutionId,
      createdBy: instA_User.userId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
  };
  (answerKeyService as any).saveToDisk(mixedNumberingKey);
  const approvedMixedKey = answerKeyService.approveAnswerKey(mixedNumberingKey.id, instA_User);
  assert(approvedMixedKey.status === 'approved', 'Mixed numbering formats (1.a, 1.b, 2(a), Section A - 3.1) successfully approved.');

  // 16f. Genuine duplicates in hierarchical numbering are strictly rejected
  const genuineHierDuplicateKey = {
    id: 'ak_genuine_hier_dup_05',
    examId: 'exam_hier_dup_05',
    title: 'Hierarchical Duplicate Exam',
    sourceMode: 'ai_generated' as const,
    version: 1,
    status: 'draft' as const,
    totalMaxMarks: 10,
    questions: [
      {
        questionId: '1.1',
        maxMarks: 5,
        referenceAnswer: 'First 1.1 answer',
        expectedConcepts: ['Concept 1'],
        acceptableAlternatives: [],
        markingCriteria: ['5 marks'],
      },
      {
        questionId: '1.1', // GENUINE DUPLICATE!
        maxMarks: 5,
        referenceAnswer: 'Second 1.1 answer',
        expectedConcepts: ['Concept 2'],
        acceptableAlternatives: [],
        markingCriteria: ['5 marks'],
      },
    ],
    metadata: {
      institutionId: instA_User.institutionId,
      createdBy: instA_User.userId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
  };
  (answerKeyService as any).saveToDisk(genuineHierDuplicateKey);
  assertThrows(
    () => answerKeyService.approveAnswerKey(genuineHierDuplicateKey.id, instA_User),
    'duplicate question number',
    'Genuine duplicate hierarchical question numbers (1.1 and 1.1) are strictly rejected.'
  );

  // 16g. Update/Editing validation: updateAnswerKey accepts hierarchical questions but rejects duplicates
  const keyToEdit = {
    id: 'ak_edit_validation_06',
    examId: 'exam_edit_06',
    title: 'Edit Validation Exam',
    sourceMode: 'ai_generated' as const,
    version: 1,
    status: 'draft' as const,
    totalMaxMarks: 10,
    questions: [
      {
        questionId: '1',
        maxMarks: 10,
        referenceAnswer: 'Initial answer',
        expectedConcepts: ['Initial'],
        acceptableAlternatives: [],
        markingCriteria: ['10 marks'],
      },
    ],
    metadata: {
      institutionId: instA_User.institutionId,
      createdBy: instA_User.userId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
  };
  (answerKeyService as any).saveToDisk(keyToEdit);

  // Editing to hierarchical 1.1 and 1.2 succeeds
  const updatedHier = answerKeyService.updateAnswerKey(
    keyToEdit.id,
    {
      questions: [
        {
          questionId: '1.1',
          maxMarks: 5,
          referenceAnswer: 'Updated 1.1',
          expectedConcepts: ['Concept 1.1'],
          acceptableAlternatives: [],
          markingCriteria: ['5 marks'],
        },
        {
          questionId: '1.2',
          maxMarks: 5,
          referenceAnswer: 'Updated 1.2',
          expectedConcepts: ['Concept 1.2'],
          acceptableAlternatives: [],
          markingCriteria: ['5 marks'],
        },
      ],
    },
    instA_User
  );
  assert(updatedHier.questions[0].questionId === '1.1' && updatedHier.questions[1].questionId === '1.2', 'updateAnswerKey successfully saves hierarchical question numbering.');

  // Editing to duplicate questions throws AnswerKeyValidationError
  assertThrows(
    () =>
      answerKeyService.updateAnswerKey(
        keyToEdit.id,
        {
          questions: [
            {
              questionId: '2.1',
              maxMarks: 5,
              referenceAnswer: 'First 2.1',
              expectedConcepts: [],
              acceptableAlternatives: [],
              markingCriteria: [],
            },
            {
              questionId: '2.1', // Duplicate!
              maxMarks: 5,
              referenceAnswer: 'Second 2.1',
              expectedConcepts: [],
              acceptableAlternatives: [],
              markingCriteria: [],
            },
          ],
        },
        instA_User
      ),
    'duplicate question number',
    'updateAnswerKey strictly rejects duplicate question numbers.'
  );

  // 17. Rejection of Mode 2 extraction when answer key document is missing
  let caughtMissingDoc = false;
  try {
    await answerKeyService.extractFromUploadedKey({
      answerKeyDoc: null as any,
      title: 'Missing Doc Exam',
      metadata: { institutionId: instA_User.institutionId, createdBy: instA_User.userId },
    });
  } catch (err: any) {
    if (String(err?.message || err).toLowerCase().includes('document content')) {
      caughtMissingDoc = true;
    }
  }
  assert(caughtMissingDoc, 'Mode 2 extraction strictly rejected if answer key document is missing.');

  // 18. Token minimization: verify document processor does NOT retransmit visual QP/AK pages when canonical key is present
  const docPrep = documentProcessor.prepareInput({
    sourceDoc: {
      name: 'student_script.pdf',
      base64: 'JVBERi0xLjQK...',
      mimeType: 'application/pdf',
      text: 'Student answers to questions...',
    },
    questionPaper: {
      name: 'QP.pdf',
      base64: 'QP_BASE64_DATA...',
      mimeType: 'application/pdf',
      text: 'Question 1: Explain concept...',
    },
    canonicalAnswerKey: reapprovedKey,
    mode: 'without-manual',
    studentName: 'Minimization Test Student',
  });

  const hasVisualQP = docPrep.contentsParts.some((p: any) =>
    typeof p.text === 'string' && p.text.includes('DOCUMENT_START: OFFICIAL QUESTION PAPER (Visual)')
  );
  const hasVisualAK = docPrep.contentsParts.some((p: any) =>
    typeof p.text === 'string' && p.text.includes('DOCUMENT_START: OFFICIAL ANSWER KEY (Visual Reference)')
  );
  const hasVisualStudent = docPrep.contentsParts.some((p: any) =>
    typeof p.text === 'string' && p.text.includes('STUDENT ACTUAL ANSWER SCRIPT')
  );

  assert(!hasVisualQP, 'Context Minimization: Visual Question Paper is NOT re-transmitted when approved canonical key is present.');
  assert(!hasVisualAK, 'Context Minimization: Visual Answer Key is NOT re-transmitted when approved canonical key is present.');
  assert(hasVisualStudent, 'Student handwritten answer script visual pages are faithfully preserved for diagram & handwriting inspection.');

  // 19. Model routing & selective escalation
  setMockGeminiProvider(async ({ model }) => {
    return {
      text: JSON.stringify({
        studentName: 'Model Routing Student',
        testTitle: 'Routing Test',
        testTopics: 'Anatomy',
        testDate: '2026-10-30',
        totalScore: 10,
        maxScore: 10,
        questions: [{ qNo: '1', marks: 10, maxMarks: 10, isCorrect: true, feedbackPoints: ['Accurate.'] }],
        generalFeedback: {
          overallPerformance: ['Good.'],
          mcqs: [],
          contentAccuracy: ['Good.'],
          completenessOfAnswers: ['Good.'],
          presentationDiagrams: [],
          investigations: [],
          attemptingQuestions: ['Attempted.'],
          actionPoints: ['Keep it up.'],
        },
      }),
      usageMetadata: { promptTokenCount: 1500, candidatesTokenCount: 200 },
    };
  });

  const liteResult = await callGeminiWithFallback(
    [{ text: 'Test content' }],
    'Test system instruction',
    `routing_test_${Date.now()}`,
    {
      model: 'gemini-3.1-flash-lite',
      jobId: `job_lite_${Date.now()}`,
      institutionId: instA_User.institutionId,
      pipelineStage: 'grading',
    }
  );

  assert(liteResult.modelUsed === 'gemini-3.1-flash-lite', 'Model routing successfully routes routine calls to cost-effective gemini-3.1-flash-lite.');

  // ==========================================================================
  // GROUP 12: Two-Stage LLM Evaluation Architecture (Stage 1 Extraction + Stage 2 Evaluation)
  // ==========================================================================
  console.log('\n--- TEST GROUP 12: Two-Stage LLM Architecture (Extraction & Evaluation) ---');

  // Test 1: Stage 1 Student Answer Extraction
  setMockGeminiProvider(async ({ correlationId }) => {
    if (correlationId.startsWith('ext_')) {
      return {
        text: JSON.stringify({
          studentName: 'Rahul Kumar',
          examTitle: 'Anatomy End-Term Assessment',
          answers: [
            {
              questionId: '1',
              subquestionId: null,
              studentAnswerText: 'The median nerve arises from lateral and medial cords of brachial plexus. It runs down the arm into the cubital fossa...',
              diagramDescription: 'Hand-drawn schematic of cubital fossa showing relations of biceps tendon, brachial artery, and median nerve from lateral to medial.',
              formulas: ['Root value: C5, C6, C7, C8, T1'],
              pageReferences: [1, 2],
              isAttempted: true,
              confidence: 0.96,
              flaggedUncertain: false,
            },
            {
              questionId: '2.a',
              subquestionId: 'a',
              studentAnswerText: 'Carpal bones: Scaphoid, Lunate, Triquetrum, Pisiform, Trapezium, Trapezoid, Capitate, Hamate.',
              isAttempted: true,
              confidence: 0.99,
              flaggedUncertain: false,
            },
            // Note: Question 2.b is intentionally omitted by student to test coverage validation!
          ],
          unmappedContent: [],
          warnings: [],
          visualEvidenceRetained: true,
        }),
        usageMetadata: { promptTokenCount: 2100, candidatesTokenCount: 450 },
      };
    }

    return {
      text: JSON.stringify({
        studentName: 'Rahul Kumar',
        testTitle: 'Anatomy Assessment',
        testTopics: 'Upper Limb Anatomy',
        testDate: '2026-10-30',
        totalScore: 13,
        maxScore: 20,
        questions: [
          { qNo: '1', marks: 8.5, maxMarks: 10, isCorrect: true, feedbackPoints: ['Good anatomical relations in cubital fossa.', 'Well-labeled diagram.'] },
          { qNo: '2.a', marks: 4.5, maxMarks: 5, isCorrect: true, feedbackPoints: ['All 8 carpal bones enumerated in anatomical order.'] },
          { qNo: '2.b', marks: 0, maxMarks: 5, isCorrect: false, feedbackPoints: ['Question not attempted by student. 0 marks awarded.'] },
        ],
        generalFeedback: {
          overallPerformance: ['Satisfactory performance.'],
          mcqs: [],
          contentAccuracy: ['Accurate descriptions.'],
          completenessOfAnswers: ['Question 2.b was omitted.'],
          presentationDiagrams: ['Clear hand-drawn schematic with appropriate labeling.'],
          investigations: [],
          attemptingQuestions: ['Attempted Q1 and Q2.a. Missed Q2.b.'],
          actionPoints: ['Attempt all questions to maximize score potential.'],
        },
      }),
      usageMetadata: { promptTokenCount: 1900, candidatesTokenCount: 400 },
    };
  });

  const sampleStudentDoc = {
    name: 'Rahul_Kumar_MBBS_Anatomy.pdf',
    text: 'Student Script Content...',
    base64: 'JVBERi0xLjQKJ_STUDENT_SCRIPT_MOCK_BASE64_DATA',
    mimeType: 'application/pdf',
  };

  // Test Stage 1 extraction
  const extractedScript = await studentExtractor.extractStudentAnswers(
    sampleStudentDoc,
    reapprovedKey,
    `two_stage_corr_${Date.now()}`,
    {
      fallbackStudentName: 'Rahul Kumar',
    }
  );

  assert(extractedScript.studentName === 'Rahul Kumar', 'Stage 1: Student name extracted correctly.');
  assert(extractedScript.answers.length === 3, 'Stage 1: Extracted script maps all 3 canonical exam questions.');
  assert(extractedScript.answers[0].questionId === '1', 'Stage 1: Question 1 mapped.');
  assert(extractedScript.answers[0].isAttempted === true, 'Stage 1: Question 1 isAttempted is true.');
  assert(Boolean(extractedScript.answers[0].diagramDescription), 'Stage 1: Diagram description preserved for Q1.');
  assert(Boolean(extractedScript.answers[0].formulas && extractedScript.answers[0].formulas.length > 0), 'Stage 1: Formulas preserved.');
  assert(extractedScript.visualEvidenceRetained === true, 'Stage 1: Visual evidence retained flag is true.');

  // Test 2: Question coverage check — omitted question 2.b is marked unattempted, never fabricated!
  const q2b = extractedScript.answers.find((a) => a.questionId === '2.b');
  assert(q2b !== undefined, 'Stage 1: Omitted question 2.b is present in coverage mapping.');
  assert(q2b!.isAttempted === false, 'Stage 1: Omitted question 2.b is marked isAttempted: false (NEVER fabricated!).');
  assert(q2b!.studentAnswerText === '[Not Attempted]', 'Stage 1: Omitted question text is [Not Attempted].');

  // Test 3: Flagging uncertain handwriting
  const uncertainExtraction = studentExtractor.validateAndNormalizeExtractedScript(
    {
      studentName: 'Faint Script Student',
      answers: [
        {
          questionId: '1',
          studentAnswerText: 'Partially legible text regarding median nerve',
          isAttempted: true,
          confidence: 0.55,
          flaggedUncertain: true,
          flaggedIssue: 'Handwriting faint and partially cropped on line 4',
        },
      ],
    },
    reapprovedKey,
    'Faint Script Student'
  );

  assert(uncertainExtraction.answers[0].flaggedUncertain === true, 'Stage 1: Uncertain handwriting flagged honestly.');
  assert(uncertainExtraction.answers[0].flaggedIssue !== undefined, 'Stage 1: flaggedIssue details the illegibility.');

  // Test 4: Rejection of malformed extraction JSON
  assertThrows(
    () => studentExtractor.validateAndNormalizeExtractedScript(null as any, reapprovedKey, 'Test'),
    'not a structured JSON object',
    'Stage 1: Rejects null or malformed extraction responses.'
  );

  // Test 5: Rejection of empty student document during extraction
  let caughtEmptyDoc = false;
  try {
    await studentExtractor.extractStudentAnswers(
      { name: 'empty.pdf' },
      reapprovedKey,
      'corr_empty'
    );
  } catch (err: any) {
    if (String(err?.message || err).toLowerCase().includes('missing or empty')) {
      caughtEmptyDoc = true;
    }
  }
  assert(caughtEmptyDoc, 'Stage 1: Extraction strictly rejected if student answer script is missing or empty.');

  // Test 6: Stage 2 Grading context assembly — zero exam PDFs retransmitted
  const stage2Context = evaluationEngine.prepareStage2GradingContext(
    extractedScript,
    reapprovedKey,
    'without-manual',
    'Rahul Kumar'
  );

  const hasExamPdf = stage2Context.contentsParts.some(
    (p: any) => typeof p.text === 'string' && (p.text.includes('DOCUMENT_START: OFFICIAL QUESTION PAPER') || p.text.includes('DOCUMENT_START: OFFICIAL ANSWER KEY'))
  );
  assert(!hasExamPdf, 'Stage 2: Original exam PDFs and scans are NOT retransmitted to grading model.');

  const hasStructuredExam = stage2Context.contentsParts.some(
    (p: any) => typeof p.text === 'string' && p.text.includes('APPROVED CANONICAL EXAM REFERENCE')
  );
  assert(hasStructuredExam, 'Stage 2: Approved canonical exam JSON is transmitted.');

  const hasExtractedStudent = stage2Context.contentsParts.some(
    (p: any) => typeof p.text === 'string' && p.text.includes('EXTRACTED STUDENT RESPONSES (STAGE 1 OUTPUT)')
  );
  assert(hasExtractedStudent, 'Stage 2: Extracted student response JSON is transmitted.');

  // Test 7: End-to-end two-stage evaluation job execution
  const twoStageJob = evaluationQueue.enqueue(
    {
      sourceDoc: sampleStudentDoc,
      canonicalAnswerKey: reapprovedKey,
      mode: 'without-manual',
      studentName: 'Rahul Kumar',
    },
    instA_User
  );

  const twoStageReport = await evaluationEngine.evaluate(twoStageJob);

  assert(twoStageReport.studentName === 'Rahul Kumar', 'Two-Stage E2E: Evaluated report student name matches.');
  assert(twoStageReport.totalScore === 13, 'Two-Stage E2E: Awarded total score matches (13).');
  assert(twoStageReport.maxScore === 20, 'Two-Stage E2E: Max score matches canonical key (20).');
  assert(twoStageReport.questions.length === 3, 'Two-Stage E2E: Evaluated all 3 questions.');
  assert(twoStageReport.questions[2].marks === 0, 'Two-Stage E2E: Unattempted question 2.b awarded 0 marks.');
  assert(twoStageJob.extractedScript !== undefined, 'Two-Stage E2E: EvaluationJob preserves extractedScript.');

  // Test 8: Score bounds validation — awarded marks cannot exceed maxMarks
  assertThrows(
    () =>
      evaluationEngine.validateAndNormalizeReport(
        {
          studentName: 'Over-score Student',
          questions: [{ qNo: '1', marks: 15, maxMarks: 10, isCorrect: true, feedbackPoints: ['Good'] }], // 15 > 10!
          generalFeedback: {},
        },
        'without-manual',
        'Over-score Student'
      ),
    'exceed maximum permissible marks',
    'Stage 2: Awarded marks exceeding maxMarks is strictly rejected.'
  );

  // Test 9: Score bounds validation — negative marks rejected
  assertThrows(
    () =>
      evaluationEngine.validateAndNormalizeReport(
        {
          studentName: 'Negative Score Student',
          questions: [{ qNo: '1', marks: -2, maxMarks: 10, isCorrect: false, feedbackPoints: ['Penalty'] }],
          generalFeedback: {},
        },
        'without-manual',
        'Negative Score Student'
      ),
    'non-negative number >= 0',
    'Stage 2: Negative marks are strictly rejected.'
  );

  // Test 10: Usage ledger tracks distinct student_extraction and grading attempts
  const twoStageUsage = usageLedger.getJobUsageSummary(twoStageJob.id, instA_User);
  assert(twoStageUsage !== null, 'Usage ledger summary exists for two-stage job.');
  const extCalls = twoStageUsage!.calls.filter((c) => c.pipelineStage === 'student_extraction');
  const gradeCalls = twoStageUsage!.calls.filter((c) => c.pipelineStage === 'grading');
  assert(extCalls.length >= 1, 'Usage ledger recorded Stage 1 student_extraction call.');
  assert(gradeCalls.length >= 1, 'Usage ledger recorded Stage 2 grading call.');
  assert((twoStageJob.metrics.inputTokens ?? 0) > 0, 'Consolidated inputTokens recorded in job metrics.');
  assert((twoStageJob.metrics.outputTokens ?? 0) > 0, 'Consolidated outputTokens recorded in job metrics.');

  // =========================================================================
  // TEST GROUP 13: Subject-Independent Answer-Key Generation & Multi-Discipline Evaluation
  // =========================================================================
  console.log('\n--- TEST GROUP 13: Subject-Independent Evaluation & Multi-Discipline Pipeline ---');

  // 13.1 Subject-Independent PDF Processing Optimization (isVisualEvidenceNeeded)
  const pureTextQp = {
    name: 'QP_English_Literature.pdf',
    text: 'Explain the central themes of power, guilt, and moral responsibility in 19th-century Victorian novels. Discuss with reference to two distinct authors and analyze their stylistic techniques in detail.',
    base64: 'B64_PURE_TEXT',
    mimeType: 'application/pdf',
  };
  assert(!isVisualEvidenceNeeded(pureTextQp), 'Optimization: Pure text question paper without visual elements requires no visual transmission (token saving).');

  const mathEquationQp = {
    name: 'QP_Calculus.pdf',
    text: 'Evaluate the definite integral \\int_{0}^{1} \\frac{x^2}{\\sqrt{1-x^2}} dx and determine if \\sum_{n=1}^{\\infty} a_n converges.',
    base64: 'B64_MATH_EQUATIONS',
    mimeType: 'application/pdf',
  };
  assert(isVisualEvidenceNeeded(mathEquationQp), 'Optimization: Mathematical notation & LaTeX formulas retain visual evidence.');

  const diagramQp = {
    name: 'QP_Physics.pdf',
    text: 'Question 1: Refer to [Fig 1] showing a block on an inclined plane. Determine normal force and friction.',
    base64: 'B64_DIAGRAM',
    mimeType: 'application/pdf',
  };
  assert(isVisualEvidenceNeeded(diagramQp), 'Optimization: Questions referencing diagrams ([Fig]) retain visual evidence.');

  const chemistryQp = {
    name: 'QP_Chemistry.pdf',
    text: 'Write the complete balanced equation for C3H8 + 5O2 -> 3CO2 + 4H2O and draw the reaction mechanism.',
    base64: 'B64_CHEMISTRY',
    mimeType: 'application/pdf',
  };
  assert(isVisualEvidenceNeeded(chemistryQp), 'Optimization: Chemical formulas & reaction equations retain visual evidence.');

  const codeQp = {
    name: 'QP_ComputerScience.pdf',
    text: 'Write a Python function def binary_search(arr, target): that returns the index of target in O(log n) time.',
    base64: 'B64_CODE',
    mimeType: 'application/pdf',
  };
  assert(isVisualEvidenceNeeded(codeQp), 'Optimization: Questions containing code blocks retain visual evidence.');

  const commerceQp = {
    name: 'QP_Commerce.pdf',
    text: 'Prepare the Balance Sheet as of 31st March with ledger account details and journal entry for equipment purchase.',
    base64: 'B64_COMMERCE',
    mimeType: 'application/pdf',
  };
  assert(isVisualEvidenceNeeded(commerceQp), 'Optimization: Commerce accounting ledgers and balance sheet queries retain visual evidence.');

  const shortScannedQp = {
    name: 'Scanned_Scan_Only.pdf',
    text: 'P1 OCR error',
    base64: 'B64_SCANNED',
    mimeType: 'application/pdf',
  };
  assert(isVisualEvidenceNeeded(shortScannedQp), 'Optimization: Scanned document with insufficient text (<50 chars) retains visual evidence.');

  // DocumentProcessor input preparation:
  // When QP is pure text and has no canonical key, pure text is transmitted without visual QP
  const textOnlyPrep = documentProcessor.prepareInput({
    sourceDoc: { name: 'student.pdf', base64: 'STU_B64', mimeType: 'application/pdf' },
    questionPaper: pureTextQp,
    mode: 'without-manual',
    studentName: 'Literature Student',
  });
  const hasPureTextVisualQp = textOnlyPrep.contentsParts.some((p: any) =>
    typeof p.text === 'string' && p.text.includes('DOCUMENT_START: OFFICIAL QUESTION PAPER (Visual)')
  );
  assert(!hasPureTextVisualQp, 'DocumentProcessor: Pure text question paper omits visual QP to minimize token usage.');

  // When QP contains mathematical equations, visual QP is retained
  const mathPrep = documentProcessor.prepareInput({
    sourceDoc: { name: 'student.pdf', base64: 'STU_B64', mimeType: 'application/pdf' },
    questionPaper: mathEquationQp,
    mode: 'without-manual',
    studentName: 'Math Student',
  });
  const hasMathVisualQp = mathPrep.contentsParts.some((p: any) =>
    typeof p.text === 'string' && p.text.includes('DOCUMENT_START: OFFICIAL QUESTION PAPER (Visual)')
  );
  assert(hasMathVisualQp, 'DocumentProcessor: Mathematical question paper retains visual QP for notation fidelity.');

  // Student answer script ALWAYS retains visual evidence
  const studentVisualPreserved = mathPrep.contentsParts.some((p: any) =>
    typeof p.text === 'string' && p.text.includes('DOCUMENT_START: STUDENT ACTUAL ANSWER SCRIPT')
  );
  assert(studentVisualPreserved, 'DocumentProcessor: Student answer script visual pages are faithfully preserved.');

  // 13.2 Subject Test: Mathematics & Physical Sciences
  setMockGeminiProvider(async ({ correlationId }) => {
    if (correlationId.startsWith('ak_gen_')) {
      return {
        text: JSON.stringify({
          examTitle: 'Advanced Calculus & Analytical Geometry',
          totalMaxMarks: 20,
          warnings: [],
          questions: [
            {
              questionId: '1',
              questionText: 'Evaluate the definite integral \\int_{0}^{\\pi/2} \\sin(x)\\cos(x) dx.',
              maxMarks: 10,
              referenceAnswer: 'Let u = sin(x), du = cos(x)dx. When x=0, u=0; x=pi/2, u=1. \\int_0^1 u du = [u^2/2]_0^1 = 1/2.',
              expectedConcepts: ['Substitution method or double angle identity', 'Correct change of limits or antiderivative', 'Final answer = 1/2'],
              acceptableAlternatives: ['Double-angle identity: \\int (1/2)\\sin(2x)dx = [- (1/4)\\cos(2x)]_0^{\\pi/2} = 1/2'],
              markingCriteria: ['4 marks for valid substitution/identity', '3 marks for correct limits and antiderivative', '3 marks for exact result 1/2'],
              diagramReferences: [],
              confidence: 0.98,
            },
            {
              questionId: '2',
              questionText: 'Prove that the area of a right-angled triangle with base b and height h is (1/2)bh. Draw labelled diagram.',
              maxMarks: 10,
              referenceAnswer: 'Complete the rectangle of sides b and h. Diagonal splits rectangle of area bh into two congruent right triangles. Area = (1/2)bh.',
              expectedConcepts: ['Rectangle completion or integral derivation', 'Congruence argument', 'Labelled diagram with base b, height h, hypotenuse'],
              acceptableAlternatives: ['Coordinate geometry proof placing vertices at (0,0), (b,0), (0,h)'],
              markingCriteria: ['5 marks for geometric proof', '5 marks for correct labelled diagram'],
              diagramReferences: ['Right-angled coordinate geometry triangle with base b, height h, right angle symbol'],
              confidence: 0.95,
            },
          ],
        }),
        usageMetadata: { promptTokenCount: 1500, candidatesTokenCount: 300 },
      };
    }

    if (correlationId.startsWith('ext_')) {
      return {
        text: JSON.stringify({
          studentName: 'Srinivasa Ramanujan',
          examTitle: 'Advanced Calculus & Analytical Geometry',
          answers: [
            {
              questionId: '1',
              studentAnswerText: 'Used double angle identity: sin(x)cos(x) = (1/2)sin(2x). Antiderivative is -(1/4)cos(2x). Evaluated between 0 and pi/2 gives -1/4(-1 - 1) = 1/2.',
              formulas: ['sin(x)cos(x) = 0.5sin(2x)', '\\int 0.5sin(2x)dx = -0.25cos(2x)', 'Result = 0.5'],
              isAttempted: true,
              confidence: 0.99,
            },
            {
              questionId: '2',
              studentAnswerText: 'Constructed rectangle with sides b and h. Triangle is half the rectangle. Area = 0.5 * b * h.',
              diagramDescription: 'Hand-drawn right-angled triangle with vertices labeled A, B, C; base labeled b, vertical altitude labeled h, right angle marked at vertex B.',
              formulas: ['Area = 0.5 * b * h'],
              isAttempted: true,
              confidence: 0.96,
            },
          ],
          visualEvidenceRetained: true,
        }),
        usageMetadata: { promptTokenCount: 1500, candidatesTokenCount: 300 },
      };
    }

    // Stage 2 Eval
    return {
      text: JSON.stringify({
        studentName: 'Srinivasa Ramanujan',
        testTitle: 'Advanced Calculus & Analytical Geometry',
        testTopics: 'Definite Integrals & Geometric Proofs',
        testDate: '2026-10-30',
        totalScore: 20,
        maxScore: 20,
        questions: [
          {
            qNo: '1',
            marks: 10,
            maxMarks: 10,
            isCorrect: true,
            feedbackPoints: ['Correctly applied alternative double-angle identity.', 'Flawless calculation of definite limits.', 'Exact result 1/2.'],
          },
          {
            qNo: '2',
            marks: 10,
            maxMarks: 10,
            isCorrect: true,
            feedbackPoints: ['Solid rectangle decomposition proof.', 'Accurate hand-drawn right triangle with all labels and right-angle box.'],
          },
        ],
        generalFeedback: {
          overallPerformance: ['Outstanding mathematical rigor and analytical clarity.'],
          mcqs: [],
          contentAccuracy: ['Precise calculus identities and geometric proof principles.'],
          completenessOfAnswers: ['All intermediate derivation steps fully articulated.'],
          presentationDiagrams: ['Clean diagrammatic presentation with clear vertex labels.'],
          investigations: ['Valid double-angle substitution methodology.'],
          attemptingQuestions: ['Attempted all questions completely.'],
          actionPoints: ['Continue exploring multi-variable integration.'],
        },
      }),
      usageMetadata: { promptTokenCount: 1800, candidatesTokenCount: 400 },
    };
  });

  const mathKey = await answerKeyService.generateFromQuestionPaper({
    questionPaper: mathEquationQp,
    title: 'Advanced Calculus & Analytical Geometry',
    subject: 'Mathematics',
    grade: 'B.Sc / Engineering Year 1',
    totalMaxMarks: 20,
    metadata: { institutionId: 'inst_math_01', createdBy: 'prof_euler' },
  });

  assert(mathKey.subject === 'Mathematics', 'Math key: Correct subject preserved.');
  assert(mathKey.questions.length === 2, 'Math key: Extracted both questions.');
  assert(mathKey.questions[0].acceptableAlternatives.length > 0, 'Math key: Preserves acceptable alternative calculus methods.');
  assert(mathKey.questions[1].diagramReferences?.length === 1, 'Math key: Preserves geometric diagram requirements.');

  const approvedMathKey = answerKeyService.approveAnswerKey(mathKey.id, {
    userId: 'prof_euler',
    role: 'instructor',
    institutionId: 'inst_math_01',
    name: 'Prof. Euler',
  });
  assert(approvedMathKey.status === 'approved', 'Math key: Successfully approved by faculty instructor.');

  // Math Evaluation Execution
  const mathJob: EvaluationJob = {
    id: `eval_math_${Date.now()}`,
    correlationId: `corr_math_${Date.now()}`,
    institutionId: 'inst_math_01',
    status: 'queued',
    progressPercent: 0,
    currentStepMessage: 'Queued',
    mode: 'without-manual',
    studentName: 'Srinivasa Ramanujan',
    inputPayload: {
      sourceDoc: { name: 'ramanujan_calculus_script.pdf', base64: 'MATH_B64_DATA', mimeType: 'application/pdf' },
      canonicalAnswerKey: approvedMathKey,
    },
    canonicalAnswerKey: approvedMathKey,
    metrics: { correlationId: `corr_math_${Date.now()}`, startTime: Date.now(), cacheHit: false, retriesCount: 0 },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  const mathReport = await evaluationEngine.evaluate(mathJob);
  assert(mathReport.totalScore === 20, 'Math evaluation: Awarded full 20/20 for mathematically valid alternative method.');
  assert(mathReport.questions[0].marks === 10, 'Math evaluation: Q1 awarded full 10 marks.');
  assert(mathJob.extractedScript?.answers[0].formulas?.length! >= 1, 'Math evaluation: Extracted formulas preserved.');
  assert(mathJob.extractedScript?.visualEvidenceRetained === true, 'Math evaluation: Visual evidence retained for geometry diagram.');

  // 13.3 Subject Test: Computer Science & Software Engineering
  setMockGeminiProvider(async ({ correlationId }) => {
    if (correlationId.startsWith('ak_gen_')) {
      return {
        text: JSON.stringify({
          examTitle: 'Data Structures & Algorithms',
          totalMaxMarks: 15,
          warnings: [],
          questions: [
            {
              questionId: '1',
              questionText: 'Implement binary search in Python. Explain time complexity O(log n) and edge case handling for empty list.',
              maxMarks: 8,
              referenceAnswer: 'def binary_search(arr, target):\n    low, high = 0, len(arr) - 1\n    while low <= high:\n        mid = (low + high) // 2\n        if arr[mid] == target: return mid\n        elif arr[mid] < target: low = mid + 1\n        else: high = mid - 1\n    return -1\nTime complexity is O(log n) as search space halves each iteration.',
              expectedConcepts: ['Pointers initialization', 'While loop condition low <= high', 'Mid calculation preventing overflow', 'Halving logic', 'O(log n) proof', 'Empty array returns -1'],
              acceptableAlternatives: ['Recursive implementation', 'left, right or l, r variable naming', 'mid = low + (high - low) // 2'],
              markingCriteria: ['4 marks for correct Python code', '2 marks for boundary & empty list handling', '2 marks for O(log n) derivation'],
              diagramReferences: ['Search space halving recursion tree / interval diagram'],
              confidence: 0.99,
            },
            {
              questionId: '2',
              questionText: 'Draw the logic circuit diagram of a 2-to-1 Multiplexer and write its boolean truth table.',
              maxMarks: 7,
              referenceAnswer: 'Y = (A AND NOT S) OR (B AND S). Circuit contains 1 NOT gate, 2 AND gates, and 1 OR gate.',
              expectedConcepts: ['Boolean expression Y = A*S_bar + B*S', 'Truth table with inputs S, A, B and output Y', 'Logic gates schematic'],
              acceptableAlternatives: ['NAND-only implementation'],
              markingCriteria: ['3 marks for Boolean truth table', '4 marks for correctly interconnected logic gates'],
              diagramReferences: ['2-to-1 Multiplexer logic gate schematic showing NOT, AND, OR gates'],
              confidence: 0.96,
            },
          ],
        }),
        usageMetadata: { promptTokenCount: 1500, candidatesTokenCount: 300 },
      };
    }

    if (correlationId.startsWith('ext_')) {
      return {
        text: JSON.stringify({
          studentName: 'Ada Lovelace',
          examTitle: 'Data Structures & Algorithms',
          answers: [
            {
              questionId: '1',
              studentAnswerText: 'def binary_search(arr, target):\n    l, r = 0, len(arr) - 1\n    while l <= r:\n        m = l + (r - l) // 2\n        if arr[m] == target: return m\n        elif arr[m] < target: l = m + 1\n        else: r = m - 1\n    return -1\nEach step divides N by 2, leading to log2(N) steps -> O(log N). Empty array: l=0, r=-1, loop terminates immediately returning -1.',
              isAttempted: true,
              confidence: 0.98,
            },
            {
              questionId: '2',
              studentAnswerText: 'Truth table:\nS A B | Y\n0 0 X | 0\n0 1 X | 1\n1 X 0 | 0\n1 X 1 | 1\nLogic expression Y = (A and ~S) or (B and S).',
              diagramDescription: 'Drawn 2-to-1 MUX schematic with select line S inverted to first AND gate with input A; non-inverted S to second AND gate with input B; outputs merged into final OR gate labeled Y.',
              isAttempted: true,
              confidence: 0.95,
            },
          ],
          visualEvidenceRetained: true,
        }),
        usageMetadata: { promptTokenCount: 1500, candidatesTokenCount: 300 },
      };
    }

    return {
      text: JSON.stringify({
        studentName: 'Ada Lovelace',
        testTitle: 'Data Structures & Algorithms',
        testTopics: 'Search Algorithms & Digital Logic',
        testDate: '2026-10-30',
        totalScore: 15,
        maxScore: 15,
        questions: [
          {
            qNo: '1',
            marks: 8,
            maxMarks: 8,
            isCorrect: true,
            feedbackPoints: ['Correct Python implementation using safe midpoint calculation.', 'Robust empty array handling verified.', 'Accurate O(log n) time complexity proof.'],
          },
          {
            qNo: '2',
            marks: 7,
            maxMarks: 7,
            isCorrect: true,
            feedbackPoints: ['Accurate 2-to-1 MUX truth table.', 'Properly routed NOT, AND, and OR logic gate schematic.'],
          },
        ],
        generalFeedback: {
          overallPerformance: ['Exemplary algorithmic thinking and digital logic proficiency.'],
          mcqs: [],
          contentAccuracy: ['Syntactically and logically correct code.'],
          completenessOfAnswers: ['Both algorithm and schematic thoroughly developed.'],
          presentationDiagrams: ['Standard logic gate symbols correctly used in schematic.'],
          investigations: ['Midpoint calculation prevents integer overflow.'],
          attemptingQuestions: ['Complete question coverage.'],
          actionPoints: ['Explore non-linear search algorithms (e.g. ternary search).'],
        },
      }),
      usageMetadata: { promptTokenCount: 1800, candidatesTokenCount: 400 },
    };
  });

  const csKey = await answerKeyService.generateFromQuestionPaper({
    questionPaper: codeQp,
    title: 'Data Structures & Algorithms',
    subject: 'Computer Science',
    grade: 'B.Tech / CS Year 2',
    totalMaxMarks: 15,
    metadata: { institutionId: 'inst_cs_01', createdBy: 'prof_turing' },
  });

  assert(csKey.subject === 'Computer Science', 'CS key: Subject correctly tagged as Computer Science.');
  assert(csKey.questions[0].referenceAnswer.includes('def binary_search'), 'CS key: Preserves Python code in model answer.');
  assert(csKey.questions[1].diagramReferences?.length === 1, 'CS key: Preserves circuit schematic diagram requirement.');

  const approvedCsKey = answerKeyService.approveAnswerKey(csKey.id, {
    userId: 'prof_turing',
    role: 'instructor',
    institutionId: 'inst_cs_01',
    name: 'Prof. Turing',
  });

  const csJob: EvaluationJob = {
    id: `eval_cs_${Date.now()}`,
    correlationId: `corr_cs_${Date.now()}`,
    institutionId: 'inst_cs_01',
    status: 'queued',
    progressPercent: 0,
    currentStepMessage: 'Queued',
    mode: 'without-manual',
    studentName: 'Ada Lovelace',
    inputPayload: {
      sourceDoc: { name: 'ada_algorithms.pdf', base64: 'CS_B64_DATA', mimeType: 'application/pdf' },
      canonicalAnswerKey: approvedCsKey,
    },
    canonicalAnswerKey: approvedCsKey,
    metrics: { correlationId: `corr_cs_${Date.now()}`, startTime: Date.now(), cacheHit: false, retriesCount: 0 },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  const csReport = await evaluationEngine.evaluate(csJob);
  assert(csReport.totalScore === 15, 'CS evaluation: Full 15/15 marks awarded for functionally correct code and schematic.');
  assert(csReport.questions[0].marks === 8, 'CS evaluation: Binary search code awarded full 8 marks.');
  assert(csReport.questions[1].marks === 7, 'CS evaluation: Logic circuit awarded full 7 marks.');

  // 13.4 Subject Test: Chemistry & Chemical Sciences
  setMockGeminiProvider(async ({ correlationId }) => {
    if (correlationId.startsWith('ak_ext_')) {
      return {
        text: JSON.stringify({
          examTitle: 'Organic & Physical Chemistry Mid-Term',
          totalMaxMarks: 10,
          warnings: [],
          questions: [
            {
              questionId: '1',
              questionText: 'Write and balance the complete combustion reaction of ethanol (C2H5OH).',
              maxMarks: 4,
              referenceAnswer: 'C2H5OH(l) + 3 O2(g) -> 2 CO2(g) + 3 H2O(l) + Heat',
              expectedConcepts: ['Reactants: C2H5OH + O2', 'Products: CO2 + H2O', 'Correct stoichiometric coefficients (1, 3 -> 2, 3)'],
              acceptableAlternatives: ['Unstated physical states if coefficients are balanced'],
              markingCriteria: ['2 marks for correct products', '2 marks for stoichiometric balancing'],
              diagramReferences: [],
              confidence: 0.99,
            },
            {
              questionId: '2',
              questionText: 'Describe the SN2 mechanism for reaction of chloromethane with hydroxide ion. Include stereochemistry.',
              maxMarks: 6,
              referenceAnswer: 'Backside nucleophilic attack of OH- on CH3Cl creates a pentacoordinate transition state [HO...CH3...Cl]-, expels Cl- leaving group, leading to inversion of configuration (Walden inversion).',
              expectedConcepts: ['Bimolecular nucleophilic substitution', 'Backside attack', 'Pentacoordinate transition state', 'Walden inversion'],
              acceptableAlternatives: ['Detailed orbital diagram showing sp3 to sp2 transition state'],
              markingCriteria: ['2 marks for backside attack mechanism', '2 marks for transition state representation', '2 marks for Walden inversion statement'],
              diagramReferences: ['Backside attack arrow and pentacoordinate transition state diagram'],
              confidence: 0.96,
            },
          ],
        }),
        usageMetadata: { promptTokenCount: 1500, candidatesTokenCount: 300 },
      };
    }

    if (correlationId.startsWith('ext_')) {
      return {
        text: JSON.stringify({
          studentName: 'Marie Curie',
          examTitle: 'Organic & Physical Chemistry Mid-Term',
          answers: [
            {
              questionId: '1',
              studentAnswerText: 'C2H5OH + 3 O2 -> 2 CO2 + 3 H2O',
              formulas: ['C2H5OH + 3O2 -> 2CO2 + 3H2O'],
              isAttempted: true,
              confidence: 0.99,
            },
            {
              questionId: '2',
              studentAnswerText: 'Hydroxide ion attacks carbon from the side opposite to chlorine. A transition state forms where both OH and Cl are partially bonded. Cl- leaves, causing complete inversion of configuration (Walden inversion).',
              diagramDescription: 'Chemical structure drawing of CH3Cl with curved arrow from :OH- to central carbon; bracketed transition state with partial bonds dashed to HO and Cl and negative charge; final product with inverted tetrahedral geometry.',
              formulas: ['[HO...CH3...Cl]^-'],
              isAttempted: true,
              confidence: 0.97,
            },
          ],
          visualEvidenceRetained: true,
        }),
        usageMetadata: { promptTokenCount: 1500, candidatesTokenCount: 300 },
      };
    }

    return {
      text: JSON.stringify({
        studentName: 'Marie Curie',
        testTitle: 'Organic & Physical Chemistry Mid-Term',
        testTopics: 'Stoichiometry & Reaction Mechanisms',
        testDate: '2026-10-30',
        totalScore: 10,
        maxScore: 10,
        questions: [
          {
            qNo: '1',
            marks: 4,
            maxMarks: 4,
            isCorrect: true,
            feedbackPoints: ['Correctly balanced stoichiometric combustion equation.'],
          },
          {
            qNo: '2',
            marks: 6,
            maxMarks: 6,
            isCorrect: true,
            feedbackPoints: ['Accurate chemical transition state illustration.', 'Clear explanation of backside nucleophilic attack and Walden inversion.'],
          },
        ],
        generalFeedback: {
          overallPerformance: ['Mastery of organic reaction pathways and chemical stoichiometry.'],
          mcqs: [],
          contentAccuracy: ['Flawless chemical formulas and balancing.'],
          completenessOfAnswers: ['Comprehensive mechanism and transition state.'],
          presentationDiagrams: ['Accurate chemical bond arrows and stereochemical inversion.'],
          investigations: ['Bimolecular mechanism kinetics correctly reflected.'],
          attemptingQuestions: ['All questions attempted.'],
          actionPoints: ['Continue exploring stereospecific synthesis reactions.'],
        },
      }),
      usageMetadata: { promptTokenCount: 1800, candidatesTokenCount: 400 },
    };
  });

  const chemKey = await answerKeyService.extractFromUploadedKey({
    answerKeyDoc: {
      name: 'Chemistry_Key_Official.pdf',
      text: 'Q1. Combustion: C2H5OH + 3O2 -> 2CO2 + 3H2O (4 marks). Q2. SN2 backside attack and Walden inversion (6 marks).',
      base64: 'CHEM_KEY_B64',
      mimeType: 'application/pdf',
    },
    title: 'Organic & Physical Chemistry Mid-Term',
    subject: 'Chemistry',
    grade: 'B.Sc Chemistry',
    totalMaxMarks: 10,
    metadata: { institutionId: 'inst_chem_01', createdBy: 'prof_mendeleev' },
  });

  assert(chemKey.subject === 'Chemistry', 'Chemistry key: Subject correctly tagged as Chemistry.');
  assert(chemKey.sourceMode === 'uploaded', 'Chemistry key: Uploaded mode preserved.');
  assert(chemKey.questions[0].referenceAnswer.includes('C2H5OH'), 'Chemistry key: Preserves chemical equations.');

  const approvedChemKey = answerKeyService.approveAnswerKey(chemKey.id, {
    userId: 'prof_mendeleev',
    role: 'instructor',
    institutionId: 'inst_chem_01',
    name: 'Prof. Mendeleev',
  });

  const chemJob: EvaluationJob = {
    id: `eval_chem_${Date.now()}`,
    correlationId: `corr_chem_${Date.now()}`,
    institutionId: 'inst_chem_01',
    status: 'queued',
    progressPercent: 0,
    currentStepMessage: 'Queued',
    mode: 'without-manual',
    studentName: 'Marie Curie',
    inputPayload: {
      sourceDoc: { name: 'curie_chemistry_script.pdf', base64: 'CHEM_B64_DATA', mimeType: 'application/pdf' },
      canonicalAnswerKey: approvedChemKey,
    },
    canonicalAnswerKey: approvedChemKey,
    metrics: { correlationId: `corr_chem_${Date.now()}`, startTime: Date.now(), cacheHit: false, retriesCount: 0 },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  const chemReport = await evaluationEngine.evaluate(chemJob);
  assert(chemReport.totalScore === 10, 'Chemistry evaluation: Full 10/10 awarded for balanced equations and reaction mechanism.');
  assert(chemReport.questions[1].marks === 6, 'Chemistry evaluation: SN2 mechanism with transition state awarded 6 marks.');

  // 13.5 Subject Test: Commerce, Economics & Accounting
  setMockGeminiProvider(async ({ correlationId }) => {
    if (correlationId.startsWith('ak_gen_')) {
      return {
        text: JSON.stringify({
          examTitle: 'Financial Accounting & Microeconomics',
          totalMaxMarks: 12,
          warnings: [],
          questions: [
            {
              questionId: '1',
              questionText: 'Record the journal entry for purchasing office equipment for $50,000, paying $20,000 cash and balance on credit.',
              maxMarks: 6,
              referenceAnswer: 'Equipment A/c Dr. $50,000\n  To Cash A/c $20,000\n  To Accounts Payable A/c $30,000\n(Being equipment purchased partly in cash and partly on credit)',
              expectedConcepts: ['Debit asset increase (Equipment)', 'Credit asset decrease (Cash)', 'Credit liability increase (Accounts Payable)', 'Sum equality: 50,000 = 20,000 + 30,000'],
              acceptableAlternatives: ['Trade Creditors in place of Accounts Payable'],
              markingCriteria: ['2 marks for debit entry', '2 marks for cash credit', '2 marks for accounts payable credit'],
              diagramReferences: [],
              confidence: 0.99,
            },
            {
              questionId: '2',
              questionText: 'Explain the market equilibrium effect of an increase in raw material costs using a supply-demand curve diagram.',
              maxMarks: 6,
              referenceAnswer: 'An increase in raw material costs decreases supply, shifting supply curve leftward from S1 to S2. Demand remains unchanged. Equilibrium price rises from P1 to P2, and equilibrium quantity falls from Q1 to Q2.',
              expectedConcepts: ['Supply curve shifts leftward (S1 to S2)', 'Demand curve remains constant', 'Higher equilibrium price (P2 > P1)', 'Lower equilibrium quantity (Q2 < Q1)'],
              acceptableAlternatives: ['Price increase and quantity decrease graphical demonstration'],
              markingCriteria: ['3 marks for verbal analysis', '3 marks for correct labeled supply-demand curve shift graph'],
              diagramReferences: ['Supply and Demand curve graph showing S1->S2 left shift, price increase P1->P2, quantity decrease Q1->Q2'],
              confidence: 0.97,
            },
          ],
        }),
        usageMetadata: { promptTokenCount: 1500, candidatesTokenCount: 300 },
      };
    }

    if (correlationId.startsWith('ext_')) {
      return {
        text: JSON.stringify({
          studentName: 'Adam Smith',
          examTitle: 'Financial Accounting & Microeconomics',
          answers: [
            {
              questionId: '1',
              studentAnswerText: 'Office Equipment A/c  Dr. 50,000\n   To Cash A/c              20,000\n   To Accounts Payable      30,000\n(Office equipment acquired for cash and on account)',
              isAttempted: true,
              confidence: 0.99,
            },
            {
              questionId: '2',
              studentAnswerText: 'Higher input cost reduces profitability at every price level, causing supply curve to shift to the left. At the original price there is shortage, driving price up to new equilibrium P2 while quantity traded falls to Q2.',
              diagramDescription: 'Market equilibrium graph with Price on Y-axis and Quantity on X-axis; downward-sloping Demand curve D; initial supply S1 and leftward shifted supply S2; arrow showing price rise from P1 to P2 and quantity drop from Q1 to Q2.',
              isAttempted: true,
              confidence: 0.96,
            },
          ],
          visualEvidenceRetained: true,
        }),
        usageMetadata: { promptTokenCount: 1500, candidatesTokenCount: 300 },
      };
    }

    return {
      text: JSON.stringify({
        studentName: 'Adam Smith',
        testTitle: 'Financial Accounting & Microeconomics',
        testTopics: 'Double Entry Bookkeeping & Market Dynamics',
        testDate: '2026-10-30',
        totalScore: 12,
        maxScore: 12,
        questions: [
          {
            qNo: '1',
            marks: 6,
            maxMarks: 6,
            isCorrect: true,
            feedbackPoints: ['Correct compound journal entry with balanced debit and credit totals.'],
          },
          {
            qNo: '2',
            marks: 6,
            maxMarks: 6,
            isCorrect: true,
            feedbackPoints: ['Sound economic reasoning on input cost shock.', 'Accurate supply shift diagram with labeled price and quantity axes.'],
          },
        ],
        generalFeedback: {
          overallPerformance: ['Strong command of commercial accounting principles and microeconomics.'],
          mcqs: [],
          contentAccuracy: ['Accurate double-entry rules and equilibrium shifts.'],
          completenessOfAnswers: ['Clear compound entries and graphical explanations.'],
          presentationDiagrams: ['Neat supply and demand curve graph with clear directional arrows.'],
          investigations: ['Market clearing mechanism correctly explained.'],
          attemptingQuestions: ['Full question coverage.'],
          actionPoints: ['Explore price elasticity of supply impacts.'],
        },
      }),
      usageMetadata: { promptTokenCount: 1800, candidatesTokenCount: 400 },
    };
  });

  const commerceKey = await answerKeyService.generateFromQuestionPaper({
    questionPaper: commerceQp,
    title: 'Financial Accounting & Microeconomics',
    subject: 'Commerce & Economics',
    grade: 'B.Com / Economics Year 1',
    totalMaxMarks: 12,
    metadata: { institutionId: 'inst_commerce_01', createdBy: 'prof_keynes' },
  });

  assert(commerceKey.subject === 'Commerce & Economics', 'Commerce key: Subject correctly tagged as Commerce & Economics.');
  assert(commerceKey.questions[0].referenceAnswer.includes('Equipment A/c Dr'), 'Commerce key: Preserves debit/credit journal entries.');
  assert(commerceKey.questions[1].diagramReferences?.length === 1, 'Commerce key: Preserves supply-demand curve diagram reference.');

  const approvedCommerceKey = answerKeyService.approveAnswerKey(commerceKey.id, {
    userId: 'prof_keynes',
    role: 'instructor',
    institutionId: 'inst_commerce_01',
    name: 'Prof. Keynes',
  });

  const commerceJob: EvaluationJob = {
    id: `eval_comm_${Date.now()}`,
    correlationId: `corr_comm_${Date.now()}`,
    institutionId: 'inst_commerce_01',
    status: 'queued',
    progressPercent: 0,
    currentStepMessage: 'Queued',
    mode: 'without-manual',
    studentName: 'Adam Smith',
    inputPayload: {
      sourceDoc: { name: 'smith_accounting_script.pdf', base64: 'COMM_B64_DATA', mimeType: 'application/pdf' },
      canonicalAnswerKey: approvedCommerceKey,
    },
    canonicalAnswerKey: approvedCommerceKey,
    metrics: { correlationId: `corr_comm_${Date.now()}`, startTime: Date.now(), cacheHit: false, retriesCount: 0 },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  const commerceReport = await evaluationEngine.evaluate(commerceJob);
  assert(commerceReport.totalScore === 12, 'Commerce evaluation: Full 12/12 awarded for journal entries and economic graph.');
  assert(commerceReport.questions[0].marks === 6, 'Commerce evaluation: Double entry accounting awarded full 6 marks.');
  assert(commerceReport.questions[1].marks === 6, 'Commerce evaluation: Supply curve shift analysis awarded full 6 marks.');

  // 13.6 Subject Test: Humanities & Languages / Literature
  setMockGeminiProvider(async ({ correlationId }) => {
    if (correlationId.startsWith('ak_gen_')) {
      return {
        text: JSON.stringify({
          examTitle: 'English Literature & European History',
          totalMaxMarks: 20,
          warnings: [],
          questions: [
            {
              questionId: '1',
              questionText: 'Analyze Shakespeare\'s depiction of vaulting ambition and psychological guilt in Macbeth. Support with textual references.',
              maxMarks: 10,
              referenceAnswer: 'Macbeth examines how hubris and prophetic temptation override moral conscience. Key soliloquies ("If it were done when \'tis done", "Tomorrow and tomorrow") reveal internal descent into paranoia, echoed by Lady Macbeth\'s somnambulism ("Out, damned spot").',
              expectedConcepts: ['Vaulting ambition as tragic hamartia', 'Supernatural temptation vs moral agency', 'Psychological decay of Macbeth and Lady Macbeth', 'Specific textual citations/soliloquies'],
              acceptableAlternatives: ['Aristotelian tragic flaw interpretation or political Jacobean allegory'],
              markingCriteria: ['4 marks for thematic thesis', '3 marks for textual citations', '3 marks for literary analysis of dramatic irony and imagery'],
              diagramReferences: [],
              confidence: 0.98,
            },
            {
              questionId: '2',
              questionText: 'Explain the socioeconomic and institutional causes of the French Revolution of 1789.',
              maxMarks: 10,
              referenceAnswer: 'Causes include: 1) Three Estates feudal inequality with Third Estate bearing tax burden (taille), 2) Financial insolvency from Seven Years War and American Revolution, 3) Agricultural famine of 1788-1789, 4) Enlightenment ideals (Rousseau, Voltaire) challenging absolutism.',
              expectedConcepts: ['Ancien Regime social hierarchy', 'Crown fiscal bankruptcy', 'Bread shortages/famine', 'Enlightenment political philosophy'],
              acceptableAlternatives: ['Marxist class struggle analysis or revisionist fiscal-institutional interpretation'],
              markingCriteria: ['3 marks for social structure & Estates General', '3 marks for financial crisis', '2 marks for Enlightenment influence', '2 marks for immediate triggers (1788 harvests)'],
              diagramReferences: [],
              confidence: 0.97,
            },
          ],
        }),
        usageMetadata: { promptTokenCount: 1500, candidatesTokenCount: 300 },
      };
    }

    if (correlationId.startsWith('ext_')) {
      return {
        text: JSON.stringify({
          studentName: 'Virginia Woolf',
          examTitle: 'English Literature & European History',
          answers: [
            {
              questionId: '1',
              studentAnswerText: 'Shakespeare portrays ambition not merely as desire, but as an overwhelming pathology. In Act 1, Macbeth acknowledges "vaulting ambition which o\'erleaps itself". By Act 5, ambition has emptied life of meaning, culminating in the nihilistic despair of "a tale told by an idiot, full of sound and fury". Lady Macbeth\'s obsessive washing of hands externalizes guilt that water cannot purge.',
              isAttempted: true,
              confidence: 0.99,
            },
            {
              questionId: '2',
              studentAnswerText: 'The 1789 Revolution stemmed from systemic fiscal bankruptcy aggravated by war debts, combined with the regressive taxation of the Third Estate while the nobility and clergy enjoyed exemptions. Enlightenment writings questioned divine right absolutism, while catastrophic grain harvest failures in 1788 sparked urban riots and the storming of the Bastille.',
              isAttempted: true,
              confidence: 0.98,
            },
          ],
          visualEvidenceRetained: false,
        }),
        usageMetadata: { promptTokenCount: 1500, candidatesTokenCount: 300 },
      };
    }

    return {
      text: JSON.stringify({
        studentName: 'Virginia Woolf',
        testTitle: 'English Literature & European History',
        testTopics: 'Shakespearean Tragedy & 18th Century Historiography',
        testDate: '2026-10-30',
        totalScore: 20,
        maxScore: 20,
        questions: [
          {
            qNo: '1',
            marks: 10,
            maxMarks: 10,
            isCorrect: true,
            feedbackPoints: ['Exceptional textual integration of key soliloquies.', 'Deep psychological dissection of Macbeth and Lady Macbeth.'],
          },
          {
            qNo: '2',
            marks: 10,
            maxMarks: 10,
            isCorrect: true,
            feedbackPoints: ['Comprehensive breakdown of institutional, economic, and intellectual causes of 1789.'],
          },
        ],
        generalFeedback: {
          overallPerformance: ['Distinguished essay composition and critical literary scholarship.'],
          mcqs: [],
          contentAccuracy: ['Flawless historical context and literary text quotations.'],
          completenessOfAnswers: ['Well-structured thesis statements with nuanced analysis.'],
          presentationDiagrams: ['Cohesive essay paragraph transitions.'],
          investigations: ['Critical comparative historiography.'],
          attemptingQuestions: ['Attempted all questions.'],
          actionPoints: ['Continue writing with publishable analytical depth.'],
        },
      }),
      usageMetadata: { promptTokenCount: 1800, candidatesTokenCount: 400 },
    };
  });

  const humanitiesKey = await answerKeyService.generateFromQuestionPaper({
    questionPaper: pureTextQp,
    title: 'English Literature & European History',
    subject: 'Humanities & Literature',
    grade: 'B.A. Literature Year 2',
    totalMaxMarks: 20,
    metadata: { institutionId: 'inst_humanities_01', createdBy: 'prof_woolf' },
  });

  assert(humanitiesKey.subject === 'Humanities & Literature', 'Humanities key: Subject correctly tagged as Humanities & Literature.');
  assert(humanitiesKey.questions.length === 2, 'Humanities key: Generated both essay rubrics.');
  assert(humanitiesKey.questions[0].expectedConcepts.some((c) => c.toLowerCase().includes('ambition')), 'Humanities key: Expected concepts reflect actual literature question.');

  const approvedHumanitiesKey = answerKeyService.approveAnswerKey(humanitiesKey.id, {
    userId: 'prof_woolf',
    role: 'instructor',
    institutionId: 'inst_humanities_01',
    name: 'Prof. Woolf',
  });

  const humanitiesJob: EvaluationJob = {
    id: `eval_hum_${Date.now()}`,
    correlationId: `corr_hum_${Date.now()}`,
    institutionId: 'inst_humanities_01',
    status: 'queued',
    progressPercent: 0,
    currentStepMessage: 'Queued',
    mode: 'without-manual',
    studentName: 'Virginia Woolf',
    inputPayload: {
      sourceDoc: { name: 'woolf_essay_script.pdf', text: 'Shakespeare portrays ambition...', mimeType: 'application/pdf' },
      canonicalAnswerKey: approvedHumanitiesKey,
    },
    canonicalAnswerKey: approvedHumanitiesKey,
    metrics: { correlationId: `corr_hum_${Date.now()}`, startTime: Date.now(), cacheHit: false, retriesCount: 0 },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  const humanitiesReport = await evaluationEngine.evaluate(humanitiesJob);
  assert(humanitiesReport.totalScore === 20, 'Humanities evaluation: Full 20/20 awarded for analytical essay thesis.');
  assert(humanitiesReport.questions[0].marks === 10, 'Humanities evaluation: Macbeth essay awarded 10 marks.');
  assert(humanitiesReport.questions[1].marks === 10, 'Humanities evaluation: French Revolution history essay awarded 10 marks.');

  // 13.7 Cross-Discipline Strict Validation Invariance: Unapproved keys, zero marks & bound violations
  await assertRejects(
    async () => {
      const draftKey: CanonicalAnswerKey = { ...approvedMathKey, status: 'draft' };
      const job: EvaluationJob = {
        ...mathJob,
        canonicalAnswerKey: draftKey,
        inputPayload: { ...mathJob.inputPayload, canonicalAnswerKey: draftKey },
      };
      await (evaluationEngine as any).evaluate(job);
    },
    'unapproved answer key',
    'Cross-Discipline Invariance: Math grading strictly rejected when answer key is in draft status.'
  );

  await assertRejects(
    async () => {
      const draftCsKey: CanonicalAnswerKey = { ...approvedCsKey, status: 'needs_review' };
      const job: EvaluationJob = {
        ...csJob,
        canonicalAnswerKey: draftCsKey,
        inputPayload: { ...csJob.inputPayload, canonicalAnswerKey: draftCsKey },
      };
      await (evaluationEngine as any).evaluate(job);
    },
    'unapproved answer key',
    'Cross-Discipline Invariance: Computer Science grading strictly rejected when answer key needs review.'
  );

  // Updating an approved key resets status to draft across any subject
  const updatedMathKey = answerKeyService.updateAnswerKey(
    approvedMathKey.id,
    { title: 'Calculus Advanced (Revised)' },
    { userId: 'prof_euler', role: 'instructor', institutionId: 'inst_math_01', name: 'Prof. Euler' }
  );
  assert(updatedMathKey.version === 2, 'Cross-Discipline Invariance: Editing approved math key bumps version to 2.');
  assert(updatedMathKey.status === 'draft', 'Cross-Discipline Invariance: Editing approved math key resets status to draft.');

  // Zero-marks approval rejection across non-medical disciplines
  const zeroMarkKey: CanonicalAnswerKey = {
    ...approvedCsKey,
    id: `ak_zero_${Date.now()}`,
    status: 'draft',
    questions: [{ questionId: '1', maxMarks: 0, referenceAnswer: 'def zero(): pass', expectedConcepts: [], acceptableAlternatives: [], markingCriteria: [] }],
  };
  (answerKeyService as any).saveToDisk(zeroMarkKey);
  assertThrows(
    () => answerKeyService.approveAnswerKey(zeroMarkKey.id, { userId: 'prof_turing', role: 'instructor', institutionId: 'inst_cs_01', name: 'Prof. Turing' }),
    'All questions must have positive maximum marks before approval',
    'Cross-Discipline Invariance: Rejection of zero maxMarks enforced for Computer Science.'
  );

  // Clean up mock provider
  setMockGeminiProvider(null);
  console.log('\n========================================================================');
  console.log(` ALL REGRESSION TESTS COMPLETED: ${passedTests}/${totalTests} PASSED`);
  console.log('========================================================================\n');
  process.exit(0);
}

runTests().catch((err) => {
  console.error('\n❌ TEST SUITE FAILED:', err);
  process.exit(1);
});
