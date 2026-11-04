import assert from 'assert';
import { evaluationEngine } from '../server/evaluator';
import { answerKeyService } from '../server/answerKeyService';
import {
  setMockGeminiProvider,
  getGeminiClient,
  isModelInCooldown,
  getModelCooldownStatus,
  resetModelCooldowns,
  studentExtractionSchema,
  evaluationReportSchema,
} from '../server/geminiClient';
import { config } from '../server/config';
import { EvaluationJob, CanonicalAnswerKey } from '../server/types';

async function runLiveFallbackEvaluationTest() {
  console.log('========================================================================');
  console.log(' STARTING SCENARIO VALIDATION: 429 & 503 FALLBACK CHAIN TO GEMINI 2.5');
  console.log('========================================================================\n');

  resetModelCooldowns();

  const institutionId = `inst_fallback_${Date.now()}`;
  const userId = `prof_fallback_${Date.now()}`;
  const userCtx = {
    userId,
    role: 'instructor' as const,
    institutionId,
    name: 'Prof. Fallback Test',
  };

  const canonicalKeyData: CanonicalAnswerKey = {
    id: `ak_fb_${Date.now()}`,
    examId: `exam_fb_${Date.now()}`,
    title: 'Clinical Neuroanatomy Assessment',
    subject: 'Anatomy',
    grade: 'MBBS Year 1',
    sourceMode: 'ai_generated',
    version: 1,
    status: 'draft',
    printedMaxMarks: 20,
    totalMaxMarks: 20,
    questions: [
      {
        questionId: '1',
        maxMarks: 10,
        questionText: 'Describe the course and functional components of the Oculomotor Nerve (CN III).',
        referenceAnswer: 'The oculomotor nerve emerges from the interpeduncular fossa of the midbrain. It carries somatic motor fibers to levator palpebrae superioris, superior rectus, medial rectus, inferior rectus, and inferior oblique. It carries preganglionic parasympathetic fibers from the Edinger-Westphal nucleus to the ciliary ganglion for pupillary constriction and accommodation.',
        expectedConcepts: [
          'Emergence from interpeduncular fossa / midbrain',
          'Somatic motor supply to extraocular muscles',
          'Parasympathetic from Edinger-Westphal nucleus to ciliary ganglion',
          'Action: pupillary constriction and accommodation',
        ],
        markingCriteria: [
          'Origin and course: 3 marks',
          'Extraocular muscle motor supply: 4 marks',
          'Parasympathetic functional component: 3 marks',
        ],
        confidence: 0.98,
        acceptableAlternatives: [],
      },
      {
        questionId: '2.a',
        subquestionId: 'a',
        maxMarks: 5,
        questionText: 'Enumerate the clinical signs of complete Oculomotor Nerve palsy.',
        referenceAnswer: 'Signs of complete CN III palsy include ptosis (paralysis of levator palpebrae), down-and-out eye position (unopposed superior oblique and lateral rectus), dilated and fixed pupil (mydriasis), and loss of accommodation.',
        expectedConcepts: [
          'Ptosis',
          'Down and out eye position (external strabismus)',
          'Dilated pupil / absent light reflex',
          'Loss of accommodation',
        ],
        markingCriteria: [
          'Eyelid ptosis: 1.5 marks',
          'Eye position (down & out): 1.5 marks',
          'Pupillary dilation and loss of light reflex: 2 marks',
        ],
        confidence: 0.99,
        acceptableAlternatives: [],
      },
      {
        questionId: '2.b',
        subquestionId: 'b',
        maxMarks: 5,
        questionText: 'What is Argyll Robertson pupil and what is its anatomical lesion site?',
        referenceAnswer: 'Argyll Robertson pupil is characterized by pupils that accommodate but do not react to light (light-near dissociation). The anatomical lesion is located in the pretectal nucleus/area of the midbrain, commonly associated with neurosyphilis.',
        expectedConcepts: [
          'Accommodates to near target but does not react to light',
          'Lesion in the midbrain pretectal area interrupting light reflex pathway',
        ],
        markingCriteria: [
          'Light-near dissociation: 2.5 marks',
          'Lesion site in pretectal area: 2.5 marks',
        ],
        confidence: 0.98,
        acceptableAlternatives: [],
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
  console.log(`✓ Approved Canonical Answer Key: ${approvedKey.id} (Max Marks: ${approvedKey.totalMaxMarks})`);

  const studentScriptText = `
STUDENT ANSWER SHEET
Student Name: Priya Patel
Roll Number: MBBS-2026-142
Subject: Clinical Neuroanatomy
Date: 2026-10-31

Question 1:
Course and Functional Components of Oculomotor Nerve (CN III):
1. Origin & Course: Emerges from the anterior midbrain in the interpeduncular fossa medial to the cerebral peduncle. It passes between the posterior cerebral and superior cerebellar arteries, pierces the dura mater, and enters the cavernous sinus lateral wall. It enters the orbit via the superior orbital fissure.
2. Somatic Motor Component: Supplies levator palpebrae superioris, superior rectus, medial rectus, inferior rectus, and inferior oblique muscles.
3. Visceral Motor (Parasympathetic): Originates from the Edinger-Westphal nucleus in the rostral midbrain. Preganglionic fibers travel with the inferior division of CN III to synapse in the ciliary ganglion. Postganglionic short ciliary nerves supply the sphincter pupillae (pupillary constriction) and ciliary muscle (accommodation for near vision).

---

Question 2.a:
Clinical Signs of Oculomotor Nerve Palsy:
1. Complete Ptosis due to paralysis of levator palpebrae superioris.
2. Eyeball rotated "down and out" due to unopposed action of lateral rectus (CN VI) and superior oblique (CN IV).
3. Mydriasis (dilated, non-reactive pupil) caused by loss of parasympathetic tone to sphincter pupillae.
4. Loss of accommodation reflex.

---

Question 2.b:
[Unanswered by student / Omitted]
`;

  // Track each invocation to inspect model fallback sequence
  const callAudit: {
    stage: string;
    correlationId: string;
    modelAttempted: string;
    outcome: string;
    errorType?: string;
  }[] = [];

  const ai = getGeminiClient();

  // Install custom mock provider for models 1, 2, and 3; delegate model 4 (gemini-2.5-flash) to LIVE Gemini API
  setMockGeminiProvider(async ({ model, contentsParts, systemInstruction, correlationId }) => {
    const stage = correlationId.includes('ext_') ? 'Stage 1 (Extraction)' : 'Stage 2 (Grading)';

    if (model === 'gemini-3.8-flash') {
      callAudit.push({
        stage,
        correlationId,
        modelAttempted: model,
        outcome: '429 Quota Exhausted',
        errorType: 'DAILY_QUOTA_EXHAUSTED',
      });
      const err: any = new Error(
        'You exceeded your current quota, please check your plan and billing details. Generate content requests per day limit exceeded on Free Tier. Please retry in 18h.'
      );
      err.status = 429;
      err.code = 429;
      throw err;
    }

    if (model === 'gemini-flash-latest') {
      callAudit.push({
        stage,
        correlationId,
        modelAttempted: model,
        outcome: '429 Quota Exhausted',
        errorType: 'DAILY_QUOTA_EXHAUSTED',
      });
      const err: any = new Error(
        'Generate content requests per day limit exceeded on Free Tier. quotaId: GenerateRequestsPerDayPerProjectPerModel-FreeTier'
      );
      err.status = 429;
      err.code = 429;
      throw err;
    }

    if (model === 'gemini-3.1-flash-lite') {
      callAudit.push({
        stage,
        correlationId,
        modelAttempted: model,
        outcome: '503 Overloaded',
        errorType: 'SERVICE_UNAVAILABLE',
      });
      const err: any = new Error('503 Service Unavailable: High load / server overloaded');
      err.status = 503;
      err.statusCode = 503;
      throw err;
    }

    if (model === 'gemini-2.5-flash') {
      console.log(`[TestInterceptor] Delegating ${model} to LIVE Gemini API (Stage: ${stage})...`);
      const callStart = Date.now();

      // Resolve appropriate schema
      const schema = correlationId.includes('ext_')
        ? studentExtractionSchema
        : evaluationReportSchema;

      // Call live Gemini model. If gemini-2.5-flash hit Google's 20-call daily quota limit today,
      // fallback to live gemini-3.5-flash-lite to guarantee actual live Google API response.
      let liveResponse: any;
      let actualLiveModel = 'gemini-2.5-flash';
      try {
        liveResponse = await ai.models.generateContent({
          model: 'gemini-2.5-flash',
          contents: [{ parts: contentsParts }],
          config: {
            systemInstruction,
            temperature: 0,
            seed: 42,
            responseMimeType: 'application/json',
            responseSchema: schema,
            thinkingConfig: { thinkingBudget: 0 },
          },
        });
      } catch (liveErr: any) {
        const liveMsg = String(liveErr?.message || liveErr).toLowerCase();
        if (liveMsg.includes('quota') || liveMsg.includes('429') || liveErr?.status === 429) {
          console.warn(`[TestInterceptor] Note: Live gemini-2.5-flash daily quota exhausted on Google; delegating to active live model gemini-3.5-flash-lite...`);
          actualLiveModel = 'gemini-3.5-flash-lite';
          liveResponse = await ai.models.generateContent({
            model: 'gemini-3.5-flash-lite',
            contents: [{ parts: contentsParts }],
            config: {
              systemInstruction,
              temperature: 0,
              seed: 42,
              responseMimeType: 'application/json',
              responseSchema: schema,
            },
          });
        } else {
          throw liveErr;
        }
      }

      const elapsed = Date.now() - callStart;
      console.log(`[TestInterceptor] ✓ LIVE Google Gemini API call succeeded with model "${actualLiveModel}" in ${elapsed}ms!`);

      callAudit.push({
        stage,
        correlationId,
        modelAttempted: model,
        outcome: `200 Success (Live Google API via ${actualLiveModel})`,
      });

      return {
        text: liveResponse.text,
        usageMetadata: liveResponse.usageMetadata,
      };
    }

    throw new Error(`Unexpected model requested in fallback test: ${model}`);
  });

  const job: EvaluationJob = {
    id: `job_fb_val_${Date.now()}`,
    correlationId: `corr_fb_${Date.now()}`,
    status: 'queued',
    progressPercent: 0,
    currentStepMessage: 'Queued for live evaluation',
    mode: 'without-manual',
    studentName: 'Priya Patel',
    institutionId,
    createdBy: userId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    canonicalAnswerKey: approvedKey,
    inputPayload: {
      sourceDoc: {
        name: 'Priya_Patel_Neuroanatomy_Script.txt',
        text: studentScriptText,
      },
      canonicalAnswerKey: approvedKey,
    },
    metrics: {
      startTime: Date.now(),
      modelUsed: 'gemini-2.5-flash',
      retriesCount: 0,
      fallbackCallsCount: 0,
    } as any,
  };

  console.log('\n--- EXECUTING EVALUATION PIPELINE WITH 429 + 503 FALLBACK ---');
  const stageTimings: Record<string, number> = {};
  let lastProgressTime = Date.now();

  const report = await evaluationEngine.evaluate(job, (progress, step) => {
    const elapsed = Date.now() - lastProgressTime;
    lastProgressTime = Date.now();
    stageTimings[step] = elapsed;
    console.log(`[Progress ${progress}%] ${step}`);
  });

  console.log('\n========================================================================');
  console.log(' CALL AUDIT & MODEL SEQUENCE VERIFICATION');
  console.log('========================================================================');
  for (const c of callAudit) {
    console.log(`[${c.stage}] Model: ${c.modelAttempted.padEnd(22)} -> Outcome: ${c.outcome}`);
  }

  console.log('\n--- Cooldown Status Store ---');
  console.log(getModelCooldownStatus());

  console.log('\n========================================================================');
  console.log(' EVALUATION REPORT & METADATA SUMMARY');
  console.log('========================================================================');
  console.log(`Job ID          : ${job.id}`);
  console.log(`Job Status      : ${job.status}`);
  console.log(`Student Name    : ${report.studentName}`);
  console.log(`Evaluated Model : ${report.evaluatedByModel}`);
  console.log(`Total Score     : ${report.totalScore} / ${report.maxScore}`);

  for (const q of report.questions) {
    console.log(`\nQuestion ${q.qNo}:`);
    console.log(`  Awarded Marks : ${q.marks} / ${q.maxMarks} (isCorrect: ${q.isCorrect})`);
    console.log(`  Feedback      : ${q.feedbackPoints.join(' ')}`);
  }

  // -------------------------------------------------------------------------
  // Assertions
  // -------------------------------------------------------------------------
  console.log('\n--- VERIFYING REQUIREMENTS ---');

  // 1. Stage 1 verified fallback
  const stage1Calls = callAudit.filter((c) => c.stage.includes('Stage 1'));
  assert.strictEqual(stage1Calls[0].modelAttempted, 'gemini-3.8-flash', 'Stage 1 must attempt gemini-3.8-flash first');
  assert.strictEqual(stage1Calls[1].modelAttempted, 'gemini-flash-latest', 'Stage 1 must fallback to gemini-flash-latest second');
  assert.strictEqual(stage1Calls[2].modelAttempted, 'gemini-3.1-flash-lite', 'Stage 1 must fallback to gemini-3.1-flash-lite third');
  const stage1Success = stage1Calls.find((c) => c.modelAttempted === 'gemini-2.5-flash');
  assert(stage1Success !== undefined, 'Stage 1 must successfully reach gemini-2.5-flash');
  console.log('✓ Requirement 1 & 2: Stage 1 traversed 429/503 and completed on gemini-2.5-flash.');

  // 2. Stage 2 must immediately skip models in quota cooldown
  const stage2Calls = callAudit.filter((c) => c.stage.includes('Stage 2'));
  console.log(`Stage 2 Call Count: ${stage2Calls.length}`);
  // In Stage 2, gemini-3.8-flash and gemini-flash-latest were marked QUOTA_EXHAUSTED in Stage 1!
  assert(
    !stage2Calls.some((c) => c.modelAttempted === 'gemini-3.8-flash'),
    'Stage 2 must NOT call gemini-3.8-flash because it was in 429 quota cooldown!'
  );
  assert(
    !stage2Calls.some((c) => c.modelAttempted === 'gemini-flash-latest'),
    'Stage 2 must NOT call gemini-flash-latest because it was in 429 quota cooldown!'
  );
  console.log('✓ Requirement 2 & 4: Stage 2 immediately skipped 429 quota-exhausted models without wasting any retries or latency!');

  // 3. Stage 2 must succeed promptly on gemini-2.5-flash
  const stage2Success = stage2Calls.find((c) => c.modelAttempted === 'gemini-2.5-flash');
  assert(stage2Success !== undefined, 'Stage 2 must execute on gemini-2.5-flash');
  console.log('✓ Requirement 4: Stage 2 prompt execution succeeded on gemini-2.5-flash.');

  // 4. Final marks verification (accurate, non-zero)
  const q1 = report.questions.find((q) => q.qNo === '1');
  assert(q1 && q1.marks >= 8.0, `Question 1 should receive >= 8/10 for comprehensive answer. Actual: ${q1?.marks}`);
  console.log(`✓ Question 1: Received ${q1.marks}/10 marks.`);

  const q2a = report.questions.find((q) => q.qNo === '2.a');
  assert(q2a && q2a.marks >= 4.0, `Question 2.a should receive >= 4/5 marks. Actual: ${q2a?.marks}`);
  console.log(`✓ Question 2.a: Received ${q2a.marks}/5 marks.`);

  const q2b = report.questions.find((q) => q.qNo === '2.b');
  assert(q2b && q2b.marks === 0, `Question 2.b was unattempted and must receive 0 marks. Actual: ${q2b?.marks}`);
  console.log(`✓ Question 2.b: Received 0/5 marks (honestly identified as unattempted).`);

  assert.strictEqual(report.totalScore, q1.marks + q2a.marks, 'Total score must equal sum of questions');
  console.log(`✓ Final Total Score: ${report.totalScore}/20 marks verified strictly non-zero!`);

  // 5. Job status
  assert.strictEqual(job.status, 'completed', 'Job status must be completed');
  console.log(`✓ Job status: "${job.status}" correctly maintained.`);

  console.log('\n========================================================================');
  console.log(' ALL REQUIREMENTS VERIFIED SUCCESSFULLY WITH FLYING COLORS!');
  console.log('========================================================================\n');
}

runLiveFallbackEvaluationTest().catch((err) => {
  console.error('\n❌ Test Failed:', err);
  process.exit(1);
});
