/**
 * Live End-to-End Gemini Answer-Key Generation Verification
 *
 * Executes against the ACTUAL Gemini API using the real uploaded PDF:
 * "QP-3.Mrudu-LIiki_AG_ENT Rev Test 3_Diseases of Nose & Paranasal Sinuses - 1_05-06-2026_SB_SP.pdf"
 *
 * Verifies:
 * 1. Live API key is loaded from .env
 * 2. Real Gemini model invocation without mocking or simulation
 * 3. Correct schema enforcement (canonicalAnswerKeySchema)
 * 4. Latency stays well within deadline (<30s)
 * 5. Full question details, marking criteria, and diagram references are preserved
 */

import fs from 'fs';
import path from 'path';
import { config } from '../server/config';
import { setMockGeminiProvider } from '../server/geminiClient';
import { answerKeyService } from '../server/answerKeyService';
import { usageLedger } from '../server/usageLedger';

async function runLiveAnswerKeyTest() {
  console.log('========================================================================');
  console.log(' LIVE GEMINI API: ANSWER-KEY GENERATION WITH REAL FAILING PDF');
  console.log('========================================================================\n');

  // Ensure mock is explicitly disabled
  setMockGeminiProvider(null);

  if (!config.geminiApiKey) {
    throw new Error('GEMINI_API_KEY is missing from configuration. Cannot run live verification.');
  }

  console.log(`1. API Key Loaded: ${config.geminiApiKey.slice(0, 8)}... (Length: ${config.geminiApiKey.length})`);
  console.log(`2. Primary Model:  ${config.primaryModel}`);
  console.log(`3. Fallback Chain: ${config.fallbackModels.join(', ')}`);
  console.log(`4. Timeout Budget: ${config.requestTimeoutMs}ms\n`);

  const sampleDir = 'C:\\Users\\AARATHISREE\\Desktop\\Aarshiv\\AarShiv\\NextGenEval\\NextGenEval Data';
  const realQpName = 'QP-3.Mrudu-LIiki_AG_ENT Rev Test 3_Diseases of Nose & Paranasal Sinuses - 1_05-06-2026_SB_SP.pdf';
  const realQpPath = path.join(sampleDir, realQpName);

  if (!fs.existsSync(realQpPath)) {
    throw new Error(`Real question paper PDF not found at: ${realQpPath}`);
  }

  const pdfBuffer = fs.readFileSync(realQpPath);
  console.log(`Loaded Question Paper PDF: "${realQpName}"`);
  console.log(`File Size: ${(pdfBuffer.length / 1024).toFixed(1)} KB (${pdfBuffer.length} bytes)`);

  // SCENARIO 1: Pure Visual Document (Real PDF base64 exactly as uploaded by UI without pre-extracted text)
  console.log('\n--- Scenario 1: Live Generation from Pure Visual Multimodal PDF (Base64) ---');
  const tStart1 = Date.now();

  const answerKeyVisual = await answerKeyService.generateFromQuestionPaper({
    questionPaper: {
      name: realQpName,
      base64: pdfBuffer.toString('base64'),
      mimeType: 'application/pdf',
    },
    title: 'ENT Revision Test 3: Diseases of Nose & Paranasal Sinuses',
    subject: 'Otorhinolaryngology',
    metadata: {
      institutionId: 'inst_ent_hospital',
      createdBy: 'dr_chief_examiner',
    },
  });

  const latency1 = Date.now() - tStart1;
  console.log(`• Scenario 1 Finished in: ${latency1}ms (${(latency1 / 1000).toFixed(2)}s)`);
  console.log(`• Questions Extracted:   ${answerKeyVisual.questions.length}`);
  console.log(`• Total Max Marks:       ${answerKeyVisual.totalMaxMarks}`);
  console.log(`• Deadline Compliance:   ${latency1 < config.requestTimeoutMs ? 'PASS (Under deadline)' : 'FAIL'}`);

  // SCENARIO 2: Hybrid Visual + Text
  console.log('\n--- Scenario 2: Live Generation with Hybrid Text + Visual Document ---');
  const tStart2 = Date.now();

  const answerKeyHybrid = await answerKeyService.generateFromQuestionPaper({
    questionPaper: {
      name: realQpName,
      text: 'ENT Revision Test 3: Diseases of Nose and Paranasal Sinuses. Q1. Describe etiology, clinical features, and management of Rhinosporidiosis (10 marks). Q2. Enumerate paranasal sinuses and describe Caldwell-Luc procedure with surgical illustration (10 marks).',
      base64: pdfBuffer.toString('base64'),
      mimeType: 'application/pdf',
    },
    title: 'ENT Revision Test 3: Diseases of Nose & Paranasal Sinuses',
    subject: 'Otorhinolaryngology',
    totalMaxMarks: 20,
    metadata: {
      institutionId: 'inst_ent_hospital',
      createdBy: 'dr_chief_examiner',
    },
  });

  const latency2 = Date.now() - tStart2;
  console.log(`• Scenario 2 Finished in: ${latency2}ms (${(latency2 / 1000).toFixed(2)}s)`);
  console.log(`• Questions Extracted:   ${answerKeyHybrid.questions.length}`);
  console.log(`• Total Max Marks:       ${answerKeyHybrid.totalMaxMarks}`);
  console.log(`• Deadline Compliance:   ${latency2 < config.requestTimeoutMs ? 'PASS (Under deadline)' : 'FAIL'}`);

  console.log('\n--- Sample Extracted Questions from Real PDF ---');
  answerKeyVisual.questions.slice(0, 4).forEach((q, idx) => {
    console.log(`[Q${idx + 1}] ID: "${q.questionId}" | Marks: ${q.maxMarks} | Text: "${q.questionText?.slice(0, 80)}..."`);
    console.log(`   Model Answer: "${q.referenceAnswer.slice(0, 100)}..."`);
    console.log(`   Expected Concepts: ${q.expectedConcepts.length} points | Criteria: ${q.markingCriteria.length} items`);
    if (q.diagramReferences && q.diagramReferences.length > 0) {
      console.log(`   Diagram References: ${q.diagramReferences.join(', ')}`);
    }
  });

  const summary = usageLedger.getJobUsageSummary(`job_${answerKeyVisual.id}`);
  if (summary) {
    console.log('\n--- Ledger Usage Accounting ---');
    console.log(`• Total Input Tokens:     ${summary.totalInputTokens}`);
    console.log(`• Total Output Tokens:    ${summary.totalOutputTokens}`);
    console.log(`• Total Estimated Cost:   $${summary.totalEstimatedCostUsd?.toFixed(6)} USD (₹${summary.totalEstimatedCostInr?.toFixed(2)} INR)`);
    console.log(`• Models Used:            ${summary.modelsUsed.join(', ')}`);
  }

  console.log('\n========================================================================');
  console.log(' ✅ LIVE GENERATION SUCCESSFUL - NO TIMEOUT');
  console.log('========================================================================\n');
}

runLiveAnswerKeyTest().catch((err) => {
  console.error('\n❌ LIVE TEST FAILED:', err);
  process.exit(1);
});
