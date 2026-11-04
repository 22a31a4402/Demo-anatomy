import { jsPDF } from 'jspdf';
import { EvaluationReport, QuestionFeedback } from '../types';
import { downloadBytes } from './pdfMerger';

type ColorTuple = readonly [number, number, number];

// NextGen Eval Brand Color Palette
const COLOR_PRIMARY: ColorTuple = [249, 58, 44];    // #F93A2C NextGen Red
const COLOR_DARK: ColorTuple = [15, 23, 42];        // #0F172A Dark Slate
const COLOR_TEXT: ColorTuple = [30, 41, 59];        // #1E293B Body Text
const COLOR_MUTED: ColorTuple = [100, 116, 139];    // #64748B Secondary Text
const COLOR_BORDER: ColorTuple = [226, 232, 240];   // #E2E8F0 Subtle Border
const COLOR_BG_LIGHT: ColorTuple = [248, 250, 252]; // #F8FAFC Card Background
const COLOR_SUCCESS: ColorTuple = [22, 163, 74];    // #16A34A Green
const COLOR_WARNING: ColorTuple = [217, 119, 6];    // #D97706 Amber
const COLOR_DANGER: ColorTuple = [220, 38, 38];     // #DC2626 Red

// Sanitize string for clean rendering in Standard Type 1 PDF fonts
const sanitizeText = (input: string | undefined | null): string => {
  if (!input) return '';
  return String(input)
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .replace(/[\t\r]/g, ' ')
    .trim();
};

/**
 * Native PDF Generator for NextGen Eval Academic Reports.
 * Produces crisp, 100% vector, selectable, and searchable text PDFs
 * with robust auto-pagination and academic formatting.
 */
export const generateEvaluationPdf = async (report: EvaluationReport): Promise<Uint8Array> => {
  const doc = new jsPDF({
    orientation: 'portrait',
    unit: 'pt',
    format: 'a4',
  });

  const pageWidth = doc.internal.pageSize.getWidth();   // 595.28 pt
  const pageHeight = doc.internal.pageSize.getHeight(); // 841.89 pt

  const marginX = 42;
  const marginTop = 48;
  const marginBottom = 48;
  const contentWidth = pageWidth - marginX * 2; // 511.28 pt
  const maxY = pageHeight - marginBottom;

  const total = Number(report.totalScore) || 0;
  const max = Number(report.maxScore) || 100;
  const pct = max > 0 ? Math.round((total / max) * 100) : 0;

  let y = marginTop;

  // Helper: check space and break page seamlessly
  const ensureSpace = (requiredPt: number) => {
    if (y + requiredPt > maxY) {
      doc.addPage();
      y = marginTop;
    }
  };

  // Helper: render wrapped lines of text
  const renderWrappedText = (
    text: string,
    x: number,
    maxWidth: number,
    lineHeight: number,
    fontSize: number,
    fontStyle: 'normal' | 'bold' | 'italic' = 'normal',
    color: ColorTuple = COLOR_TEXT
  ) => {
    doc.setFont('helvetica', fontStyle);
    doc.setFontSize(fontSize);
    doc.setTextColor(color[0], color[1], color[2]);

    const sanitized = sanitizeText(text);
    const lines = doc.splitTextToSize(sanitized, maxWidth);

    for (const line of lines) {
      ensureSpace(lineHeight);
      doc.text(line, x, y + fontSize * 0.85);
      y += lineHeight;
    }
  };

  // ==========================================
  // 1. PAGE 1 BRAND HEADER
  // ==========================================
  const renderHeader = () => {
    // Brand Icon Badge (Red rounded square with white 'N')
    doc.setFillColor(COLOR_PRIMARY[0], COLOR_PRIMARY[1], COLOR_PRIMARY[2]);
    doc.roundedRect(marginX, y, 32, 32, 7, 7, 'F');
    doc.setTextColor(255, 255, 255);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(14);
    doc.text('AG', marginX + 6.5, y + 22.5);

    // Aarshiv AI – Anatomy Guru Brand Text
    doc.setFontSize(20);
    doc.setTextColor(COLOR_DARK[0], COLOR_DARK[1], COLOR_DARK[2]);
    doc.text('Anatomy ', marginX + 42, y + 18);
    const evalWidth = doc.getTextWidth('Anatomy ');
    doc.setTextColor(COLOR_PRIMARY[0], COLOR_PRIMARY[1], COLOR_PRIMARY[2]);
    doc.text('Guru', marginX + 42 + evalWidth, y + 18);

    doc.setFontSize(8);
    doc.setTextColor(COLOR_MUTED[0], COLOR_MUTED[1], COLOR_MUTED[2]);
    doc.setFont('helvetica', 'bold');
    doc.text('AARSHIV AI — MEDICAL ANSWER-SHEET EVALUATION', marginX + 42, y + 29);

    // Right-side Score Badge
    const scoreBoxWidth = 145;
    const scoreBoxHeight = 44;
    const scoreBoxX = pageWidth - marginX - scoreBoxWidth;

    doc.setFillColor(COLOR_BG_LIGHT[0], COLOR_BG_LIGHT[1], COLOR_BG_LIGHT[2]);
    doc.setDrawColor(COLOR_BORDER[0], COLOR_BORDER[1], COLOR_BORDER[2]);
    doc.setLineWidth(1);
    doc.roundedRect(scoreBoxX, y - 4, scoreBoxWidth, scoreBoxHeight, 8, 8, 'FD');

    doc.setFontSize(7.5);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(COLOR_MUTED[0], COLOR_MUTED[1], COLOR_MUTED[2]);
    doc.text('TOTAL SCORE', scoreBoxX + 12, y + 10);

    doc.setFontSize(16);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(COLOR_PRIMARY[0], COLOR_PRIMARY[1], COLOR_PRIMARY[2]);
    doc.text(`${total} `, scoreBoxX + 12, y + 28);
    const scoreWidth = doc.getTextWidth(`${total} `);

    doc.setFontSize(11);
    doc.setTextColor(COLOR_DARK[0], COLOR_DARK[1], COLOR_DARK[2]);
    doc.text(`/ ${max}`, scoreBoxX + 12 + scoreWidth, y + 28);

    // Score percentage pill
    doc.setFillColor(COLOR_PRIMARY[0], COLOR_PRIMARY[1], COLOR_PRIMARY[2]);
    doc.roundedRect(scoreBoxX + scoreBoxWidth - 42, y + 14, 32, 16, 4, 4, 'F');
    doc.setTextColor(255, 255, 255);
    doc.setFontSize(8);
    doc.setFont('helvetica', 'bold');
    doc.text(`${pct}%`, scoreBoxX + scoreBoxWidth - 36, y + 25);

    y += 50;

    // Header divider rule
    doc.setDrawColor(COLOR_BORDER[0], COLOR_BORDER[1], COLOR_BORDER[2]);
    doc.setLineWidth(1);
    doc.line(marginX, y, pageWidth - marginX, y);
    y += 14;

    // Assessment Metadata Card
    const metaCardHeight = 58;
    doc.setFillColor(COLOR_BG_LIGHT[0], COLOR_BG_LIGHT[1], COLOR_BG_LIGHT[2]);
    doc.setDrawColor(COLOR_BORDER[0], COLOR_BORDER[1], COLOR_BORDER[2]);
    doc.roundedRect(marginX, y, contentWidth, metaCardHeight, 8, 8, 'FD');

    const col1X = marginX + 14;
    const col2X = marginX + contentWidth / 2 + 10;

    // Student Name
    doc.setFontSize(7.5);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(COLOR_PRIMARY[0], COLOR_PRIMARY[1], COLOR_PRIMARY[2]);
    doc.text('STUDENT NAME', col1X, y + 16);

    doc.setFontSize(11);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(COLOR_DARK[0], COLOR_DARK[1], COLOR_DARK[2]);
    const cleanStudentName = sanitizeText(report.studentName) || 'Unknown Student';
    doc.text(cleanStudentName, col1X, y + 30);

    // Test Title
    doc.setFontSize(7.5);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(COLOR_MUTED[0], COLOR_MUTED[1], COLOR_MUTED[2]);
    doc.text('TEST / SUBJECT', col1X, y + 42);

    doc.setFontSize(9);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(COLOR_TEXT[0], COLOR_TEXT[1], COLOR_TEXT[2]);
    const cleanTitle = sanitizeText(report.testTitle) || 'Academic Assessment';
    doc.text(doc.splitTextToSize(cleanTitle, contentWidth / 2 - 20)[0] || cleanTitle, col1X, y + 52);

    // Date
    doc.setFontSize(7.5);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(COLOR_MUTED[0], COLOR_MUTED[1], COLOR_MUTED[2]);
    doc.text('EVALUATION DATE', col2X, y + 16);

    doc.setFontSize(9.5);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(COLOR_DARK[0], COLOR_DARK[1], COLOR_DARK[2]);
    doc.text(sanitizeText(report.testDate) || new Date().toISOString().split('T')[0], col2X, y + 28);

    // Topics
    doc.setFontSize(7.5);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(COLOR_MUTED[0], COLOR_MUTED[1], COLOR_MUTED[2]);
    doc.text('TOPICS COVERED', col2X, y + 42);

    doc.setFontSize(8.5);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(COLOR_TEXT[0], COLOR_TEXT[1], COLOR_TEXT[2]);
    const cleanTopics = sanitizeText(report.testTopics) || 'Standard Academic Assessment Syllabus';
    doc.text(doc.splitTextToSize(cleanTopics, contentWidth / 2 - 20)[0] || cleanTopics, col2X, y + 52);

    y += metaCardHeight + 20;
  };

  renderHeader();

  // ==========================================
  // 2. QUESTION-BY-QUESTION EVALUATION
  // ==========================================
  const questions = report.questions || [];

  if (questions.length > 0) {
    ensureSpace(32);
    // Section Header
    doc.setFontSize(12);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(COLOR_DARK[0], COLOR_DARK[1], COLOR_DARK[2]);
    const sectionTitle = 'Question-by-Question Evaluation';
    doc.text(sectionTitle, marginX, y + 10);

    // Right-aligned question count badge - completely eliminates any overlapping
    doc.setFontSize(8.5);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(COLOR_MUTED[0], COLOR_MUTED[1], COLOR_MUTED[2]);
    const questionsCountText = `(${questions.length} Questions Evaluated)`;
    const countWidth = doc.getTextWidth(questionsCountText);
    doc.text(questionsCountText, pageWidth - marginX - countWidth, y + 10);

    y += 18;
    doc.setDrawColor(COLOR_PRIMARY[0], COLOR_PRIMARY[1], COLOR_PRIMARY[2]);
    doc.setLineWidth(1.5);
    doc.line(marginX, y, marginX + 48, y);
    doc.setDrawColor(COLOR_BORDER[0], COLOR_BORDER[1], COLOR_BORDER[2]);
    doc.setLineWidth(0.75);
    doc.line(marginX + 48, y, pageWidth - marginX, y);
    y += 14;

    questions.forEach((q: QuestionFeedback) => {
      const qMarks = Number(q.marks) || 0;
      const qMax = Number(q.maxMarks) || 0;
      const isFull = qMax > 0 && qMarks >= qMax;
      const isZero = qMarks === 0;

      // Ensure room for question header block + first bullet
      ensureSpace(55);

      // Question Header Bar
      const barHeight = 22;
      doc.setFillColor(COLOR_BG_LIGHT[0], COLOR_BG_LIGHT[1], COLOR_BG_LIGHT[2]);
      doc.setDrawColor(COLOR_BORDER[0], COLOR_BORDER[1], COLOR_BORDER[2]);
      doc.setLineWidth(0.75);
      doc.roundedRect(marginX, y, contentWidth, barHeight, 4, 4, 'FD');

      // Question Number
      doc.setFontSize(9.5);
      doc.setFont('helvetica', 'bold');
      doc.setTextColor(COLOR_DARK[0], COLOR_DARK[1], COLOR_DARK[2]);
      const cleanQNo = sanitizeText(q.qNo);
      doc.text(`Question ${cleanQNo}`, marginX + 10, y + 14.5);

      // Correctness / Status Badge
      let statusText = 'PARTIAL CREDIT';
      let statusColor: ColorTuple = COLOR_WARNING;
      if (isFull) {
        statusText = 'FULL MARKS';
        statusColor = COLOR_SUCCESS;
      } else if (isZero) {
        statusText = 'ZERO / UNATTEMPTED';
        statusColor = COLOR_DANGER;
      }

      const qNoWidth = doc.getTextWidth(`Question ${cleanQNo}`);
      const badgeX = marginX + 10 + qNoWidth + 12;
      doc.setFontSize(7.5);
      doc.setFont('helvetica', 'bold');
      doc.setTextColor(statusColor[0], statusColor[1], statusColor[2]);
      doc.text(`[ ${statusText} ]`, badgeX, y + 14.5);

      // Flagged Indicator
      if (q.isFlagged) {
        const flagX = badgeX + doc.getTextWidth(`[ ${statusText} ]`) + 8;
        doc.setTextColor(COLOR_WARNING[0], COLOR_WARNING[1], COLOR_WARNING[2]);
        doc.text('(! Discrepancy Resolved)', flagX, y + 14.5);
      }

      // Marks Scored / Max
      const marksString = `Marks: ${qMarks} / ${qMax}`;
      doc.setFontSize(9.5);
      doc.setFont('helvetica', 'bold');
      doc.setTextColor(COLOR_DARK[0], COLOR_DARK[1], COLOR_DARK[2]);
      const marksWidth = doc.getTextWidth(marksString);
      doc.text(marksString, pageWidth - marginX - marksWidth - 10, y + 14.5);

      y += barHeight + 8;

      // Feedback Bullet Points
      const points = q.feedbackPoints || [];
      if (points.length === 0) {
        renderWrappedText(
          'No detailed observations recorded for this question.',
          marginX + 16,
          contentWidth - 24,
          13,
          8.5,
          'italic',
          COLOR_MUTED
        );
      } else {
        points.forEach((point: string) => {
          const sanitizedPoint = sanitizeText(point);
          if (!sanitizedPoint) return;

          const bulletIndent = 12;
          const textMaxWidth = contentWidth - 28;
          doc.setFont('helvetica', 'normal');
          doc.setFontSize(8.5);
          const lines = doc.splitTextToSize(sanitizedPoint, textMaxWidth);

          // Render bullet symbol on first line
          ensureSpace(14);
          doc.setFillColor(COLOR_PRIMARY[0], COLOR_PRIMARY[1], COLOR_PRIMARY[2]);
          doc.circle(marginX + 12, y + 5.5, 1.8, 'F');

          lines.forEach((line: string) => {
            ensureSpace(13);
            doc.setFont('helvetica', 'normal');
            doc.setFontSize(8.5);
            doc.setTextColor(isZero ? COLOR_DANGER[0] : COLOR_TEXT[0], isZero ? COLOR_DANGER[1] : COLOR_TEXT[1], isZero ? COLOR_DANGER[2] : COLOR_TEXT[2]);
            doc.text(line, marginX + 12 + bulletIndent, y + 7.5);
            y += 13;
          });
          y += 2; // Small gap between bullets
        });
      }

      // If Flagged: render discrepancy explanation note
      if (q.isFlagged && q.flaggedComment) {
        const cleanComment = sanitizeText(q.flaggedComment);
        ensureSpace(34);
        y += 4;
        const noteBoxX = marginX + 16;
        const noteBoxWidth = contentWidth - 32;

        doc.setFont('helvetica', 'normal');
        doc.setFontSize(8);
        const commentLines = doc.splitTextToSize(`Evaluator Resolution: ${cleanComment}`, noteBoxWidth - 16);
        const noteBoxHeight = commentLines.length * 12 + 12;

        ensureSpace(noteBoxHeight + 6);
        doc.setFillColor(254, 243, 199); // Light amber
        doc.setDrawColor(245, 158, 11);  // Amber border
        doc.setLineWidth(0.75);
        doc.roundedRect(noteBoxX, y, noteBoxWidth, noteBoxHeight, 4, 4, 'FD');

        doc.setFont('helvetica', 'bold');
        doc.setFontSize(8);
        doc.setTextColor(180, 83, 9); // Dark amber
        doc.text('Evaluator Resolution:', noteBoxX + 8, y + 11);

        const labelWidth = doc.getTextWidth('Evaluator Resolution: ');
        doc.setFont('helvetica', 'normal');
        doc.setTextColor(146, 64, 14);

        let curY = y + 11;
        commentLines.forEach((line: string, lineIdx: number) => {
          if (lineIdx === 0) {
            // First line after header
            const restOfFirstLine = line.replace('Evaluator Resolution: ', '');
            doc.text(restOfFirstLine, noteBoxX + 8 + labelWidth, curY);
          } else {
            curY += 12;
            doc.text(line, noteBoxX + 8, curY);
          }
        });

        y += noteBoxHeight + 6;
      }

      y += 8; // Spacing between questions
    });

    // Score Summation Banner
    ensureSpace(36);
    y += 6;
    doc.setFillColor(COLOR_DARK[0], COLOR_DARK[1], COLOR_DARK[2]);
    doc.roundedRect(marginX, y, contentWidth, 30, 6, 6, 'F');

    doc.setFontSize(9);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(255, 255, 255);
    doc.text('TOTAL RECALCULATED SCORE SUMMATION', marginX + 16, y + 19);

    const scoreSummaryText = `${total} / ${max}  (${pct}%)`;
    const scoreSumWidth = doc.getTextWidth(scoreSummaryText);
    doc.text(scoreSummaryText, pageWidth - marginX - scoreSumWidth - 16, y + 19);

    y += 42;
  }

  // ==========================================
  // 3. OVERALL GENERAL FEEDBACK
  // ==========================================
  if (report.generalFeedback) {
    ensureSpace(45);
    doc.setFontSize(12);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(COLOR_DARK[0], COLOR_DARK[1], COLOR_DARK[2]);
    doc.text('Overall Feedback & Recommendations', marginX, y + 10);

    y += 18;
    doc.setDrawColor(COLOR_PRIMARY[0], COLOR_PRIMARY[1], COLOR_PRIMARY[2]);
    doc.setLineWidth(1.5);
    doc.line(marginX, y, marginX + 48, y);
    doc.setDrawColor(COLOR_BORDER[0], COLOR_BORDER[1], COLOR_BORDER[2]);
    doc.setLineWidth(0.75);
    doc.line(marginX + 48, y, pageWidth - marginX, y);
    y += 16;

    const sections: Array<{ key: keyof typeof report.generalFeedback; title: string }> = [
      { key: 'overallPerformance', title: '1) Overall Performance' },
      { key: 'mcqs', title: '2) Objective & MCQ Analysis' },
      { key: 'contentAccuracy', title: '3) Content Accuracy & Core Concepts' },
      { key: 'completenessOfAnswers', title: '4) Completeness of Answers' },
      { key: 'presentationDiagrams', title: '5) Presentation, Structure & Diagrams' },
      { key: 'investigations', title: '6) Key Methodologies, Workings & Explanations' },
      { key: 'attemptingQuestions', title: '7) Question Attempt Strategy' },
      { key: 'actionPoints', title: '8) Action Points & Recommended Next Steps' },
    ];

    sections.forEach((sec) => {
      const bulletPoints = report.generalFeedback[sec.key] || [];
      if (bulletPoints.length === 0) return;

      ensureSpace(34);
      // Section Heading
      doc.setFontSize(9.5);
      doc.setFont('helvetica', 'bold');
      doc.setTextColor(COLOR_DARK[0], COLOR_DARK[1], COLOR_DARK[2]);
      doc.text(sec.title, marginX, y + 10);
      y += 16;

      bulletPoints.forEach((bullet: string) => {
        const cleanBullet = sanitizeText(bullet);
        if (!cleanBullet) return;

        const bulletIndent = 12;
        const textMaxWidth = contentWidth - 28;
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(8.5);
        const lines = doc.splitTextToSize(cleanBullet, textMaxWidth);

        ensureSpace(14);
        doc.setFillColor(COLOR_PRIMARY[0], COLOR_PRIMARY[1], COLOR_PRIMARY[2]);
        doc.circle(marginX + 6, y + 5.5, 1.8, 'F');

        lines.forEach((line: string) => {
          ensureSpace(13);
          doc.setFont('helvetica', 'normal');
          doc.setFontSize(8.5);
          doc.setTextColor(COLOR_TEXT[0], COLOR_TEXT[1], COLOR_TEXT[2]);
          doc.text(line, marginX + 6 + bulletIndent, y + 7.5);
          y += 13;
        });
        y += 2;
      });

      y += 8; // Gap between sections
    });
  }

  // ==========================================
  // 4. AUDIT TRAIL / CONTRADICTIONS SECTION
  // ==========================================
  const flaggedQuestions = questions.filter(q => q.isFlagged);
  if (flaggedQuestions.length > 0) {
    ensureSpace(50);
    y += 10;
    doc.setFontSize(12);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(COLOR_DARK[0], COLOR_DARK[1], COLOR_DARK[2]);
    doc.text('Audit Trail: Resolution of Contradictions', marginX, y + 10);

    y += 18;
    doc.setDrawColor(COLOR_WARNING[0], COLOR_WARNING[1], COLOR_WARNING[2]);
    doc.setLineWidth(1.5);
    doc.line(marginX, y, marginX + 48, y);
    doc.setDrawColor(COLOR_BORDER[0], COLOR_BORDER[1], COLOR_BORDER[2]);
    doc.setLineWidth(0.75);
    doc.line(marginX + 48, y, pageWidth - marginX, y);
    y += 14;

    renderWrappedText(
      'The following questions exhibited a contradiction between provided human evaluation feedback and the official Answer Key. The system prioritized the Answer Key for the primary score, with the discrepancy resolution recorded below:',
      marginX,
      contentWidth,
      12,
      8,
      'italic',
      COLOR_MUTED
    );
    y += 8;

    flaggedQuestions.forEach((fq: QuestionFeedback) => {
      ensureSpace(40);
      doc.setFontSize(9);
      doc.setFont('helvetica', 'bold');
      doc.setTextColor(COLOR_DARK[0], COLOR_DARK[1], COLOR_DARK[2]);
      doc.text(`Question ${sanitizeText(fq.qNo)} Discrepancy Note:`, marginX + 4, y + 8);
      y += 14;

      if (fq.flaggedComment) {
        renderWrappedText(
          fq.flaggedComment,
          marginX + 14,
          contentWidth - 20,
          12,
          8,
          'normal',
          COLOR_TEXT
        );
      }
      y += 6;
    });
  }

  // ==========================================
  // 5. RUNNING HEADERS & FOOTERS (ALL PAGES)
  // ==========================================
  const totalPages = doc.getNumberOfPages();

  for (let p = 1; p <= totalPages; p++) {
    doc.setPage(p);

    // Running Header (Pages 2 onwards)
    if (p > 1) {
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8);
      doc.setTextColor(COLOR_PRIMARY[0], COLOR_PRIMARY[1], COLOR_PRIMARY[2]);
      doc.text('Anatomy Guru', marginX, 28);

      doc.setFont('helvetica', 'normal');
      doc.setTextColor(COLOR_MUTED[0], COLOR_MUTED[1], COLOR_MUTED[2]);
      doc.text('|  Medical Evaluation Report', marginX + 64, 28);

      const headerRight = `${sanitizeText(report.studentName) || 'Student'}  •  ${sanitizeText(report.testTitle) || 'Evaluation'}`;
      const headerRightWidth = doc.getTextWidth(headerRight);
      doc.text(headerRight, pageWidth - marginX - headerRightWidth, 28);

      doc.setDrawColor(COLOR_BORDER[0], COLOR_BORDER[1], COLOR_BORDER[2]);
      doc.setLineWidth(0.5);
      doc.line(marginX, 34, pageWidth - marginX, 34);
    }

    // Running Footer (All pages)
    const footerY = pageHeight - 24;
    doc.setDrawColor(COLOR_BORDER[0], COLOR_BORDER[1], COLOR_BORDER[2]);
    doc.setLineWidth(0.5);
    doc.line(marginX, footerY - 10, pageWidth - marginX, footerY - 10);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.setTextColor(COLOR_MUTED[0], COLOR_MUTED[1], COLOR_MUTED[2]);
    doc.text('Aarshiv AI – Anatomy Guru | Medical Answer-Sheet Evaluation', marginX, footerY + 2);

    doc.setFont('helvetica', 'bold');
    const pageString = `Page ${p} of ${totalPages}`;
    const pageStringWidth = doc.getTextWidth(pageString);
    doc.text(pageString, pageWidth - marginX - pageStringWidth, footerY + 2);
  }

  const arrayBuffer = doc.output('arraybuffer');
  return new Uint8Array(arrayBuffer);
};

/**
 * Downloads the native Anatomy Guru Evaluation Report PDF directly.
 */
export const downloadEvaluationPdf = async (
  report: EvaluationReport,
  customFileName?: string
): Promise<void> => {
  const pdfBytes = await generateEvaluationPdf(report);
  const studentSafe = (report.studentName || 'Student').replace(/[^a-zA-Z0-9_-]/g, '_');
  const filename = customFileName || `Anatomy_Guru_${studentSafe}_Report.pdf`;
  downloadBytes(pdfBytes, filename);
};
