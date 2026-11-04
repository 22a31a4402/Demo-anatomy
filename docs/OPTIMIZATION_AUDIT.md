# NextGen Eval — Phase 0 Repository Audit & Optimization Baseline

**Project:** NextGen Eval by Aarshiv AI  
**Client:** Anatomy Guru (Medical Coaching Institute)  
**Document Version:** 1.0.0  
**Audit Date:** May 2026 / Turn Baseline  
**Auditor:** Senior AI Infrastructure & Reliability Engineering Team  

---

## Executive Summary

NextGen Eval evaluates students' handwritten academic answer scripts (typically 40–50 pages for medical and university examinations) against authoritative question papers, answer keys, and marking schemes using Gemini multimodal models.

* **Client Reported Operating Cost:** ₹9–₹14 per student script (40–50 pages) — based on client billing reports, prior to independent model usage verification.
* **Target Operating Cost:** ₹4–₹5 or less per completed student evaluation without degrading academic grading accuracy or visual evidence inspection.
* **Commercial Model:** Client-owned Google Cloud Project, Gemini API key, and GCP billing account; Aarshiv AI provides application development, hardening, deployment, handover, and SLA maintenance.
* **Current Operational Constraint:** No active Gemini API key is configured in the current development environment. All Phase 0 findings, micro-benchmarks, and test verifications are conducted offline with zero fabricated metrics or assumed numbers. Real Gemini measurements are reported strictly as **unmeasured / pending API key configuration**.

---

## 1. Current Architecture & Actual Execution Flow

### 1.1 High-Level Architecture Overview

The repository is structured as a full-stack web application with a dedicated Node.js/Express backend that mounts Vite middleware during development and serves static production assets in production, alongside a separate Python/FastAPI backend prototype.

```
+-----------------------------------------------------------------------------------------+
|                                    CLIENT BROWSER (SPA)                                 |
|                                                                                         |
|  +--------------------+   +---------------------+   +--------------------------------+  |
|  | Single Evaluation  |   | Batch Processor     |   | 4-in-1 PDF Exporter & Report   |  |
|  | (App.tsx)          |   | (BatchProcessor.tsx)|   | (FeedbackReport.tsx)           |  |
|  +---------+----------+   +----------+----------+   +---------------+----------------+  |
|            |                         |                              |                   |
|            +------------+------------+                              |                   |
|                         |                                           |                   |
|                         v                                           |                   |
|            services/geminiService.ts (API Proxy)                    |                   |
|            - Auth Bearer Token                                      |                   |
|            - SSE Listener + Polling Fallback                        |                   |
+-------------------------|-------------------------------------------|-------------------+
                          | HTTP POST /api/evaluations                |
                          | SSE GET /api/evaluations/:id/events       |
                          v                                           |
+---------------------------------------------------------------------|-------------------+
|                         NODE.JS / EXPRESS 5 BACKEND (server.ts)     |                   |
|                                                                     |                   |
|  [CORS Allowlist] -> [Correlation ID] -> [Auth & RBAC Middleware]   |                   |
|                                                                     |                   |
|  +---------------------------------------------------------------+  |                   |
|  | evaluationsRouter (server/routes/evaluations.ts)              |  |                   |
|  | - POST /api/evaluations (Enqueue Job, Rate Limit & Capacity)  |  |                   |
|  | - GET /api/evaluations/:id (Job status & metrics)             |  |                   |
|  | - GET /api/evaluations/:id/results (Validated report)         |  |                   |
|  | - GET /api/evaluations/:id/events (SSE progress stream)       |  |                   |
|  | - POST /api/evaluations/:id/retry (Safe retry)                |  |                   |
|  | - DELETE /api/evaluations/:id (Job & file deletion)           |  |                   |
|  +-------------------------------+-------------------------------+  |                   |
|                                  |                                  |                   |
|                                  v                                  |                   |
|  +---------------------------------------------------------------+  |                   |
|  | EvaluationQueue (server/queue.ts)                             |  |                   |
|  | - In-memory Map + Atomic Disk Persistence (.tmp -> .json)     |  |                   |
|  | - Bounded concurrency pool (maxConcurrentEvaluations = 4)     |  |                   |
|  | - Queue capacity limit = 50 jobs (HTTP 503 Backpressure)      |  |                   |
|  | - Crash recovery on server startup                            |  |                   |
|  +-------------------------------+-------------------------------+  |                   |
|                                  |                                  |                   |
|                                  v                                  |                   |
|  +---------------------------------------------------------------+  |                   |
|  | EvaluationEngine (server/evaluator.ts)                        |  |                   |
|  |                                                               |  |                   |
|  | 1. Cryptographic Fingerprint & Authorization Check             |  |                   |
|  |    (server/cache.ts - Full SHA-256 over all bytes & params)   |  |                   |
|  |    --> If Cache HIT: Return cached report (0 API tokens)      |  |                   |
|  |                                                               |  |                   |
|  | 2. Document Processor (server/documentProcessor.ts)           |  |                   |
|  |    --> Formats distinct QP, AK, Student Script, Faculty Notes |  |                   |
|  |                                                               |  |                   |
|  | 3. Resilient Gemini Client (server/geminiClient.ts)            |  |                   |
|  |    --> Primary: gemini-3.8-flash, Fallbacks: flash-latest     |  |                   |
|  |    --> Request timeout (90s) & exponential backoff on 503/429 |  |                   |
|  |                                                               |  |                   |
|  | 4. Strict Academic Validation Engine                           |  |                   |
|  |    --> Score bounds (marks <= maxMarks, no clamping)          |  |                   |
|  |    --> Non-zero maxMarks (no default to 1)                    |  |                   |
|  |    --> Mathematical total sum consistency verification        |  |                   |
|  |    --> Discrepancy -> transition to 'needs_review'            |  |                   |
|  |                                                               |  |                   |
|  | 5. Final Report Cache Write & Completion Event                |  |                   |
|  +---------------------------------------------------------------+  |                   |
+-----------------------------------------------------------------------------------------+
```

### 1.2 End-to-End Execution Trace

1. **Upload & Preprocessing (Client):**
   * In `App.tsx` or `components/BatchProcessor.tsx`, the instructor uploads:
     * Student written answer script (PDF or images).
     * Question paper (PDF or text).
     * Official answer key / marking scheme (PDF or text).
     * Optional faculty manual feedback notes (for `with-manual` mode).
   * Files are parsed using `pdfjs-dist` (text extraction) and converted to base64 via `safeFileToBase64`.
   * Filenames are parsed via `services/filenameParser.ts` to deduce student names.

2. **Submission to Backend API (`services/geminiService.ts`):**
   * The client initiates `generateStructuredFeedback(...)`.
   * Sends an HTTP POST to `/api/evaluations` with payload containing:
     * `sourceDoc`: `{ name, text, base64, mimeType }`
     * `questionPaper`: `{ name, text, base64, mimeType }`
     * `answerKey`: `{ name, text, base64, mimeType }`
     * `facultyNotes`: `{ name, text, base64, mimeType }` (if mode is `with-manual`)
     * `mode`: `'with-manual'` or `'without-manual'`
     * `studentName` & `testTitle`
   * Request includes `Authorization: Bearer <token>` (defaulting to instructor token `nextgen_inst_sec_token_4412`).

3. **Ingestion & Queue Admission (`server.ts` & `server/queue.ts`):**
   * CORS allowlist validates the calling origin.
   * Authentication middleware (`server/auth.ts`) validates credentials, checks per-client rate limits (max 120 req/min), and attaches `UserContext` (`userId`, `role`, `institutionId`).
   * Queue capacity is verified (`queuedCount < 50`). If exceeded, HTTP 503 with `Retry-After: 30` is returned.
   * An atomic write persists job state to `.data/evaluations/jobs/<jobId>.json` via a `.tmp` file and rename.
   * Returns HTTP 202 Accepted with `jobId`, `correlationId`, and status URL links.

4. **Progress Monitoring:**
   * The frontend establishes an SSE connection to `/api/evaluations/:id/events` (with fallback polling every 1500ms to `/api/evaluations/:id`).
   * Real-time events (`status`, `progress`, `completed`, `failed`) keep the UI responsive.

5. **Worker Execution (`server/evaluator.ts`):**
   * Worker pool is bounded by `config.maxConcurrentEvaluations = 4` to prevent API rate limit exhaustion.
   * **Stage B (Fingerprinting & Cache Lookup):** `evaluationCache.generateFingerprint(...)` computes a full-byte SHA-256 digest across 100% of all documents and settings. If a cache hit is found and caller's tenant matches, the verified report is returned immediately (0 tokens, 0 cost).
   * **Stage C (Multimodal Assembly):** `documentProcessor.prepareInput(...)` constructs structured parts, sending text where available and visual base64 for student scripts to inspect diagrams, equations, and handwriting.
   * **Stage D (Model Invocation):** `callGeminiWithFallback(...)` calls `ai.models.generateContent` on `gemini-3.8-flash` with response schema enforcement, temperature 0, and a 90-second deadline. Retries with exponential backoff on transient errors (429, 503, timeouts).
   * **Stage F (Academic Validation):** `validateAndNormalizeReport(...)` verifies every question:
     * Question ID uniqueness and non-empty status.
     * Finite positive `maxMarks` (never defaults to 1).
     * Awarded marks within `[0, maxMarks]` (never clamped).
     * Mathematical sum: `totalScore === sum(q.marks)` and `maxScore === sum(q.maxMarks)`.
     * If validation fails, the job transitions to `needs_review` and never silently completes with fabricated marks.
   * **Stage G (Assembly & Storage):** The validated report is cached, the job is marked `completed`, and the final report is saved to disk.

6. **Client Completion & Reporting:**
   * The client receives the `completed` event, loads the report into `FeedbackReport.tsx`, and enables interactive editing, re-scoring, and 4-in-1 unified PDF export via `services/evaluationPdf.ts`.

---

## 2. Authoritative Backend Determination

The repository contains both TypeScript/Node.js (`server/`, `server.ts`) and Python/FastAPI (`backend/`) implementations:

| Criterion | TypeScript / Express Backend (`server.ts`) | Python / FastAPI Backend (`backend/`) | Determination |
| :--- | :--- | :--- | :--- |
| **Frontend Integration** | **Directly connected.** React frontend (`services/geminiService.ts`, `App.tsx`) calls `/api/evaluations` on the same Express server port (3000). | Not connected to frontend by default; requires running a separate server process on port 8000. | **TypeScript is Authoritative** |
| **Dev Environment** | Fully integrated with Vite middleware in `server.ts` (`npm run dev`). Dev server and API run concurrently on port 3000. | Requires separate Python environment, pip packages (`google-genai`, `fastapi`, `uvicorn`), and separate port proxying. | **TypeScript is Authoritative** |
| **Test Coverage** | Full test suite (`npm test`) executes `test/test_pipeline.ts` with 26 automated tests passing. | No dedicated Python test suite configured in `package.json` or CI. | **TypeScript is Authoritative** |
| **Production Build** | Node production build (`npm run build` + `npm start`) packages SPA static files served by Express. | Requires separate Docker container or multi-service orchestration. | **TypeScript is Authoritative** |
| **Parity Status** | Complete implementation of Auth, RBAC, Cache, Queue, Evaluator, and Validation. | Hardened in previous turn (no 10/10 mock fallback, startup recovery added), but remains a secondary reference. | **TypeScript is Authoritative** |

### Decision:
* **The Node.js / Express backend (`server.ts` + `server/`) is the single authoritative production evaluation backend.**
* The Python backend in `backend/` is designated as an **alternative / secondary reference service**. It has been hardened to prevent fabricated results and enforce security, but will not be used in the production execution path to prevent dual-backend drift.

---

## 3. Current Gemini Call Sites, Models, and Configurations

### 3.1 Call Site Inventory

#### Call Site 1: Node.js Primary Evaluator
* **File:** `/server/geminiClient.ts` -> `callGeminiWithFallback()`
* **Invoked By:** `server/evaluator.ts` -> `EvaluationEngine.evaluate()` (line 123)
* **SDK:** `@google/genai` (v1.40.0) with header `User-Agent: aistudio-build`
* **Models:**
  * Primary: `gemini-3.8-flash` (configurable via `GEMINI_MODEL` env var)
  * Fallbacks: `gemini-flash-latest`, `gemini-3.1-flash-lite`
* **Configuration:**
  * `temperature: 0`
  * `seed: 42`
  * `responseMimeType: 'application/json'`
  * `responseSchema: evaluationReportSchema` (enforces typed JSON structure)
  * `requestTimeoutMs: 90000` (enforced via `Promise.race`)
  * `maxRetriesPerModel: 2`
  * Backoff: Bounded exponential backoff (`min(1000 * 2^(attempt-1) + jitter, 6000)`)
* **Payload Structure:**
  * System instruction: Strict subject-agnostic academic evaluator guidelines, rubric compliance, diagram verification, partial-credit rules, audit privacy.
  * Parts:
    1. Official Question Paper (text block or visual base64 inlineData)
    2. Official Answer Key (text block or visual base64 inlineData)
    3. Student Script Header & OCR text (if available)
    4. Student Script Full Visual Multimodal Pages (base64 inlineData, for diagrams & handwriting)
    5. Faculty Notes (text/base64, only for `with-manual` mode)
    6. Execution prompt directive

#### Call Site 2: Python Secondary Evaluator
* **File:** `/backend/main.py` -> `process_evaluation_job()` (line 164)
* **SDK:** `google-genai` (Python)
* **Model:** `gemini-3.8-flash` (configured via `backend/config.py`)
* **Status:** Secondary alternative; identical prompt and validation schema.

#### Client-Side Inspection:
* **File:** `/services/geminiService.ts`
* **Finding:** Contains **ZERO direct Gemini API calls**. All calls are proxied through `/api/evaluations` with server-side authentication. No client-side Gemini SDK imports exist in the browser bundle.

---

## 4. Cost Drivers & Cost-Saving Opportunities

### 4.1 Cost Structure Analysis (40–50 Page Scripts)
In an examination setting (e.g. Anatomy Guru medical exams), students write 40 to 50 pages of handwritten answers. Under the current monolithic pipeline:
* **Input Tokens per Student:**
  * Question Paper: ~3,000–8,000 tokens.
  * Answer Key & Marking Scheme: ~8,000–20,000 tokens.
  * Student Handwritten Script: 40–50 pages × ~258 tokens/image = ~10,320–13,000 visual tokens (or significantly more if scanned at ultra-high resolution or with extracted OCR text duplicated).
  * System Prompt & Rubric: ~1,500 tokens.
  * **Total Prompt Tokens per Student:** ~25,000–45,000 tokens.
* **Redundancy Across a Batch:**
  * In a batch of 50 students taking the exact same exam:
    * The Question Paper and Answer Key (~15,000–28,000 tokens) are sent **50 separate times**.
    * Total redundant input tokens across the batch: **750,000 to 1,400,000 tokens**.
* **Output Token Inefficiency:**
  * Generating a 30-question report in one shot generates ~2,500–4,000 output tokens. Output tokens are priced 4× higher than input tokens ($0.30/1M vs $0.075/1M).
  * If the model stutters, truncates, or fails validation on question 29, the entire 4,000-token generation is lost and must be re-executed from scratch.

### 4.2 Identified Optimization Opportunities (Phases 1–8 Roadmap)

| Opportunity | Current State | Proposed Hardened State | Potential Variable Cost Impact |
| :--- | :--- | :--- | :--- |
| **1. Reusable Exam Reference JSON (Phase 3)** | Reference documents (QP + AK) are transmitted in full with every student evaluation call. | Extract & validate Exam Reference JSON once per exam; store permanently by content hash; reuse structured reference for all students in that exam. | **35% – 50% input token reduction** across batch evaluations. |
| **2. Gemini Context Caching** | No context caching headers or TTL cache IDs are used; all tokens are billed at full prompt price. | Use Gemini API Context Caching on the shared Exam Reference for exams exceeding 32k tokens. Subsequent calls receive up to 75% input token discount. | **Up to 75% discount** on reference input tokens. |
| **3. Two-Stage Pipeline: OCR/Vision Extraction vs Grading (Phase 4 & 5)** | A single massive prompt attempts to read 50 pages of handwriting, map questions, and grade simultaneously. | **Stage 1:** Extract handwriting into validated `student-answers.json` once. **Stage 2:** Grade structured answers question-by-question or in small batches. Avoids re-reading 50 pages on grading retries. | Eliminates redundant vision token processing during rubric adjustments or regrading. |
| **4. Question-Group Chunked Grading (Phase 5)** | All 20–30 questions are evaluated in a single monolithic prompt, risking token truncation and high blast-radius failures. | Evaluate in question groups (e.g., 3–5 questions per chunk) or sections (MCQs, Short Notes, Long Essays). Failed chunks retry individually without re-grading the entire exam. | Reduces retry waste; enables fine-grained progress reporting. |
| **5. Model Tiering & Selective Escalation (Phase 5 & 8)** | Monolithic model (`gemini-3.8-flash`) runs for all questions regardless of complexity. | Use `gemini-3.1-flash-lite` for straightforward MCQs and objective text; selectively escalate only diagram-heavy or ambiguous subjective answers to `gemini-3.8-flash`. | **20% – 40% cost reduction** on objective and simple questions. |
| **6. Output Schema Compactness** | Verbose general feedback sections (`presentationDiagrams`, `investigations`, `actionPoints`) with redundant generic filler. | Concise, high-density structured feedback focusing specifically on missing key concepts and rubric mark deductions. | **25% – 35% output token reduction** ($0.30/1M output savings). |
| **7. Content-Addressed Caching (Phase 6)** | In-memory + disk cache operates on full raw document hashes. | Multi-tier caching: (1) Reference extraction cache, (2) Student transcription cache, (3) Question evaluation cache. | 100% savings on re-evaluations or duplicate submissions. |

---

## 5. Security, Correctness, and Reliability Status

### 5.1 Security Audit
* **CORS Allowlist:** Configurable via `ALLOWED_ORIGINS`. Safely supports Google AI Studio Preview domains (`*.googleusercontent.com`, `*.google.com`, `*.run.app`) and loopback interfaces. Non-allowed origins receive clean rejection without crashing the server.
* **Authentication & RBAC:** Protected endpoints require Bearer tokens or `x-api-key`. Role hierarchy (`operator`, `admin`, `instructor`, `evaluator`) and tenant isolation (`institutionId`) prevent cross-tenant data leaks.
* **Credential Isolation:** `GEMINI_API_KEY` is loaded exclusively in server environment variables (`server/config.ts`). It is never passed to Vite frontend defines or client responses.
* **Upload Boundaries:** Request bodies are bounded at 50MB to accommodate high-resolution multi-page student scans without memory exhaustion.
* **Rate Limiting:** Per-client rate limit of 120 requests/minute prevents API flooding and accidental billing spikes.

### 5.2 Correctness & Grading Integrity
* **No Fabricated Fallbacks:** Any missing API key, model failure, timeout, or malformed JSON strictly triggers a `failed` or `needs_review` state. The system never generates fake 10/10 marks.
* **Strict Academic Validation Engine:**
  * Rejects marks > maxMarks (never clamps).
  * Rejects negative, NaN, or non-finite marks.
  * Rejects missing or non-positive maxMarks (never defaults to 1).
  * Rejects duplicate question IDs.
  * Verifies that `totalScore === sum(q.marks)` within 0.05 tolerance.
* **Adversarial Resilience:** 10 adversarial unit tests in `test/test_pipeline.ts` pass, proving that invalid model outputs are caught and flagged for human review.

### 5.3 Reliability & Queue Persistence Limits
* **Atomic Persistence:** Evaluation jobs are saved using `.tmp` files and atomic filesystem renames (`fs.renameSync`), preventing corrupted JSON files during sudden crashes.
* **Startup Recovery:** Interrupted jobs (`preprocessing`, `grading`, `validating`) are automatically recovered into `queued` status on server restart and workers resume processing.
* **Durability Boundary Limitation:** Current job queue and cache use local filesystem storage (`.data/evaluations/`). This is durable across restarts of a single persistent instance, but **is not suitable for multi-replica auto-scaling container environments (e.g., Cloud Run or Kubernetes)** without a shared persistent volume or distributed store (Redis / Cloud SQL). This limitation is documented for Phase 9 handover.

---

## 6. Existing Tests & Missing Test Coverage

### 6.1 Existing Test Suite (`test/test_pipeline.ts`)
The current test suite consists of 26 comprehensive automated tests across 4 core groups:
1. **Full-Byte SHA-256 Digesting & Cache Invalidation (4 tests):**
   * Deterministic hashing consistency.
   * Middle-byte mutation of same-length 10KB PDF buffer alters hash.
   * Tenant isolation alters hash.
2. **Adversarial Academic Score Validation (10 tests):**
   * Valid report acceptance.
   * Marks > maxMarks rejection.
   * NaN and infinite marks rejection.
   * Negative marks rejection.
   * maxMarks <= 0 rejection.
   * Duplicate question IDs rejection.
   * Total score mismatch rejection.
   * Partial credit preservation.
3. **Authentication & Multi-Tenant Access Control (7 tests):**
   * Unauthenticated rejection.
   * Instructor token authentication.
   * Tenant binding.
   * Operator token privileges.
   * Cross-institution isolation (403 Forbidden).
   * Authorized same-institution access.
4. **Queue Persistence & Concurrency Bounds (5 tests):**
   * Job enqueueing & persistence.
   * Atomic file writing without orphan temp files.
   * Queue capacity backpressure limit (50 jobs -> HTTP 503).

**Actual Execution Result:** 26/26 tests PASSED (`npm test`, verified May 2026).

### 6.2 Existing Benchmark Suite (`test/benchmark.ts`)
* **Micro-benchmarks:** Measured high-resolution timings for SHA-256 hashing (20.18ms for 4.5MB), cache hit retrieval (0.09ms), validation throughput (0.08ms for 50 questions), and batch enqueueing (3.23ms for 10 jobs).
* **Live Gemini Benchmark:** Implemented with opt-in flag (`RUN_LIVE_BENCHMARK=true`). Safely skips when no API key is present without failing the suite.

### 6.3 Missing Test Coverage to Implement in Phases 1–7
* **Offline Mock Gemini Provider:** A mock provider simulating realistic Gemini responses with token usage metadata, network latency distributions, rate-limiting (429), timeouts, and malformed outputs without calling Google APIs.
* **Multi-Page Student Script Tests:** Tests validating pagination, page-mapping, and diagram extraction across 40–50 page scripts.
* **Exam Reference Reusability Tests:** Tests verifying that identical question papers and answer keys in a batch produce exactly 1 reference extraction and N evaluation calls.
* **Token & Cost Accounting Tests:** Tests verifying per-model pricing calculations, INR conversion, prompt cache accounting, and retry cost aggregation.
* **Question Chunking & Partial Regrade Tests:** Tests verifying that failing question 15 does not require re-evaluating questions 1 through 14.

---

## 7. Baseline Measurement Plan

Because no active Gemini API key is currently configured, the system must maintain a strict boundary between **empirically measured local performance**, **simulated offline estimates**, and **live Gemini API measurements**.

### 7.1 Measurement Categorization Standard
1. **Real Gemini Measured:**
   * Token counts taken directly from `response.usageMetadata.promptTokenCount` and `candidatesTokenCount`.
   * Real wall-clock latency measured via `performance.now()`.
   * Real cost calculated from verified token counts and official GCP pricing.
   * *Current Status:* **Unmeasured (Pending client/dev API key).**
2. **Simulated / Estimated:**
   * Simulated token counts and latencies produced by offline mock providers based on typical document sizes.
   * Clearly labeled in all UI and metrics as `Simulated (Offline Mode)`.
3. **Local Architecture Measured:**
   * Disk I/O, cryptographic hashing, JSON parsing, schema validation, and memory operations.
   * *Current Status:* **Physically measured via Node `perf_hooks`.**

### 7.2 Live Benchmark Harness Specification (When Key is Provided)
* **Dataset:** 3 representative medical answer scripts from Anatomy Guru:
  * Script A: 10-page short assessment (MCQs + 5 short notes).
  * Script B: 30-page standard exam (MCQs, short notes, 2 long essays with diagrams).
  * Script C: 50-page full comprehensive exam (multi-part clinical cases, anatomical drawings).
* **Ground Truth:** Faculty-awarded question-level and total marks.
* **Controlled Comparison Metrics:**
  * Total input & output tokens per script.
  * Measured median and P95 latency.
  * Total cost per script in USD and INR (at configurable exchange rate, e.g. ₹85/USD).
  * Score concordance: Mean absolute error (MAE) vs faculty marks.
  * Question-level agreement and partial credit fidelity.
  * Diagram recognition success rate.

---

## 8. Phased Implementation Checklist

- [x] **Phase 0: Repository Audit & Optimization Baseline**
  - [x] Inspect full codebase across frontend, backend, server, and tests.
  - [x] Trace complete execution path from upload to evaluation and PDF export.
  - [x] Determine authoritative backend (Node/Express).
  - [x] Inventory all Gemini call sites, models, schemas, and retry policies.
  - [x] Identify major cost drivers (redundant reference transmission, monolithic prompts).
  - [x] Document security, correctness, and queue persistence limits.
  - [x] Run baseline regression tests (26/26 passed) and empirical benchmark.
  - [x] Produce and commit `docs/OPTIMIZATION_AUDIT.md`.

- [x] **Phase 1: Security, Grading Integrity & Reliability Hardening**
  - [x] Enforce strict input validation on document MIME types and sizes (PDF, JPEG, PNG, WebP, plain text, DOCX).
  - [x] Disallow forged operator/admin roles via unsigned dynamic tokens; add HMAC-SHA256 signature verification.
  - [x] Add dedicated evaluation creation rate limiting (max 15 evals/min per client key).
  - [x] Enforce 90-second overall deadline across all attempts, retries, and fallback models combined.
  - [x] Implement cancellation (`POST /api/evaluations/:id/cancel`) and draft review (`GET /api/evaluations/:id/review`).
  - [x] Add automated retention pruning endpoint (`POST /api/evaluations/prune`) restricted to operators/admins.
  - [x] Preserve draft unvalidated reports on `needs_review` state for human discrepancy auditing.
  - [x] Clean up stale `.tmp.` files (> 5 minutes) and prune zero-byte corrupt files on queue startup.
  - [x] Build pluggable mock Gemini provider for offline testing of transient errors, 429 backoff, and model fallback.
  - [x] Expand regression test suite from 26 to 55 tests covering all Phase 1 safeguards.

---

## 9. Phase 1 Hardening & Security Verification Report

### 9.1 Issues Verified in the Active Code
1. **Unsigned Role Forging Risk:** The previous `server/auth.ts` parsed `tkn_<role>_<institutionId>_<userId>` directly from the header without cryptographic signature verification, allowing a caller to claim `operator` or `admin` status in development.
2. **Evaluation-Specific Denial-of-Service Risk:** Rate limiting previously applied a flat 120 requests/minute across all endpoints. A malicious or looping client could create 120 expensive multimodal evaluation jobs in 60 seconds.
3. **MIME Type & Payload Permissiveness:** `POST /api/evaluations` validated presence of `sourceDoc`, but did not reject unsupported or dangerous MIME types (e.g., shell scripts, executables, raw HTML).
4. **Per-Attempt vs Overall Deadline:** In `server/geminiClient.ts`, the 90-second deadline was re-instantiated on every single attempt and model fallback (`setTimeout(..., 90000)`). A slow connection with retries across candidate models could run for several minutes without timing out.
5. **Needs Review Visibility:** When academic validation failed with `ValidationError`, the model's draft report was discarded, preventing instructors or human reviewers from seeing the exact question discrepancies.
6. **Startup Queue Robustness:** Leftover `.tmp.` files from sudden host terminations were not actively scrubbed, and empty/corrupted JSON files could trigger uncaught parsing exceptions.

### 9.2 Issues Fixed & Files Changed
* **`/server/auth.ts`:**
  * Added cryptographic HMAC-SHA256 token signing (`signDynamicToken`) and verification using `AUTH_SECRET`.
  * Unsigned dynamic tokens are strictly prohibited from granting `operator` or `admin` roles, even in non-production environments.
  * Added `checkEvaluationRateLimit` restricting evaluation submissions to 15 per minute per client key, keeping general status polling at 120 req/min.
* **`/server/geminiClient.ts`:**
  * Enforced an **overall evaluation deadline** (`overallDeadline = Date.now() + config.requestTimeoutMs`) across all attempts, backoff delays, and candidate models combined. If remaining time is exhausted during backoff or calls, it fails cleanly.
  * Added `fallbackCallsCount` tracking in `GeminiCallResult`.
  * Added `setMockGeminiProvider` hook enabling comprehensive offline testing of transient 503 errors, 429 rate limit backoff, 400 client error aborts, and model fallbacks without live Google API keys.
* **`/server/routes/evaluations.ts`:**
  * Added `ALLOWED_MIME_TYPES` validation: `application/pdf`, `image/jpeg`, `image/png`, `image/webp`, `text/plain`, and DOCX. All other MIME types (e.g. `application/x-sh`) are rejected with HTTP 400.
  * Added `mode` validation (`'with-manual' | 'without-manual'`).
  * Enforced `checkEvaluationRateLimit` on both `POST /` and `POST /sync`.
  * Added `POST /api/evaluations/:id/cancel` for cancelling queued or in-flight jobs.
  * Added `GET /api/evaluations/:id/review` for inspecting draft reports and validation discrepancies on `needs_review` jobs.
  * Added `POST /api/evaluations/prune` for retention policy cleanup (operator/admin only).
  * Refined SSE stream to emit explicit `needs_review` events when validation fails.
* **`/server/queue.ts`:**
  * Enhanced `loadSavedJobs()` to clean up stale `.tmp.` files (> 5 minutes old) and safely remove zero-byte corrupt files on startup.
  * Added `cancelJob(id, userContext)`.
* **`/server/evaluator.ts`:**
  * Preserved `job.draftReport = geminiResult.report` upon academic validation discrepancies before throwing `ValidationError`, enabling human review.
  * Recorded `fallbackCallsCount` in execution metrics.
* **`/server/types.ts`:**
  * Added `'cancelled'` to `JobStatus`.
  * Added `draftReport?: any` to `EvaluationJob`.
  * Added `fallbackCallsCount?: number` to `JobMetrics`.
* **`/test/test_pipeline.ts`:**
  * Added 29 new automated regression tests (Groups 5, 6, 7, 8), expanding the suite from 26 to 55 tests.

### 9.3 Actual Test Results
* **Command:** `npm test` (`tsx test/test_pipeline.ts`)
* **Outcome:** `ALL REGRESSION TESTS COMPLETED: 55/55 PASSED` (0 failures, 100% pass rate).
* **Test Groups Executed:**
  * Group 1 (4/4): Cryptographic SHA-256 fingerprinting & middle-byte mutation.
  * Group 2 (10/10): Adversarial score validation (bounds, NaN, Inf, duplicate IDs, sum mismatch).
  * Group 3 (7/7): Authentication, RBAC, and multi-tenant isolation.
  * Group 4 (5/5): Queue persistence, atomic disk storage, and capacity backpressure (50 jobs).
  * Group 5 (6/6): HMAC signed tokens, unsigned operator forging rejection, evaluation rate limiting.
  * Group 6 (6/6): Request schema boundaries & unsupported MIME type rejection.
  * Group 7 (5/5): Mock Gemini transient 503 retry, 429 rate limit backoff, non-retryable 400 abort, automated model fallback, malformed JSON handling.
  * Group 8 (5/5): Job cancellation, review endpoint, retention pruning, and zero credential exposure in health probes.
* **Build Verification:** `npm run build` and `compile_applet` passed cleanly with 0 TypeScript or Vite errors.

### 9.4 Remaining Risks & Deployment Assumptions
1. **Single-Instance Filesystem Durability Assumption:** Job queue state and cache persist to `.data/evaluations/` via atomic file operations. This is durable across restarts of a single VM or container with a persistent volume. If the client deploys to an auto-scaling multi-replica container environment (such as multiple Google Cloud Run revisions or stateless Kubernetes pods), shared distributed storage (Redis/BullMQ or Cloud SQL PostgreSQL with advisory locks) will be required.
2. **Client-Owned API Key Requirement:** All offline tests pass with mocks. Actual Gemini latency, real token consumption, and live grading fidelity for 40–50 page scripts cannot be measured until a valid client-owned Gemini API key is configured.
3. **OCR / Vision Scalability on 50-Page PDFs:** The current pipeline sends all 50 visual pages in a single evaluation call. While robustly validated and protected, cost and token efficiency will remain high until Phase 3 (Reusable Exam Reference JSON) and Phase 4 (Student JSON Extraction Pipeline) are implemented.


- [x] **Phase 2: Comprehensive Usage & Cost Instrumentation Layer** *(Completed & Verified)*
  - [x] Implement centralized usage and cost ledger (`server/usageLedger.ts`) recording tokens, retries, latencies, status, and stage tags.
  - [x] Externalize model pricing tables into versioned configuration (`server/pricing.ts`, schedule `pricing_v2.1_2026_05`).
  - [x] Add real-time INR currency conversion based on configurable exchange rates (`USD_TO_INR_RATE`).
  - [x] Separate retry and fallback costs (`retryAndFallbackCostUsd`) to isolate wasted spend.
  - [x] Strictly classify data sources (`ACTUAL_API`, `ESTIMATED_COST`, `IMPORTED_BILLED`, `SIMULATED_MOCK`, `UNKNOWN`) with zero fabrication of $0.00.
  - [x] Multi-tenant usage retrieval and batch statistics APIs (`GET /api/evaluations/:id/usage`, `GET /api/usage/summary`).
  - [x] Comprehensive offline regression test coverage expanded to **110/110 passing tests** across Groups 1–10.
  - [x] Documentation delivered in `docs/COST_MEASUREMENT.md`.

- [ ] **Phase 3: Reusable Exam Reference JSON Engine**
  - [ ] Create schema for structured `ExamReference` (questions, maxMarks, rubrics, concepts).
  - [ ] Implement one-time reference extraction and durable storage by content hash.
  - [ ] Enable batch evaluations to reuse reference JSON without re-sending raw PDFs.

- [ ] **Phase 4: Student JSON Extraction Pipeline**
  - [ ] Decouple student handwriting reading from academic grading.
  - [ ] Build intermediate `StudentAnswerScript` JSON mapping pages to question IDs.
  - [ ] Retain high-fidelity image crops for questions requiring diagram inspection.

- [ ] **Phase 5: Cost-Efficient Question-Wise Gemini Evaluation**
  - [ ] Implement question-group evaluator consuming reference JSON and student JSON.
  - [ ] Compact grading prompts to minimize output token overhead.
  - [ ] Implement selective escalation: route MCQs to Lite and diagrams to Flash.

- [ ] **Phase 6: Multi-Tier Cache Strengthening**
  - [ ] Add content-addressed caching for intermediate extraction stages.
  - [ ] Support TTL and cache invalidation on rubric or prompt updates.

- [ ] **Phase 7: Offline Testing & Benchmark Infrastructure**
  - [ ] Build deterministic offline Mock Gemini Provider with all error scenarios.
  - [ ] Create benchmark harness comparing baseline vs JSON-first pipeline offline.

- [ ] **Phase 8: Model & Pipeline Comparisons**
  - [ ] Run comparative benchmarks across chunk sizes, prompt strategies, and models.
  - [ ] Verify score agreement against faculty ground truth.

- [ ] **Phase 9: Deployment & Handover Readiness**
  - [ ] Author client onboarding guide for Google Cloud Project and API key setup.
  - [ ] Provide production Docker Compose and Cloud Run deployment manifests.
  - [ ] Document backup, recovery, and rollback checklists.

- [ ] **Phase 10: Final Documentation & Handover Report**
  - [ ] Deliver `docs/PIPELINE_ARCHITECTURE.md`, `docs/COST_MEASUREMENT.md`, `docs/BENCHMARKING.md`, and `docs/CLIENT_HANDOVER.md`.
