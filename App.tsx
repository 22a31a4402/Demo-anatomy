import React, { useState, useEffect } from 'react';
import { Plus, Trash, Check, Sparkles, Sliders, FileText, CheckCircle, ShieldCheck } from 'lucide-react';
import { 
  generateStructuredFeedback, 
  parseActionableError, 
  EvaluationMode, 
  getLatestApprovedKeyApi,
  extractAnswerKeyApi,
  updateAnswerKeyApi,
  approveAnswerKeyApi,
  findApprovedKeyForReferencePairApi
} from './services/geminiService';
import { EvaluationReport, FileData, HistoryItem, CanonicalAnswerKey } from './types';
import FileUploader from './components/FileUploader';
import { AnswerKeyReviewModal } from './components/AnswerKeyReviewModal';
import FeedbackReport from './components/FeedbackReport';
import BatchProcessor from './components/BatchProcessor';
import { logoBase64 } from './services/logoBase64';
// @ts-ignore
import mammoth from 'mammoth';
// @ts-ignore
import * as pdfjsLib from 'pdfjs-dist';
// @ts-ignore
import pdfjsWorker from 'pdfjs-dist/build/pdf.worker.mjs?url';
// @ts-ignore
import { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, WidthType, AlignmentType, HeadingLevel, Footer, PageNumber, NumberFormat } from 'docx';
import { fileToPdfBytes, mergePdfs, downloadBytes } from './services/pdfMerger';
import { generateEvaluationPdf, downloadEvaluationPdf } from './services/evaluationPdf';
import { safeFileToBase64 } from './services/fileUtils';
import { extractStudentNameFromFile } from './services/filenameParser';
import { saveFilesToDB, getFilesFromDB, deleteFilesFromDB } from './services/fileStorage';
import { saveReportToDB, getReportFromDB, deleteReportFromDB } from './services/reportStorage';

const pdfjs: any = pdfjsLib;

if (pdfjs && pdfjs.GlobalWorkerOptions) {
  pdfjs.GlobalWorkerOptions.workerSrc = pdfjsWorker;
}

// Global in-memory cache of file downloads to avoid losing files upon navigating views or editing from history in the same session
const sessionFilesCache: Record<string, {
  student: File | null;
  qp: File | null;
  ak: File | null;
}> = {};

// Helper function to convert oklch CSS color definitions to standard rgb/rgba
const replaceOklchInString = (cssText: string): string => {
  return cssText.replace(/oklch\(([^)]+)\)/gi, (match, inner) => {
    try {
      // If the color contains CSS variables references, return a safe default color to avoid parser crash
      if (inner.toLowerCase().includes('var(')) {
        return 'rgb(120, 120, 120)';
      }

      const cleanInner = inner.replace(/,/g, ' ').trim();
      const parts = cleanInner.split(/\s+/);
      
      const lStr = parts[0] || '0';
      const cStr = parts[1] || '0';
      const hStr = parts[2] || '0';
      let aStr = parts[4] || undefined; // slash is parts[3]
      
      if (parts[3] && parts[3] !== '/') {
        aStr = parts[3];
      }

      let l = 0;
      if (lStr.endsWith('%')) {
        l = parseFloat(lStr) / 100;
      } else {
        l = parseFloat(lStr);
      }
      if (isNaN(l)) l = 0.5;
      
      let c = parseFloat(cStr);
      if (isNaN(c)) c = 0.1;
      
      let h = 0;
      if (hStr.endsWith('deg')) {
        h = parseFloat(hStr);
      } else if (hStr.endsWith('turn')) {
        h = parseFloat(hStr) * 360;
      } else if (hStr.endsWith('rad')) {
        h = parseFloat(hStr) * (180 / Math.PI);
      } else {
        h = parseFloat(hStr);
      }
      if (isNaN(h)) h = 0;

      let a: number | undefined = undefined;
      if (aStr) {
        if (aStr.endsWith('%')) {
          a = parseFloat(aStr) / 100;
        } else {
          a = parseFloat(aStr);
        }
      }

      // OKLCH to RGB conversion math
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

      if (isNaN(r) || isNaN(g) || isNaN(b)) {
        return 'rgb(120, 120, 120)';
      }

      if (a !== undefined && !isNaN(a)) {
        return `rgba(${r}, ${g}, ${b}, ${a})`;
      }
      return `rgb(${r}, ${g}, ${b})`;
    } catch (e) {
      return 'rgb(120, 120, 120)';
    }
  });
};

const App: React.FC = () => {
  const [evalMode, setEvalMode] = useState<EvaluationMode>('without-manual');
  const [sourceDoc, setSourceDoc] = useState<File | null>(null);
  const [dirtyFeedbackDoc, setDirtyFeedbackDoc] = useState<File | null>(null);
  const [questionPaperFile, setQuestionPaperFile] = useState<File | null>(null);
  const [answerKeyFile, setAnswerKeyFile] = useState<File | null>(null);
  const [isExportingUnified, setIsExportingUnified] = useState(false);
  const [report, setReport] = useState<EvaluationReport | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [loadingStep, setLoadingStep] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<'dashboard' | 'report' | 'history' | 'batch'>('dashboard');
  const [isReviewModalOpen, setIsReviewModalOpen] = useState(false);
  const [isCheckingPair, setIsCheckingPair] = useState(false);
  const [isExtractingKey, setIsExtractingKey] = useState(false);
  const [currentAnswerKey, setCurrentAnswerKey] = useState<CanonicalAnswerKey | null>(() => {
    try {
      const saved = localStorage.getItem('anatomy_guru_active_answer_key');
      return saved ? JSON.parse(saved) : null;
    } catch (e) {
      return null;
    }
  });

  useEffect(() => {
    try {
      if (currentAnswerKey) {
        localStorage.setItem('anatomy_guru_active_answer_key', JSON.stringify(currentAnswerKey));
      } else {
        localStorage.removeItem('anatomy_guru_active_answer_key');
      }
    } catch (e) {
      console.warn("Failed to update anatomy_guru_active_answer_key in localStorage:", e);
    }
  }, [currentAnswerKey]);

  useEffect(() => {
    if (!currentAnswerKey) {
      getLatestApprovedKeyApi()
        .then((latest) => {
          if (latest && latest.status === 'approved') {
            setCurrentAnswerKey(latest);
          }
        })
        .catch((e) => console.warn('Failed restoring latest approved key:', e));
    }
  }, []);

  // Automatically check if an approved answer key already exists for this exact Question Paper + Answer Key pair
  useEffect(() => {
    let isCancelled = false;
    const checkExistingPair = async () => {
      if (!questionPaperFile || !answerKeyFile) return;
      setIsCheckingPair(true);
      try {
        const qpData = await processFile(questionPaperFile);
        const akData = await processFile(answerKeyFile);
        if (isCancelled) return;
        const existingKey = await findApprovedKeyForReferencePairApi(qpData, akData);
        if (isCancelled) return;
        if (existingKey) {
          setCurrentAnswerKey(existingKey);
        }
      } catch (e) {
        console.warn('Could not check reference pair hash:', e);
      } finally {
        if (!isCancelled) setIsCheckingPair(false);
      }
    };
    checkExistingPair();
    return () => {
      isCancelled = true;
    };
  }, [questionPaperFile, answerKeyFile]);

  const [editingSingleReport, setEditingSingleReport] = useState<EvaluationReport | null>(null);

  // Helper handlers to edit single evaluation report
  const handleEditSingleQuestionMark = (qIdx: number, val: number) => {
    if (!editingSingleReport) return;
    const nextQuestions = [...editingSingleReport.questions];
    nextQuestions[qIdx] = { ...nextQuestions[qIdx], marks: val };
    setEditingSingleReport({ ...editingSingleReport, questions: nextQuestions });
  };

  const handleEditSingleQuestionMaxMark = (qIdx: number, val: number) => {
    if (!editingSingleReport) return;
    const nextQuestions = [...editingSingleReport.questions];
    nextQuestions[qIdx] = { ...nextQuestions[qIdx], maxMarks: val };
    setEditingSingleReport({ ...editingSingleReport, questions: nextQuestions });
  };

  const handleEditSingleQuestionFeedbackBullet = (qIdx: number, bIdx: number, val: string) => {
    if (!editingSingleReport) return;
    const nextQuestions = [...editingSingleReport.questions];
    const bulletArray = [...nextQuestions[qIdx].feedbackPoints];
    bulletArray[bIdx] = val;
    nextQuestions[qIdx] = { ...nextQuestions[qIdx], feedbackPoints: bulletArray };
    setEditingSingleReport({ ...editingSingleReport, questions: nextQuestions });
  };

  const handleRemoveSingleQuestionFeedbackBullet = (qIdx: number, bIdx: number) => {
    if (!editingSingleReport) return;
    const nextQuestions = [...editingSingleReport.questions];
    const bulletArray = nextQuestions[qIdx].feedbackPoints.filter((_, idx) => idx !== bIdx);
    nextQuestions[qIdx] = { ...nextQuestions[qIdx], feedbackPoints: bulletArray };
    setEditingSingleReport({ ...editingSingleReport, questions: nextQuestions });
  };

  const handleAddSingleQuestionFeedbackBullet = (qIdx: number) => {
    if (!editingSingleReport) return;
    const nextQuestions = [...editingSingleReport.questions];
    nextQuestions[qIdx] = { ...nextQuestions[qIdx], feedbackPoints: [...nextQuestions[qIdx].feedbackPoints, 'New feedback line...'] };
    setEditingSingleReport({ ...editingSingleReport, questions: nextQuestions });
  };

  const handleEditSingleQuestionFlaggedComment = (qIdx: number, val: string) => {
    if (!editingSingleReport) return;
    const nextQuestions = [...editingSingleReport.questions];
    nextQuestions[qIdx] = { ...nextQuestions[qIdx], flaggedComment: val };
    setEditingSingleReport({ ...editingSingleReport, questions: nextQuestions });
  };

  const handleAddSingleQuestionToReport = () => {
    if (!editingSingleReport) return;
    const nextQuestions = [...editingSingleReport.questions];
    const nextQNo = (nextQuestions.length + 1).toString();
    nextQuestions.push({
      qNo: nextQNo,
      feedbackPoints: ['Correct answer.'],
      marks: 1,
      maxMarks: 1,
      isCorrect: true,
      isFlagged: false,
      flaggedComment: ''
    });
    setEditingSingleReport({ ...editingSingleReport, questions: nextQuestions });
  };

  const handleEditSingleGeneralFeedbackBullet = (field: string, bulletIdx: number, val: string) => {
    if (!editingSingleReport || !editingSingleReport.generalFeedback) return;
    const nextGeneral = { ...editingSingleReport.generalFeedback } as any;
    const bulletArray = [...(nextGeneral[field] || [])];
    bulletArray[bulletIdx] = val;
    nextGeneral[field] = bulletArray;
    setEditingSingleReport({ ...editingSingleReport, generalFeedback: nextGeneral });
  };

  const handleRemoveSingleGeneralFeedbackBullet = (field: string, bulletIdx: number) => {
    if (!editingSingleReport || !editingSingleReport.generalFeedback) return;
    const nextGeneral = { ...editingSingleReport.generalFeedback } as any;
    const bulletArray = (nextGeneral[field] || []).filter((_: any, idx: number) => idx !== bulletIdx);
    nextGeneral[field] = bulletArray;
    setEditingSingleReport({ ...editingSingleReport, generalFeedback: nextGeneral });
  };

  const handleAddSingleGeneralFeedbackBullet = (field: string) => {
    if (!editingSingleReport || !editingSingleReport.generalFeedback) return;
    const nextGeneral = { ...editingSingleReport.generalFeedback } as any;
    const bulletArray = [...(nextGeneral[field] || []), 'New summary point...'];
    nextGeneral[field] = bulletArray;
    setEditingSingleReport({ ...editingSingleReport, generalFeedback: nextGeneral });
  };

  const handleApplySingleCorrections = async () => {
    if (!editingSingleReport) return;
    const updated = { ...editingSingleReport };
    updated.totalScore = updated.questions?.reduce((acc: number, q: any) => acc + (Number(q.marks) || 0), 0) || 0;
    
    // Save updated report to IndexedDB
    if (updated.id) {
      await saveReportToDB(updated);
    }

    // 1. Instantly update the state so that other components and views (including the offscreen capture target) render with the corrected report
    setReport(updated);
    setHistory(prev => prev.map(item => {
      if (item.id === updated.id || item.report?.id === updated.id) {
        return {
          ...item,
          studentName: updated.studentName,
          testTitle: updated.testTitle,
          report: updated
        };
      }
      return item;
    }));

    // 2. Open offscreen capture sheet and download 4-in-1 consolidated PDF booklet
    setIsExportingUnified(true);
    try {
      const coverReportPdfBytes = await generateEvaluationPdf(updated);

      // Retrieve original session/uploaded files from IndexedDB, session files cache, or current state variables as fallback
      let studentFile: File | null = null;
      let qpFile: File | null = null;
      let akFile: File | null = null;

      if (updated.id) {
        // Try IndexedDB first
        const dbResult = await getFilesFromDB(updated.id);
        if (dbResult) {
          studentFile = dbResult.student;
          qpFile = dbResult.qp;
          akFile = dbResult.ak;
        } else {
          // Try session caching
          const sessionResult = sessionFilesCache[updated.id];
          if (sessionResult) {
            studentFile = sessionResult.student;
            qpFile = sessionResult.qp;
            akFile = sessionResult.ak;
          }
        }
      }

      // If we still found nothing, we fallback to current state variables
      if (!studentFile && !qpFile && !akFile) {
        studentFile = sourceDoc;
        qpFile = questionPaperFile;
        akFile = answerKeyFile;
      }

      // Gather other documents for physical consolidation
      const studentPdfBytes = studentFile ? await fileToPdfBytes(studentFile) : null;
      const qpPdfBytes = qpFile ? await fileToPdfBytes(qpFile) : null;
      const akPdfBytes = akFile ? await fileToPdfBytes(akFile) : null;

      const mergePdfsList: Uint8Array[] = [coverReportPdfBytes];
      if (qpPdfBytes) mergePdfsList.push(qpPdfBytes);
      if (akPdfBytes) mergePdfsList.push(akPdfBytes);
      if (studentPdfBytes) mergePdfsList.push(studentPdfBytes);

      const valuationMergedBytes = await mergePdfs(mergePdfsList);

      const formattedStudentName = (updated.studentName || 'Student').trim().replace(/\s+/g, '_');

      const cleanQPName = qpFile 
        ? qpFile.name.replace(/\.[^/.]+$/, "") 
        : "Question_Paper";

      const formattedName = `${formattedStudentName}_${cleanQPName}.pdf`;
      downloadBytes(valuationMergedBytes, formattedName);
    } catch (err: any) {
      console.error("Single consolidated PDF export failed:", err);
      alert("Failed to compile 4-in-1 consolidated PDF: " + err.message);
    } finally {
      setIsExportingUnified(false);
      setEditingSingleReport(null);
    }
  };



  useEffect(() => {
    const loadHistoryAndMigrate = async () => {
      try {
        const savedHistoryStr = localStorage.getItem('nextgen_eval_history');
        if (savedHistoryStr) {
          const parsed = JSON.parse(savedHistoryStr);
          if (Array.isArray(parsed)) {
            const sanitizedItems: HistoryItem[] = [];
            for (const item of parsed) {
              if (item.report) {
                // Migrate legacy report embedded in localStorage to IndexedDB
                await saveReportToDB(item.report);
                sanitizedItems.push({
                  id: item.id || item.report.id,
                  studentName: item.studentName || item.report.studentName,
                  testTitle: item.testTitle || item.report.testTitle,
                  timestamp: item.timestamp || item.report.timestamp || Date.now(),
                  report: item.report
                });
              } else if (item.id) {
                sanitizedItems.push({
                  id: item.id,
                  studentName: item.studentName || 'Student',
                  testTitle: item.testTitle || 'Academic Evaluation Report',
                  timestamp: item.timestamp || Date.now()
                });
              }
            }
            setHistory(sanitizedItems);

            // Clean up localStorage immediately to store ONLY lightweight metadata
            try {
              const lightweight = sanitizedItems.map(({ id, studentName, testTitle, timestamp }) => ({
                id,
                studentName,
                testTitle,
                timestamp
              }));
              localStorage.setItem('nextgen_eval_history', JSON.stringify(lightweight));
            } catch (quotaErr) {
              console.warn("localStorage setItem error on history cleanup:", quotaErr);
            }
          }
        }
      } catch (e) {
        console.error("Failed to load history from localStorage", e);
      }
    };

    loadHistoryAndMigrate();
  }, []);

  useEffect(() => {
    try {
      const lightweight = history.map(({ id, studentName, testTitle, timestamp }) => ({
        id,
        studentName,
        testTitle,
        timestamp
      }));
      localStorage.setItem('nextgen_eval_history', JSON.stringify(lightweight));
    } catch (e) {
      console.warn("Failed to update nextgen_eval_history in localStorage:", e);
    }
  }, [history]);

  useEffect(() => {
    if (report) setView('report');
  }, [report]);

  const extractTextFromPDF = async (file: File): Promise<string> => {
    if (!pdfjs || !pdfjs.getDocument) {
      throw new Error("PDF processing library not initialized.");
    }
    const arrayBuffer = await file.arrayBuffer();
    const loadingTask = pdfjs.getDocument({ data: arrayBuffer });
    const pdf = await loadingTask.promise;
    let fullText = '';
    
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const textContent = await page.getTextContent();
      const pageText = textContent.items.map((item: any) => item.str).join(' ');
      fullText += `[P${i}] ${pageText}\n`;
    }
    return fullText;
  };

  const processFile = async (file: File): Promise<FileData> => {
    const fileName = file.name.toLowerCase();
    const isDocx = fileName.endsWith('.docx') || file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    const isPdf = fileName.endsWith('.pdf') || file.type === 'application/pdf';
    
    if (isDocx) {
      setLoadingStep(`Analyzing DOCX: ${file.name}`);
      const arrayBuffer = await file.arrayBuffer();
      const result = await mammoth.extractRawText({ arrayBuffer });
      return { text: result.value, name: file.name, isDocx: true };
    } 
    
    if (isPdf) {
      setLoadingStep(`Processing PDF: ${file.name}`);
      const base64 = await safeFileToBase64(file);

      let text = '';
      try {
        text = await extractTextFromPDF(file);
      } catch (e) {
        console.warn("Text extraction failed, relying on native PDF OCR", e);
      }

      return {
        base64,
        mimeType: file.type || 'application/pdf',
        text: text || undefined,
        name: file.name,
        isDocx: false
      };
    }

    setLoadingStep(`Preparing Visual Data: ${file.name}`);
    const base64 = await safeFileToBase64(file);

    return {
      base64,
      mimeType: file.type || 'image/jpeg',
      name: file.name,
      isDocx: false
    };
  };

  const handleExtractOrReviewCriteria = async () => {
    if (!questionPaperFile || !answerKeyFile) {
      setError("Please upload both the Question Paper and Official Answer Key first.");
      return;
    }
    if (currentAnswerKey) {
      setIsReviewModalOpen(true);
      return;
    }
    setIsExtractingKey(true);
    setError(null);
    try {
      setLoadingStep("Reading documents for criteria extraction...");
      const qpData = await processFile(questionPaperFile);
      const akData = await processFile(answerKeyFile);
      setLoadingStep("Extracting question-wise criteria from official documents...");
      const extracted = await extractAnswerKeyApi({
        answerKeyDoc: akData,
        questionPaperDoc: qpData,
        title: questionPaperFile.name.replace(/\.[^/.]+$/, "") + " Official Key"
      });
      const approvedResult = await approveAnswerKeyApi(extracted.id, "Auto-approved from uploaded official documents");
      setCurrentAnswerKey(approvedResult.answerKey);
      setIsReviewModalOpen(true);
    } catch (e: any) {
      console.error("Failed to extract criteria:", e);
      setError("Failed to extract criteria from official documents: " + (e.message || e));
    } finally {
      setIsExtractingKey(false);
      setLoadingStep('');
    }
  };

  const handleAnalyze = async () => {
    if (!questionPaperFile) {
      setError("Please upload the Question Paper (PDF). Both Question Paper and Answer Key are mandatory.");
      return;
    }

    if (!answerKeyFile) {
      setError("Please upload the Official Answer Key (PDF). Both Question Paper and Answer Key are mandatory.");
      return;
    }

    if (!sourceDoc) {
      setError("Please upload the Student Answer Sheet (PDF).");
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      setLoadingStep("Reading documents...");
      
      setLoadingStep(`Reading Question Paper: ${questionPaperFile.name}...`);
      const qpData = await processFile(questionPaperFile);

      setLoadingStep(`Reading Official Answer Key: ${answerKeyFile.name}...`);
      const akData = await processFile(answerKeyFile);

      setLoadingStep(`Reading Student Answer Sheet: ${sourceDoc.name}...`);
      const sourceData = await processFile(sourceDoc);

      let dirtyFeedbackData: FileData | null = null;
      if (evalMode === 'with-manual' && dirtyFeedbackDoc) {
        setLoadingStep(`Reading Faculty Feedback Notes: ${dirtyFeedbackDoc.name}...`);
        dirtyFeedbackData = await processFile(dirtyFeedbackDoc);
      }

      let activeKey = currentAnswerKey;
      if (!activeKey) {
        setLoadingStep("Extracting question-wise reference criteria from official documents...");
        const extracted = await extractAnswerKeyApi({
          answerKeyDoc: akData,
          questionPaperDoc: qpData,
          title: questionPaperFile.name.replace(/\.[^/.]+$/, "") + " Official Key"
        });
        const approved = await approveAnswerKeyApi(extracted.id, "Auto-approved from uploaded official documents");
        activeKey = approved.answerKey;
        setCurrentAnswerKey(activeKey);
      }

      setLoadingStep("Anatomy Guru is evaluating student responses with strict medical standards...");
      const result = await generateStructuredFeedback(
        sourceData, 
        dirtyFeedbackData, 
        evalMode, 
        (percent, msg) => {
          setLoadingStep(`[${percent}%] ${msg}`);
        },
        qpData,
        akData,
        undefined,
        activeKey?.id
      );
      
      const newReport = {
        ...result,
        studentName: extractStudentNameFromFile(sourceDoc.name),
        id: crypto.randomUUID(),
        timestamp: Date.now()
      };

      if (newReport.id) {
        sessionFilesCache[newReport.id] = {
          student: sourceDoc,
          qp: questionPaperFile,
          ak: answerKeyFile
        };
        // Persist files in IndexedDB
        await saveFilesToDB(newReport.id, sourceDoc, questionPaperFile, answerKeyFile);
        // Persist full report in IndexedDB
        await saveReportToDB(newReport);
      }

      setReport(newReport);
      setHistory(prev => [
        {
          id: newReport.id,
          studentName: newReport.studentName,
          testTitle: newReport.testTitle,
          timestamp: newReport.timestamp,
          report: newReport
        },
        ...prev
      ]);
    } catch (err: any) {
      const parsedError = parseActionableError(err);
      console.error("[Anatomy Guru Single Evaluation Failure]", {
        category: parsedError.category,
        actionableMessage: parsedError.message,
        statusCode: parsedError.statusCode,
        rawError: err,
        stack: err?.stack || new Error().stack,
        timestamp: new Date().toISOString()
      });
      setError(`${parsedError.category}: ${parsedError.message}`);
    } finally {
      setIsLoading(false);
      setLoadingStep('');
    }
  };

  const handleExportPDF = () => {
    window.print();
  };

  const handleDownloadEvaluationPdf = async () => {
    if (!report) return;
    try {
      await downloadEvaluationPdf(report);
    } catch (err: any) {
      console.error("Evaluation PDF export failed:", err);
      alert("Failed to export PDF: " + (err.message || "Unknown error"));
    }
  };

  const handleDownloadUnifiedBundle = async () => {
    if (!report) return;
    setIsExportingUnified(true);
    try {
      const coverReportPdfBytes = await generateEvaluationPdf(report);

      // Retrieve original session/uploaded files from IndexedDB, session files cache, or current state variables as fallback
      let studentFile: File | null = null;
      let qpFile: File | null = null;
      let akFile: File | null = null;

      if (report.id) {
        // Try IndexedDB first
        const dbResult = await getFilesFromDB(report.id);
        if (dbResult) {
          studentFile = dbResult.student;
          qpFile = dbResult.qp;
          akFile = dbResult.ak;
        } else {
          // Try session caching
          const sessionResult = sessionFilesCache[report.id];
          if (sessionResult) {
            studentFile = sessionResult.student;
            qpFile = sessionResult.qp;
            akFile = sessionResult.ak;
          }
        }
      }

      // If we still found nothing, we fallback to current state variables
      if (!studentFile && !qpFile && !akFile) {
        studentFile = sourceDoc;
        qpFile = questionPaperFile;
        akFile = answerKeyFile;
      }

      // Gather other documents for physical consolidation
      const studentPdfBytes = studentFile ? await fileToPdfBytes(studentFile) : null;
      const qpPdfBytes = qpFile ? await fileToPdfBytes(qpFile) : null;
      const akPdfBytes = akFile ? await fileToPdfBytes(akFile) : null;

      const mergePdfsList: Uint8Array[] = [coverReportPdfBytes];
      if (qpPdfBytes) mergePdfsList.push(qpPdfBytes);
      if (akPdfBytes) mergePdfsList.push(akPdfBytes);
      if (studentPdfBytes) mergePdfsList.push(studentPdfBytes);

      const valuationMergedBytes = await mergePdfs(mergePdfsList);

      const formattedStudentName = (report.studentName || 'Student').trim().replace(/\s+/g, '_');

      const cleanQPName = qpFile 
        ? qpFile.name.replace(/\.[^/.]+$/, "") 
        : "Question_Paper";

      const formattedName = `${formattedStudentName}_${cleanQPName}.pdf`;
      downloadBytes(valuationMergedBytes, formattedName);
    } catch (err: any) {
      console.error("Single consolidated PDF export failed:", err);
      alert("Failed to compile 4-in-1 consolidated PDF: " + err.message);
    } finally {
      setIsExportingUnified(false);
    }
  };

  const handleExportWord = async () => {
    if (!report) return;

    const sections = [];
    sections.push(
      new Paragraph({
        children: [new TextRun(report.testTitle || 'Academic Evaluation Report')],
        heading: HeadingLevel.HEADING_1,
        alignment: AlignmentType.CENTER,
      }),
      new Paragraph({ children: [new TextRun({ text: `Student: ${report.studentName}`, bold: true })] }),
      new Paragraph({ children: [new TextRun({ text: `Date: ${report.testDate}`, bold: true })] }),
      new Paragraph({ children: [] }) 
    );

    const tableRows = [
      new TableRow({
        children: [
          new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: "Q No", bold: true })] })] }),
          new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: "Feedback", bold: true })] })] }),
          new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: "Marks", bold: true })] })] }),
        ],
      }),
    ];

    report.questions.forEach((q) => {
      tableRows.push(
        new TableRow({
          children: [
            new TableCell({ children: [new Paragraph({ children: [new TextRun(q.qNo)] })] }),
            new TableCell({ children: q.feedbackPoints.map(p => new Paragraph({ children: [new TextRun("• " + p)] })) }),
            new TableCell({ children: [new Paragraph({ children: [new TextRun(`${q.marks}/${q.maxMarks}`)] })] }),
          ],
        })
      );
    });

    sections.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: tableRows }));

    // Add Audit Trail if there are flagged questions
    const flagged = report.questions.filter(q => q.isFlagged);
    if (flagged.length > 0) {
      sections.push(
        new Paragraph({ children: [], spacing: { before: 400 } }),
        new Paragraph({
          children: [new TextRun({ text: "AUDIT TRAIL: RESOLUTION OF CONTRADICTIONS", bold: true })],
          heading: HeadingLevel.HEADING_2,
        }),
        new Paragraph({
          children: [new TextRun({ text: "The following questions showed a significant contradiction between the Faculty Notes and the official Answer Key. The system has prioritized the Answer Key for the final report.", italics: true, size: 20 })],
        })
      );

      flagged.forEach(q => {
        sections.push(
          new Paragraph({ children: [new TextRun({ text: `Question ${q.qNo}`, bold: true })], spacing: { before: 200 } }),
          new Paragraph({ children: [new TextRun({ text: "Original Faculty Observation:", bold: true, size: 18 })] }),
          ...q.feedbackPoints.map(p => new Paragraph({ children: [new TextRun({ text: `• ${p}`, size: 18 })] })),
          new Paragraph({ children: [new TextRun({ text: "Evaluator's Resolution:", bold: true, size: 18, color: "8B4513" })] }),
          new Paragraph({ children: [new TextRun({ text: q.flaggedComment || "N/A", size: 18, color: "8B4513" })] })
        );
      });
    }

    const doc = new Document({
      sections: [{
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.RIGHT,
                children: [
                  new TextRun("Page "),
                  new TextRun({
                    children: [PageNumber.CURRENT],
                  }),
                  new TextRun(" of "),
                  new TextRun({
                    children: [PageNumber.TOTAL_PAGES],
                  }),
                ],
              }),
            ],
          }),
        },
        children: sections,
      }],
    });
    const blob = await Packer.toBlob(doc);
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `Anatomy_Guru_${report.studentName || 'Report'}.docx`;
    link.click();
  };

  const renderHistory = () => (
    <div className="max-w-4xl mx-auto px-4 mt-16 animate-fade-in pb-20">
      <header className="text-center mb-12">
        <h1 className="text-5xl font-black text-slate-900 mb-4 tracking-tight">
          Evaluation <span className="text-blue-600">History</span>
        </h1>
        <p className="text-slate-500 font-medium text-lg max-w-2xl mx-auto">
          Review previous academic evaluations and student performance reports.
        </p>
      </header>

      {history.length === 0 ? (
        <div className="text-center py-20 bg-white rounded-3xl border border-dashed border-slate-300">
          <p className="text-slate-400 font-medium">No evaluation history found.</p>
          <button 
            onClick={() => setView('dashboard')}
            className="mt-4 text-slate-900 font-bold hover:underline"
          >
            Start your first evaluation
          </button>
        </div>
      ) : (
        <div className="grid gap-4">
          {history.map((item) => (
            <div 
              key={item.id}
              className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm hover:shadow-md transition-all flex items-center justify-between group"
            >
              <div>
                <h3 className="text-lg font-bold text-slate-900">{item.studentName}</h3>
                <p className="text-slate-500 text-sm font-medium">{item.testTitle}</p>
                <p className="text-slate-400 text-xs mt-1">
                  {new Date(item.timestamp).toLocaleString()}
                </p>
              </div>
              <div className="flex items-center gap-3">
                <button 
                  onClick={async () => {
                    if (item.report) {
                      setReport(item.report);
                      setView('report');
                    } else {
                      const fullReport = await getReportFromDB(item.id);
                      if (fullReport) {
                        setReport(fullReport);
                        setView('report');
                      } else {
                        alert("Full report data could not be retrieved.");
                      }
                    }
                  }}
                  className="px-4 py-2 bg-slate-900 text-white rounded-xl text-sm font-bold hover:bg-black transition-all cursor-pointer"
                >
                  View Report
                </button>
                <button 
                  onClick={async () => {
                    if (confirm('Are you sure you want to delete this report?')) {
                      setHistory(prev => prev.filter(h => h.id !== item.id));
                      await deleteReportFromDB(item.id);
                      await deleteFilesFromDB(item.id);
                    }
                  }}
                  className="p-2 text-slate-300 hover:text-red-500 transition-all cursor-pointer"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );

  const renderDashboard = () => (
    <div className="max-w-5xl mx-auto px-4 mt-12 animate-fade-in pb-20">
      <header className="text-center mb-10">
        <img 
          src={logoBase64} 
          alt="Aarshiv AI – Anatomy Guru Logo" 
          className="h-24 mx-auto mb-6 rounded-2xl shadow-md border border-slate-100 object-contain"
        />
        <h1 className="text-4xl sm:text-5xl font-black text-slate-900 mb-3 tracking-tight">
          Anatomy Guru – <span className="text-[#E5281B]">Version 2</span>
        </h1>
        <p className="text-slate-500 font-medium text-base sm:text-lg max-w-2xl mx-auto">
          AI-Powered Medical Answer-Sheet Evaluation. Evaluates student responses against official question papers and answer keys with strict anatomical and clinical precision.
        </p>
      </header>

      {/* Evaluation Mode Switcher */}
      <div className="flex justify-center mb-8">
        <div className="inline-flex p-1.5 bg-slate-200/80 rounded-2xl border border-slate-300 shadow-inner">
          <button
            type="button"
            onClick={() => setEvalMode('without-manual')}
            className={`px-5 py-2.5 rounded-xl font-bold text-xs uppercase tracking-wider transition-all cursor-pointer ${
              evalMode === 'without-manual'
                ? 'bg-white text-slate-900 shadow-sm'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Mode 1: Without Manual Feedback
          </button>
          <button
            type="button"
            onClick={() => setEvalMode('with-manual')}
            className={`px-5 py-2.5 rounded-xl font-bold text-xs uppercase tracking-wider transition-all cursor-pointer ${
              evalMode === 'with-manual'
                ? 'bg-[#E5281B] text-white shadow-sm'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Mode 2: With Manual Feedback (Audit Mode)
          </button>
        </div>
      </div>

      {/* Batch Queue Promotional Banner */}
      <div className="bg-red-50/50 border border-red-100 p-5 rounded-2xl mb-8 text-center flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div className="text-left font-sans">
          <h3 className="font-extrabold text-slate-900 text-sm flex items-center gap-2">
            <span className="text-[10px] font-black bg-[#E5281B] text-white px-2 py-0.5 rounded-full uppercase tracking-wider">BATCH PIPELINE</span>
            Class Valuation Pipeline
          </h3>
          <p className="text-xs text-slate-500 mt-0.5 font-medium">
            Evaluate entire class batches against official questions & answer keys. Generates consolidated 4-in-1 medical evaluation PDF booklets.
          </p>
        </div>
        <button
          onClick={() => setView('batch')}
          className="px-5 py-2 bg-[#E5281B] hover:bg-[#C92015] hover:-translate-y-0.5 transition-all text-white font-extrabold text-xs rounded-xl shadow-md shadow-red-600/20 shrink-0 cursor-pointer"
        >
          Launch Batch Pipeline ⚡
        </button>
      </div>

      {/* 4-Card Upload Interface */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        {/* Card 1: Question Paper (Mandatory) */}
        <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-sm flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-[10px] font-black uppercase tracking-wider bg-red-100 text-red-700 px-2 py-0.5 rounded-full">Mandatory</span>
              <span className="text-xs font-bold text-slate-400">Step 1</span>
            </div>
            <FileUploader
              label="Question Paper"
              description="Official valuation question paper PDF"
              selectedFile={questionPaperFile}
              onFileSelect={setQuestionPaperFile}
              icon={<FileText className="w-6 h-6 text-red-500" />}
            />
          </div>
        </div>

        {/* Card 2: Official Answer Key (Mandatory) */}
        <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-sm flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-[10px] font-black uppercase tracking-wider bg-red-100 text-red-700 px-2 py-0.5 rounded-full">Mandatory</span>
              <span className="text-xs font-bold text-slate-400">Step 2</span>
            </div>
            <FileUploader
              label="Official Answer Key"
              description="Faculty gold-standard model key PDF"
              selectedFile={answerKeyFile}
              onFileSelect={setAnswerKeyFile}
              icon={<ShieldCheck className="w-6 h-6 text-emerald-600" />}
            />
          </div>
        </div>

        {/* Card 3: Student Answer Script (Mandatory) */}
        <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-sm flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-[10px] font-black uppercase tracking-wider bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full">Mandatory</span>
              <span className="text-xs font-bold text-slate-400">Step 3</span>
            </div>
            <FileUploader
              label="Student Answer Script"
              description="Student's handwritten or typed script PDF"
              selectedFile={sourceDoc}
              onFileSelect={setSourceDoc}
              icon={<FileText className="w-6 h-6 text-blue-600" />}
            />
          </div>
        </div>

        {/* Card 4: Faculty Manual Feedback (Optional / Active in with-manual) */}
        <div className={`p-4 rounded-2xl border transition-all flex flex-col justify-between ${
          evalMode === 'with-manual' 
            ? 'bg-white border-amber-300 shadow-sm ring-1 ring-amber-200' 
            : 'bg-slate-50 border-dashed border-slate-200 opacity-60'
        }`}>
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className={`text-[10px] font-black uppercase tracking-wider px-2 py-0.5 rounded-full ${
                evalMode === 'with-manual' ? 'bg-amber-100 text-amber-800' : 'bg-slate-200 text-slate-500'
              }`}>
                {evalMode === 'with-manual' ? 'Optional (Audit)' : 'Disabled in Mode 1'}
              </span>
              <span className="text-xs font-bold text-slate-400">Step 4</span>
            </div>
            {evalMode === 'with-manual' ? (
              <FileUploader
                label="Faculty Feedback"
                description="Handwritten faculty notes for discrepancy audit"
                selectedFile={dirtyFeedbackDoc}
                onFileSelect={setDirtyFeedbackDoc}
                icon={<FileText className="w-6 h-6 text-amber-600" />}
              />
            ) : (
              <div className="p-4 text-center text-xs text-slate-400 flex flex-col items-center justify-center h-32">
                <span className="font-bold">Mode 2 Feature</span>
                <span className="text-[10px] mt-1">Switch to "With Manual Feedback" to upload faculty review notes</span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Criteria Status & Review Bar */}
      {questionPaperFile && answerKeyFile && (
        <div className="bg-slate-100/90 border border-slate-200 rounded-2xl p-4 mb-6 flex flex-col sm:flex-row items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            {isCheckingPair || isExtractingKey ? (
              <div className="animate-spin w-5 h-5 border-2 border-red-600 border-t-transparent rounded-full" />
            ) : currentAnswerKey ? (
              <CheckCircle className="w-5 h-5 text-emerald-600 shrink-0" />
            ) : (
              <Sparkles className="w-5 h-5 text-amber-600 shrink-0" />
            )}
            <div>
              <div className="text-xs font-bold text-slate-800">
                {isCheckingPair
                  ? "Checking persistent reference database for matching document pair..."
                  : isExtractingKey
                  ? "Extracting question-wise criteria from official documents..."
                  : currentAnswerKey
                  ? `✓ Official Reference Key Linked (${currentAnswerKey.questions?.length || 0} Questions, ${currentAnswerKey.questions?.reduce((acc, q) => acc + (Number(q.maxMarks) || 0), 0) || 0} Total Marks)`
                  : "Official Question Paper & Answer Key loaded. Ready to evaluate or review criteria."}
              </div>
              <div className="text-[10px] text-slate-500">
                {currentAnswerKey 
                  ? `Identified by full content SHA-256 hash • Reused persistently across all students (v${currentAnswerKey.version})` 
                  : "Criteria are extracted once per document pair and reused for all subsequent students."}
              </div>
            </div>
          </div>

          <button
            type="button"
            onClick={handleExtractOrReviewCriteria}
            disabled={isExtractingKey || isCheckingPair}
            className="px-4 py-2 bg-white hover:bg-slate-50 border border-slate-300 rounded-xl text-xs font-bold text-slate-700 shadow-sm hover:shadow flex items-center gap-1.5 shrink-0 cursor-pointer transition-all"
          >
            <Sliders className="w-3.5 h-3.5 text-slate-500" />
            <span>{currentAnswerKey ? "Review / Edit Criteria ✍️" : "Extract & Review Criteria"}</span>
          </button>
        </div>
      )}

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 p-4 rounded-xl mb-6 flex items-center gap-3 animate-pulse">
          <svg className="w-5 h-5 shrink-0" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd"></path></svg>
          <p className="text-sm font-semibold">{error}</p>
        </div>
      )}

      {/* Evaluate & Generate Report Action */}
      <button
        onClick={handleAnalyze}
        disabled={isLoading || !questionPaperFile || !answerKeyFile || !sourceDoc}
        className={`w-full py-5 rounded-2xl font-bold text-base shadow-xl transition-all flex flex-col items-center justify-center ${
          isLoading || !questionPaperFile || !answerKeyFile || !sourceDoc
            ? 'bg-slate-200 text-slate-400 cursor-not-allowed border border-slate-300' 
            : 'bg-[#E5281B] hover:bg-[#C92015] text-white hover:-translate-y-0.5 cursor-pointer shadow-red-600/20'
        }`}
      >
        {isLoading ? (
          <div className="flex items-center gap-3">
            <svg className="animate-spin h-5 w-5 text-white" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
            <span>{loadingStep || "Evaluating..."}</span>
          </div>
        ) : !questionPaperFile || !answerKeyFile ? (
          <span className="text-sm">Upload Question Paper and Official Answer Key (Both Mandatory)</span>
        ) : !sourceDoc ? (
          <span className="text-sm">Upload Student Answer Sheet to Evaluate</span>
        ) : (
          "Run Evaluation & Generate Report 🚀"
        )}
      </button>
    </div>
  );

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Off-screen capture sheet */}
      {isExportingUnified && (
        <div 
          className="fixed left-0 top-0 bg-white pointer-events-none" 
          style={{ width: '850px', zIndex: -50 }}
        >
          <div id="capture-target">
            <FeedbackReport report={report} hideAuditTrail={false} />
          </div>
        </div>
      )}
      <nav className="bg-white/80 backdrop-blur-md border-b border-slate-200 sticky top-0 z-50 no-print h-16">
        <div className="max-w-7xl mx-auto px-4 h-full flex items-center justify-between">
          <div className="flex items-center">
             {(view === 'report' || view === 'history' || view === 'batch') && (
              <button 
                onClick={() => setView('dashboard')}
                className="flex items-center gap-2 text-slate-500 hover:text-slate-900 font-bold transition-all text-sm"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 19l-7-7m0 0l7-7m-7 7h18"></path></svg>
                Back to Dashboard
              </button>
            )}
            {view === 'dashboard' && (
              <div className="flex items-center gap-4">
                <img 
                  src={logoBase64} 
                  alt="Aarshiv AI – Anatomy Guru Logo" 
                  className="h-10 rounded-lg shadow-sm"
                />
                <button 
                  onClick={() => setView('history')}
                  className="flex items-center gap-2 px-3 py-1.5 bg-slate-100 text-slate-600 rounded-lg text-xs font-bold hover:bg-slate-200 transition-all cursor-pointer"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
                  History
                </button>
                <button 
                  onClick={() => setView('batch')}
                  className="flex items-center gap-2 px-3 py-1.5 bg-red-50 text-red-600 rounded-lg text-xs font-bold hover:bg-red-100 transition-all border border-red-100 cursor-pointer"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"></path></svg>
                  Batch Valuation Queue ⚡
                </button>
              </div>
            )}
          </div>
          
          <div className="flex items-center gap-2">

            {view === 'report' && report && (
              <>
                <button 
                  onClick={() => setEditingSingleReport(JSON.parse(JSON.stringify(report)))} 
                  className="px-3 py-1.5 bg-amber-500 hover:bg-amber-600 text-white rounded-lg text-xs font-bold shadow-md shadow-amber-500/15 hover:-translate-y-0.5 transition-all cursor-pointer"
                >
                  Edit Evaluation ✍️
                </button>
                <button 
                  onClick={handleDownloadEvaluationPdf} 
                  className="px-3 py-1.5 bg-emerald-600 text-white rounded-lg text-xs font-bold hover:bg-emerald-700 shadow-md shadow-emerald-500/10 transition-all cursor-pointer flex items-center gap-1"
                  title="Download Evaluation Report as a native searchable PDF"
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"></path></svg>
                  <span>Export PDF</span>
                </button>
                <button 
                  onClick={handleExportWord} 
                  className="px-3 py-1.5 bg-blue-600 text-white rounded-lg text-xs font-bold hover:bg-blue-700 shadow-md shadow-blue-500/10 transition-all cursor-pointer"
                >
                  Export Word
                </button>
                <button 
                  onClick={handleExportPDF} 
                  className="px-3 py-1.5 bg-slate-700 text-white rounded-lg text-xs font-bold hover:bg-slate-800 shadow-md shadow-slate-500/10 transition-all cursor-pointer"
                >
                  Print Report
                </button>
                <button 
                  onClick={handleDownloadUnifiedBundle} 
                  disabled={isExportingUnified}
                  className={`px-3 py-1.5 text-white rounded-lg text-xs font-bold shadow-md transition-all flex items-center gap-1 cursor-pointer ${
                    isExportingUnified 
                      ? 'bg-red-400 cursor-not-allowed' 
                      : 'bg-[#F93A2C] hover:bg-[#E5281B] shadow-red-500/10'
                  }`}
                >
                  {isExportingUnified ? (
                    <>
                      <svg className="animate-spin h-3.5 w-3.5 text-white" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
                      <span>Compiling...</span>
                    </>
                  ) : (
                    <span>Download 4-in-1 PDF ⚡</span>
                  )}
                </button>
              </>
            )}
          </div>
        </div>
      </nav>

      <main>
        {view === 'dashboard' && renderDashboard()}
        {view === 'history' && renderHistory()}
        {view === 'report' && (
          <div id="visible-report-container" className="bg-white">
            <FeedbackReport report={report} hideAuditTrail={false} />
          </div>
        )}
        <div style={{ display: view === 'batch' ? 'block' : 'none' }}>
          <BatchProcessor 
            onBack={() => setView('dashboard')} 
            history={history}
            onAddHistoryItem={(newReport) => {
              if (newReport.id) {
                saveReportToDB(newReport).catch(err => console.error("Failed to save report to DB", err));
              }
              setHistory(prev => {
                if (prev.some(h => h.id === newReport.id)) return prev;
                return [
                  {
                    id: newReport.id || crypto.randomUUID(),
                    studentName: newReport.studentName,
                    testTitle: newReport.testTitle,
                    timestamp: newReport.timestamp || Date.now(),
                    report: newReport
                  },
                  ...prev
                ];
              });
            }}
          />
        </div>
      </main>

      {editingSingleReport && (() => {
        const report = editingSingleReport;
        const studentName = editingSingleReport.studentName;
        const calculatedSum = report.questions?.reduce((acc: number, q: any) => acc + (Number(q.marks) || 0), 0) || 0;

        return (
          <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-md z-50 overflow-y-auto px-4 py-8 flex justify-center no-print">
            <div className="bg-white rounded-3xl w-full max-w-4xl border border-slate-200 shadow-2xl h-fit overflow-hidden animate-fade-in relative font-sans">
              
              {/* Header */}
              <div className="bg-slate-950 text-white p-6 border-b border-slate-800 flex items-center justify-between">
                <div>
                  <p className="text-[10px] font-black tracking-widest text-[#F93A2C] uppercase mb-1">
                    CORRECTION DESK | AI ACADEMIC EVALUATOR
                  </p>
                  <h3 className="text-xl font-bold font-sans">
                    Editing: <span className="underline underline-offset-4 decoration-[#F93A2C]">{studentName}</span>
                  </h3>
                </div>
                <div className="text-right">
                  <span className="text-xs font-semibold text-slate-400 block font-sans">Total Recalculated Sum:</span>
                  <span className="text-2xl font-black text-white font-sans">
                    {calculatedSum} / {report.maxScore || 100}
                  </span>
                </div>
              </div>

              {/* Editing Form */}
              <div className="p-8 space-y-8 max-h-[70vh] overflow-y-auto">
                
                {/* Identification Editor */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6 bg-slate-50 p-4 rounded-2xl border border-slate-200">
                  <div>
                    <label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-1.5 font-sans">
                      Student Name
                    </label>
                    <input 
                      type="text"
                      value={editingSingleReport.studentName}
                      onChange={(e) => {
                        const newName = e.target.value;
                        setEditingSingleReport({
                          ...editingSingleReport,
                          studentName: newName
                        });
                      }}
                      className="w-full px-4 py-2 bg-white border border-slate-300 focus:border-red-500 rounded-xl text-sm font-bold text-slate-800 outline-none transition-colors"
                      placeholder="Enter Student Name"
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-1.5 font-sans">
                      Test Title Designator
                    </label>
                    <input 
                      type="text"
                      value={report.testTitle || ''}
                      onChange={(e) => {
                        const newTitle = e.target.value;
                        setEditingSingleReport({
                          ...editingSingleReport,
                          testTitle: newTitle
                        });
                      }}
                      className="w-full px-4 py-2 bg-white border border-slate-300 focus:border-red-500 rounded-xl text-sm font-bold text-slate-800 outline-none transition-colors"
                      placeholder="Enter Test Title"
                    />
                  </div>
                </div>

                {/* Question Feedback Table Editor */}
                <div>
                  <h4 className="text-xs font-black text-slate-800 uppercase tracking-widest border-b pb-1.5 mb-4 flex items-center justify-between font-sans">
                    <span>Question-wise Scoring & Feedback Points</span>
                    <button 
                      onClick={handleAddSingleQuestionToReport}
                      className="px-3 py-1 bg-slate-100 hover:bg-slate-200 text-slate-800 rounded font-black text-[10px] flex items-center gap-1 cursor-pointer"
                    >
                      <Plus className="w-3 h-3" /> Insert Question
                    </button>
                  </h4>
                  
                  <div className="space-y-6">
                    {report.questions.map((q, qIdx) => (
                      <div key={qIdx} className="bg-slate-50/50 p-4 rounded-2xl border border-slate-200 text-xs font-bold text-slate-700 space-y-4 font-sans">
                        
                        {/* Grid Header line */}
                        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-100 pb-2">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-extrabold text-[#111] uppercase tracking-wide">
                              Question Number {q.qNo}
                            </span>
                            {q.isFlagged && (
                              <span className="px-2.5 py-0.5 bg-amber-100 border border-amber-300 text-amber-800 rounded-full text-[10px] uppercase font-black tracking-wider animate-pulse inline-flex items-center gap-1">
                                <Sparkles className="w-3 h-3 text-amber-500" /> Faculty Contradiction Flagged
                              </span>
                            )}
                          </div>
                          
                          <div className="flex items-center gap-2">
                            <span>Awarded:</span>
                            <input 
                              type="number" 
                              step="0.5"
                              value={q.marks} 
                              onChange={(e) => handleEditSingleQuestionMark(qIdx, parseFloat(e.target.value) || 0)}
                              className="bg-white border border-slate-200 rounded p-1.5 text-center w-16"
                            />
                            <span>/ Max:</span>
                            <input 
                              type="number" 
                              step="0.5"
                              value={q.maxMarks} 
                              onChange={(e) => handleEditSingleQuestionMaxMark(qIdx, parseFloat(e.target.value) || 0)}
                              className="bg-white border border-slate-200 rounded p-1.5 text-center w-16"
                            />
                          </div>
                        </div>

                        {/* Bullet list edit */}
                        <div className="space-y-2">
                          <label className="block text-[10px] uppercase text-slate-400 tracking-wider">Evaluation Bullet Points:</label>
                          {q.feedbackPoints.map((bullet, bIdx) => (
                            <div key={bIdx} className="flex gap-2">
                              <input 
                                type="text" 
                                value={bullet} 
                                onChange={(e) => handleEditSingleQuestionFeedbackBullet(qIdx, bIdx, e.target.value)}
                                className="w-full bg-white border border-slate-200 rounded p-2 text-xs text-slate-800 font-normal shadow-sm"
                              />
                              <button 
                                onClick={() => handleRemoveSingleQuestionFeedbackBullet(qIdx, bIdx)}
                                className="p-2 text-slate-300 hover:text-red-500 hover:bg-slate-100 rounded transition-colors cursor-pointer"
                                title="Delete Bullet"
                              >
                                <Trash className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          ))}
                          <button 
                            onClick={() => handleAddSingleQuestionFeedbackBullet(qIdx)}
                            className="pt-1.5 text-xs text-blue-600 hover:text-blue-800 hover:underline flex items-center gap-1 font-bold cursor-pointer inline-flex"
                          >
                            <Plus className="w-3.5 h-3.5" /> Append Feedback Line
                          </button>
                        </div>

                        {/* Audit explanation contradiction (Only if flagged) */}
                        <div>
                          <label className="block text-[10px] uppercase text-slate-400 tracking-wider mb-1">
                            Evaluator Discrepancy Resolution:
                          </label>
                          <textarea 
                            value={q.flaggedComment || ''}
                            placeholder="Optional description of contradiction or grading rationale..."
                            onChange={(e) => handleEditSingleQuestionFlaggedComment(qIdx, e.target.value)}
                            className="w-full bg-white border border-slate-200 rounded p-2 font-normal text-xs text-slate-800"
                            rows={2}
                          />
                        </div>

                      </div>
                    ))}
                  </div>
                </div>

                {/* General feedback paragraph list edits */}
                {report.generalFeedback && (
                  <div>
                    <h4 className="text-xs font-black text-slate-800 uppercase tracking-widest border-b pb-1.5 mb-4 font-sans">
                      General Summary Paragraphs
                    </h4>

                    <div className="grid md:grid-cols-2 gap-6">
                      {(Object.keys(report.generalFeedback) as Array<string>).map((field, fIdx) => {
                        const bullets = report.generalFeedback ? ((report.generalFeedback as any)[field] || []) : [];
                        
                        // Label map
                        const labelMap: Record<string, string> = {
                          overallPerformance: '1) Overall Performance',
                          mcqs: '2) MCQs Section',
                          contentAccuracy: '3) Content Accuracy',
                          completenessOfAnswers: '4) Completeness of Answers',
                          presentationDiagrams: '5) Presentation & Diagrams',
                          investigations: '6) Investigations Mapping',
                          attemptingQuestions: '7) Question Coverage',
                          actionPoints: '8) Action Points / Next Steps'
                        };

                        return (
                          <div key={fIdx} className="bg-slate-50/50 p-4 rounded-xl border border-slate-100 text-xs font-bold uppercase space-y-2 text-slate-700 font-sans">
                            <span className="text-[10px] text-slate-800 tracking-wider font-extrabold">{labelMap[field] || field}</span>
                            
                            <div className="space-y-1.5 pt-1">
                              {bullets.map((b: string, bIdx: number) => (
                                <div key={bIdx} className="flex gap-1.5">
                                  <input 
                                    type="text" 
                                    value={b} 
                                    onChange={(e) => handleEditSingleGeneralFeedbackBullet(field, bIdx, e.target.value)}
                                    className="w-full bg-white border border-slate-200 rounded p-1.5 text-xs text-slate-700 font-normal"
                                  />
                                  <button 
                                    onClick={() => handleRemoveSingleGeneralFeedbackBullet(field, bIdx)}
                                    className="p-1 text-slate-300 hover:text-red-500 rounded cursor-pointer"
                                  >
                                    <Trash className="w-3 h-3" />
                                  </button>
                                </div>
                              ))}
                              <button 
                                onClick={() => handleAddSingleGeneralFeedbackBullet(field)}
                                className="pt-1.5 text-[10px] text-blue-600 hover:underline flex items-center gap-0.5 lowercase font-black self-start cursor-pointer inline-flex"
                              >
                                <Plus className="w-3.5 h-3.5" /> add line
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

              </div>

              {/* Bottom Actions footer */}
              <div className="bg-slate-50 p-6 border-t border-slate-200 flex items-center justify-end gap-3 font-sans">
                <button 
                  onClick={() => setEditingSingleReport(null)}
                  className="px-5 py-2.5 bg-slate-200 hover:bg-slate-300 rounded-xl text-slate-700 text-xs font-bold cursor-pointer"
                >
                  Discard Corrections
                </button>
                <button 
                  onClick={handleApplySingleCorrections}
                  disabled={isExportingUnified}
                  className={`px-6 py-2.5 rounded-xl text-white text-xs font-extrabold flex items-center gap-1.5 cursor-pointer shadow-md transition-all ${
                    isExportingUnified 
                      ? 'bg-red-400 cursor-not-allowed' 
                      : 'bg-[#F93A2C] hover:bg-[#E5281B]'
                  }`}
                >
                  {isExportingUnified ? (
                    <>
                      <svg className="animate-spin h-3.5 w-3.5 text-white" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
                      <span>Compiling 4in1 Booklet...</span>
                    </>
                  ) : (
                    <>
                      <Check className="w-4 h-4" /> Apply & Download Updated PDF
                    </>
                  )}
                </button>
              </div>

            </div>
          </div>
        );
      })()}

      <footer className="max-w-4xl mx-auto px-4 pb-10 no-print">
        <div className="p-4 bg-slate-100 rounded-xl border border-slate-200 text-center">
          <p className="text-slate-500 text-xs font-medium">
            <span className="font-bold text-slate-700">NOTE:</span> Ensure the files are in pdf or docx format only and file size is strictly &lt;= 20mb
          </p>
        </div>
      </footer>

      {currentAnswerKey && (
        <AnswerKeyReviewModal
          isOpen={isReviewModalOpen}
          answerKey={currentAnswerKey}
          questionPaperFile={questionPaperFile}
          answerKeyFile={answerKeyFile}
          onClose={() => setIsReviewModalOpen(false)}
          onSave={async (updated) => {
            const saved = await updateAnswerKeyApi(updated.id, updated);
            setCurrentAnswerKey(saved);
          }}
          onApprove={async (keyId) => {
            const result = await approveAnswerKeyApi(keyId, "Approved by instructor");
            setCurrentAnswerKey(result.answerKey);
            setIsReviewModalOpen(false);
          }}
        />
      )}

    </div>
  );
};

export default App;
