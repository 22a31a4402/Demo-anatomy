import React from 'react';
import { EvaluationReport, QuestionFeedback } from '../types';

interface FeedbackReportProps {
  report: EvaluationReport | null;
  hideAuditTrail?: boolean;
}

const FeedbackReport: React.FC<FeedbackReportProps> = ({ report, hideAuditTrail = false }) => {
  if (!report) {
    return (
      <div className="flex items-center justify-center p-20 text-slate-400 font-bold uppercase tracking-widest text-sm">
        No report data available.
      </div>
    );
  }

  const questions: QuestionFeedback[] = report.questions || [];
  const total = Number(report.totalScore) || 0;
  const max = Number(report.maxScore) || 100;
  const pct = max > 0 ? Math.round((total / max) * 100) : 0;
  const flaggedQuestions = questions.filter(q => q.isFlagged);

  const printStyles = `
    @media print {
      @page {
        margin: 12mm 15mm;
        size: A4 portrait;
      }
      body {
        margin: 0;
        -webkit-print-color-adjust: exact !important;
        print-color-adjust: exact !important;
      }
      .report-container {
        margin: 0 !important;
        padding: 0 !important;
        box-shadow: none !important;
        border: none !important;
        width: 100% !important;
        max-width: none !important;
      }
      .page-break-inside-avoid {
        page-break-inside: avoid !important;
        break-inside: avoid !important;
      }
      .no-print {
        display: none !important;
      }
    }
  `;

  return (
    <div className="max-w-4xl mx-auto my-8 bg-white rounded-2xl shadow-xl shadow-slate-200/50 border border-slate-200 report-container p-6 sm:p-10 text-slate-800 font-sans relative">
      <style>{printStyles}</style>

      {/* ==========================================
          1. BRAND HEADER & SCORE CARD
          ========================================== */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-slate-200 page-break-inside-avoid">
        {/* Aarshiv AI – Anatomy Guru Brand Identity */}
        <div className="flex items-center gap-3.5">
          <div className="w-10 h-10 rounded-xl bg-blue-700 flex items-center justify-center text-white font-black text-xl shadow-md shadow-blue-500/20 shrink-0">
            AG
          </div>
          <div>
            <div className="flex items-baseline">
              <span className="text-2xl font-black tracking-tight text-slate-900">Anatomy</span>
              <span className="text-2xl font-black tracking-tight text-blue-600 ml-1">Guru</span>
            </div>
            <p className="text-[10px] font-bold tracking-widest text-slate-400 uppercase">
              Aarshiv AI — Medical Answer-Sheet Evaluation
            </p>
          </div>
        </div>

        {/* Right-side Total Score Badge */}
        <div className="bg-slate-50 border border-slate-200/80 rounded-xl p-2.5 px-4 flex items-center justify-between sm:justify-start gap-4 shrink-0 shadow-sm">
          <div>
            <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block">
              TOTAL SCORE
            </span>
            <div className="flex items-baseline gap-1 mt-0.5">
              <span className="text-2xl font-black text-[#F93A2C] leading-none">
                {total}
              </span>
              <span className="text-sm font-bold text-slate-500">
                / {max}
              </span>
            </div>
          </div>
          <div className="bg-[#F93A2C] text-white px-2.5 py-1 rounded-md text-xs font-black tracking-wide shadow-sm shadow-red-500/25">
            {pct}%
          </div>
        </div>
      </div>

      {/* ==========================================
          2. ASSESSMENT METADATA CARD
          ========================================== */}
      <div className="mt-5 bg-slate-50/90 border border-slate-200/80 rounded-xl p-4 sm:p-5 page-break-inside-avoid shadow-sm">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {/* Left Column: Student & Subject */}
          <div className="space-y-3">
            <div>
              <span className="text-[10px] font-extrabold uppercase tracking-wider text-[#F93A2C] block">
                STUDENT NAME
              </span>
              <p className="text-base font-black text-slate-900 mt-0.5">
                {report.studentName || 'Unknown Student'}
              </p>
            </div>
            <div>
              <span className="text-[10px] font-extrabold uppercase tracking-wider text-slate-400 block">
                TEST / SUBJECT
              </span>
              <p className="text-sm font-bold text-slate-800 mt-0.5">
                {report.testTitle || 'Academic Assessment'}
              </p>
            </div>
          </div>

          {/* Right Column: Date & Topics */}
          <div className="space-y-3">
            <div>
              <span className="text-[10px] font-extrabold uppercase tracking-wider text-slate-400 block">
                EVALUATION DATE
              </span>
              <p className="text-sm font-semibold text-slate-800 mt-0.5">
                {report.testDate || new Date().toISOString().split('T')[0]}
              </p>
            </div>
            <div>
              <span className="text-[10px] font-extrabold uppercase tracking-wider text-slate-400 block">
                TOPICS COVERED
              </span>
              <p className="text-xs font-medium text-slate-700 mt-0.5 leading-relaxed">
                {report.testTopics || 'Standard Academic Assessment Syllabus'}
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* ==========================================
          3. QUESTION-BY-QUESTION EVALUATION
          ========================================== */}
      {questions.length > 0 && (
        <div className="mt-8">
          {/* Section Header with Right-Aligned Count Badge (Guaranteed No Overlapping) */}
          <div className="flex items-center justify-between pb-2">
            <h3 className="text-base font-extrabold text-slate-900 tracking-tight">
              Question-by-Question Evaluation
            </h3>
            <span className="text-xs font-bold text-slate-400">
              ({questions.length} Questions Evaluated)
            </span>
          </div>

          {/* Section Accent Rule (NextGen Red accent line + subtle divider) */}
          <div className="relative h-1 mb-5">
            <div className="absolute inset-0 bg-slate-200 h-[1px]"></div>
            <div className="absolute left-0 top-0 bg-[#F93A2C] h-[2px] w-14 rounded-full"></div>
          </div>

          {/* Question List */}
          <div className="space-y-4">
            {questions.map((q: QuestionFeedback, idx: number) => {
              const qMarks = Number(q.marks) || 0;
              const qMax = Number(q.maxMarks) || 0;
              const isFull = qMax > 0 && qMarks >= qMax;
              const isZero = qMarks === 0;

              return (
                <div 
                  key={idx} 
                  className="border border-slate-200/90 rounded-xl overflow-hidden page-break-inside-avoid shadow-sm hover:border-slate-300 transition-colors"
                >
                  {/* Question Header Bar */}
                  <div className="bg-slate-50/90 px-4 py-2.5 border-b border-slate-200/80 flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2.5">
                      <span className="text-sm font-extrabold text-slate-900">
                        Question {q.qNo}
                      </span>
                      {isFull ? (
                        <span className="text-[11px] font-bold px-2 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200">
                          FULL MARKS
                        </span>
                      ) : isZero ? (
                        <span className="text-[11px] font-bold px-2 py-0.5 rounded bg-red-50 text-red-700 border border-red-200">
                          ZERO / UNATTEMPTED
                        </span>
                      ) : (
                        <span className="text-[11px] font-bold px-2 py-0.5 rounded bg-amber-50 text-amber-700 border border-amber-200">
                          PARTIAL CREDIT
                        </span>
                      )}

                      {q.isFlagged && (
                        <span className="text-[11px] font-bold text-amber-600 flex items-center gap-1">
                          (! Discrepancy Resolved)
                        </span>
                      )}
                    </div>

                    <span className="text-sm font-extrabold text-slate-900 ml-auto">
                      Marks: {qMarks} / {qMax}
                    </span>
                  </div>

                  {/* Question Feedback Bullets */}
                  <div className="p-4 space-y-2 text-sm bg-white">
                    {q.feedbackPoints && q.feedbackPoints.length > 0 ? (
                      q.feedbackPoints.map((point: string, pIdx: number) => (
                        <div key={pIdx} className="flex items-start gap-2.5">
                          <span className="w-1.5 h-1.5 rounded-full bg-[#F93A2C] mt-2 shrink-0"></span>
                          <p 
                            className={`leading-relaxed text-sm ${isZero ? 'text-red-700' : 'text-slate-700'}`}
                            dangerouslySetInnerHTML={{
                              __html: point.replace(/\*\*(.*?)\*\*/g, '<strong class="font-bold text-slate-900">$1</strong>')
                            }}
                          />
                        </div>
                      ))
                    ) : (
                      <p className="text-xs italic text-slate-400">
                        No detailed observations recorded for this question.
                      </p>
                    )}

                    {/* Evaluator Resolution Callout for Flagged Items */}
                    {q.isFlagged && q.flaggedComment && (
                      <div className="mt-3 p-3 bg-amber-50/90 border border-amber-200 rounded-lg text-xs leading-relaxed text-amber-900">
                        <span className="font-extrabold text-amber-800 uppercase tracking-wide block mb-1">
                          Evaluator Resolution:
                        </span>
                        {q.flaggedComment}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Score Summation Banner */}
          <div className="mt-6 bg-slate-900 text-white rounded-xl p-3.5 px-5 flex items-center justify-between font-bold text-xs sm:text-sm tracking-wide shadow-md shadow-slate-900/10 page-break-inside-avoid">
            <span className="uppercase tracking-wider">
              TOTAL RECALCULATED SCORE SUMMATION
            </span>
            <span className="text-base sm:text-lg font-black text-white">
              {total} / {max} <span className="text-slate-400 text-xs sm:text-sm font-normal">({pct}%)</span>
            </span>
          </div>
        </div>
      )}

      {/* ==========================================
          4. OVERALL FEEDBACK & RECOMMENDATIONS
          ========================================== */}
      {report.generalFeedback && (
        <div className="mt-10 page-break-inside-avoid">
          {/* Section Header */}
          <div className="pb-2">
            <h3 className="text-base font-extrabold text-slate-900 tracking-tight">
              Overall Feedback & Recommendations
            </h3>
          </div>

          {/* Section Accent Rule */}
          <div className="relative h-1 mb-6">
            <div className="absolute inset-0 bg-slate-200 h-[1px]"></div>
            <div className="absolute left-0 top-0 bg-[#F93A2C] h-[2px] w-14 rounded-full"></div>
          </div>

          <div className="space-y-6">
            {[
              { key: 'overallPerformance', title: '1) Overall Performance' },
              { key: 'mcqs', title: '2) Objective & MCQ Analysis' },
              { key: 'contentAccuracy', title: '3) Content Accuracy & Core Concepts' },
              { key: 'completenessOfAnswers', title: '4) Completeness of Answers' },
              { key: 'presentationDiagrams', title: '5) Presentation, Structure & Diagrams' },
              { key: 'investigations', title: '6) Key Methodologies, Workings & Explanations' },
              { key: 'attemptingQuestions', title: '7) Question Attempt Strategy' },
              { key: 'actionPoints', title: '8) Action Points & Recommended Next Steps' },
            ].map((section) => {
              const bullets = (report.generalFeedback as any)?.[section.key] || [];
              if (bullets.length === 0) return null;

              return (
                <div key={section.key} className="space-y-2 page-break-inside-avoid">
                  <h4 className="text-xs font-black uppercase tracking-wider text-slate-900">
                    {section.title}
                  </h4>
                  <div className="space-y-2 pl-1">
                    {bullets.map((b: string, bIdx: number) => (
                      <div key={bIdx} className="flex items-start gap-2.5">
                        <span className="w-1.5 h-1.5 rounded-full bg-[#F93A2C] mt-2 shrink-0"></span>
                        <p 
                          className="text-sm text-slate-700 leading-relaxed"
                          dangerouslySetInnerHTML={{
                            __html: b.replace(/\*\*(.*?)\*\*/g, '<strong class="font-bold text-slate-900">$1</strong>')
                          }}
                        />
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ==========================================
          5. AUDIT TRAIL / CONTRADICTIONS SECTION
          ========================================== */}
      {!hideAuditTrail && flaggedQuestions.length > 0 && (
        <div className="mt-10 page-break-inside-avoid">
          {/* Section Header */}
          <div className="pb-2">
            <h3 className="text-base font-extrabold text-amber-700 tracking-tight">
              Audit Trail: Resolution of Contradictions
            </h3>
          </div>

          {/* Section Accent Rule (Amber) */}
          <div className="relative h-1 mb-4">
            <div className="absolute inset-0 bg-slate-200 h-[1px]"></div>
            <div className="absolute left-0 top-0 bg-amber-500 h-[2px] w-14 rounded-full"></div>
          </div>

          <p className="text-xs text-slate-500 italic mb-4 leading-relaxed">
            The following questions exhibited a contradiction between provided human evaluation feedback and the official Answer Key. The system prioritized the Answer Key for the primary score, with the discrepancy resolution recorded below:
          </p>

          <div className="space-y-3">
            {flaggedQuestions.map((fq: QuestionFeedback, idx: number) => (
              <div 
                key={idx} 
                className="bg-amber-50/80 border border-amber-200/90 rounded-xl p-3.5 space-y-1.5"
              >
                <div className="flex items-center justify-between">
                  <span className="text-xs font-black uppercase tracking-wider text-amber-900">
                    Question {fq.qNo} Discrepancy Note:
                  </span>
                  <span className="text-xs font-bold text-amber-700">
                    Marks: {fq.marks} / {fq.maxMarks}
                  </span>
                </div>
                <p className="text-xs text-amber-950 leading-relaxed">
                  {fq.flaggedComment || 'Evaluator resolved discrepancy according to the marking scheme.'}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ==========================================
          6. RUNNING BRAND FOOTER
          ========================================== */}
      <div className="mt-12 pt-4 border-t border-slate-200 flex flex-col sm:flex-row items-center justify-between text-[11px] text-slate-400 page-break-inside-avoid gap-2">
        <span className="font-semibold">
          Aarshiv AI – Anatomy Guru | AI-Powered Medical Answer-Sheet Evaluation
        </span>
        <span className="font-medium text-slate-400">
          Official Medical Assessment Report
        </span>
      </div>
    </div>
  );
};

export default FeedbackReport;
