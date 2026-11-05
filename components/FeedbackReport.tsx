import React from 'react';
import { EvaluationReport } from '../types';
import { logoBase64 } from '../services/logoBase64';

// Use the local Base64-encoded logo to ensure zero CORS and perfect offline rendering in pdf exports
const logo = logoBase64;

interface FeedbackReportProps {
  report: EvaluationReport | null;
  hideAuditTrail?: boolean;
}

const FeedbackReport: React.FC<FeedbackReportProps> = ({ report, hideAuditTrail = false }) => {
  if (!report) {
    return (
      <div className="flex items-center justify-center p-20 text-slate-400 font-bold uppercase tracking-widest">
        No report data available.
      </div>
    );
  }

  const calculatedSum = report.questions?.reduce((acc: number, q: any) => acc + (Number(q.marks) || 0), 0) || 0;
  const displayScore = typeof report.totalScore === 'number' && !isNaN(report.totalScore)
    ? report.totalScore
    : calculatedSum;

  const allQuestions = report.questions || [];
  const flaggedQuestions = allQuestions.filter(q => q.isFlagged) || [];

  const getQuestionStatus = (q: any) => {
    const marks = Number(q.marks) || 0;
    const feedbackText = q.feedbackPoints?.join(' ').toLowerCase() || '';

    if (marks === 0 || feedbackText.includes('not attempted') || feedbackText.includes('skipped')) {
      return 'unattempted';
    }

    if (feedbackText.includes('excellent') || feedbackText.includes('perfect') || feedbackText.includes('precise') || feedbackText.includes('correct')) {
      return 'correct';
    }

    return 'partial';
  };

  const reportStyle: React.CSSProperties = {
    fontFamily: '"Times New Roman", Times, serif',
  };

  const printStyles = `
    @media print {
      @page {
        margin: 0;
      }
      body {
        margin: 0;
        -webkit-print-color-adjust: exact;
      }
      .report-container {
        margin: 0 !important;
        padding: 20mm !important;
        box-shadow: none !important;
        border: none !important;
        width: 100% !important;
        max-width: none !important;
      }
      tr, h2, h3, h4, li, p, .general-feedback-section {
        page-break-inside: avoid !important;
        break-inside: avoid-page !important;
        break-inside: avoid !important;
      }
      .page-number::after {
        content: counter(page);
      }
      .report-footer {
        position: fixed;
        bottom: 10mm;
        right: 10mm;
        font-size: 10px;
        color: #666;
      }
    }
  `;

  const headingStyle: React.CSSProperties = {
    fontSize: '16px',
    fontWeight: '900',
  };

  const contentStyle: React.CSSProperties = {
    fontSize: '14px',
  };

  const sectionLabelStyle: React.CSSProperties = {
    fontSize: '14px',
    fontWeight: 'bold',
  };

  const renderBulletList = (items?: string[]) => {
    if (!items || items.length === 0) return <p className="ml-10 text-slate-400 italic" style={contentStyle}>No specific feedback provided.</p>;

    return (
      <div className="ml-10 space-y-1.5 mb-2">
        {items.map((item, i) => {
          return (
            <div key={i} className="relative pl-4 text-left feedback-bullet-point" style={contentStyle}>
              <span className="absolute left-0 top-[2px] select-none font-bold text-slate-800">•</span>
              <div className="text-slate-800 leading-normal font-normal">
                <span dangerouslySetInnerHTML={{ __html: item.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>') }} />
              </div>
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <div className="max-w-[850px] mx-auto my-10 bg-white shadow-none rounded-none border border-slate-300 report-container p-6 pb-40 sm:p-12 sm:pb-48 text-[#1e1e1e] animate-fade-in relative" style={reportStyle}>
      <style>{printStyles}</style>

      {/* Brand Header */}
      <div className="flex flex-col items-center mb-2">
        <div className="flex items-center justify-center leading-none">
          <img
            src={logo}
            alt="Anatomy Guru Logo"
            className="w-64 object-contain block m-0 p-0 rounded"
          />
        </div>
      </div>

      {/* Metadata Section */}
      <div className="text-center mb-6">
        <h2 className="text-red-600 uppercase tracking-widest border-b border-slate-200 pb-1 inline-block mb-3" style={headingStyle}>
          {report.testTitle || 'General Medicine Test'}
        </h2>
        <div className="space-y-1" style={contentStyle}>
          <p className="font-bold text-slate-800">Topics: {report.testTopics || 'N/A'}</p>
          <p className="font-black text-blue-800 uppercase tracking-widest">Date: {report.testDate || 'N/A'}</p>
        </div>
      </div>

      {/* Student Identification Row */}
      <div className="mb-4 flex items-center gap-2 border-t pt-4 border-slate-100" style={contentStyle}>
        <span className="text-red-600 font-black uppercase tracking-wide">Student Name:</span>
        <span className="font-black text-slate-900 underline underline-offset-4 decoration-2 decoration-slate-300">{report.studentName || 'Unknown Student'}</span>
      </div>

      {/* Assessment Table */}
      <div className="border border-slate-400 overflow-hidden mb-8">
        <table className="w-full border-collapse">
          <thead>
            <tr className="border-b border-slate-400 bg-white">
              <th className="w-[10%] p-2 border-r border-slate-400 text-slate-900 uppercase tracking-wide text-center" style={headingStyle}>Q No</th>
              <th className="w-[75%] p-2 border-r border-slate-400 text-slate-900 uppercase tracking-wide text-center" style={headingStyle}>Feedback</th>
              <th className="w-[15%] p-2 text-slate-900 uppercase tracking-wide text-center" style={headingStyle}>Marks</th>
            </tr>
          </thead>
          <tbody>
            {allQuestions.map((q, idx) => {
              const status = getQuestionStatus(q);
              const isZeroOrUnattempted = Number(q.marks) === 0 || status === 'unattempted';

              return (
                <tr key={idx} className={`border-b border-slate-300 ${isZeroOrUnattempted ? 'text-red-600' : ''}`}>
                  <td className="p-2 border-r border-slate-400 text-center font-bold align-top relative" style={contentStyle}>
                    {q.qNo}
                    {q.isFlagged && (
                      <span className="block text-[10px] text-amber-600 font-bold" title={q.flaggedComment || 'Contradiction Resolved'}>
                        *
                      </span>
                    )}
                  </td>
                  <td className="p-3 border-r border-slate-400 align-top">
                    {q.feedbackPoints && q.feedbackPoints.length > 0 ? (
                      <div className="space-y-1.5 text-left" style={contentStyle}>
                        {q.feedbackPoints.map((point: string, pIdx: number) => (
                          <div key={pIdx} className="relative pl-4 text-left feedback-bullet-point">
                            <span className="absolute left-0 top-[2px] select-none text-slate-800 font-bold">•</span>
                            <div className={`leading-relaxed font-normal ${isZeroOrUnattempted ? 'italic text-red-600' : 'text-slate-800'}`}>
                              <span dangerouslySetInnerHTML={{ __html: point.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>') }} />
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="text-slate-400 italic text-xs" style={contentStyle}>No specific feedback provided.</p>
                    )}
                  </td>
                  <td className="p-2 text-center font-bold align-top" style={contentStyle}>
                    {q.marks}
                  </td>
                </tr>
              );
            })}
            <tr className="bg-slate-50 border-t border-slate-400">
              <td colSpan={2} className="p-3 border-r border-slate-400 text-center font-black uppercase tracking-widest text-slate-500" style={contentStyle}>
                Total Score Summation
              </td>
              <td className="p-3 text-center font-black text-slate-900 bg-white" style={headingStyle}>
                {displayScore} / {report.maxScore || 100}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* General Feedback Section */}
      {report.generalFeedback && (
        <div className="mt-6 border border-slate-900 p-6">
          <h3 className="text-slate-900 font-bold mb-2 underline" style={headingStyle}>General Feedback:</h3>

          <div className="space-y-4">
            <div className="feedback-section-block">
              <h4 style={sectionLabelStyle}>1) Overall Performance</h4>
              {renderBulletList(report.generalFeedback.overallPerformance)}
            </div>

            <div className="feedback-section-block">
              <h4 style={sectionLabelStyle}>2) MCQs</h4>
              {renderBulletList(report.generalFeedback.mcqs)}
            </div>

            <div className="feedback-section-block">
              <h4 style={sectionLabelStyle}>3) Content Accuracy</h4>
              {renderBulletList(report.generalFeedback.contentAccuracy)}
            </div>

            <div className="feedback-section-block">
              <h4 style={sectionLabelStyle}>4) Completeness of Answers</h4>
              {renderBulletList(report.generalFeedback.completenessOfAnswers)}
            </div>

            <div className="feedback-section-block">
              <h4 style={sectionLabelStyle}>5) Presentation & Diagrams (Major drawback)</h4>
              {renderBulletList(report.generalFeedback.presentationDiagrams)}
            </div>

            <div className="feedback-section-block">
              <h4 style={sectionLabelStyle}>6) Investigations (Must improve)</h4>
              {renderBulletList(report.generalFeedback.investigations)}
            </div>

            <div className="feedback-section-block">
              <h4 style={sectionLabelStyle}>7) Attempting All Questions</h4>
              {renderBulletList(report.generalFeedback.attemptingQuestions)}
            </div>

            <div className="feedback-section-block">
              <h4 style={sectionLabelStyle}>8) What to do next (Action points)</h4>
              {renderBulletList(report.generalFeedback.actionPoints)}
            </div>
          </div>
        </div>
      )}

      {/* Flagged Questions Section (Audit Trail) */}
      {!hideAuditTrail && flaggedQuestions.length > 0 && (
        <div className="mt-12 p-6 bg-slate-50 border-2 border-slate-200 rounded-none animate-fade-in no-print">
          <div className="flex items-center gap-3 mb-4 border-b border-slate-300 pb-2">
            <h3 className="text-lg font-black text-slate-900 uppercase tracking-tight">Audit Trail: Resolution of Contradictions</h3>
          </div>
          <p className="text-xs text-slate-600 mb-6 font-medium italic">
            The following questions showed a significant contradiction between the Faculty Notes and the official Answer Key. 
            The system has prioritized the Answer Key for the final report, but the original notes and auditor's resolution are preserved below.
          </p>

          <div className="space-y-6">
            {flaggedQuestions.map((q, idx) => (
              <div key={idx} className="border-l-4 border-amber-500 pl-4 py-1 feedback-section-block">
                <div className="flex items-center justify-between mb-2">
                  <span className="font-black text-slate-900 uppercase text-sm">Question {q.qNo}</span>
                </div>

                <div className="grid grid-cols-1 gap-3">
                  <div className="bg-white p-3 border border-slate-200">
                    <span className="text-[10px] font-black text-slate-400 uppercase block mb-1">Original Faculty Observation:</span>
                    <div className="space-y-1.5">
                      {q.feedbackPoints.map((point: string, pIdx: number) => (
                        <div key={pIdx} className="relative pl-4 text-left feedback-bullet-point">
                          <span className="absolute left-0 top-[2px] select-none text-slate-700 text-xs">•</span>
                          <div className="text-xs text-slate-700 leading-relaxed font-normal">
                            <span dangerouslySetInnerHTML={{ __html: point.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>') }} />
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  {q.flaggedComment && (
                    <div className="bg-amber-50 p-3 border border-amber-100 text-xs text-amber-900 font-semibold">
                      <span className="uppercase tracking-wider text-[10px] opacity-60 block mb-1">Auditor's Resolution:</span>
                      {q.flaggedComment}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Official Footer */}
      <div className="mt-24 mb-12 flex justify-between items-center text-[9px] font-black text-slate-400 uppercase tracking-[0.3em] border-t-2 border-slate-900 pt-8 pb-16">
        <div className="flex items-center gap-6">
          <span></span>
          <span></span>
        </div>
      </div>

      {/* Print-only page number footer */}
      <div className="hidden print:block fixed bottom-8 right-8 text-[10px] text-slate-400 font-mono no-print">
        <span className="page-number"></span>
      </div>
    </div>
  );
};

export default FeedbackReport;
