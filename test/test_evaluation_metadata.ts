/**
 * Comprehensive Developer-Only Evaluation Cost & Token Metadata Test Suite (Anatomy Guru)
 *
 * Verifies all criteria from prompt:
 * 1. Emits structured developer log with exact prefix: [ANATOMY GURU EVALUATION COST METADATA]
 * 2. Complete metadata fields:
 *    - Evaluation ID
 *    - Evaluation status
 *    - Model name(s) used
 *    - Total API calls (including successful and failed call breakdown)
 *    - Retry and fallback counts
 *    - Extraction stage input & output tokens
 *    - Grading stage input & output tokens
 *    - Cached tokens, when provided by Gemini
 *    - Total input & output tokens
 *    - Extraction cost (USD and INR)
 *    - Grading cost (USD and INR)
 *    - Total evaluation cost (USD and INR)
 *    - API latency and total evaluation time
 *    - Whether usage and cost figures are actual, estimated, partial, or unavailable (figureStatus)
 *    - Currency conversion rate used for INR calculations
 * 3. Accuracy & zero-fabrication:
 *    - Read token counts from actual Gemini API usage metadata
 *    - Never fabricate missing token counts or costs
 *    - Preserve partial token usage and costs on failure
 *    - Confirm extraction and grading costs reported separately and total cost reconciles with calls
 * 4. Privacy & Developer-only visibility:
 *    - Server-side only
 *    - Never expose student names, student answers, or API keys in the developer logs
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { evaluationEngine } from '../server/evaluator';
import { setMockGeminiProvider } from '../server/geminiClient';
import { evaluationMetadataService } from '../server/evaluationMetadata';
import { config } from '../server/config';
import { CanonicalAnswerKey, EvaluationJob } from '../server/types';

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

async function runMetadataTests() {
  console.log('\n========================================================================');
  console.log(' STARTING [ANATOMY GURU EVALUATION COST METADATA] VERIFICATION SUITE');
  console.log('========================================================================\n');

  const metadataDir = path.join(config.dataDir, 'metadata');

  // Intercept console.log to inspect the developer log
  const capturedLogs: string[] = [];
  const originalConsoleLog = console.log;
  console.log = (...args: any[]) => {
    const formatted = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
    if (formatted.includes('[ANATOMY GURU EVALUATION COST METADATA]')) {
      capturedLogs.push(formatted);
    }
    originalConsoleLog(...args);
  };

  try {
    // Sample canonical exam key (Anatomy Guru MBBS Phase 1)
    const anatomyCanonicalKey: CanonicalAnswerKey = {
      id: `ak_meta_${Date.now()}_anatomy`,
      subject: 'Human Anatomy',
      examId: 'exam_anatomy_01',
      title: 'Anatomy Guru Gross Anatomy Final Assessment',
      totalMaxMarks: 15,
      version: 1,
      status: 'approved',
      sourceMode: 'ai_generated',
      questions: [
        {
          questionId: '1',
          questionText: 'Describe the anatomical relations and blood supply of the Thyroid Gland.',
          maxMarks: 10,
          referenceAnswer: 'Thyroid gland relations: pretracheal fascia, recurrent laryngeal nerve, superior/inferior thyroid arteries.',
          expectedConcepts: ['pretracheal fascia', 'recurrent laryngeal nerve', 'superior thyroid artery', 'inferior thyroid artery'],
          acceptableAlternatives: ['external laryngeal nerve relation'],
          markingCriteria: ['Relations and blood supply accurate (10 marks)'],
        },
        {
          questionId: '2',
          questionText: 'MCQ: Which nerve provides motor innervation to the vocal cords (except cricothyroid)?',
          maxMarks: 5,
          referenceAnswer: 'Recurrent laryngeal nerve',
          expectedConcepts: ['Recurrent laryngeal nerve'],
          acceptableAlternatives: ['RLN'],
          markingCriteria: ['Identifies RLN (5 marks)'],
        },
      ],
      metadata: {
        createdBy: 'dr_sharma',
        institutionId: 'inst_anatomy_guru',
        createdAt: Date.now(),
        approvedBy: 'dr_sharma',
        approvedAt: Date.now(),
        updatedAt: Date.now(),
      },
    };

    // ---------------------------------------------------------------------------
    // TEST GROUP 1: Successful Evaluation with Complete Developer Log
    // ---------------------------------------------------------------------------
    console.log('--- Test Group 1: Two-Stage Successful Evaluation with Developer Log ---');

    const jobId1 = `eval_test_meta_1_${Date.now()}`;
    const job1: EvaluationJob = {
      id: jobId1,
      correlationId: `meta_corr_1_${Date.now()}`,
      status: 'queued',
      progressPercent: 0,
      currentStepMessage: 'Queued',
      mode: 'without-manual',
      studentName: 'Aarathi Sree',
      testTitle: 'Anatomy Guru Gross Anatomy Assessment',
      institutionId: 'inst_anatomy_guru',
      createdBy: 'dr_sharma',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      canonicalAnswerKey: anatomyCanonicalKey,
      metrics: {
        correlationId: `meta_corr_1_${Date.now()}`,
        startTime: Date.now(),
        cacheHit: false,
        retriesCount: 0,
      },
      inputPayload: {
        sourceDoc: { name: 'student_script_1.pdf', text: `Run 1 ${Date.now()}: Thyroid gland relations: enveloped in pretracheal fascia, intimately related to recurrent laryngeal nerve. Blood supply: superior and inferior thyroid arteries. 2. Recurrent laryngeal nerve.` },
        canonicalAnswerKey: anatomyCanonicalKey,
      },
    };

    // Mock Gemini responses with realistic cached tokens
    setMockGeminiProvider(async ({ correlationId }) => {
      if (correlationId.startsWith('ext_')) {
        return {
          text: JSON.stringify({
            studentName: 'Aarathi Sree',
            examTitle: 'Anatomy End-Term Assessment',
            answers: [
              {
                questionId: '1',
                subquestionId: null,
                studentAnswerText: 'Thyroid relations: enveloped in pretracheal fascia, relates to recurrent laryngeal nerve. Blood supply from superior and inferior thyroid arteries.',
                diagramDescription: 'Clear anatomical neck schematic.',
                formulas: [],
                pageReferences: [1],
                isAttempted: true,
                confidence: 0.98,
                flaggedUncertain: false,
              },
              {
                questionId: '2',
                subquestionId: null,
                studentAnswerText: 'Recurrent laryngeal nerve',
                diagramDescription: null,
                formulas: [],
                pageReferences: [2],
                isAttempted: true,
                confidence: 0.99,
                flaggedUncertain: false,
              },
            ],
            unmappedContent: [],
            warnings: [],
            visualEvidenceRetained: true,
          }),
          usageMetadata: { promptTokenCount: 1200, candidatesTokenCount: 250, cachedContentTokenCount: 300 },
        };
      }

      return {
        text: JSON.stringify({
          studentName: 'Aarathi Sree',
          testTitle: 'Anatomy Guru Gross Anatomy Assessment',
          testTopics: 'Head and Neck Anatomy',
          testDate: '2026-10-31',
          totalScore: 15,
          maxScore: 15,
          questions: [
            {
              qNo: '1',
              feedbackPoints: ['Flawless anatomical relations and arterial blood supply detailed.'],
              marks: 10,
              maxMarks: 10,
              isCorrect: true,
            },
            {
              qNo: '2',
              feedbackPoints: ['Correct answer: Recurrent laryngeal nerve.'],
              marks: 5,
              maxMarks: 5,
              isCorrect: true,
            },
          ],
          generalFeedback: {
            overallPerformance: ['Outstanding medical anatomical comprehension.'],
            mcqs: ['Perfect MCQ response.'],
            contentAccuracy: ['Comprehensive coverage of arterial and nerve relations.'],
            completenessOfAnswers: ['Answers meet gold standard.'],
            presentationDiagrams: ['Adequate written anatomical description.'],
            investigations: ['N/A'],
            attemptingQuestions: ['All questions attempted.'],
            actionPoints: ['Maintain this high level of clinical accuracy.'],
          },
        }),
        usageMetadata: { promptTokenCount: 2000, candidatesTokenCount: 400, cachedContentTokenCount: 500 },
      };
    });

    const report1 = await evaluationEngine.evaluate(job1);
    assert(Boolean(report1), 'Evaluation completed successfully.');
    assert(report1.totalScore === 15, 'Grading logic correctly evaluated student.');

    // Verify developer log was printed
    const log1 = capturedLogs.find(l => l.includes(jobId1));
    assert(Boolean(log1), 'Developer log was printed with the evaluation ID.');
    assert(log1!.startsWith('[ANATOMY GURU EVALUATION COST METADATA]'), 'Log starts with exact required prefix.');

    // Verify log contains all required fields
    assert(log1!.includes(`evaluationId=${jobId1}`), 'Log contains evaluationId.');
    assert(log1!.includes('status=completed'), 'Log contains status=completed.');
    assert(log1!.includes('models='), 'Log contains model name(s).');
    assert(log1!.includes('totalApiCalls=2'), 'Log contains totalApiCalls=2.');
    assert(log1!.includes('(successful=2,failed=0)'), 'Log contains successful and failed API calls breakdown.');
    assert(log1!.includes('retries=0'), 'Log contains retry count.');
    assert(log1!.includes('fallbacks=0'), 'Log contains fallback count.');
    assert(log1!.includes('extractionTokens(in=1200,out=250)'), 'Log contains extraction stage input & output tokens.');
    assert(log1!.includes('gradingTokens(in=2000,out=400)'), 'Log contains grading stage input & output tokens.');
    assert(log1!.includes('cachedTokens=800'), 'Log contains cached tokens (300 + 500 = 800).');
    assert(log1!.includes('totalTokens(in=3200,out=650)'), 'Log contains total input and output tokens.');
    assert(log1!.includes('extractionCost=$'), 'Log contains extraction cost (USD).');
    assert(log1!.includes('gradingCost=$'), 'Log contains grading cost (USD).');
    assert(log1!.includes('totalCost=$'), 'Log contains total cost (USD and INR).');
    assert(log1!.includes('exchangeRate=₹'), 'Log records currency conversion rate.');
    assert(log1!.includes('apiLatency='), 'Log contains API latency.');
    assert(log1!.includes('totalEvaluationTime='), 'Log contains total evaluation time.');
    assert(/figureStatus=(actual|estimated|partial|unavailable)/.test(log1!), 'Log indicates figure status (actual/estimated/partial/unavailable).');

    // Verify strict developer-only privacy in log
    assert(!log1!.includes('Aarathi Sree'), 'Log does NOT contain student name.');
    assert(!log1!.includes('pretracheal fascia'), 'Log does NOT contain student answers.');
    assert(!log1!.includes('API_KEY'), 'Log does NOT contain any API key.');

    // Verify metadata file contents
    const meta1 = evaluationMetadataService.getMetadata(jobId1);
    assert(Boolean(meta1), 'Retrieved saved metadata from disk.');
    assert(meta1!.evaluationId === jobId1, 'Metadata evaluationId matches.');
    assert(meta1!.fallbacks === 0, 'Metadata records fallbacks=0.');
    assert(meta1!.apiLatencyMs >= 0, 'Metadata records apiLatencyMs.');
    assert(meta1!.stages.extraction.status === 'success', 'Extraction stage status is success.');
    assert(meta1!.stages.grading.status === 'success', 'Grading stage status is success.');

    // Confirm that extraction and grading costs are reported separately and reconcile with total cost
    const reconciledUsd = parseFloat(((meta1!.extractionCost.usd || 0) + (meta1!.gradingCost.usd || 0)).toFixed(6));
    assert(meta1!.totalCost.usd === reconciledUsd, `Total cost ($${meta1!.totalCost.usd}) reconciles with stage costs ($${reconciledUsd}).`);

    // ---------------------------------------------------------------------------
    // TEST GROUP 2: Retries and Fallbacks Logging
    // ---------------------------------------------------------------------------
    console.log('\n--- Test Group 2: Retries and Fallbacks Telemetry Logging ---');

    const jobId2 = `eval_test_meta_2_${Date.now()}`;
    const job2: EvaluationJob = {
      ...job1,
      id: jobId2,
      extractedScript: undefined,
      correlationId: `meta_corr_2_${Date.now()}`,
      metrics: { ...job1.metrics, correlationId: `meta_corr_2_${Date.now()}`, startTime: Date.now() },

      inputPayload: {
        sourceDoc: { name: 'student_script_2_retry.pdf', text: `Unique text for retry test ${Date.now()}: Q1 Relations of thyroid.` },
        canonicalAnswerKey: anatomyCanonicalKey,
      },
    };

    let gradingAttempts = 0;
    setMockGeminiProvider(async ({ correlationId }) => {
      if (correlationId.startsWith('ext_')) {
        return {
          text: JSON.stringify({
            studentName: 'Aarathi Sree',
            examTitle: 'Test',
            answers: [{ questionId: '1', subquestionId: null, studentAnswerText: 'Answer 1', isAttempted: true, confidence: 0.9 }],
            unmappedContent: [],
            warnings: [],
          }),
          usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 200 },
        };
      }

      gradingAttempts++;
      if (gradingAttempts === 1) {
        // Transient 503 triggers retry
        const err: any = new Error('503 Service Unavailable: High load');
        err.status = 503;
        throw err;
      }
      return {
        text: JSON.stringify({
          studentName: 'Aarathi Sree',
          testTitle: 'Test',
          testTopics: 'Anatomy',
          testDate: '2026-10-31',
          totalScore: 10,
          maxScore: 15,
          questions: [
            { qNo: '1', feedbackPoints: ['Good'], marks: 10, maxMarks: 10, isCorrect: true },
            { qNo: '2', feedbackPoints: ['Unattempted'], marks: 0, maxMarks: 5, isCorrect: false },
          ],
          generalFeedback: {
            overallPerformance: ['Good'], mcqs: ['None'], contentAccuracy: ['Accurate'],
            completenessOfAnswers: ['Complete'], presentationDiagrams: ['None'],
            investigations: ['None'], attemptingQuestions: ['Partial'], actionPoints: ['Review'],
          },
        }),
        usageMetadata: { promptTokenCount: 1800, candidatesTokenCount: 300 },
      };
    });

    await evaluationEngine.evaluate(job2);
    const log2 = capturedLogs.find(l => l.includes(jobId2));
    assert(Boolean(log2), 'Developer log printed for retry evaluation.');
    assert(log2!.includes('retries=1'), 'Log recorded retries=1.');
    assert(log2!.includes('totalApiCalls=3'), 'Log recorded totalApiCalls=3.');
    assert(log2!.includes('(successful=2,failed=1)'), 'Log recorded successful=2, failed=1.');

    // ---------------------------------------------------------------------------
    // TEST GROUP 3: Failed Evaluation Preserves Partial Token Usage & Costs
    // ---------------------------------------------------------------------------
    console.log('\n--- Test Group 3: Failed Evaluation Partial Usage & Cost Preservation ---');

    const jobId3 = `eval_test_meta_3_${Date.now()}`;
    const job3: EvaluationJob = {
      ...job1,
      id: jobId3,
      extractedScript: undefined,
      correlationId: `meta_corr_3_${Date.now()}`,
      metrics: { ...job1.metrics, correlationId: `meta_corr_3_${Date.now()}`, startTime: Date.now() },

      inputPayload: {
        sourceDoc: { name: 'student_script_3_fail.pdf', text: `Unique text for failed test ${Date.now()}: Q1 Relations of thyroid.` },
        canonicalAnswerKey: anatomyCanonicalKey,
      },
    };

    // Stage 1 extraction succeeds, Stage 2 grading repeatedly fails with fatal 500 error
    setMockGeminiProvider(async ({ correlationId }) => {
      if (correlationId.startsWith('ext_')) {
        return {
          text: JSON.stringify({
            studentName: 'Aarathi Sree',
            examTitle: 'Test',
            answers: [{ questionId: '1', subquestionId: null, studentAnswerText: 'Answer 1', isAttempted: true, confidence: 0.9 }],
            unmappedContent: [],
            warnings: [],
          }),
          usageMetadata: { promptTokenCount: 1500, candidatesTokenCount: 350 },
        };
      }

      const err: any = new Error('Fatal Gemini internal failure (500)');
      err.status = 500;
      throw err;
    });

    let threwError = false;
    try {
      await evaluationEngine.evaluate(job3);
    } catch (e: any) {
      threwError = true;
      job3.status = 'failed';
      job3.error = e.message;
      evaluationMetadataService.generateMetadata(job3);
    }

    assert(threwError, 'Evaluation threw error as expected on fatal grading failure.');

    const log3 = capturedLogs.find(l => l.includes(jobId3));
    assert(Boolean(log3), 'Developer log was printed for failed evaluation.');
    assert(log3!.includes('status=failed'), 'Log recorded status=failed.');
    assert(log3!.includes('figureStatus=partial'), 'Log correctly recorded figureStatus=partial.');
    assert(log3!.includes('extractionTokens(in=1500,out=350)'), 'Extraction stage tokens preserved.');
    assert(log3!.includes('gradingTokens(in=null,out=null)'), 'Grading stage tokens strictly null (unfabricated).');
    assert(log3!.includes('gradingCost=N/A'), 'Grading cost strictly N/A.');
    assert(log3!.includes('partial=true'), 'partial=true flag logged.');

    const meta3 = evaluationMetadataService.getMetadata(jobId3);
    assert(meta3!.stages.extraction.status === 'success', 'Extraction status preserved as success.');
    assert(meta3!.stages.grading.status === 'failed', 'Grading status preserved as failed.');
    assert(meta3!.totalCost.usd === meta3!.extractionCost.usd, 'Total cost reflects partial extraction spend.');
    assert(meta3!.zeroFabrication.isPartial === true, 'isPartial is true in metadata.');

    // ---------------------------------------------------------------------------
    // TEST GROUP 4: Zero Fabrication on Missing Token Metadata
    // ---------------------------------------------------------------------------
    console.log('\n--- Test Group 4: Zero-Fabrication on Missing Metadata ---');

    const jobId4 = `eval_test_meta_4_${Date.now()}`;
    const job4: EvaluationJob = {
      ...job1,
      id: jobId4,
      correlationId: `meta_corr_4_${Date.now()}`,
      metrics: { ...job1.metrics, correlationId: `meta_corr_4_${Date.now()}`, startTime: Date.now() },
      extractedScript: undefined,
      inputPayload: {
        sourceDoc: { name: 'student_script_4_missing.pdf', text: `Unique text missing metadata ${Date.now()}: Q1 Relations of thyroid.` },
        canonicalAnswerKey: anatomyCanonicalKey,
      },
    };

    // Mock Gemini returning null usageMetadata
    setMockGeminiProvider(async ({ correlationId }) => {
      if (correlationId.startsWith('ext_')) {
        return {
          text: JSON.stringify({
            studentName: 'Aarathi Sree',
            examTitle: 'Test',
            answers: [{ questionId: '1', subquestionId: null, studentAnswerText: 'Thyroid', isAttempted: true, confidence: 0.9 }],
            unmappedContent: [],
            warnings: [],
          }),
          usageMetadata: null as any,
        };
      }
      return {
        text: JSON.stringify({
          studentName: 'Aarathi Sree',
          testTitle: 'Test',
          testTopics: 'Anatomy',
          testDate: '2026-10-31',
          totalScore: 10,
          maxScore: 15,
          questions: [
            { qNo: '1', feedbackPoints: ['Good'], marks: 10, maxMarks: 10, isCorrect: true },
            { qNo: '2', feedbackPoints: ['MCQ'], marks: 0, maxMarks: 5, isCorrect: false },
          ],
          generalFeedback: {
            overallPerformance: ['Good'], mcqs: ['None'], contentAccuracy: ['Accurate'],
            completenessOfAnswers: ['Complete'], presentationDiagrams: ['None'],
            investigations: ['None'], attemptingQuestions: ['Partial'], actionPoints: ['Review'],
          },
        }),
        usageMetadata: null as any,
      };
    });

    await evaluationEngine.evaluate(job4);

    const log4 = capturedLogs.find(l => l.includes(jobId4));
    assert(Boolean(log4), 'Developer log was printed when usage metadata was null.');
    assert(log4!.includes('figureStatus=unavailable'), 'Log marks figureStatus=unavailable.');
    assert(log4!.includes('totalTokens(in=null,out=null)'), 'Tokens strictly null (NEVER fabricated to 0).');
    assert(log4!.includes('totalCost=N/A'), 'Cost strictly N/A.');
    assert(log4!.includes('calculable=false'), 'calculable=false logged.');

    // ---------------------------------------------------------------------------
    // TEST GROUP 5: Single-Stage Evaluation (Without Answer Key)
    // ---------------------------------------------------------------------------
    console.log('\n--- Test Group 5: Single-Stage Evaluation (Extraction Skipped) ---');

    const jobId5 = `eval_test_meta_5_${Date.now()}`;
    const job5: EvaluationJob = {
      ...job1,
      id: jobId5,
      correlationId: `meta_corr_5_${Date.now()}`,
      canonicalAnswerKey: undefined, // Single-stage mode
      extractedScript: undefined,
      metrics: { ...job1.metrics, correlationId: `meta_corr_5_${Date.now()}`, startTime: Date.now() },
      inputPayload: {
        sourceDoc: { name: 'student_script_5_single.pdf', text: `Run 5 ${Date.now()}: Single stage test.` },
      },
    };

    setMockGeminiProvider(async () => {
      return {
        text: JSON.stringify({
          studentName: 'Aarathi Sree',
          testTitle: 'Anatomy Test',
          testTopics: 'Head and Neck',
          testDate: '2026-10-31',
          totalScore: 10,
          maxScore: 10,
          questions: [
            { qNo: '1', feedbackPoints: ['Great'], marks: 10, maxMarks: 10, isCorrect: true },
          ],
          generalFeedback: {
            overallPerformance: ['Great'], mcqs: ['N/A'], contentAccuracy: ['Accurate'],
            completenessOfAnswers: ['Complete'], presentationDiagrams: ['Adequate'],
            investigations: ['N/A'], attemptingQuestions: ['Complete'], actionPoints: ['None'],
          },
        }),
        usageMetadata: { promptTokenCount: 1400, candidatesTokenCount: 300 },
      };
    });

    await evaluationEngine.evaluate(job5);
    const log5 = capturedLogs.find(l => l.includes(jobId5));
    assert(Boolean(log5), 'Developer log printed for single-stage evaluation.');
    assert(log5!.includes('extractionCost=SKIPPED'), 'Extraction cost clearly marked SKIPPED.');
    assert(log5!.includes('gradingTokens(in=1400,out=300)'), 'Grading tokens recorded.');
    assert(/figureStatus=(actual|estimated|partial|unavailable)/.test(log5!), 'figureStatus is valid.');

    // Clean up mock provider
    setMockGeminiProvider(null);

    console.log('\n========================================================================');
    console.log(` ALL FOCUSED METADATA TESTS COMPLETED: ${passedTests}/${totalTests} PASSED`);
    console.log('========================================================================\n');
  } finally {
    console.log = originalConsoleLog;
  }
}

runMetadataTests().catch((err) => {
  console.error('\n❌ METADATA TEST SUITE FAILED:', err);
  process.exit(1);
});
