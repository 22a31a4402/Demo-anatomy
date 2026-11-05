import { jsPDF } from 'jspdf';
import html2canvas from 'html2canvas';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { EvaluationReport, QuestionFeedback } from '../types';
import { downloadBytes } from './pdfMerger';
import { logoBase64 } from './logoBase64';
import FeedbackReport from '../components/FeedbackReport';

// Helper function to convert oklch CSS color definitions to standard rgb/rgba to prevent html2canvas crashes
export const replaceOklchInString = (cssText: string): string => {
  return cssText.replace(/oklch\(([^)]+)\)/gi, (match, inner) => {
    try {
      if (inner.toLowerCase().includes('var(')) {
        return 'rgb(120, 120, 120)';
      }
      const cleanInner = inner.replace(/,/g, ' ').trim();
      const parts = cleanInner.split(/\s+/);
      const lStr = parts[0] || '0';
      const cStr = parts[1] || '0';
      const hStr = parts[2] || '0';
      let aStr = parts[4] || undefined;
      if (parts[3] && parts[3] !== '/') {
        aStr = parts[3];
      }
      let l = lStr.endsWith('%') ? parseFloat(lStr) / 100 : parseFloat(lStr);
      if (isNaN(l)) l = 0.5;
      let c = parseFloat(cStr);
      if (isNaN(c)) c = 0.1;
      let h = hStr.endsWith('deg')
        ? parseFloat(hStr)
        : hStr.endsWith('turn')
        ? parseFloat(hStr) * 360
        : hStr.endsWith('rad')
        ? parseFloat(hStr) * (180 / Math.PI)
        : parseFloat(hStr);
      if (isNaN(h)) h = 0;
      let a: number | undefined = undefined;
      if (aStr) a = aStr.endsWith('%') ? parseFloat(aStr) / 100 : parseFloat(aStr);

      const l_ = l;
      const a_ = c * Math.cos((h * Math.PI) / 180);
      const b_ = c * Math.sin((h * Math.PI) / 180);

      const l_lms = l_ + 0.3963377774 * a_ + 0.2158037573 * b_;
      const m_lms = l_ - 0.1055613458 * a_ - 0.0638541728 * b_;
      const s_lms = l_ - 0.0894841775 * a_ - 1.291485548 * b_;

      const l3 = l_lms * l_lms * l_lms;
      const m3 = m_lms * m_lms * m_lms;
      const s3 = s_lms * s_lms * s_lms;

      const r_lin = +4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3;
      const g_lin = -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3;
      const b_lin = -0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3;

      const f = (x: number) => (x >= 0.0031308 ? 1.055 * Math.pow(x, 1 / 2.4) - 0.055 : 12.92 * x);

      let r = Math.max(0, Math.min(255, Math.round(f(r_lin) * 255)));
      let g = Math.max(0, Math.min(255, Math.round(f(g_lin) * 255)));
      let b = Math.max(0, Math.min(255, Math.round(f(b_lin) * 255)));

      if (isNaN(r) || isNaN(g) || isNaN(b)) return 'rgb(120, 120, 120)';
      if (a !== undefined && !isNaN(a)) return `rgba(${r}, ${g}, ${b}, ${a})`;
      return `rgb(${r}, ${g}, ${b})`;
    } catch {
      return 'rgb(120, 120, 120)';
    }
  });
};

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
 * Captures an HTML report container element using html2canvas and compiles it into an A4 PDF
 * with smart pagination that avoids cutting through table rows, headings, and lists.
 */
export const renderDomElementToPdfBytes = async (element: HTMLElement): Promise<Uint8Array> => {
  // 1. Preload all images in the report (including the branding logo)
  const reportImages = Array.from(element.querySelectorAll('img'));
  if (reportImages.length > 0) {
    await Promise.all(
      reportImages.map((img) => {
        if (img.complete && img.naturalWidth > 0) return Promise.resolve();
        return new Promise<void>((resolve) => {
          img.onload = () => resolve();
          img.onerror = () => resolve();
        });
      })
    );
  }

  // Brief delay for styles and fonts to settle
  await new Promise((resolve) => setTimeout(resolve, 300));

  // 2. Render container to high-res canvas with oklch sanitization
  const canvas = await html2canvas(element, {
    useCORS: true,
    scale: 2.0,
    backgroundColor: '#FFFFFF',
    logging: false,
    onclone: (clonedDoc) => {
      try {
        // Disable animations to guarantee full opacity during capture
        clonedDoc.querySelectorAll('.animate-fade-in').forEach((el: any) => {
          el.classList.remove('animate-fade-in');
          el.style.opacity = '1';
          el.style.animation = 'none';
          el.style.transition = 'none';
        });

        let combinedCss = '';
        Array.from(document.styleSheets).forEach((sheet) => {
          try {
            const rules = sheet.cssRules || sheet.rules;
            if (rules) {
              Array.from(rules).forEach((rule) => {
                combinedCss += rule.cssText + '\n';
              });
            }
          } catch (e) {
            // Ignore restricted cross-origin sheets
          }
        });

        const cleanCss = replaceOklchInString(combinedCss);
        clonedDoc.querySelectorAll('link[rel="stylesheet"], style').forEach((node) => {
          try {
            node.remove();
          } catch {}
        });

        const head = clonedDoc.head || clonedDoc.getElementsByTagName('head')[0];
        if (head) {
          const newStyle = clonedDoc.createElement('style');
          newStyle.textContent = cleanCss;
          head.appendChild(newStyle);
        }

        clonedDoc.querySelectorAll('[style]').forEach((el: any) => {
          const styleAttr = el.getAttribute('style');
          if (styleAttr && styleAttr.toLowerCase().includes('oklch')) {
            el.setAttribute('style', replaceOklchInString(styleAttr));
          }
        });

        const originalTarget = element;
        const clonedTarget = clonedDoc.getElementById(element.id) || clonedDoc.querySelector('.report-container');
        if (originalTarget && clonedTarget) {
          const inlineStylesRecursive = (src: HTMLElement, dst: HTMLElement) => {
            const computed = window.getComputedStyle(src);
            const properties = [
              'color',
              'background-color',
              'border-color',
              'border-top-color',
              'border-bottom-color',
              'border-left-color',
              'border-right-color',
            ];
            properties.forEach((prop) => {
              try {
                let val = computed.getPropertyValue(prop);
                if (val) {
                  if (val.toLowerCase().includes('oklch')) {
                    val = replaceOklchInString(val);
                  }
                  dst.style.setProperty(prop, val);
                }
              } catch {}
            });
            const srcChildren = Array.from(src.children) as HTMLElement[];
            const dstChildren = Array.from(dst.children) as HTMLElement[];
            for (let i = 0; i < srcChildren.length; i++) {
              if (srcChildren[i] && dstChildren[i]) {
                inlineStylesRecursive(srcChildren[i] as HTMLElement, dstChildren[i] as HTMLElement);
              }
            }
          };
          inlineStylesRecursive(originalTarget, clonedTarget as HTMLElement);
        }
      } catch (err) {
        console.error('Error cleaning up cloned document style for html2canvas:', err);
      }
    },
  });

  // 3. Multi-page smart slicing onto A4 PDF (595.28 x 841.89 pt)
  const pageWidth = 595.28;
  const pageHeight = 841.89;
  const leftMargin = 45;
  const rightMargin = 45;
  const topMargin = 50;
  const bottomMargin = 50;
  const usableWidth = pageWidth - leftMargin - rightMargin;
  const usableHeight = pageHeight - topMargin - bottomMargin;

  const scale = canvas.width / usableWidth;
  const H = canvas.height;
  const W = canvas.width;
  const usableHeightCanvas = usableHeight * scale;
  const pdf = new jsPDF('p', 'pt', 'a4');

  let sy = 0;
  let pageIndex = 0;
  const rect = element.getBoundingClientRect();
  const canvasToDomScale = H / (rect.height || 1);

  while (sy < H) {
    if (pageIndex > 0) {
      pdf.addPage();
    }
    let sHeight = Math.min(usableHeightCanvas, H - sy);

    if (sy + sHeight < H) {
      const proposedCut = sy + sHeight;
      let bestCut = proposedCut;

      const candidates = Array.from(
        element.querySelectorAll(
          'tr, h2, h3, h4, li, p, .feedback-bullet-point, .feedback-section-block, .border, [class*="border"]'
        )
      );

      for (const cand of candidates) {
        const candRect = cand.getBoundingClientRect();
        const candTop = (candRect.top - rect.top) * canvasToDomScale;
        const candBottom = (candRect.bottom - rect.top) * canvasToDomScale;
        const candHeight = candBottom - candTop;

        if (candTop < proposedCut && candBottom > proposedCut) {
          if (candHeight < usableHeightCanvas) {
            const idealCut = candTop - 3 * canvasToDomScale;
            if (idealCut > sy + usableHeightCanvas * 0.3) {
              if (idealCut < bestCut) {
                bestCut = idealCut;
              }
            }
          }
        }
      }
      sHeight = bestCut - sy;
    }

    const pageCanvas = document.createElement('canvas');
    pageCanvas.width = pageWidth * scale;
    pageCanvas.height = pageHeight * scale;
    const ctx = pageCanvas.getContext('2d');
    if (ctx) {
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(0, 0, pageCanvas.width, pageCanvas.height);
      ctx.drawImage(canvas, 0, sy, W, sHeight, leftMargin * scale, topMargin * scale, W, sHeight);
    }

    const pageImgData = pageCanvas.toDataURL('image/jpeg', 0.95);
    pdf.addImage(pageImgData, 'JPEG', 0, 0, pageWidth, pageHeight);

    sy += sHeight;
    pageIndex++;
  }

  return new Uint8Array(pdf.output('arraybuffer'));
};

/**
 * Native vector jsPDF generator implementing the exact Anatomy Guru assessment format
 * (used as a fallback or in non-DOM/server environments).
 */
export const renderReportViaNativeJsPdf = (report: EvaluationReport): Uint8Array => {
  const doc = new jsPDF({
    orientation: 'portrait',
    unit: 'pt',
    format: 'a4',
  });

  const pageWidth = doc.internal.pageSize.getWidth(); // 595.28 pt
  const pageHeight = doc.internal.pageSize.getHeight(); // 841.89 pt
  const marginX = 45;
  const marginTop = 45;
  const marginBottom = 45;
  const contentWidth = pageWidth - marginX * 2; // 505.28 pt
  const maxY = pageHeight - marginBottom;

  let y = marginTop;

  const ensureSpace = (requiredPt: number) => {
    if (y + requiredPt > maxY) {
      doc.addPage();
      y = marginTop;
      return true;
    }
    return false;
  };

  // 1. Centered Anatomy Guru Logo
  try {
    if (logoBase64) {
      const logoW = 190;
      const logoH = 55;
      const logoX = (pageWidth - logoW) / 2;
      doc.addImage(logoBase64, 'JPEG', logoX, y, logoW, logoH);
      y += logoH + 12;
    }
  } catch (err) {
    y += 10;
  }

  // 2. Exam Title (Red, uppercase, tracking, with underline)
  doc.setFont('times', 'bold');
  doc.setFontSize(14);
  doc.setTextColor(220, 38, 38); // Red
  const titleText = (report.testTitle || 'ACADEMIC ASSESSMENT').toUpperCase();
  const titleWidth = doc.getTextWidth(titleText);
  const titleX = (pageWidth - titleWidth) / 2;
  doc.text(titleText, titleX, y);
  y += 4;
  doc.setDrawColor(226, 232, 240);
  doc.setLineWidth(1);
  doc.line(titleX, y, titleX + titleWidth, y);
  y += 14;

  // 3. Topics & Date
  doc.setFont('times', 'bold');
  doc.setFontSize(10.5);
  doc.setTextColor(30, 41, 59);
  const topicsText = `Topics: ${report.testTopics || 'N/A'}`;
  const topicsWidth = doc.getTextWidth(topicsText);
  doc.text(topicsText, (pageWidth - topicsWidth) / 2, y);
  y += 14;

  doc.setFont('times', 'bold');
  doc.setFontSize(10);
  doc.setTextColor(30, 64, 175); // Dark blue
  const dateText = `Date: ${report.testDate || 'N/A'}`;
  const dateWidth = doc.getTextWidth(dateText);
  doc.text(dateText, (pageWidth - dateWidth) / 2, y);
  y += 16;

  // 4. Student Identification Row
  doc.setDrawColor(241, 245, 249);
  doc.setLineWidth(1);
  doc.line(marginX, y, pageWidth - marginX, y);
  y += 14;

  doc.setFont('times', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(220, 38, 38);
  doc.text('Student Name:', marginX, y);
  const studentLabelW = doc.getTextWidth('Student Name: ');

  doc.setFont('times', 'bold');
  doc.setTextColor(15, 23, 42);
  const studentNameStr = report.studentName || 'Unknown Student';
  doc.text(studentNameStr, marginX + studentLabelW, y);
  const nameW = doc.getTextWidth(studentNameStr);
  doc.setDrawColor(203, 213, 225);
  doc.setLineWidth(1);
  doc.line(marginX + studentLabelW, y + 2, marginX + studentLabelW + nameW, y + 2);
  y += 18;

  // 5. Assessment Table (3 columns: 10% Q No, 75% Feedback, 15% Marks)
  const col1W = Math.round(contentWidth * 0.1); // ~50 pt
  const col3W = Math.round(contentWidth * 0.15); // ~75 pt
  const col2W = contentWidth - col1W - col3W; // ~380 pt

  const col1X = marginX;
  const col2X = col1X + col1W;
  const col3X = col2X + col2W;

  const renderTableHeader = () => {
    ensureSpace(24);
    doc.setFillColor(255, 255, 255);
    doc.setDrawColor(148, 163, 184); // border-slate-400
    doc.setLineWidth(1);
    doc.rect(marginX, y, contentWidth, 22);

    doc.line(col2X, y, col2X, y + 22);
    doc.line(col3X, y, col3X, y + 22);

    doc.setFont('times', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(15, 23, 42);

    doc.text('Q No', col1X + (col1W - doc.getTextWidth('Q No')) / 2, y + 15);
    doc.text('Feedback', col2X + (col2W - doc.getTextWidth('Feedback')) / 2, y + 15);
    doc.text('Marks', col3X + (col3W - doc.getTextWidth('Marks')) / 2, y + 15);

    y += 22;
  };

  renderTableHeader();

  const questions: QuestionFeedback[] = report.questions || [];
  const calculatedSum = questions.reduce((sum, q) => sum + (Number(q.marks) || 0), 0);
  const displayScore =
    typeof report.totalScore === 'number' && !isNaN(report.totalScore)
      ? report.totalScore
      : calculatedSum;

  for (const q of questions) {
    const isZero = Number(q.marks) === 0;
    const feedbackPoints = q.feedbackPoints && q.feedbackPoints.length > 0 ? q.feedbackPoints : ['No specific feedback provided.'];

    // Precalculate lines for feedback column
    const formattedLines: { text: string; isBulletStart: boolean }[] = [];
    doc.setFont('times', isZero ? 'italic' : 'normal');
    doc.setFontSize(9.5);

    for (const pt of feedbackPoints) {
      const sanitized = sanitizeText(pt);
      const wrapped = doc.splitTextToSize(`•  ${sanitized}`, col2W - 14);
      wrapped.forEach((line: string, lIdx: number) => {
        formattedLines.push({ text: line, isBulletStart: lIdx === 0 });
      });
    }

    const rowLineHeight = 13;
    const rowHeight = Math.max(26, formattedLines.length * rowLineHeight + 12);

    if (ensureSpace(rowHeight)) {
      renderTableHeader();
    }

    // Row boundaries
    doc.setDrawColor(203, 213, 225);
    doc.setLineWidth(0.5);
    doc.rect(marginX, y, contentWidth, rowHeight);
    doc.line(col2X, y, col2X, y + rowHeight);
    doc.line(col3X, y, col3X, y + rowHeight);

    // Q No
    doc.setFont('times', 'bold');
    doc.setFontSize(10.5);
    doc.setTextColor(isZero ? 220 : 15, isZero ? 38 : 23, isZero ? 38 : 42);
    const qStr = String(q.qNo);
    doc.text(qStr, col1X + (col1W - doc.getTextWidth(qStr)) / 2, y + 16);

    // Feedback Points
    let textY = y + 14;
    doc.setFont('times', isZero ? 'italic' : 'normal');
    doc.setFontSize(9.5);
    doc.setTextColor(isZero ? 220 : 30, isZero ? 38 : 41, isZero ? 38 : 59);

    for (const fLine of formattedLines) {
      doc.text(fLine.text, col2X + 8, textY);
      textY += rowLineHeight;
    }

    // Marks
    doc.setFont('times', 'bold');
    doc.setFontSize(10.5);
    doc.setTextColor(isZero ? 220 : 15, isZero ? 38 : 23, isZero ? 38 : 42);
    const mStr = String(q.marks);
    doc.text(mStr, col3X + (col3W - doc.getTextWidth(mStr)) / 2, y + 16);

    y += rowHeight;
  }

  // Total Score Summation Row
  ensureSpace(26);
  doc.setFillColor(248, 250, 252);
  doc.setDrawColor(148, 163, 184);
  doc.setLineWidth(1);
  doc.rect(marginX, y, contentWidth, 24, 'FD');
  doc.line(col3X, y, col3X, y + 24);

  doc.setFont('times', 'bold');
  doc.setFontSize(10.5);
  doc.setTextColor(100, 116, 139);
  const totalLabel = 'Total Score Summation';
  doc.text(totalLabel, col1X + (col1W + col2W - doc.getTextWidth(totalLabel)) / 2, y + 16);

  doc.setFont('times', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(15, 23, 42);
  const scoreVal = `${displayScore} / ${report.maxScore || 100}`;
  doc.text(scoreVal, col3X + (col3W - doc.getTextWidth(scoreVal)) / 2, y + 16);
  y += 32;

  // 6. General Feedback Section (Enclosed in bordered box)
  if (report.generalFeedback) {
    ensureSpace(120);

    const gf = report.generalFeedback;
    const sections = [
      { num: '1', title: 'Overall Performance', items: gf.overallPerformance },
      { num: '2', title: 'MCQs', items: gf.mcqs },
      { num: '3', title: 'Content Accuracy', items: gf.contentAccuracy },
      { num: '4', title: 'Completeness of Answers', items: gf.completenessOfAnswers },
      { num: '5', title: 'Presentation & Diagrams (Major drawback)', items: gf.presentationDiagrams },
      { num: '6', title: 'Investigations (Must improve)', items: gf.investigations },
      { num: '7', title: 'Attempting All Questions', items: gf.attemptingQuestions },
      { num: '8', title: 'What to do next (Action points)', items: gf.actionPoints },
    ].filter((s) => s.items && s.items.length > 0);

    if (sections.length > 0) {
      doc.setFont('times', 'bold');
      doc.setFontSize(12);
      doc.setTextColor(15, 23, 42);
      doc.text('General Feedback:', marginX, y);
      const gfW = doc.getTextWidth('General Feedback:');
      doc.setDrawColor(15, 23, 42);
      doc.setLineWidth(1);
      doc.line(marginX, y + 2, marginX + gfW, y + 2);
      y += 18;

      for (const s of sections) {
        ensureSpace(35);
        doc.setFont('times', 'bold');
        doc.setFontSize(10.5);
        doc.setTextColor(15, 23, 42);
        doc.text(`${s.num}) ${s.title}`, marginX + 8, y);
        y += 14;

        doc.setFont('times', 'normal');
        doc.setFontSize(9.5);
        doc.setTextColor(30, 41, 59);

        for (const item of s.items || []) {
          const sanitized = sanitizeText(item);
          const lines = doc.splitTextToSize(`•  ${sanitized}`, contentWidth - 30);
          for (const line of lines) {
            ensureSpace(13);
            doc.text(line, marginX + 20, y);
            y += 13;
          }
        }
        y += 6;
      }
    }
  }

  // 7. Flagged Questions / Contradictions (Audit Trail)
  const flagged = questions.filter((q) => q.isFlagged);
  if (flagged.length > 0) {
    ensureSpace(60);
    doc.setFont('times', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(180, 83, 9); // Amber
    doc.text('Audit Trail: Resolution of Contradictions', marginX, y);
    y += 14;

    for (const fq of flagged) {
      ensureSpace(40);
      doc.setFont('times', 'bold');
      doc.setFontSize(10);
      doc.setTextColor(15, 23, 42);
      doc.text(`Question ${fq.qNo}:`, marginX + 8, y);
      y += 12;

      doc.setFont('times', 'normal');
      doc.setFontSize(9);
      doc.setTextColor(71, 85, 105);
      const comment = fq.flaggedComment || 'Contradiction resolved according to official Answer Key.';
      const cLines = doc.splitTextToSize(comment, contentWidth - 20);
      for (const cl of cLines) {
        ensureSpace(12);
        doc.text(cl, marginX + 16, y);
        y += 12;
      }
      y += 6;
    }
  }

  // Footer on all pages
  const totalPages = (doc as any).internal.getNumberOfPages();
  for (let p = 1; p <= totalPages; p++) {
    doc.setPage(p);
    doc.setDrawColor(15, 23, 42);
    doc.setLineWidth(1);
    doc.line(marginX, pageHeight - 35, pageWidth - marginX, pageHeight - 35);

    doc.setFont('times', 'normal');
    doc.setFontSize(8.5);
    doc.setTextColor(100, 116, 139);
    doc.text('Anatomy Guru — Academic Assessment Report', marginX, pageHeight - 22);

    const pageStr = `Page ${p} of ${totalPages}`;
    doc.text(pageStr, pageWidth - marginX - doc.getTextWidth(pageStr), pageHeight - 22);
  }

  return new Uint8Array(doc.output('arraybuffer'));
};

/**
 * Generates the Anatomy Guru Feedback Report PDF bytes in the NEW official format.
 * In the browser, it captures the rendered DOM element (via #capture-target or offscreen render)
 * using html2canvas with smart pagination; if unavailable or in non-browser context, it uses the
 * native vector jsPDF generator implementing the exact new Anatomy Guru design.
 */
export const generateEvaluationPdf = async (report: EvaluationReport): Promise<Uint8Array> => {
  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    // 1. Check if #capture-target is already mounted and rendered in the DOM
    const targetEl = document.getElementById('capture-target');
    if (targetEl && targetEl.offsetHeight > 50) {
      try {
        const reportEl = (targetEl.querySelector('.report-container') as HTMLElement) || targetEl;
        return await renderDomElementToPdfBytes(reportEl);
      } catch (domErr) {
        console.warn('[PDF] Error capturing existing #capture-target, falling back:', domErr);
      }
    }

    // 2. Check if visible report container or any .report-container is available
    const visibleEl = document.getElementById('visible-report-container');
    if (visibleEl && visibleEl.offsetHeight > 50) {
      try {
        const reportEl = (visibleEl.querySelector('.report-container') as HTMLElement) || visibleEl;
        return await renderDomElementToPdfBytes(reportEl);
      } catch (domErr) {
        console.warn('[PDF] Error capturing #visible-report-container, falling back:', domErr);
      }
    }

    const anyReportEl = document.querySelector('.report-container') as HTMLElement;
    if (anyReportEl && anyReportEl.offsetHeight > 50) {
      try {
        return await renderDomElementToPdfBytes(anyReportEl);
      } catch (domErr) {
        console.warn('[PDF] Error capturing .report-container, falling back:', domErr);
      }
    }

    // 3. Dynamically mount an offscreen <FeedbackReport report={report} /> container
    let dynamicContainer: HTMLDivElement | null = null;
    let root: any = null;
    try {
      dynamicContainer = document.createElement('div');
      dynamicContainer.style.position = 'fixed';
      dynamicContainer.style.left = '0';
      dynamicContainer.style.top = '0';
      dynamicContainer.style.width = '850px';
      dynamicContainer.style.background = '#FFFFFF';
      dynamicContainer.style.zIndex = '-9999';
      dynamicContainer.style.pointerEvents = 'none';
      document.body.appendChild(dynamicContainer);

      root = createRoot(dynamicContainer);
      root.render(React.createElement(FeedbackReport, { report, hideAuditTrail: false }));

      // Wait for React to mount and styles to apply
      await new Promise((resolve) => setTimeout(resolve, 400));

      const renderedReportEl = (dynamicContainer.querySelector('.report-container') as HTMLElement) || dynamicContainer;
      if (renderedReportEl) {
        const bytes = await renderDomElementToPdfBytes(renderedReportEl);
        root.unmount();
        document.body.removeChild(dynamicContainer);
        return bytes;
      }
    } catch (renderErr) {
      console.warn('[PDF] Dynamic DOM render failed, using native generator:', renderErr);
      if (root) {
        try {
          root.unmount();
        } catch {}
      }
      if (dynamicContainer && dynamicContainer.parentNode) {
        try {
          document.body.removeChild(dynamicContainer);
        } catch {}
      }
    }
  }

  // 4. Native vector jsPDF generator (exact new Anatomy Guru layout)
  return renderReportViaNativeJsPdf(report);
};

/**
 * Downloads the Anatomy Guru Evaluation Report PDF directly.
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
