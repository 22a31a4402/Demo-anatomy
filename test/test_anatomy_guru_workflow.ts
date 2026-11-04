/**
 * Aarshiv AI – Anatomy Guru Automated Workflow Test Suite
 *
 * Verifies:
 * 1. Document pair extraction, persistent storage, and SHA-256 pair reuse across submissions
 * 2. Rejection of empty/invalid student extraction (marked 'needs_review', never fabricating marks)
 * 3. Removal of Answer Key generation
 * 4. 'without-manual' evaluation with strict Anatomy Guru medical grading rules
 * 5. 'with-manual' evaluation with faculty auditing, discrepancy flags, and clean feedback
 */

import crypto from 'crypto';
import { answerKeyService, computeReferencePairHash, DocumentPayload } from '../server/answerKeyService';
import { evaluationEngine, ValidationError } from '../server/evaluator';
import { setMockGeminiProvider } from '../server/geminiClient';
import { UserContext } from '../server/auth';
import { generateAnswerKeyApi } from '../services/geminiService';

type ProcessedDocument = DocumentPayload;

const mockUser: UserContext = {
  userId: 'faculty_anatomy_01',
  role: 'instructor',
  institutionId: 'inst_anatomy_guru',
  name: 'Dr. Anatomy Guru',
};

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`❌ FAIL: ${msg}`);
    failed++;
    throw new Error(`Assertion failed: ${msg}`);
  } else {
    console.log(`✅ PASS: ${msg}`);
    passed++;
  }
}

async function runTests() {
  console.log('\n======================================================');
  console.log('🩺 RUNNING AARSHIV AI – ANATOMY GURU WORKFLOW TESTS');
  console.log('======================================================\n');

  // Test 1: Full-content SHA-256 reference pair hash computation
  console.log('--- Test 1: Full-content SHA-256 reference pair hash computation ---');
  const qpDoc1: ProcessedDocument = {
    name: 'Anatomy_Paper_1.pdf',
    text: 'Q1. Describe the anatomy of the Brachial Plexus with relations and clinical anatomy. (10 marks)',
  };
  const akDoc1: ProcessedDocument = {
    name: 'Official_Key_1.pdf',
    text: 'Brachial Plexus: Roots (C5-T1), Trunks, Divisions, Cords, Branches. Relations: Axillary artery. Clinical: Erb-Duchenne palsy, Klumpke paralysis.',
  };

  const hash1 = computeReferencePairHash(qpDoc1, akDoc1);
  const hash1Repeat = computeReferencePairHash(qpDoc1, akDoc1);
  assert(hash1 === hash1Repeat, 'Reference pair hash must be deterministic for identical contents');
  assert(hash1.length === 64, 'Reference pair hash must be a 64-character SHA-256 hex string');

  // Mutation in QP changes hash
  const qpDocMutated: ProcessedDocument = {
    name: 'Anatomy_Paper_1.pdf',
    text: 'Q1. Describe the anatomy of the Brachial Plexus with relations and clinical anatomy. (15 marks)',
  };
  const hashMutated = computeReferencePairHash(qpDocMutated, akDoc1);
  assert(hash1 !== hashMutated, 'Changing Question Paper content must produce a distinct pair hash');

  // Mutation in AK changes hash
  const akDocMutated: ProcessedDocument = {
    name: 'Official_Key_1.pdf',
    text: 'Brachial Plexus: Roots (C5-T1), Trunks, Divisions, Cords, Branches. Relations: Subclavian artery.',
  };
  const hashMutatedAk = computeReferencePairHash(qpDoc1, akDocMutated);
  assert(hash1 !== hashMutatedAk, 'Changing Answer Key content must produce a distinct pair hash');

  // Different filenames with identical content have SAME hash (content-based, not filename-based!)
  const qpDocSameContentDiffName: ProcessedDocument = {
    name: 'Student_Renamed_QP.pdf',
    text: qpDoc1.text,
  };
  const akDocSameContentDiffName: ProcessedDocument = {
    name: 'Copy_Of_Official_Key.pdf',
    text: akDoc1.text,
  };
  const hashIdenticalContent = computeReferencePairHash(qpDocSameContentDiffName, akDocSameContentDiffName);
  assert(hash1 === hashIdenticalContent, 'Hash must identify document pairs by full content, not filenames');

  // Test 2: Persistent storage and reuse of reference key across submissions
  console.log('\n--- Test 2: Persistent reference key extraction and reuse ---');
  let geminiCalls = 0;
  setMockGeminiProvider(async (req) => {
    geminiCalls++;
    const promptText = JSON.stringify(req);

    // Answer Key Extraction Response
    if (promptText.includes('EXTRACTED ANSWER KEY') || promptText.includes('Canonical Answer Key') || req.correlationId?.startsWith('ak_ext_')) {
      return {
        text: JSON.stringify({
          title: 'Gross Anatomy Paper 1',
          printedMaxMarks: 20,
          questions: [
            {
              questionNumber: '1',
              questionText: 'Describe the Brachial Plexus in detail including roots, trunks, cords, branches, and clinical correlations.',
              maxMarks: 10,
              referenceAnswer: 'Roots C5-T1, Upper/Middle/Lower trunks, Anterior/Posterior divisions, Lateral/Medial/Posterior cords. Axillary relations. Erb and Klumpke palsies.',
              markingCriteria: [
                { point: 'Roots, trunks, cords and branches identified', marks: 4 },
                { point: 'Relations to axillary artery & subclavian vessels', marks: 2 },
                { point: 'Accurate diagram of plexus', marks: 2 },
                { point: 'Clinical correlations (Erb, Klumpke)', marks: 2 }
              ]
            },
            {
              questionNumber: '2',
              questionText: 'Describe the blood supply of the thyroid gland.',
              maxMarks: 10,
              referenceAnswer: 'Superior thyroid artery (ECA branch), Inferior thyroid artery (thyrocervical trunk), Thyroid ima artery (occasional). Venous drainage to IJV and brachiocephalic vein.',
              markingCriteria: [
                { point: 'Arterial supply sources and relations to recurrent laryngeal nerve', marks: 5 },
                { point: 'Venous drainage (superior, middle, inferior veins)', marks: 3 },
                { point: 'Clinical: thyroidectomy surgical margins', marks: 2 }
              ]
            }
          ]
        }),
        candidates: [{ finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 1500, candidatesTokenCount: 600, totalTokenCount: 2100 }
      };
    }

    // Stage 1: Student Answer Script Extraction
    if (promptText.includes('Stage 1 Extraction') || req.correlationId?.startsWith('ext_') || promptText.includes('studentExtractionSchema')) {
      return {
        text: JSON.stringify({
          studentName: 'Dr. Rahul Sharma',
          examTitle: 'Gross Anatomy Paper 1',
          answers: [
            {
              questionId: '1',
              studentAnswerText: 'The Brachial Plexus is formed by roots C5-T1. They join into upper, middle, and lower trunks, divide into anterior and posterior divisions, and form lateral, medial, and posterior cords surrounding the axillary artery. Terminal branches include median, ulnar, radial, and musculocutaneous nerves. Erb-Duchenne palsy affects C5-C6 with policeman tip deformity.',
              diagramDescription: 'Neat hand-drawn diagram illustrating roots C5-T1, upper/middle/lower trunks, cords around axillary artery, and terminal nerves with labeled roots.',
              isAttempted: true,
              confidence: 0.98
            },
            {
              questionId: '2',
              studentAnswerText: 'The thyroid gland blood supply is via the superior thyroid artery (branch of external carotid artery) related to the external laryngeal nerve, and inferior thyroid artery (branch of thyrocervical trunk) closely related to the recurrent laryngeal nerve. Venous drainage occurs via superior and middle thyroid veins into the internal jugular vein, and inferior thyroid vein into the brachiocephalic vein.',
              isAttempted: true,
              confidence: 0.98
            }
          ]
        }),
        candidates: [{ finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 1800, candidatesTokenCount: 500, totalTokenCount: 2300 }
      };
    }

    // Stage 2: Student Evaluation Response
    return {
      text: JSON.stringify({
        studentName: 'Dr. Rahul Sharma',
        testTitle: 'Gross Anatomy Paper 1',
        testDate: '2026-11-03',
        totalScore: 16,
        totalMaxMarks: 20,
        percentage: 80,
        grade: 'A',
        generalFeedback: {
          overallStrengths: ['Excellent anatomical description of brachial plexus roots and trunks', 'Clear thyroid arterial relations'],
          areasForImprovement: ['Could elaborate on Klumpke paralysis presentation'],
          actionableSteps: ['Practice neat labeling of plexus cords and terminal branches']
        },
        questions: [
          {
            qNo: '1',
            marks: 8,
            maxMarks: 10,
            feedbackPoints: [
              'Correctly traced roots from C5 to T1 and formed trunks and cords accurately.',
              'Axillary artery relations clearly documented with neurovascular bundle landmarks.',
              'Diagram was neat and clearly demarcated terminal nerves.',
              'Mentioned Erb palsy presentation, but Klumpke intrinsic hand muscle clawing was brief.'
            ],
            confidence: 0.95
          },
          {
            qNo: '2',
            marks: 8,
            maxMarks: 10,
            feedbackPoints: [
              'Superior and inferior thyroid arteries correctly identified with parent vessels.',
              'Highlighted critical relation of inferior thyroid artery with recurrent laryngeal nerve.',
              'Venous drainage complete including middle thyroid vein draining into IJV.'
            ],
            confidence: 0.95
          }
        ]
      }),
      candidates: [{ finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 2200, candidatesTokenCount: 750, totalTokenCount: 2950 }
    };
  });

  const testNonce = `nonce_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const qpDocTest: ProcessedDocument = {
    name: `Gross_Anatomy_QP_${testNonce}.pdf`,
    text: `Exam Code: ${testNonce}\nQ1. Describe the anatomy of the Brachial Plexus with relations and clinical anatomy. (10 marks)\nQ2. Blood supply of thyroid gland. (10 marks)`
  };
  const akDocTest: ProcessedDocument = {
    name: `Official_Key_${testNonce}.pdf`,
    text: `Exam Code: ${testNonce}\nModel 1: Brachial Plexus Roots C5-T1, trunks, cords, branches.\nModel 2: Thyroid arterial & venous supply.`
  };

  const testPairHash = computeReferencePairHash(qpDocTest, akDocTest);

  // First extraction: calls Gemini and saves key with referencePairHash
  const initialKey = await answerKeyService.extractFromUploadedKey({
    answerKeyDoc: akDocTest,
    questionPaperDoc: qpDocTest,
    title: 'Gross Anatomy Official Key',
    metadata: { institutionId: mockUser.institutionId, createdBy: mockUser.userId }
  });

  assert(initialKey.status === 'draft', 'Newly extracted key starts in draft status');
  assert(initialKey.referencePairHash === testPairHash, 'Key must have referencePairHash saved');
  assert(initialKey.questions.length === 2, 'Key must contain 2 questions');

  // Approve the key
  const approvedKey = answerKeyService.approveAnswerKey(initialKey.id, mockUser, 'Approved official reference key');
  assert(approvedKey.status === 'approved', 'Key is now approved');

  // Lookup by pair hash
  const foundByPair = answerKeyService.findApprovedKeyForReferencePair(qpDocTest, akDocTest, mockUser);
  assert(foundByPair !== null, 'findApprovedKeyForReferencePair must find the approved key');
  assert(foundByPair?.id === approvedKey.id, 'Found key ID must match approved key ID');

  // Second extraction with identical QP + AK pair: must reuse instantly WITHOUT calling Gemini!
  const callsBeforeSecondExtraction = geminiCalls;
  const reusedKey = await answerKeyService.extractFromUploadedKey({
    answerKeyDoc: akDocTest,
    questionPaperDoc: qpDocTest,
    title: 'Second Student Uploading Same Key',
    metadata: { institutionId: mockUser.institutionId, createdBy: mockUser.userId }
  });
  const callsAfterSecondExtraction = geminiCalls;

  assert(callsAfterSecondExtraction === callsBeforeSecondExtraction, 'Reusing identical QP+AK pair must NOT call Gemini API again');
  assert(reusedKey.id === approvedKey.id, 'Reused key must return the exact existing canonical key');
  assert(reusedKey.status === 'approved', 'Reused key must maintain approved status');

  // Test 3: Removal of Answer Key Generation
  console.log('\n--- Test 3: Answer key generation is completely removed ---');
  let generationErrorCaught = false;
  try {
    await generateAnswerKeyApi();
  } catch (err: any) {
    generationErrorCaught = true;
    assert(err.message.includes('removed'), 'generateAnswerKeyApi must reject with removal error');
  }
  assert(generationErrorCaught, 'Calling generateAnswerKeyApi must throw error');

  // Test 4: Evaluation in 'without-manual' mode
  console.log('\n--- Test 4: Evaluation in without-manual mode ---');
  const studentDoc: ProcessedDocument = {
    name: 'Rahul_Sharma_Anatomy_Script.pdf',
    text: 'Student script answers for Brachial plexus and Thyroid blood supply.'
  };

  const jobWithoutManual: any = {
    id: crypto.randomUUID(),
    correlationId: 'eval_test_wm_01',
    status: 'queued',
    progressPercent: 0,
    currentStepMessage: 'Queued',
    mode: 'without-manual',
    studentName: 'Dr. Rahul Sharma',
    testTitle: 'Gross Anatomy Paper 1',
    institutionId: mockUser.institutionId,
    createdBy: mockUser.userId,
    creatorRole: mockUser.role,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    canonicalAnswerKey: approvedKey,
    metrics: {
      correlationId: 'eval_test_wm_01',
      startTime: Date.now(),
      cacheHit: false,
      retriesCount: 0,
    },
    inputPayload: {
      sourceDoc: studentDoc,
      questionPaper: qpDocTest,
      answerKey: akDocTest,
    }
  };

  const reportWithoutManual = await evaluationEngine.evaluate(jobWithoutManual);

  assert(reportWithoutManual.totalScore === 16, 'Total score must match question scores sum');
  assert(reportWithoutManual.questions.length === 2, 'Report must contain exactly 2 evaluated questions');
  assert(reportWithoutManual.questions[0].maxMarks === 10, 'Question 1 max marks must be 10');
  assert(reportWithoutManual.questions[1].maxMarks === 10, 'Question 2 max marks must be 10');
  // In without-manual mode, isFlagged must be false or cleared
  assert(!reportWithoutManual.questions[0].isFlagged, 'without-manual mode must not have flagged contradictions');

  // Test 5: Evaluation in 'with-manual' mode with faculty audit discrepancy
  console.log('\n--- Test 5: Evaluation in with-manual mode with faculty discrepancy audit ---');
  setMockGeminiProvider(async (req) => {
    return {
      text: JSON.stringify({
        studentName: 'Dr. Rahul Sharma',
        testTitle: 'Gross Anatomy Paper 1',
        testDate: '2026-11-03',
        totalScore: 14,
        totalMaxMarks: 20,
        percentage: 70,
        grade: 'B+',
        generalFeedback: {
          overallStrengths: ['Good anatomical relations'],
          areasForImprovement: ['Elaborate thyroid venous drainage'],
          actionableSteps: ['Review cervical fascia layers']
        },
        questions: [
          {
            qNo: '1',
            marks: 8,
            maxMarks: 10,
            feedbackPoints: [
              'Correctly identified all roots C5-T1, trunks, and cords.',
              'Axillary artery relations were precisely detailed.',
              'Neat diagram included with labeled cords and branches.'
            ],
            confidence: 0.95
          },
          {
            qNo: '2',
            marks: 6,
            maxMarks: 10,
            feedbackPoints: [
              'Superior thyroid artery from external carotid artery correctly stated.',
              'Inferior thyroid artery relations with recurrent laryngeal nerve thoroughly explained.',
              'Venous drainage omitted middle thyroid vein draining into internal jugular vein.'
            ],
            isFlagged: true,
            flaggedComment: 'Official answer key requires all three venous drainage pathways (superior, middle, inferior) for full marks. The manual notes awarded 8 marks overlooking the omitted middle thyroid vein. Adjusted to 6/10 per official marking rubric.',
            confidence: 0.92
          }
        ]
      }),
      candidates: [{ finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 2600, candidatesTokenCount: 800, totalTokenCount: 3400 }
    };
  });

  const facultyNotesDoc: ProcessedDocument = {
    name: 'Faculty_Manual_Marking_Notes.pdf',
    text: 'Q1: 8/10 good diagram. Q2: 8/10 gave thyroid blood supply.'
  };

  const jobWithManual: any = {
    id: crypto.randomUUID(),
    correlationId: 'eval_test_wm_02',
    status: 'queued',
    progressPercent: 0,
    currentStepMessage: 'Queued',
    mode: 'with-manual',
    studentName: 'Dr. Rahul Sharma',
    testTitle: 'Gross Anatomy Paper 1',
    institutionId: mockUser.institutionId,
    createdBy: mockUser.userId,
    creatorRole: mockUser.role,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    canonicalAnswerKey: approvedKey,
    metrics: {
      correlationId: 'eval_test_wm_02',
      startTime: Date.now(),
      cacheHit: false,
      retriesCount: 0,
    },
    inputPayload: {
      sourceDoc: studentDoc,
      questionPaper: qpDocTest,
      answerKey: akDocTest,
      facultyNotes: facultyNotesDoc,
    }
  };

  const reportWithManual = await evaluationEngine.evaluate(jobWithManual);

  assert(reportWithManual.questions[1].isFlagged === true, 'Question 2 must be flagged for discrepancy with official key');
  assert(Boolean(reportWithManual.questions[1].flaggedComment), 'Question 2 flaggedComment must explain the resolution');
  assert(
    !reportWithManual.questions[1].feedbackPoints.some((p: string) => /faculty|manual note/i.test(p)),
    'Feedback points for students must remain clean and objective without leaking faculty internal audit notes'
  );

  // Test 6: Empty or invalid student script extraction rejection
  console.log('\n--- Test 6: Empty or invalid student script extraction is strictly rejected ---');
  setMockGeminiProvider(async () => {
    // Return empty question extraction
    return {
      text: JSON.stringify({
        studentName: 'Unknown',
        testTitle: 'Empty Script Test',
        testDate: '2026-11-03',
        totalScore: 0,
        totalMaxMarks: 20,
        percentage: 0,
        grade: 'F',
        generalFeedback: { overallStrengths: [], areasForImprovement: [], actionableSteps: [] },
        questions: [] // EMPTY EXTRACTION!
      }),
      candidates: [{ finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 500, candidatesTokenCount: 100, totalTokenCount: 600 }
    };
  });

  let emptyExtractionCaught = false;
  try {
    const emptyJob: any = {
      id: crypto.randomUUID(),
      correlationId: 'eval_test_empty_01',
      status: 'queued',
      progressPercent: 0,
      currentStepMessage: 'Queued',
      mode: 'without-manual',
      studentName: 'Unknown',
      testTitle: 'Empty Script',
      institutionId: mockUser.institutionId,
      createdBy: mockUser.userId,
      creatorRole: mockUser.role,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      canonicalAnswerKey: approvedKey,
      metrics: {
        correlationId: 'eval_test_empty_01',
        startTime: Date.now(),
        cacheHit: false,
        retriesCount: 0,
      },
      inputPayload: {
        sourceDoc: { name: 'Blank_Script.pdf', text: '' },
        questionPaper: qpDocTest,
        answerKey: akDocTest,
      }
    };
    await evaluationEngine.evaluate(emptyJob);
  } catch (err: any) {
    console.log('Caught err in Test 6:', {
      name: err.name,
      message: err.message,
      constructorName: err.constructor?.name,
      code: err.code,
    });
    emptyExtractionCaught = true;
    assert(
      err.name === 'ExtractionValidationError' || 
      err.name === 'ValidationError' || 
      err.code === 'EXTRACTION_VALIDATION_ERROR' || 
      err.code === 'ACADEMIC_VALIDATION_ERROR',
      'Empty extraction must throw ExtractionValidationError or ValidationError'
    );
    assert(
      err.message.includes('missing') || 
      err.message.includes('empty') || 
      err.message.includes('needs_review') || 
      err.message.includes('invalid'),
      'Error message must describe empty or invalid extraction'
    );
  }
  assert(emptyExtractionCaught, 'Empty student extraction must be rejected and never fabricate a report');

  console.log('\n======================================================');
  console.log(`🎉 ALL TESTS COMPLETED: ${passed} PASSED, ${failed} FAILED`);
  console.log('======================================================\n');
}

runTests().catch((e) => {
  console.error('Fatal test error:', e);
  process.exit(1);
});
