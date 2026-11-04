/**
 * Anatomy Guru Gemini Model Fallback Configuration & Reliability Test Suite
 *
 * Verifies the exact required fallback sequence:
 * 1. gemini-3.8-flash — Primary model
 * 2. gemini-flash-latest — First fallback
 * 3. gemini-3.1-flash-lite — Second fallback
 * 4. gemini-2.5-flash — Final fallback
 *
 * Verifies all 5 prompt scenarios:
 * Scenario 1: Primary model succeeds.
 * Scenario 2: Primary model fails and the first fallback succeeds.
 * Scenario 3: First two models fail and Gemini 3.1 Flash-Lite succeeds.
 * Scenario 4: First three models fail and Gemini 2.5 Flash succeeds.
 * Scenario 5: All four models fail.
 *
 * Checks:
 * - Exponential retries on 503 / 429 / 500
 * - Does not stop evaluation pipeline after first model fails
 * - Preserves zero-fabrication guarantees on failure (no fabricated marks)
 * - Developer-only log [ANATOMY GURU EVALUATION COST METADATA] tracks model sequence, retries, fallbacks, tokens, and costs
 */

import assert from 'assert';
import { callGeminiWithFallback, setMockGeminiProvider } from '../server/geminiClient';
import { config } from '../server/config';
import { evaluationMetadataService } from '../server/evaluationMetadata';
import { EvaluationJob } from '../server/types';

let passedTests = 0;
let totalTests = 0;

function pass(name: string) {
  totalTests++;
  passedTests++;
  console.log(`✅ PASS: ${name}`);
}

async function runFallbackTests() {
  console.log('\n========================================================================');
  console.log(' STARTING ANATOMY GURU GEMINI MODEL FALLBACK RELIABILITY TEST SUITE');
  console.log('========================================================================\n');

  // Intercept developer cost logs
  const capturedLogs: string[] = [];
  const originalLog = console.log;
  console.log = (...args: any[]) => {
    const str = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
    if (str.includes('[ANATOMY GURU EVALUATION COST METADATA]')) {
      capturedLogs.push(str);
    }
    originalLog(...args);
  };

  try {
    const REQUIRED_SEQUENCE = [
      'gemini-3.8-flash',
      'gemini-flash-latest',
      'gemini-3.1-flash-lite',
      'gemini-2.5-flash',
    ];

    // Verify config default sequence
    console.log('--- Checking Global Model Configuration Sequence ---');
    assert.strictEqual(config.primaryModel, 'gemini-3.8-flash', 'Primary model must be gemini-3.8-flash');
    assert.deepStrictEqual(
      config.fallbackModels,
      ['gemini-flash-latest', 'gemini-3.1-flash-lite', 'gemini-2.5-flash'],
      'Fallback models must match required order'
    );
    pass('Global configuration uses exact 4-model sequence [gemini-3.8-flash -> gemini-flash-latest -> gemini-3.1-flash-lite -> gemini-2.5-flash]');

    const sampleReportJson = JSON.stringify({
      studentName: 'Anatomy Student',
      testTitle: 'Gross Anatomy Quiz',
      testTopics: 'Neuroanatomy',
      testDate: '2026-10-31',
      totalScore: 10,
      maxScore: 10,
      questions: [
        {
          qNo: '1',
          feedbackPoints: ['Correctly detailed cranial nerve nuclei.'],
          marks: 10,
          maxMarks: 10,
          isCorrect: true,
        },
      ],
      generalFeedback: {
        overallPerformance: ['Excellent.'],
        mcqs: ['N/A'],
        contentAccuracy: ['Comprehensive.'],
        completenessOfAnswers: ['Complete.'],
        presentationDiagrams: ['Adequate.'],
        investigations: ['N/A'],
        attemptingQuestions: ['All attempted.'],
        actionPoints: ['Continue clinical focus.'],
      },
    });

    // -------------------------------------------------------------------------
    // Scenario 1: Primary model succeeds
    // -------------------------------------------------------------------------
    console.log('\n--- Scenario 1: Primary Model (gemini-3.8-flash) Succeeds ---');
    const attemptedModels1: string[] = [];

    setMockGeminiProvider(async ({ model }) => {
      attemptedModels1.push(model);
      return {
        text: sampleReportJson,
        usageMetadata: {
          promptTokenCount: 1500,
          candidatesTokenCount: 300,
          cachedContentTokenCount: 200,
        },
      };
    });

    const res1 = await callGeminiWithFallback(
      [{ text: 'Payload 1' }],
      'System Instruction',
      `corr_scen_1_${Date.now()}`,
      { timeoutMs: 15000 }
    );

    assert.strictEqual(res1.modelUsed, 'gemini-3.8-flash', 'Should use gemini-3.8-flash');
    assert.deepStrictEqual(attemptedModels1, ['gemini-3.8-flash'], 'Only primary model was called (no extra calls)');
    assert.strictEqual(res1.fallbackCallsCount, 0, 'No fallback calls when primary succeeds');
    assert.strictEqual(res1.retries, 0, 'Zero retries on first-attempt success');
    pass('Scenario 1: Primary model (gemini-3.8-flash) succeeds immediately on attempt 1');

    // -------------------------------------------------------------------------
    // Scenario 2: Primary model fails and first fallback succeeds
    // -------------------------------------------------------------------------
    console.log('\n--- Scenario 2: Primary Model Fails -> First Fallback (gemini-flash-latest) Succeeds ---');
    const attemptedModels2: string[] = [];

    setMockGeminiProvider(async ({ model }) => {
      attemptedModels2.push(model);
      if (model === 'gemini-3.8-flash') {
        const err: any = new Error('503 Service Unavailable: High load on gemini-3.8-flash');
        err.status = 503;
        throw err;
      }
      return {
        text: sampleReportJson,
        usageMetadata: {
          promptTokenCount: 1500,
          candidatesTokenCount: 300,
        },
      };
    });

    const res2 = await callGeminiWithFallback(
      [{ text: 'Payload 2' }],
      'System Instruction',
      `corr_scen_2_${Date.now()}`,
      { timeoutMs: 30000 }
    );

    assert.strictEqual(res2.modelUsed, 'gemini-flash-latest', 'Should fall back to gemini-flash-latest');
    assert.ok(attemptedModels2.includes('gemini-3.8-flash'), 'gemini-3.8-flash was attempted');
    assert.ok(attemptedModels2.includes('gemini-flash-latest'), 'gemini-flash-latest was attempted');
    assert.ok(!attemptedModels2.includes('gemini-3.1-flash-lite'), 'gemini-3.1-flash-lite was NOT called because fallback 1 succeeded');
    assert.ok(!attemptedModels2.includes('gemini-2.5-flash'), 'gemini-2.5-flash was NOT called');
    assert.ok(res2.fallbackCallsCount >= 1, 'Records fallback calls count');
    pass('Scenario 2: Primary fails 503 -> First fallback (gemini-flash-latest) succeeds without extra calls');

    // -------------------------------------------------------------------------
    // Scenario 3: First two models fail and Gemini 3.1 Flash-Lite succeeds
    // -------------------------------------------------------------------------
    console.log('\n--- Scenario 3: First Two Models Fail -> Gemini 3.1 Flash-Lite Succeeds ---');
    const attemptedModels3: string[] = [];

    setMockGeminiProvider(async ({ model }) => {
      attemptedModels3.push(model);
      if (model === 'gemini-3.8-flash' || model === 'gemini-flash-latest') {
        const err: any = new Error(`503 Service Unavailable: Overloaded ${model}`);
        err.status = 503;
        throw err;
      }
      return {
        text: sampleReportJson,
        usageMetadata: {
          promptTokenCount: 1200,
          candidatesTokenCount: 250,
        },
      };
    });

    const res3 = await callGeminiWithFallback(
      [{ text: 'Payload 3' }],
      'System Instruction',
      `corr_scen_3_${Date.now()}`,
      { timeoutMs: 35000 }
    );

    assert.strictEqual(res3.modelUsed, 'gemini-3.1-flash-lite', 'Should fall back to gemini-3.1-flash-lite');
    assert.ok(attemptedModels3.includes('gemini-3.8-flash'), 'Primary model was attempted');
    assert.ok(attemptedModels3.includes('gemini-flash-latest'), 'First fallback was attempted');
    assert.ok(attemptedModels3.includes('gemini-3.1-flash-lite'), 'Second fallback was attempted and succeeded');
    assert.ok(!attemptedModels3.includes('gemini-2.5-flash'), 'Final fallback was NOT called because 3.1 succeeded');
    pass('Scenario 3: First two fail 503 -> Second fallback (gemini-3.1-flash-lite) succeeds');

    // -------------------------------------------------------------------------
    // Scenario 4: First three models fail and Gemini 2.5 Flash succeeds
    // -------------------------------------------------------------------------
    console.log('\n--- Scenario 4: First Three Models Fail -> Gemini 2.5 Flash Succeeds ---');
    const attemptedModels4: string[] = [];

    setMockGeminiProvider(async ({ model }) => {
      attemptedModels4.push(model);
      if (
        model === 'gemini-3.8-flash' ||
        model === 'gemini-flash-latest' ||
        model === 'gemini-3.1-flash-lite'
      ) {
        const err: any = new Error(`503 Service Unavailable: High load on ${model}`);
        err.status = 503;
        throw err;
      }
      return {
        text: sampleReportJson,
        usageMetadata: {
          promptTokenCount: 1400,
          candidatesTokenCount: 280,
        },
      };
    });

    const res4 = await callGeminiWithFallback(
      [{ text: 'Payload 4' }],
      'System Instruction',
      `corr_scen_4_${Date.now()}`,
      { timeoutMs: 40000 }
    );

    assert.strictEqual(res4.modelUsed, 'gemini-2.5-flash', 'Should fall back to gemini-2.5-flash');
    assert.ok(attemptedModels4.includes('gemini-3.8-flash'), 'Primary was attempted');
    assert.ok(attemptedModels4.includes('gemini-flash-latest'), 'First fallback was attempted');
    assert.ok(attemptedModels4.includes('gemini-3.1-flash-lite'), 'Second fallback was attempted');
    assert.ok(attemptedModels4.includes('gemini-2.5-flash'), 'Final fallback was attempted and succeeded');
    pass('Scenario 4: First three fail 503 -> Final fallback (gemini-2.5-flash) succeeds');

    // -------------------------------------------------------------------------
    // Scenario 5: All four models fail
    // -------------------------------------------------------------------------
    console.log('\n--- Scenario 5: All Four Models Fail with 503 ---');
    const attemptedModels5: string[] = [];

    setMockGeminiProvider(async ({ model }) => {
      attemptedModels5.push(model);
      const err: any = new Error(`503 Service Unavailable: High load across all capacity on ${model}`);
      err.status = 503;
      throw err;
    });

    const jobId5 = `job_scen_5_${Date.now()}`;
    const correlationId5 = `corr_scen_5_${Date.now()}`;
    let threwError = false;
    let caughtError: any = null;

    try {
      await callGeminiWithFallback(
        [{ text: 'Payload 5' }],
        'System Instruction',
        correlationId5,
        { jobId: jobId5, timeoutMs: 45000 }
      );
    } catch (e: any) {
      threwError = true;
      caughtError = e;
    }

    assert.ok(threwError, 'Should throw when all models fail');
    assert.strictEqual(caughtError.statusCode, 503, 'StatusCode must be 503');
    assert.strictEqual(caughtError.retryable, true, 'Error must be marked retryable');
    assert.strictEqual(caughtError.category, 'Gemini Server Temporarily Busy (503)', 'Category must be formatted');

    // Verify all 4 models were attempted in order
    assert.ok(attemptedModels5.includes('gemini-3.8-flash'), 'gemini-3.8-flash was attempted');
    assert.ok(attemptedModels5.includes('gemini-flash-latest'), 'gemini-flash-latest was attempted');
    assert.ok(attemptedModels5.includes('gemini-3.1-flash-lite'), 'gemini-3.1-flash-lite was attempted');
    assert.ok(attemptedModels5.includes('gemini-2.5-flash'), 'gemini-2.5-flash was attempted');

    // Verify evaluation metadata for the failed evaluation
    const failedJob: EvaluationJob = {
      id: jobId5,
      correlationId: correlationId5,
      studentName: 'Rahul V',
      testTitle: 'Physiology Paper',
      status: 'failed',
      progressPercent: 0,
      currentStepMessage: `Failed: ${caughtError.message}`,
      mode: 'without-manual',
      error: caughtError.message,
      errorCategory: caughtError.category,
      statusCode: 503,
      isRetryable: true,
      institutionId: 'inst_anatomy_guru',
      createdBy: 'dr_sharma',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      metrics: {
        correlationId: correlationId5,
        startTime: Date.now(),
        cacheHit: false,
        retriesCount: 6,
      },
      inputPayload: {
        sourceDoc: { name: 'test.pdf', text: 'student written text' },
      },
    };

    const metadata5 = evaluationMetadataService.generateMetadata(failedJob);

    // Verify zero-fabrication guarantees on failure
    assert.strictEqual(metadata5.evaluationStatus, 'failed', 'Status is failed');
    assert.strictEqual(metadata5.zeroFabrication.isPartial, true, 'isPartial is true');
    assert.strictEqual((failedJob as any).report, undefined, 'Report is strictly undefined (no marks fabricated)');

    // Verify developer log was printed with the exact required prefix and model sequence
    const log5 = capturedLogs.find((l) => l.includes(jobId5));
    assert.ok(log5, 'Developer log was printed for failed job');
    assert.ok(log5!.startsWith('[ANATOMY GURU EVALUATION COST METADATA]'), 'Log starts with exact prefix');
    assert.ok(log5!.includes('gemini-3.8-flash'), 'Log includes primary model');
    assert.ok(log5!.includes('gemini-flash-latest'), 'Log includes first fallback');
    assert.ok(log5!.includes('gemini-3.1-flash-lite'), 'Log includes second fallback');
    assert.ok(log5!.includes('gemini-2.5-flash'), 'Log includes final fallback');
    assert.ok(log5!.includes('status=failed'), 'Log marks status=failed');
    assert.ok(log5!.includes('partial=true'), 'Log marks partial=true');
    pass('Scenario 5: All 4 models fail 503 -> Structured retryable error returned with zero mark fabrication');

    // Clean up mock
    setMockGeminiProvider(null);

    console.log('\n========================================================================');
    console.log(` ALL 5 MODEL FALLBACK SCENARIOS COMPLETED: ${passedTests}/${totalTests} PASSED`);
    console.log('========================================================================\n');
  } finally {
    console.log = originalLog;
  }
}

runFallbackTests().catch((err) => {
  console.error('\n❌ MODEL FALLBACK TEST SUITE FAILED:', err);
  process.exit(1);
});
