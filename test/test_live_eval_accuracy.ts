import { evaluationEngine } from '../server/evaluator';
import { answerKeyService } from '../server/answerKeyService';
import { EvaluationJob, CanonicalAnswerKey } from '../server/types';
import assert from 'assert';

async function runLiveValidation() {
  console.log('========================================================================');
  console.log(' STARTING REAL-WORLD LIVE GEMINI STUDENT EVALUATION VALIDATION');
  console.log('========================================================================\n');

  const institutionId = `inst_live_${Date.now()}`;
  const userId = `prof_eval_${Date.now()}`;
  const userCtx = {
    userId,
    role: 'instructor' as const,
    institutionId,
    name: 'Prof. Validation',
  };

  const canonicalKeyData: CanonicalAnswerKey = {
    id: `ak_live_val_${Date.now()}`,
    examId: `exam_val_${Date.now()}`,
    title: 'Anatomy End-Term Assessment (Clinical Upper Limb)',
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
        questionText: 'Describe the course and branches of the Median Nerve in the forearm, along with its clinical correlation.',
        referenceAnswer: 'The median nerve enters the forearm between the two heads of pronator teres. It runs between flexor digitorum superficialis and flexor digitorum profundus. It gives muscular branches to superficial flexors, the anterior interosseous nerve (to deep flexors), and a palmar cutaneous branch. Clinically, compression in the carpal tunnel leads to Carpal Tunnel Syndrome with thenar atrophy.',
        expectedConcepts: [
          'Pronator teres heads relation',
          'Course between superficial and deep flexors',
          'Anterior interosseous nerve branch',
          'Muscular branches to flexor compartment',
          'Clinical: Carpal tunnel syndrome or thenar atrophy',
        ],
        acceptableAlternatives: [
          'C5-T1 root values mention',
          'Ape thumb deformity or sensory loss over lateral 3.5 digits',
        ],
        markingCriteria: [
          'Course in forearm: 3 marks',
          'Branches (muscular & anterior interosseous): 4 marks',
          'Clinical correlation: 3 marks',
        ],
        diagramReferences: ['Forearm flexor compartment and carpal tunnel schematic'],
        confidence: 0.98,
      },
      {
        questionId: '2.a',
        subquestionId: 'a',
        maxMarks: 5,
        questionText: 'Enumerate the bones of the proximal and distal rows of the carpus.',
        referenceAnswer: 'Proximal row (lateral to medial): Scaphoid, Lunate, Triquetrum, Pisiform. Distal row (lateral to medial): Trapezium, Trapezoid, Capitate, Hamate.',
        expectedConcepts: [
          'Proximal row: Scaphoid, Lunate, Triquetrum, Pisiform',
          'Distal row: Trapezium, Trapezoid, Capitate, Hamate',
          'Correct order (lateral to medial)',
        ],
        acceptableAlternatives: ['Standard mnemonics accepted if individual bones are listed'],
        markingCriteria: [
          'Proximal row bones correct: 2.5 marks',
          'Distal row bones correct: 2.5 marks',
        ],
        confidence: 0.99,
      },
      {
        questionId: '2.b',
        subquestionId: 'b',
        maxMarks: 5,
        questionText: 'Explain the anatomical basis of Volkmann ischemic contracture.',
        referenceAnswer: 'Volkmann ischemic contracture results from acute ischemia of the forearm muscles, often due to supracondylar fracture of humerus causing brachial artery injury or compartment syndrome. Fibrosis of flexor digitorum profundus and superficialis leads to flexion contracture at the wrist and interphalangeal joints.',
        expectedConcepts: [
          'Brachial artery injury or compartment syndrome',
          'Ischemia and necrosis of forearm flexor muscles',
          'Fibrous replacement causing permanent flexion contracture',
        ],
        acceptableAlternatives: ['Supracondylar fracture association'],
        markingCriteria: [
          'Etiology (supracondylar fracture/compartment syndrome): 2 marks',
          'Pathophysiology (ischemic muscle necrosis): 2 marks',
          'Deformity presentation: 1 mark',
        ],
        confidence: 0.97,
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
  console.log(`✓ Canonical Answer Key created and approved: ${approvedKey.id} (Total Marks: ${approvedKey.totalMaxMarks})`);

  const studentScriptText = `
STUDENT ANSWER SHEET
Student Name: Aarav Sharma
Roll Number: MBBS-2026-088
Subject: Human Anatomy End-Term
Date: 2026-10-31

Question 1:
Course of Median Nerve in the Forearm:
The median nerve enters the forearm by passing between the humeral and ulnar heads of the pronator teres muscle.
It travels down the anterior compartment of the forearm between flexor digitorum superficialis and flexor digitorum profundus.
At the lower forearm, approximately 5 cm above the wrist, it emerges on the lateral side of flexor digitorum superficialis and lies medial to the tendon of flexor carpi radialis.

Branches in Forearm:
1. Muscular branches: Arise directly from the nerve to supply pronator teres, flexor carpi radialis, palmaris longus, and flexor digitorum superficialis.
2. Anterior Interosseous Nerve (AIN): Arises between the two heads of pronator teres. It runs down the interosseous membrane to supply flexor pollicis longus, the lateral half of flexor digitorum profundus, and pronator quadratus.
3. Palmar cutaneous branch: Supplies sensory innervation to the skin over the thenar eminence and central palm.
4. Articular branches: to elbow and superior radioulnar joints.

Clinical Correlation:
Carpal Tunnel Syndrome: Compression of the median nerve within the osteofibrous carpal tunnel beneath the flexor retinaculum.
Features include burning pain and paresthesia along the lateral 3.5 digits, weakness of thumb abduction and opposition, and eventual atrophy of the thenar muscles (ape thumb deformity).

---

Question 2.a:
Carpal Bones:
The proximal row bones from lateral to medial are:
1. Scaphoid
2. Lunate
3. Triquetrum
4. Pisiform (a sesamoid bone in flexor carpi ulnaris tendon)

(Note: Distal row bones were not listed by the student)

---

Question 2.b:
[Left Blank / Question was not attempted by student]
`;

  const mockPngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

  const job: EvaluationJob = {
    id: `job_val_${Date.now()}`,
    correlationId: `corr_val_${Date.now()}`,
    status: 'queued',
    progressPercent: 0,
    currentStepMessage: 'Queued for live evaluation',
    mode: 'without-manual',
    studentName: 'Aarav Sharma',
    institutionId,
    createdBy: userId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    canonicalAnswerKey: approvedKey,
    inputPayload: {
      sourceDoc: {
        name: 'Aarav_Sharma_Anatomy_AnswerScript.txt',
        text: studentScriptText + `\n// Timestamp: ${Date.now()}`,
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

  console.log('\n--- INVOKING LIVE GEMINI EVALUATION PIPELINE ---');
  const report = await evaluationEngine.evaluate(job, (progress, step) => {
    console.log(`[Progress ${progress}%] ${step}`);
  });

  console.log('\n--- EXTRACTED SCRIPT FROM STAGE 1 ---');
  console.log(JSON.stringify(job.extractedScript, null, 2));

  console.log('\n========================================================================');
  console.log(' LIVE EVALUATION COMPLETED SUCCESSFULLY');
  console.log('========================================================================');
  console.log(`Student Name    : ${report.studentName}`);
  console.log(`Exam Title      : ${report.testTitle}`);
  console.log(`Evaluated Model : ${report.evaluatedByModel}`);
  console.log(`Total Score     : ${report.totalScore} / ${report.maxScore} marks`);
  console.log('------------------------------------------------------------------------');
  console.log('Question-wise Detailed Breakdown:');

  for (const q of report.questions) {
    console.log(`\nQuestion ${q.qNo}:`);
    console.log(`  Awarded Marks : ${q.marks} / ${q.maxMarks} (isCorrect: ${q.isCorrect})`);
    console.log(`  Feedback      : ${q.feedbackPoints.join(' ')}`);
  }

  console.log('\n--- VERIFYING GRADING ACCURACY CONSTRAINTS ---');

  const q1 = report.questions.find((q) => q.qNo === '1');
  assert(q1 !== undefined, 'Question 1 must be present in report');
  assert(q1.marks >= 8.0, `Question 1 should receive >= 8/10 marks for detailed answer. Actual: ${q1.marks}`);
  console.log(`✓ Question 1: Received ${q1.marks}/10 (NOT zero!) - Verified accurate full credit.`);

  const q2a = report.questions.find((q) => q.qNo === '2.a');
  assert(q2a !== undefined, 'Question 2.a must be present in report');
  assert(q2a.marks >= 2.0 && q2a.marks <= 4.0, `Question 2.a should receive ~2.5/5 marks for proximal row only. Actual: ${q2a.marks}`);
  console.log(`✓ Question 2.a: Received ${q2a.marks}/5 (NOT zero!) - Verified proportional partial credit.`);

  const q2b = report.questions.find((q) => q.qNo === '2.b');
  assert(q2b !== undefined, 'Question 2.b must be present in report');
  assert(q2b.marks === 0, `Question 2.b must receive 0/5 marks because it was unattempted. Actual: ${q2b.marks}`);
  assert(
    q2b.feedbackPoints.some((f) => f.toLowerCase().includes('not attempted') || f.toLowerCase().includes('omitted') || f.toLowerCase().includes('not answered')),
    'Question 2.b feedback must clearly indicate question was not attempted'
  );
  console.log(`✓ Question 2.b: Received 0/5 - Verified genuine unattempted distinction.`);

  const sumOfMarks = report.questions.reduce((acc, q) => acc + q.marks, 0);
  assert(
    Math.abs(report.totalScore - sumOfMarks) < 0.05,
    `Total score (${report.totalScore}) must equal mathematical sum of marks (${sumOfMarks})`
  );
  console.log(`✓ Total Score Math: ${report.totalScore} equals exact sum of question marks (${sumOfMarks}).`);

  assert(report.totalScore > 0, `Total score must be non-zero! Actual: ${report.totalScore}`);
  console.log(`✓ Non-Zero Guarantee: Student was awarded ${report.totalScore}/20 (Zero-marks bug successfully resolved).`);

  console.log('\n========================================================================');
  console.log(' ALL REAL-WORLD LIVE EVALUATION CHECKS PASSED WITH FLYING COLORS!');
  console.log('========================================================================\n');
}

runLiveValidation().catch((err) => {
  console.error('\n❌ Live Validation Failed:', err);
  process.exit(1);
});
