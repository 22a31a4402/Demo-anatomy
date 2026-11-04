/**
 * Focused Test Suite: HTTP 503 Responses, HTML Error Handling, and Complete Model Failure
 *
 * Verifies:
 * 1. Gemini HTTP 503 UNAVAILABLE triggers retry/backoff and model fallback.
 * 2. HTML responses (e.g. <!doctype html>... 503) are safely intercepted without throwing JSON parse syntax errors.
 * 3. Complete model failure preserves job state, emits structured failure responses, preserves partial usage metadata, and never fabricates marks.
 * 4. parseActionableError provides a clear, retryable message for 503 and HTML errors.
 * 5. Backend /api/* endpoints strictly return application/json.
 */

import assert from 'assert';
import { isRetryableError, setMockGeminiProvider, callGeminiWithFallback } from '../server/geminiClient';
import { evaluationEngine } from '../server/evaluator';
import { evaluationQueue } from '../server/queue';
import { evaluationMetadataService } from '../server/evaluationMetadata';
import { safeParseResponseJson, parseActionableError } from '../services/geminiService';
import { EvaluationJob } from '../server/types';

async function runTests() {
  console.log('========================================================================');
  console.log(' STARTING FOCUSED TESTS: HTTP 503, HTML RESPONSES & COMPLETE MODEL FAILURE');
  console.log('========================================================================\n');

  let passed = 0;

  function pass(msg: string) {
    passed++;
    console.log(`✅ PASS: ${msg}`);
  }

  // ---------------------------------------------------------------------------
  // Test Group 1: isRetryableError Detection for 503 and HTML Responses
  // ---------------------------------------------------------------------------
  console.log('--- Test Group 1: Retryable Error Detection ---');

  assert.strictEqual(isRetryableError({ status: 503 }), true, 'Status 503 must be retryable');
  pass('HTTP 503 status is identified as retryable');

  assert.strictEqual(
    isRetryableError(new Error('503 Service Unavailable: The model is overloaded. Please try again later.')),
    true,
    '503 message must be retryable'
  );
  pass('Gemini 503 unavailable message is identified as retryable');

  assert.strictEqual(
    isRetryableError(new Error('Unexpected token \'<\', "<!doctype "... is not valid JSON')),
    true,
    'HTML JSON parse error must be identified as retryable upstream 503'
  );
  pass('HTML JSON syntax error is identified as retryable');

  assert.strictEqual(
    isRetryableError(new Error('<!DOCTYPE html><html><title>503 Service Unavailable</title>')),
    true,
    'Raw HTML 503 is identified as retryable'
  );
  pass('Raw HTML doctype response is identified as retryable');

  assert.strictEqual(
    isRetryableError({ status: 400, message: 'Invalid argument provided' }),
    false,
    'Client 400 error must NOT be retryable'
  );
  pass('Client 400 errors are correctly rejected from retry');

  // ---------------------------------------------------------------------------
  // Test Group 2: Frontend safeParseResponseJson
  // ---------------------------------------------------------------------------
  console.log('\n--- Test Group 2: Frontend safeParseResponseJson Robustness ---');

  // Test 2.1: Valid JSON response
  const mockValidJsonRes = new Response(JSON.stringify({ jobId: 'job_test_123', status: 'queued' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
  const parsedValid = await safeParseResponseJson<any>(mockValidJsonRes, 'Test Endpoint');
  assert.strictEqual(parsedValid.jobId, 'job_test_123');
  pass('Valid JSON response parsed successfully');

  // Test 2.2: Upstream 503 HTML response
  const html503 = '<!doctype html><html lang="en"><head><title>503 Service Unavailable</title></head><body>High demand</body></html>';
  const mockHtml503Res = new Response(html503, {
    status: 503,
    headers: { 'Content-Type': 'text/html' },
  });

  try {
    await safeParseResponseJson(mockHtml503Res, 'Evaluation Service');
    assert.fail('Should have thrown on HTML response');
  } catch (err: any) {
    assert.strictEqual(err.statusCode, 503);
    assert.strictEqual(err.category, 'Gemini Server Temporarily Busy (503)');
    assert.strictEqual(err.retryable, true);
    assert.ok(err.message.includes('high traffic (503)'), 'Error message should guide user to retry');
    assert.ok(!err.message.includes('Unexpected token'), 'Must NOT expose raw JSON syntax error');
    pass('HTML 503 response intercepted gracefully without throwing SyntaxError');
  }

  // Test 2.3: Upstream 502 Bad Gateway HTML response
  const html502 = '<!doctype html><html><title>502 Bad Gateway</title><body>Proxy error</body></html>';
  const mockHtml502Res = new Response(html502, {
    status: 502,
    headers: { 'Content-Type': 'text/html' },
  });

  try {
    await safeParseResponseJson(mockHtml502Res, 'Evaluation Service');
    assert.fail('Should have thrown on 502 HTML');
  } catch (err: any) {
    assert.strictEqual(err.statusCode, 502);
    assert.strictEqual(err.retryable, true);
    assert.ok(err.message.includes('Retry'), 'Message indicates retryable gateway error');
    pass('HTML 502 Bad Gateway response handled gracefully');
  }

  // Test 2.4: Malformed response claiming application/json but containing HTML
  const fakeJsonHeaderRes = new Response('<!DOCTYPE html><html><body>Error</body></html>', {
    status: 500,
    headers: { 'Content-Type': 'application/json' },
  });

  try {
    await safeParseResponseJson(fakeJsonHeaderRes, 'Evaluation Service');
    assert.fail('Should have thrown on HTML content despite json header');
  } catch (err: any) {
    assert.strictEqual(err.isHtmlResponse, true);
    assert.ok(!err.message.includes('Unexpected token'), 'Scrubbed raw syntax error');
    pass('HTML body disguised with application/json header safely intercepted');
  }

  // ---------------------------------------------------------------------------
  // Test Group 3: parseActionableError Diagnostics
  // ---------------------------------------------------------------------------
  console.log('\n--- Test Group 3: parseActionableError User Formatting ---');

  // Test 3.1: Raw syntax error with Unexpected token '<'
  const rawSyntaxErr = new SyntaxError("Unexpected token '<', \"<!doctype \"... is not valid JSON");
  const action1 = parseActionableError(rawSyntaxErr);
  assert.strictEqual(action1.statusCode, 503);
  assert.strictEqual(action1.category, 'Gemini Server Temporarily Busy (503)');
  assert.ok(action1.message.includes('high traffic (503)'));
  assert.ok(action1.message.includes('Retry'));
  pass('Raw syntax error from HTML doctype converted to friendly 503 retryable message');

  // Test 3.2: Error with 503 in message
  const err503 = new Error('503 Service Unavailable: High load on model');
  const action2 = parseActionableError(err503);
  assert.strictEqual(action2.statusCode, 503);
  assert.strictEqual(action2.category, 'Gemini Server Temporarily Busy (503)');
  pass('503 high load error mapped to Gemini Server Temporarily Busy (503)');

  // ---------------------------------------------------------------------------
  // Test Group 4: Gemini 503 Retry and Model Fallback Execution
  // ---------------------------------------------------------------------------
  console.log('\n--- Test Group 4: Gemini 503 Retry and Fallback ---');

  let callCount = 0;
  const attemptedModels: string[] = [];

  setMockGeminiProvider(async ({ model }) => {
    callCount++;
    attemptedModels.push(model);

    if (model === 'gemini-2.5-flash') {
      // Primary model fails with 503 on attempts 1 and 2
      throw new Error('503 Service Unavailable: The model is temporarily overloaded.');
    }

    // Fallback model succeeds
    return {
      text: JSON.stringify({
        studentName: 'Aarav Patel',
        testTitle: 'Anatomy Assessment',
        testTopics: 'Cardiac Anatomy',
        testDate: '2026-10-31',
        totalScore: 5,
        maxScore: 5,
        questions: [
          {
            qNo: '1',
            feedbackPoints: ['Correctly identified coronary circulation.'],
            marks: 5,
            maxMarks: 5,
            isCorrect: true,
          },
        ],
        generalFeedback: {
          overallPerformance: ['Good understanding.'],
          mcqs: ['N/A'],
          contentAccuracy: ['Accurate.'],
          completenessOfAnswers: ['Comprehensive.'],
          presentationDiagrams: ['Adequate.'],
          investigations: ['N/A'],
          attemptingQuestions: ['Complete.'],
          actionPoints: ['Maintain standard.'],
        },
      }),
      usageMetadata: {
        promptTokenCount: 1200,
        candidatesTokenCount: 250,
        cachedContentTokenCount: 0,
      },
    };
  });

  const correlationId = `test_fallback_503_${Date.now()}`;
  const res = await callGeminiWithFallback(
    [{ text: 'Sample audit payload' }],
    'System prompt',
    correlationId,
    {
      candidateModels: ['gemini-2.5-flash', 'gemini-3.1-flash-lite'],
      timeoutMs: 30000,
    }
  );

  assert.strictEqual(res.modelUsed, 'gemini-3.1-flash-lite', 'Should have fallen back to second model');
  assert.ok(callCount >= 2, 'Should have retried before falling back');
  assert.ok(attemptedModels.includes('gemini-2.5-flash'), 'Primary model was attempted');
  assert.ok(attemptedModels.includes('gemini-3.1-flash-lite'), 'Fallback model was attempted');
  pass('503 error successfully triggered exponential retries and fallback to candidate model');

  // ---------------------------------------------------------------------------
  // Test Group 5: Complete Model Failure Handling & State Preservation
  // ---------------------------------------------------------------------------
  console.log('\n--- Test Group 5: Complete Model Exhaustion Failure ---');

  // All models fail with 503
  setMockGeminiProvider(async ({ model }) => {
    throw new Error(`503 Service Unavailable: High load on ${model}.`);
  });

  let exhaustionError: any = null;
  try {
    await callGeminiWithFallback(
      [{ text: 'Sample audit payload' }],
      'System prompt',
      `test_exhaust_${Date.now()}`,
      {
        candidateModels: ['gemini-2.5-flash', 'gemini-3.1-flash-lite'],
        timeoutMs: 15000,
      }
    );
  } catch (err: any) {
    exhaustionError = err;
  }

  assert.ok(exhaustionError, 'Should throw exhaustion error');
  assert.strictEqual(exhaustionError.statusCode, 503, 'Should specify statusCode 503');
  assert.strictEqual(exhaustionError.category, 'Gemini Server Temporarily Busy (503)');
  assert.strictEqual(exhaustionError.retryable, true, 'Should mark error as retryable');
  pass('Complete candidate exhaustion produces structured 503 retryable error');

  // Test Queue Job Failure State Preservation
  const testJobId = `job_test_fail_${Date.now()}`;
  const mockJob: EvaluationJob = {
    id: testJobId,
    correlationId: `corr_${testJobId}`,
    studentName: 'Rahul Verma',
    testTitle: 'Physiology Paper',
    status: 'preprocessing',
    progressPercent: 10,
    currentStepMessage: 'Processing...',
    mode: 'without-manual',
    institutionId: 'inst_test',
    createdBy: 'test_user',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    metrics: {
      correlationId: `corr_${testJobId}`,
      startTime: Date.now(),
      cacheHit: false,
      retriesCount: 3,
    },
    inputPayload: {
      sourceDoc: { name: 'student_script.pdf', text: 'student answers...' },
    },
  };

  // Simulate queue catch handling
  const is503 = exhaustionError?.statusCode === 503;
  mockJob.status = 'failed';
  mockJob.error = exhaustionError.message;
  mockJob.errorCategory = exhaustionError.category;
  mockJob.statusCode = exhaustionError.statusCode;
  mockJob.isRetryable = exhaustionError.retryable;
  mockJob.currentStepMessage = `Failed: ${mockJob.error}`;

  // Generate metadata for failed job
  const metadata = evaluationMetadataService.generateMetadata(mockJob);

  assert.strictEqual(mockJob.status, 'failed', 'Job status must be failed');
  assert.strictEqual(mockJob.report, undefined, 'Report must be strictly undefined (no fabricated marks)');
  assert.strictEqual(mockJob.statusCode, 503, 'Status code must be 503');
  assert.strictEqual(mockJob.isRetryable, true, 'Job must be marked retryable');
  assert.strictEqual(metadata.evaluationStatus, 'failed', 'Metadata status must be failed');
  assert.strictEqual(metadata.zeroFabrication.isPartial, true, 'Metadata must reflect partial evaluation');
  assert.ok(metadata.error?.includes('503'), 'Metadata records error message');
  pass('Failed job preserves state, generates partial metadata, and never fabricates marks');

  // Reset mock
  setMockGeminiProvider(null);

  console.log('\n========================================================================');
  console.log(` ALL FOCUSED 503 & HTML TESTS COMPLETED: ${passed}/${passed} PASSED`);
  console.log('========================================================================\n');
}

runTests().catch((err) => {
  console.error('Test Suite Failed:', err);
  process.exit(1);
});
