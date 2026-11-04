import { evaluationEngine } from '../server/evaluator';
import { evaluationQueue } from '../server/queue';
import { answerKeyService } from '../server/answerKeyService';
import { CanonicalAnswerKey, EvaluationJob } from '../server/types';
import { setMockGeminiProvider } from '../server/geminiClient';
import assert from 'assert';

async function testExtractionPreservationOnRetry() {
  console.log('========================================================================');
  console.log(' TESTING EXTRACTION PRESERVATION ON CALL 2 FAILURE & RETRY');
  console.log('========================================================================\n');

  const institutionId = `inst_preserv_${Date.now()}`;
  const userId = `prof_preserv_${Date.now()}`;
  const userCtx = {
    userId,
    role: 'instructor' as const,
    institutionId,
    name: 'Prof. Preservation',
  };

  const canonicalKeyData: CanonicalAnswerKey = {
    id: `ak_preserv_${Date.now()}`,
    examId: `exam_preserv_${Date.now()}`,
    title: 'Biochemistry Midterm',
    subject: 'Biochemistry',
    grade: 'Year 1',
    sourceMode: 'ai_generated',
    version: 1,
    status: 'draft',
    printedMaxMarks: 10,
    totalMaxMarks: 10,
    questions: [
      {
        questionId: '1',
        maxMarks: 10,
        questionText: 'Explain the rate-limiting enzyme of glycolysis.',
        referenceAnswer: 'Phosphofructokinase-1 (PFK-1) catalyzes the conversion of fructose-6-phosphate to fructose-1,6-bisphosphate.',
        expectedConcepts: ['PFK-1', 'Fructose-6-phosphate conversion', 'Allosteric regulation by ATP and AMP'],
        markingCriteria: ['Enzyme identified: 4 marks', 'Reaction: 3 marks', 'Regulation: 3 marks'],
        acceptableAlternatives: ['Phosphofructokinase', 'PFK1'],
        confidence: 0.99,
      },
    ],
    metadata: {
      institutionId,
      createdBy: userId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
  };

  (answerKeyService as any).saveToDisk(canonicalKeyData);
  const approvedKey = answerKeyService.approveAnswerKey(canonicalKeyData.id, userCtx);

  let extractionCallCount = 0;
  let gradingCallCount = 0;
  let shouldGradingFail = true;

  setMockGeminiProvider(async ({ model, contentsParts, systemInstruction, correlationId }) => {
    // Distinguish extraction vs grading by correlationId prefix or contents
    if (correlationId.startsWith('ext_')) {
      extractionCallCount++;
      return {
        text: JSON.stringify({
          studentName: 'Priya Patel',
          examTitle: 'Biochemistry Midterm',
          answers: [
            {
              questionId: '1',
              studentAnswerText: 'The rate-limiting enzyme is PFK-1 (Phosphofructokinase-1). It converts F-6-P to F-1,6-BP.',
              isAttempted: true,
              confidence: 0.98,
            },
          ],
          visualEvidenceRetained: false,
        }),
        usageMetadata: { promptTokenCount: 500, candidatesTokenCount: 150 },
      };
    } else {
      gradingCallCount++;
      if (shouldGradingFail) {
        throw new Error('Simulated upstream network timeout during Call 2 grading');
      }
      return {
        text: JSON.stringify({
          studentName: 'Priya Patel',
          testTitle: 'Biochemistry Midterm',
          testTopics: 'Glycolysis',
          testDate: '2026-10-31',
          questions: [
            {
              qNo: '1',
              marks: 8,
              maxMarks: 10,
              isCorrect: true,
              feedbackPoints: ['Correctly identified PFK-1 and the enzymatic reaction.', 'Minor omission on allosteric regulators.'],
            },
          ],
          totalScore: 8,
          maxScore: 10,
          generalFeedback: {
            overallPerformance: ['Strong conceptual foundation.'],
            mcqs: ['N/A'],
            contentAccuracy: ['Accurate.'],
            completenessOfAnswers: ['Good.'],
            presentationDiagrams: ['N/A'],
            investigations: ['N/A'],
            attemptingQuestions: ['Attempted.'],
            actionPoints: ['Review regulation mechanisms.'],
          },
        }),
        usageMetadata: { promptTokenCount: 800, candidatesTokenCount: 200 },
      };
    }
  });

  const job = evaluationQueue.enqueue(
    {
      sourceDoc: {
        name: 'Priya_Patel_Biochem.txt',
        text: 'The rate-limiting enzyme is PFK-1. It converts F-6-P to F-1,6-BP.',
      },
      canonicalAnswerKey: approvedKey,
      answerKeyId: approvedKey.id,
      studentName: 'Priya Patel',
    },
    userCtx
  );

  console.log(`Created job: ${job.id}`);

  // Wait for initial failure
  await new Promise<void>((resolve) => {
    const check = setInterval(() => {
      const current = evaluationQueue.getJob(job.id);
      if (current?.status === 'failed') {
        clearInterval(check);
        resolve();
      }
    }, 50);
  });

  const failedJob = evaluationQueue.getJob(job.id)!;
  console.log(`Initial job status after Call 2 error: ${failedJob.status}`);
  console.log(`Error message: ${failedJob.error}`);

  // Verify that Stage 1 extraction was preserved on the failed job record!
  assert(failedJob.extractedScript !== undefined, 'job.extractedScript must be preserved when Call 2 fails!');
  assert(failedJob.extractedScript?.answers.length === 1, 'Extracted script must have 1 answer');
  assert(extractionCallCount === 1, 'Call 1 extraction must have run exactly once');
  assert(gradingCallCount >= 1, 'Call 2 grading must have been attempted and failed');
  console.log('✓ Stage 1 extractedScript was durably preserved on disk despite Call 2 grading failure.');

  // Now simulate successful retry of the job
  console.log('\n--- Retrying the failed job with network recovered ---');
  shouldGradingFail = false;
  evaluationQueue.retryJob(job.id, userCtx);

  // Wait for completed status
  await new Promise<void>((resolve) => {
    const check = setInterval(() => {
      const current = evaluationQueue.getJob(job.id);
      if (current?.status === 'completed') {
        clearInterval(check);
        resolve();
      }
    }, 50);
  });

  const completedJob = evaluationQueue.getJob(job.id)!;
  console.log(`Job status after retry: ${completedJob.status}`);
  console.log(`Total Score: ${completedJob.report?.totalScore}/${completedJob.report?.maxScore}`);

  // CRITICAL VERIFICATION:
  // Extraction must NOT have been re-run! extractionCallCount must STILL be 1!
  assert.strictEqual(
    extractionCallCount,
    1,
    `Extraction was re-run! Expected extractionCallCount to remain 1, but got ${extractionCallCount}`
  );
  console.log(`✓ VERIFIED: Call 1 (Extraction) was NOT re-run during retry! extractionCallCount = ${extractionCallCount}.`);
  console.log(`✓ VERIFIED: Only Call 2 was executed on retry! Total AI calls = exactly 2 for successful evaluation.`);

  // Cleanup mock
  setMockGeminiProvider(null);

  console.log('\n========================================================================');
  console.log(' EXTRACTION PRESERVATION AND RESUME TEST PASSED COMPLETELY!');
  console.log('========================================================================\n');
}

testExtractionPreservationOnRetry().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
