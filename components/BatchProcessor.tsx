import React, { useState, useEffect, useRef } from 'react';
import { generateStructuredFeedback, parseActionableError, EvaluationMode } from '../services/geminiService';
import { EvaluationReport, FileData, QuestionFeedback, GeneralFeedbackSection, HistoryItem } from '../types';
import { fileToPdfBytes, mergePdfs, downloadBytes } from '../services/pdfMerger';
import { safeFileToBase64, safeFileToBytes } from '../services/fileUtils';
import { saveFilesToDB } from '../services/fileStorage';
import { saveReportToDB } from '../services/reportStorage';
import FeedbackReport from './FeedbackReport';
import { extractStudentNameFromFile } from '../services/filenameParser';
import { generateEvaluationPdf } from '../services/evaluationPdf';
// @ts-ignore
import mammoth from 'mammoth';
// @ts-ignore
import * as pdfjsLib from 'pdfjs-dist';
// @ts-ignore
import pdfjsWorker from 'pdfjs-dist/build/pdf.worker.mjs?url';
import { 
  Upload, 
  FileText, 
  CheckCircle, 
  Clock, 
  AlertCircle, 
  Edit3, 
  Trash2, 
  Play, 
  Pause, 
  Settings, 
  ArrowRight, 
  Sparkles, 
  Download, 
  Check, 
  Plus, 
  Trash,
  Sliders,
  SkipForward,
  RotateCcw,
  X,
  ArrowUp,
  ArrowDown,
  GripVertical,
  ChevronLeft,
  ChevronRight
} from 'lucide-react';

const pdfjs: any = pdfjsLib;

if (pdfjs && pdfjs.GlobalWorkerOptions) {
  pdfjs.GlobalWorkerOptions.workerSrc = pdfjsWorker;
}

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

interface QueueItem {
  id: string;
  file: File;
  studentName: string;
  status: 'pending' | 'extracting' | 'evaluating' | 'merging' | 'completed' | 'failed';
  countdown: number; // seconds remaining before processing
  targetTimestamp?: number; // target completion timestamp to counter browser tab suspension
  report: EvaluationReport | null;
  mergedPdfBytes: Uint8Array | null;
  reportOnlyPdfBytes?: Uint8Array | null;
  error?: string;
  fileNameFormatted?: string;
  questionPaperFile?: File | null;
  answerKeyFile?: File | null;
  queueGroupId: string; // The group this student script belongs to
  cachedBase64?: string; // Pre-cached in-memory base64 to eliminate stale file handles
  cachedPdfBytes?: Uint8Array; // Pre-cached in-memory PDF bytes
}

interface QueueGroup {
  id: string;
  name: string;
  questionPaperFile: File | null;
  answerKeyFile: File | null;
}

interface BatchProcessorProps {
  onBack: () => void;
  onAddHistoryItem: (report: EvaluationReport) => void;
  history?: HistoryItem[];
}

const BatchProcessor: React.FC<BatchProcessorProps> = ({ onBack, onAddHistoryItem, history = [] }) => {
  // Queue Groups State
  const [queueGroups, setQueueGroups] = useState<QueueGroup[]>([
    { id: 'group-1', name: 'Queue Batch 1', questionPaperFile: null, answerKeyFile: null }
  ]);
  const [activeGroupId, setActiveGroupId] = useState<string>('group-1');
  const tabsContainerRef = useRef<HTMLDivElement>(null);

  // Auto-scroll active queue tab into view when activeGroupId changes
  useEffect(() => {
    if (tabsContainerRef.current) {
      const activeEl = tabsContainerRef.current.querySelector(`[data-group-id="${activeGroupId}"]`) as HTMLElement;
      if (activeEl) {
        activeEl.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
      }
    }
  }, [activeGroupId]);

  const scrollTabs = (direction: 'left' | 'right') => {
    if (tabsContainerRef.current) {
      const scrollAmount = direction === 'left' ? -260 : 260;
      tabsContainerRef.current.scrollBy({ left: scrollAmount, behavior: 'smooth' });
    }
  };

  // Active group derived files helper
  const activeGroup = queueGroups.find(g => g.id === activeGroupId) || queueGroups[0];
  const questionPaperFile = activeGroup ? activeGroup.questionPaperFile : null;
  const answerKeyFile = activeGroup ? activeGroup.answerKeyFile : null;

  const setQuestionPaperFile = (file: File | null | ((prev: File | null) => File | null)) => {
    setQueueGroups(prev => prev.map(g => {
      if (g.id === activeGroupId) {
        const newFile = typeof file === 'function' ? file(g.questionPaperFile) : file;
        return { ...g, questionPaperFile: newFile };
      }
      return g;
    }));
  };

  const setAnswerKeyFile = (file: File | null | ((prev: File | null) => File | null)) => {
    setQueueGroups(prev => prev.map(g => {
      if (g.id === activeGroupId) {
        const newFile = typeof file === 'function' ? file(g.answerKeyFile) : file;
        return { ...g, answerKeyFile: newFile };
      }
      return g;
    }));
  };

  // Input Files States
  const [studentFiles, setStudentFiles] = useState<File[]>([]);

  // Queue State
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [isBatchRunning, setIsBatchRunning] = useState(false);
  const [currentQueueIndex, setCurrentQueueIndex] = useState<number>(-1);
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);

  // Configurations
  const [delayMinutes, setDelayMinutes] = useState<number>(15);
  const [namingPattern, setNamingPattern] = useState<string>('{student}_Anatomy_Guru_Report.pdf');
  const [evalMode, setEvalMode] = useState<EvaluationMode>('without-manual');
  
  // UI Panels
  const [showConfig, setShowConfig] = useState(false);
  const [editingItem, setEditingItem] = useState<QueueItem | null>(null);
  const [reportForCapture, setReportForCapture] = useState<EvaluationReport | null>(null);
  const [isCapturing, setIsCapturing] = useState(false);

  // Logs & Statuses
  const [currentActionLog, setCurrentActionLog] = useState<string>('');
  const [wasPausedManually, setWasPausedManually] = useState(false);
  const [hasActiveCycleStarted, setHasActiveCycleStarted] = useState(false);

  // Keep queueRef in sync with queue state to resolve async state stagnation
  const queueRef = useRef<QueueItem[]>(queue);
  useEffect(() => {
    queueRef.current = queue;
  }, [queue]);

  // Timer Ref for countdown intervals
  const intervalRef = useRef<NodeJS.Timeout | null>(null);

  // Automatically load queue when student files are selected
  useEffect(() => {
    if (studentFiles.length > 0) {
      setWasPausedManually(false); // Clear manual pause state when new files are added
      const newItems: QueueItem[] = studentFiles.map((file) => {
        const cleanName = extractStudentNameFromFile(file.name);
        
        return {
          id: crypto.randomUUID(),
          file,
          studentName: cleanName,
          status: 'pending',
          countdown: 0,
          report: null,
          mergedPdfBytes: null,
          questionPaperFile: questionPaperFile,
          answerKeyFile: answerKeyFile,
          queueGroupId: activeGroupId
        };
      });
      setQueue((prev) => {
        // Filter duplicates based on file size and name
        const filtered = newItems.filter(
          item => !prev.some(p => p.file.name === item.file.name && p.file.size === item.file.size)
        );
        return [...prev, ...filtered];
      });

      // Eagerly pre-cache in-memory base64 and bytes while OS file descriptors are fresh
      newItems.forEach((item) => {
        safeFileToBase64(item.file).then((b64) => {
          setQueue((prev) => prev.map((q) => (q.id === item.id ? { ...q, cachedBase64: b64 } : q)));
        }).catch((err) => {
          console.warn(`[BatchProcessor] Pre-caching base64 failed for ${item.studentName}:`, err);
        });

        safeFileToBytes(item.file).then((bytes) => {
          setQueue((prev) => prev.map((q) => (q.id === item.id ? { ...q, cachedPdfBytes: bytes } : q)));
        }).catch((err) => {
          console.warn(`[BatchProcessor] Pre-caching bytes failed for ${item.studentName}:`, err);
        });
      });

      setStudentFiles([]); // Clear raw upload files state
    }
  }, [studentFiles, questionPaperFile, answerKeyFile, activeGroupId]);

  // Update pending queue items if the question paper file is changed globally before/outside active batch runs
  useEffect(() => {
    if (!isBatchRunning) {
      setQueue((prevQueue) =>
        prevQueue.map((item) =>
          item.status === 'pending' && item.queueGroupId === activeGroupId
            ? { ...item, questionPaperFile: questionPaperFile }
            : item
        )
      );
    }
  }, [questionPaperFile, isBatchRunning, activeGroupId]);

  // Update pending queue items if the answer key file is changed globally before/outside active batch runs
  useEffect(() => {
    if (!isBatchRunning) {
      setQueue((prevQueue) =>
        prevQueue.map((item) =>
          item.status === 'pending' && item.queueGroupId === activeGroupId
            ? { ...item, answerKeyFile: answerKeyFile }
            : item
        )
      );
    }
  }, [answerKeyFile, isBatchRunning, activeGroupId]);

  // Clean timer on unmount
  useEffect(() => {
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  // Automated queue continuation / auto-starting for newly added items or next batches
  useEffect(() => {
    if (!isBatchRunning && hasActiveCycleStarted) {
      const firstPendingIdx = queue.findIndex(item => item.status === 'pending');
      
      if (firstPendingIdx !== -1) {
        setIsBatchRunning(true);
        setWasPausedManually(false);
        const countdownSecs = delayMinutes * 60;
        
        if (countdownSecs === 0) {
          setQueue(prev => prev.map((q, idx) => 
            idx === firstPendingIdx ? { ...q, countdown: 0, targetTimestamp: undefined } : q
          ));
          setCurrentQueueIndex(firstPendingIdx);
          const nextItem = queue[firstPendingIdx];
          if (nextItem && nextItem.queueGroupId && nextItem.queueGroupId !== activeGroupId) {
            setActiveGroupId(nextItem.queueGroupId);
          }
          setCurrentActionLog(`Auto-resuming valuation cycle. Processing ${nextItem?.studentName || 'next student'} immediately...`);
          setTimeout(() => {
            processQueueItem(firstPendingIdx);
          }, 50);
        } else {
          setQueue(prev => prev.map((q, idx) => 
            idx === firstPendingIdx ? { ...q, countdown: countdownSecs, targetTimestamp: Date.now() + countdownSecs * 1000 } : q
          ));
          setCurrentQueueIndex(firstPendingIdx);
          const nextItem = queue[firstPendingIdx];
          if (nextItem && nextItem.queueGroupId && nextItem.queueGroupId !== activeGroupId) {
            setActiveGroupId(nextItem.queueGroupId);
          }
          setCurrentActionLog(`Auto-resuming valuation cycle. Countdown started. Waiting ${delayMinutes} minutes before initiating next student.`);
        }
      }
    }
  }, [queue, isBatchRunning, hasActiveCycleStarted, delayMinutes, activeGroupId]);

  // Heartbeat countdown tick for the queue (Worker-powered for perfect background execution!)
  useEffect(() => {
    let worker: Worker | null = null;

    if (isBatchRunning) {
      const workerCode = `
        let timer = null;
        self.onmessage = function(e) {
          if (e.data.action === "start") {
            if (timer) clearInterval(timer);
            timer = setInterval(() => {
              self.postMessage({ action: "tick" });
            }, 1000);
          } else if (e.data.action === "stop") {
            if (timer) clearInterval(timer);
            timer = null;
          }
        };
      `;
      const blob = new Blob([workerCode], { type: "application/javascript" });
      const workerUrl = URL.createObjectURL(blob);
      worker = new Worker(workerUrl);

      worker.onmessage = () => {
        setQueue((prevQueue) => {
          let triggeredIdx: number | null = null;
          
          const updated = prevQueue.map((item, idx) => {
            // Force reset non-pending items to zero countdown to prevent any random timers on completed/evaluating items
            if (item.status !== "pending") {
              return { 
                ...item, 
                countdown: 0, 
                targetTimestamp: undefined 
              };
            }

            if (idx === currentQueueIndex && item.status === "pending") {
              const targetTime = item.targetTimestamp || (Date.now() + item.countdown * 1000);
              const now = Date.now();
              const nextCountdown = Math.max(0, Math.ceil((targetTime - now) / 1000));
              
              // Only trigger if it was counting down from a positive value and hits 0
              const isTriggeringNow = item.countdown > 0 && nextCountdown === 0;
              if (isTriggeringNow) {
                triggeredIdx = idx;
                // Transition status to extracting immediately in state to prevent duplicates in next tick
                return {
                  ...item,
                  status: 'extracting' as const,
                  countdown: 0,
                  targetTimestamp: undefined
                };
              }
              
              return { 
                ...item, 
                countdown: nextCountdown,
                targetTimestamp: targetTime
              };
            }
            return item;
          });

          if (triggeredIdx !== null) {
            const idxToTrigger = triggeredIdx;
            setTimeout(() => processQueueItem(idxToTrigger), 10);
          }

          return updated;
        });
      };

      worker.postMessage({ action: "start" });
    }

    return () => {
      if (worker) {
        worker.postMessage({ action: "stop" });
        worker.terminate();
      }
    };
  }, [isBatchRunning, currentQueueIndex]);

  // Read / extract PDF text helper
  const extractTextFromPDF = async (file: File): Promise<string> => {
    if (!pdfjs || !pdfjs.getDocument) {
      throw new Error("PDF processing library not initialized.");
    }
    const bytes = await safeFileToBytes(file);
    const loadingTask = pdfjs.getDocument({ data: bytes });
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

  // Convert File to FileData for Gemini
  const processFileToText = async (file: File): Promise<string> => {
    const fileName = file.name.toLowerCase();
    const isDocx = fileName.endsWith('.docx') || file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    const isPdf = fileName.endsWith('.pdf') || file.type === 'application/pdf';
    
    if (isDocx) {
      const bytes = await safeFileToBytes(file);
      const result = await mammoth.extractRawText({ arrayBuffer: bytes.buffer as ArrayBuffer });
      return result.value;
    } 
    
    if (isPdf) {
      try {
        return await extractTextFromPDF(file);
      } catch (e) {
        console.warn("Text extraction failed, fallback to native parsing", e);
        return "";
      }
    }

    return `Image evaluation required for visual pages: ${file.name}`;
  };

  // Compile individual evaluation report to native vector PDF bytes using Anatomy Guru native generator
  const renderReportToPdfBytes = async (report: EvaluationReport): Promise<Uint8Array> => {
    setCurrentActionLog("Generating native Anatomy Guru Evaluation Report PDF...");
    return await generateEvaluationPdf(report);
  };

  // Check and automatically cleanup completed/failed reference files if no other active item needs them - DISABLED to preserve reference files for editing, corrections, and subsequent scripts in the same group.
  const checkAndCleanupReferenceFiles = (completedItem: QueueItem) => {
    console.log("Preserving reference files for group of completed item to ensure correction downloads and future sets function correctly:", completedItem.studentName);
  };

  // Perform core sequential queue operations
  const processQueueItem = async (index: number) => {
    if (index >= queueRef.current.length) {
      // Loop ends
      setIsBatchRunning(false);
      setCurrentQueueIndex(-1);
      setCurrentActionLog("Batch pipeline valuation cycle fully completed!");
      return;
    }

    const item = queueRef.current[index];
    if (item.status === 'completed') {
      // Already processed, jump to next with custom countdown
      evaluateNextWithDelay(index + 1);
      return;
    }

    console.log(`Processing queue index ${index}: ${item.studentName}`);
    setCurrentQueueIndex(index);

    // Auto-switch UI group tab to match the active student script being processed
    if (item.queueGroupId && item.queueGroupId !== activeGroupId) {
      setActiveGroupId(item.queueGroupId);
    }

    updateQueueItemStatus(item.id, 'extracting');
    setCurrentActionLog(`Extracting Student: ${item.studentName}...`);

    // Dynamically look up current question paper and answer key from the item's queue group state (with item-level fallback)
    const currentGroup = queueGroups.find(g => g.id === item.queueGroupId);
    const activeQP = (currentGroup && currentGroup.questionPaperFile) ? currentGroup.questionPaperFile : (item.questionPaperFile || null);
    const activeAK = (currentGroup && currentGroup.answerKeyFile) ? currentGroup.answerKeyFile : (item.answerKeyFile || null);

    try {
      // 1. Extract content from Student Answers Script
      const studentText = await processFileToText(item.file);
      
      // 2. Extract shared resources: Question Paper & Answer Key
      setCurrentActionLog(`Reading Question Paper and Answer Key...`);
      let qpPayload: FileData | null = null;
      let akPayload: FileData | null = null;
      
      if (activeQP) {
        const qpText = await processFileToText(activeQP);
        qpPayload = {
          name: activeQP.name,
          text: qpText,
          mimeType: activeQP.type || 'application/pdf',
          isDocx: false,
        };
      }
      if (activeAK) {
        const akText = await processFileToText(activeAK);
        akPayload = {
          name: activeAK.name,
          text: akText,
          mimeType: activeAK.type || 'application/pdf',
          isDocx: false,
        };
      }

      // Convert student's actual file to base64 for multimodal analysis (prioritize cached buffer to eliminate stale file handles)
      const studentBase64 = item.cachedBase64 || await safeFileToBase64(item.file);
      if (!item.cachedBase64) {
        item.cachedBase64 = studentBase64;
      }

      const sourceDocPayload: FileData = {
        text: studentText,
        base64: studentBase64,
        mimeType: item.file.type || 'application/pdf',
        name: item.file.name,
        isDocx: false
      };

      // 4. Send to Valuation Service
      updateQueueItemStatus(item.id, 'evaluating');
      setCurrentActionLog(`Running AI Evaluation for ${item.studentName}...`);
      
      const result = await generateStructuredFeedback(
        sourceDocPayload, 
        null, 
        evalMode,
        (percent, msg) => {
          setCurrentActionLog(`[${percent}%] ${item.studentName}: ${msg}`);
        },
        qpPayload,
        akPayload
      );
      
      const enrichedResult: EvaluationReport = {
        ...result,
        studentName: item.studentName, // Enforce current script name
        id: crypto.randomUUID(),
        timestamp: Date.now()
      };

      // 5. Generate cover evaluation report PDF bytes
      updateQueueItemStatus(item.id, 'merging');
      const coverReportPdfBytes = await renderReportToPdfBytes(enrichedResult);

      // 6. Gather and convert other physical documents to PDF bytes for merging
      setCurrentActionLog(`Assembling 4-in-1 PDF pages...`);
      
      const studentPdfBytes = item.cachedPdfBytes || await fileToPdfBytes(item.file);
      if (!item.cachedPdfBytes) {
        item.cachedPdfBytes = studentPdfBytes;
      }
      const qpPdfBytes = activeQP ? await fileToPdfBytes(activeQP) : null;
      const akPdfBytes = activeAK ? await fileToPdfBytes(activeAK) : null;

      // Prepare list to merge in 4-in-1 style
      const mergePdfsList: Uint8Array[] = [coverReportPdfBytes];
      if (qpPdfBytes) mergePdfsList.push(qpPdfBytes);
      if (akPdfBytes) mergePdfsList.push(akPdfBytes);
      if (studentPdfBytes) mergePdfsList.push(studentPdfBytes);

      // Trigger 4-in-1 consolidated creation
      const valuationMergedBytes = await mergePdfs(mergePdfsList);

      // Formulate custom naming string
      const formattedStudentName = (item.studentName || 'Student').trim().replace(/\s+/g, '_');

      const cleanQPName = activeQP 
        ? activeQP.name.replace(/\.[^/.]+$/, "") 
        : "Question_Paper";

      const formattedName = `${formattedStudentName}_${cleanQPName}.pdf`;

      // 7. Auto Download File
      // Directly download the 4-in-1 PDF booklet
      setCurrentActionLog(`Downloading completed 4-in-1 evaluation sheet booklet...`);
      downloadBytes(valuationMergedBytes, formattedName);

      // Update item complete
      setQueue((prevQueue) =>
        prevQueue.map((q) =>
          q.id === item.id
            ? {
                ...q,
                status: 'completed',
                report: enrichedResult,
                mergedPdfBytes: valuationMergedBytes,
                reportOnlyPdfBytes: coverReportPdfBytes,
                fileNameFormatted: formattedName,
                questionPaperFile: activeQP,
                answerKeyFile: activeAK
              }
            : q
        )
      );

      // Sync with global audit history (non-fatal catch to ensure batch queue never halts on DB errors)
      if (enrichedResult.id) {
        try {
          await saveFilesToDB(enrichedResult.id, item.file, activeQP, activeAK);
        } catch (dbErr) {
          console.warn('[BatchProcessor] Failed saving files to DB cache (non-fatal):', dbErr);
        }
      }
      try {
        await saveReportToDB(enrichedResult);
      } catch (dbReportErr) {
        console.warn('[BatchProcessor] Failed saving report to DB cache (non-fatal):', dbReportErr);
      }
      onAddHistoryItem(enrichedResult);

      // Clean up completed reference files if no other active item needs them
      checkAndCleanupReferenceFiles(item);

      // 8. Jump to the next element with 15-minute countdown interval
      evaluateNextWithDelay(index + 1);

    } catch (err: any) {
      const parsedError = parseActionableError(err);
      
      console.error(`[NextGen Eval Batch Evaluation Failure] BatchGroup: ${item.queueGroupId || 'default'} | ScriptID: ${item.id} | Student: ${item.studentName}`, {
        category: parsedError.category,
        actionableMessage: parsedError.message,
        statusCode: parsedError.statusCode,
        rawError: err,
        stack: err?.stack || new Error().stack,
        lastAttemptedModel: (err as any)?.lastAttemptedModel,
        timestamp: new Date().toISOString()
      });

      const displayError = `${parsedError.category}: ${parsedError.message}`;

      setQueue((prevQueue) =>
        prevQueue.map((q) =>
          q.id === item.id
            ? {
                ...q,
                status: 'failed',
                error: displayError
              }
            : q
        )
      );

      // Clean up failed reference files if no other active item needs them
      checkAndCleanupReferenceFiles(item);

      // Wait briefly, then move to next
      evaluateNextWithDelay(index + 1);
    }
  };

  // Queues up the delay countdown before moving on to the next file
  const evaluateNextWithDelay = (nextIndex: number) => {
    if (nextIndex < queueRef.current.length) {
      const countdownSecs = delayMinutes * 60;
      const nextItem = queueRef.current[nextIndex];

      if (countdownSecs === 0) {
        // Instant evaluation (0 delay configuration)
        setQueue((prevQueue) =>
          prevQueue.map((q, idx) => {
            if (idx === nextIndex) {
              return { 
                ...q, 
                countdown: 0, 
                targetTimestamp: undefined 
              };
            }
            if (q.status !== 'pending') {
              return { ...q, countdown: 0, targetTimestamp: undefined };
            }
            return q;
          })
        );
        setCurrentQueueIndex(nextIndex);
        if (nextItem && nextItem.queueGroupId && nextItem.queueGroupId !== activeGroupId) {
          setActiveGroupId(nextItem.queueGroupId);
        }
        setCurrentActionLog(`Direct transition. Initializing processing for ${nextItem.studentName} immediately...`);
        setTimeout(() => {
          processQueueItem(nextIndex);
        }, 50);
      } else {
        // Scheduled delay countdown
        setQueue((prevQueue) =>
          prevQueue.map((q, idx) => {
            if (idx === nextIndex) {
              return { 
                ...q, 
                countdown: countdownSecs, 
                targetTimestamp: Date.now() + countdownSecs * 1000 
              };
            }
            if (q.status !== 'pending') {
              return { ...q, countdown: 0, targetTimestamp: undefined };
            }
            return q;
          })
        );
        setCurrentQueueIndex(nextIndex);
        if (nextItem && nextItem.queueGroupId && nextItem.queueGroupId !== activeGroupId) {
          setActiveGroupId(nextItem.queueGroupId);
        }
        setCurrentActionLog(`Countdown started. Waiting ${delayMinutes} Minutes before initiating next student.`);
      }
    } else {
      setIsBatchRunning(false);
      setCurrentQueueIndex(-1);
      setCurrentActionLog("Batch pipeline valuation cycle completed successfully.");
    }
  };

  // Helper when an active queue item gets removed, triggering the next item or completing the loop
  const evaluateNextAfterRemoval = (nextIndex: number, currentQueueState: QueueItem[]) => {
    if (nextIndex < currentQueueState.length) {
      const countdownSecs = delayMinutes * 60;
      const nextItem = currentQueueState[nextIndex];

      if (countdownSecs === 0) {
        // Instant evaluation (0 delay configuration) after removal
        setQueue((prevQueue) =>
          prevQueue.map((q, idx) => {
            if (idx === nextIndex) {
              return { 
                ...q, 
                countdown: 0, 
                targetTimestamp: undefined 
              };
            }
            if (q.status !== 'pending') {
              return { ...q, countdown: 0, targetTimestamp: undefined };
            }
            return q;
          })
        );
        setCurrentQueueIndex(nextIndex);
        if (nextItem && nextItem.queueGroupId && nextItem.queueGroupId !== activeGroupId) {
          setActiveGroupId(nextItem.queueGroupId);
        }
        setCurrentActionLog(`An item was removed. Transitioning to processing for ${nextItem?.studentName} immediately...`);
        setTimeout(() => {
          processQueueItem(nextIndex);
        }, 50);
      } else {
        // Scheduled delay countdown after removal
        setQueue((prevQueue) =>
          prevQueue.map((q, idx) => {
            if (idx === nextIndex) {
              return { 
                ...q, 
                countdown: countdownSecs, 
                targetTimestamp: Date.now() + countdownSecs * 1000 
              };
            }
            if (q.status !== 'pending') {
              return { ...q, countdown: 0, targetTimestamp: undefined };
            }
            return q;
          })
        );
        setCurrentQueueIndex(nextIndex);
        if (nextItem && nextItem.queueGroupId && nextItem.queueGroupId !== activeGroupId) {
          setActiveGroupId(nextItem.queueGroupId);
        }
        setCurrentActionLog(`An item was removed. Countdown started for the next item. Waiting ${delayMinutes} minutes before grading next student.`);
      }
    } else {
      setIsBatchRunning(false);
      setCurrentQueueIndex(-1);
      setCurrentActionLog("Batch pipeline completed.");
    }
  };

  // Change queue element status
  const updateQueueItemStatus = (id: string, status: QueueItem['status']) => {
    setQueue((prevQueue) =>
      prevQueue.map((item) => (item.id === id ? { ...item, status } : item))
    );
  };

  // Core controller buttons
  const handleStartBatch = () => {
    if (queue.length === 0) return;
    setIsBatchRunning(true);
    setWasPausedManually(false);
    setHasActiveCycleStarted(true);
    
    // Find first unfinished queue index
    const firstPendingIdx = queue.findIndex(item => item.status !== 'completed');
    if (firstPendingIdx !== -1) {
      const item = queue[firstPendingIdx];
      if (item.status === 'pending' && item.countdown > 0) {
        // If there's an active remaining countdown, resume it beautifully as a real-time countdown!
        setQueue(prev => prev.map((q, idx) => 
          idx === firstPendingIdx ? { ...q, targetTimestamp: Date.now() + q.countdown * 1000 } : q
        ));
        setCurrentQueueIndex(firstPendingIdx);
        setCurrentActionLog(`Resuming countdown. Waiting ${formatTime(item.countdown)} remaining...`);
      } else {
        // Strip any running countdowns immediately on manual force start
        setQueue(prev => prev.map((q, idx) => idx === firstPendingIdx ? { ...q, countdown: 0, targetTimestamp: undefined } : q));
        processQueueItem(firstPendingIdx);
      }
    } else {
      setIsBatchRunning(false);
      setCurrentActionLog("All student items are already successfully evaluated.");
    }
  };

  const handlePauseBatch = () => {
    setIsBatchRunning(false);
    setWasPausedManually(true);
    setCurrentActionLog("Valuation pipeline paused. Countdown halted.");
  };

  const handleSkipDelay = (index: number) => {
    // Strip countdown and trigger immediately. Transition status to 'extracting' immediately to prevent worker race.
    setQueue(prev => prev.map((q, idx) => idx === index ? { ...q, status: 'extracting' as const, countdown: 0, targetTimestamp: undefined } : q));
    processQueueItem(index);
  };

  const handleClearQueue = () => {
    setQueue(prev => prev.filter(item => item.queueGroupId !== activeGroupId));
    setIsBatchRunning(false);
    setHasActiveCycleStarted(false);
    setCurrentQueueIndex(-1);
    setCurrentActionLog("Reset current batch queue and uploaded student sheets.");
  };

  const handleUpdateGroupName = (groupId: string, newName: string) => {
    setQueueGroups(prev => prev.map(g => g.id === groupId ? { ...g, name: newName } : g));
  };

  const handleRemoveGroup = (groupId: string) => {
    const targetGroup = queueGroups.find(g => g.id === groupId);
    const targetName = targetGroup?.name || 'Queue';

    if (queueGroups.length <= 1) {
      // If only one group remains, reset it to an empty default queue instead of blocking
      setQueueGroups([{
        id: crypto.randomUUID(),
        name: 'Queue Batch 1',
        questionPaperFile: null,
        answerKeyFile: null
      }]);
      setQueue(prev => prev.filter(item => item.queueGroupId !== groupId));
      setCurrentActionLog(`Reset ${targetName} to a fresh queue.`);
      return;
    }

    // 1. Filter out the group
    const remaining = queueGroups.filter(g => g.id !== groupId);
    setQueueGroups(remaining);

    // 2. Filter out its items from global queue
    setQueue(prev => prev.filter(item => item.queueGroupId !== groupId));
    
    // 3. Switch active group to a remaining one if active is deleted
    if (activeGroupId === groupId) {
      setActiveGroupId(remaining[0].id);
    }

    setCurrentActionLog(`Deleted ${targetName}.`);
  };

  const handleRemoveItem = (id: string) => {
    setQueue((prevQueue) => {
      const targetIdx = prevQueue.findIndex((item) => item.id === id);
      if (targetIdx === -1) return prevQueue;

      const isRemovingActive = isBatchRunning && targetIdx === currentQueueIndex;

      // Filter out the item
      const newQueue = prevQueue.filter((item) => item.id !== id);

      if (isRemovingActive) {
        // The active item is being removed!
        // Transition to the next item or end the batch.
        // The next item in the newQueue is now at the same index `targetIdx`.
        if (targetIdx < newQueue.length) {
          setTimeout(() => {
            evaluateNextAfterRemoval(targetIdx, newQueue);
          }, 0);
        } else {
          setIsBatchRunning(false);
          setCurrentQueueIndex(-1);
          setCurrentActionLog("Batch pipeline completed after removing the final item.");
        }
      } else if (isBatchRunning && targetIdx < currentQueueIndex) {
        // If we removed an item BEFORE the currentQueueIndex, the active index shifts left by 1
        setCurrentQueueIndex((prev) => Math.max(0, prev - 1));
      }

      return newQueue;
    });
  };

  const handleUpdateStudentName = (id: string, newName: string) => {
    setQueue(prev => prev.map(item => item.id === id ? { ...item, studentName: newName } : item));
  };

  // Move queue item up or down manually
  const moveQueueItem = (idx: number, direction: 'up' | 'down') => {
    if (direction === 'up' && idx === 0) return;
    if (direction === 'down' && idx === queue.length - 1) return;
    const targetIdx = direction === 'up' ? idx - 1 : idx + 1;

    setQueue((prev) => {
      const copy = [...prev];
      const temp = copy[idx];
      copy[idx] = copy[targetIdx];
      copy[targetIdx] = temp;
      return copy;
    });

    if (isBatchRunning) {
      if (currentQueueIndex === idx) {
        setCurrentQueueIndex(targetIdx);
      } else if (currentQueueIndex === targetIdx) {
        setCurrentQueueIndex(idx);
      }
    }
  };

  // Drag-and-drop mechanics
  const handleDragStart = (e: React.DragEvent, index: number) => {
    if (isBatchRunning && index === currentQueueIndex) {
      e.preventDefault();
      return;
    }
    setDraggedIndex(index);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', index.toString());
  };

  const handleDragOver = (e: React.DragEvent, index: number) => {
    e.preventDefault();
  };

  const handleDrop = (e: React.DragEvent, targetIndex: number) => {
    e.preventDefault();
    if (draggedIndex === null || draggedIndex === targetIndex) return;

    setQueue((prev) => {
      const copy = [...prev];
      const [draggedItem] = copy.splice(draggedIndex, 1);
      copy.splice(targetIndex, 0, draggedItem);
      return copy;
    });

    if (isBatchRunning && currentQueueIndex !== -1) {
      if (currentQueueIndex === draggedIndex) {
        setCurrentQueueIndex(targetIndex);
      } else if (draggedIndex < currentQueueIndex && targetIndex >= currentQueueIndex) {
        setCurrentQueueIndex(prev => prev - 1);
      } else if (draggedIndex > currentQueueIndex && targetIndex <= currentQueueIndex) {
        setCurrentQueueIndex(prev => prev + 1);
      }
    }

    setDraggedIndex(null);
  };

  const handleDragEnd = () => {
    setDraggedIndex(null);
  };

  // Re-merges 4-in-1 PDF with corrected evaluation report on the fly
  const handleApplyCorrections = async () => {
    if (!editingItem || !editingItem.report) return;
    
    try {
      setCurrentActionLog(`Saving changes and updating PDF for ${editingItem.studentName}...`);
      
      const updatedReport = { ...editingItem.report };
      // Force mathematical sum check on save
      updatedReport.totalScore = updatedReport.questions?.reduce((acc: number, q: any) => acc + (Number(q.marks) || 0), 0) || 0;

      // 1. Re-render cover sheet
      const coverReportPdfBytes = await renderReportToPdfBytes(updatedReport);

      const currentGroup = queueGroups.find(g => g.id === editingItem.queueGroupId);
      const activeQP = (currentGroup && currentGroup.questionPaperFile) ? currentGroup.questionPaperFile : (editingItem.questionPaperFile || null);
      const activeAK = (currentGroup && currentGroup.answerKeyFile) ? currentGroup.answerKeyFile : (editingItem.answerKeyFile || null);

      // 2. Re-acquire separate details
      const studentPdfBytes = await fileToPdfBytes(editingItem.file);
      const qpPdfBytes = activeQP ? await fileToPdfBytes(activeQP) : null;
      const akPdfBytes = activeAK ? await fileToPdfBytes(activeAK) : null;

      // Assemble list to merge
      const mergePdfsList: Uint8Array[] = [coverReportPdfBytes];
      if (qpPdfBytes) mergePdfsList.push(qpPdfBytes);
      if (akPdfBytes) mergePdfsList.push(akPdfBytes);
      if (studentPdfBytes) mergePdfsList.push(studentPdfBytes);

      const valuationMergedBytes = await mergePdfs(mergePdfsList);

      // Keep original formatted file name if it exists, preventing any name changes during edits
      const formattedName = editingItem.fileNameFormatted || (() => {
        const formattedStudentName = (editingItem.studentName || 'Student').trim().replace(/\s+/g, '_');
        const cleanQPName = activeQP 
          ? activeQP.name.replace(/\.[^/.]+$/, "") 
          : "Question_Paper";
        return `${formattedStudentName}_${cleanQPName}.pdf`;
      })();

      // Set changes into queue list
      setQueue(prevQueue => prevQueue.map(q => {
        if (q.id === editingItem.id) {
          return {
            ...q,
            studentName: editingItem.studentName,
            report: updatedReport,
            mergedPdfBytes: valuationMergedBytes,
            reportOnlyPdfBytes: coverReportPdfBytes,
            fileNameFormatted: formattedName,
            questionPaperFile: activeQP,
            answerKeyFile: activeAK
          };
        }
        return q;
      }));

      // Directly auto-download corrected version of 4-in-1 PDF booklet too
      downloadBytes(valuationMergedBytes, formattedName);

      // Clear correction editing overlay
      setEditingItem(null);
      setCurrentActionLog(`Corrections applied and downloaded successfully: ${formattedName}`);

    } catch (err: any) {
      alert(`Correction pipeline exception: ${err.message || 'Error compiling updated PDF'}`);
    }
  };

  // Editorial desk input handles
  const handleEditQuestionMark = (qIdx: number, val: number) => {
    if (!editingItem || !editingItem.report) return;
    const nextQuestions = [...editingItem.report.questions];
    nextQuestions[qIdx] = { ...nextQuestions[qIdx], marks: Number(val) };
    
    setEditingItem({
      ...editingItem,
      report: {
        ...editingItem.report,
        questions: nextQuestions
      }
    });
  };

  const handleEditQuestionMaxMark = (qIdx: number, val: number) => {
    if (!editingItem || !editingItem.report) return;
    const nextQuestions = [...editingItem.report.questions];
    nextQuestions[qIdx] = { ...nextQuestions[qIdx], maxMarks: Number(val) };
    
    setEditingItem({
      ...editingItem,
      report: {
        ...editingItem.report,
        questions: nextQuestions
      }
    });
  };

  const handleEditQuestionFeedbackBullet = (qIdx: number, bulletIdx: number, val: string) => {
    if (!editingItem || !editingItem.report) return;
    const nextQuestions = [...editingItem.report.questions];
    const bulletArray = [...nextQuestions[qIdx].feedbackPoints];
    bulletArray[bulletIdx] = val;
    nextQuestions[qIdx] = { ...nextQuestions[qIdx], feedbackPoints: bulletArray };
    
    setEditingItem({
      ...editingItem,
      report: {
        ...editingItem.report,
        questions: nextQuestions
      }
    });
  };

  const handleAddQuestionFeedbackBullet = (qIdx: number) => {
    if (!editingItem || !editingItem.report) return;
    const nextQuestions = [...editingItem.report.questions];
    nextQuestions[qIdx] = { 
      ...nextQuestions[qIdx], 
      feedbackPoints: [...nextQuestions[qIdx].feedbackPoints, ''] 
    };
    
    setEditingItem({
      ...editingItem,
      report: {
        ...editingItem.report,
        questions: nextQuestions
      }
    });
  };

  const handleRemoveQuestionFeedbackBullet = (qIdx: number, bulletIdx: number) => {
    if (!editingItem || !editingItem.report) return;
    const nextQuestions = [...editingItem.report.questions];
    const bulletArray = nextQuestions[qIdx].feedbackPoints.filter((_, bIdx) => bIdx !== bulletIdx);
    nextQuestions[qIdx] = { ...nextQuestions[qIdx], feedbackPoints: bulletArray };
    
    setEditingItem({
      ...editingItem,
      report: {
        ...editingItem.report,
        questions: nextQuestions
      }
    });
  };

  const handleEditQuestionFlaggedComment = (qIdx: number, val: string) => {
    if (!editingItem || !editingItem.report) return;
    const nextQuestions = [...editingItem.report.questions];
    nextQuestions[qIdx] = { 
      ...nextQuestions[qIdx], 
      isFlagged: val.trim().length > 0,
      flaggedComment: val 
    };
    
    setEditingItem({
      ...editingItem,
      report: {
        ...editingItem.report,
        questions: nextQuestions
      }
    });
  };

  const handleAddQuestionToReport = () => {
    if (!editingItem || !editingItem.report) return;
    const nextQuestions = [...editingItem.report.questions];
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

    setEditingItem({
      ...editingItem,
      report: {
        ...editingItem.report,
        questions: nextQuestions
      }
    });
  };

  const handleEditGeneralFeedbackBullet = (field: keyof GeneralFeedbackSection, bulletIdx: number, val: string) => {
    if (!editingItem || !editingItem.report || !editingItem.report.generalFeedback) return;
    const nextGeneral = { ...editingItem.report.generalFeedback };
    const bulletArray = [...(nextGeneral[field] || [])];
    bulletArray[bulletIdx] = val;
    nextGeneral[field] = bulletArray;

    setEditingItem({
      ...editingItem,
      report: {
        ...editingItem.report,
        generalFeedback: nextGeneral
      }
    });
  };

  const handleAddGeneralFeedbackBullet = (field: keyof GeneralFeedbackSection) => {
    if (!editingItem || !editingItem.report || !editingItem.report.generalFeedback) return;
    const nextGeneral = { ...editingItem.report.generalFeedback };
    nextGeneral[field] = [...(nextGeneral[field] || []), ''];

    setEditingItem({
      ...editingItem,
      report: {
        ...editingItem.report,
        generalFeedback: nextGeneral
      }
    });
  };

  const handleRemoveGeneralFeedbackBullet = (field: keyof GeneralFeedbackSection, bulletIdx: number) => {
    if (!editingItem || !editingItem.report || !editingItem.report.generalFeedback) return;
    const nextGeneral = { ...editingItem.report.generalFeedback };
    nextGeneral[field] = (nextGeneral[field] || []).filter((_, idx) => idx !== bulletIdx);

    setEditingItem({
      ...editingItem,
      report: {
        ...editingItem.report,
        generalFeedback: nextGeneral
      }
    });
  };

  const formatTime = (secs: number) => {
    const mins = Math.floor(secs / 60);
    const remainingSecs = secs % 60;
    return `${mins.toString().padStart(2, '0')}:${remainingSecs.toString().padStart(2, '0')}`;
  };

  return (
    <div className="max-w-6xl mx-auto px-4 mt-12 animate-fade-in pb-24">
      {/* Off-screen capture sheet */}
      {(isCapturing || reportForCapture) && (
        <div 
          className="fixed left-0 top-0 bg-white pointer-events-none" 
          style={{ width: '850px', zIndex: -50 }}
        >
          <div id="capture-target">
            <FeedbackReport report={reportForCapture} hideAuditTrail={true} />
          </div>
        </div>
      )}

      {/* Header */}
      <h1 className="text-4xl font-extrabold text-slate-900 mb-2 flex items-center gap-3">
        <span>Batch Valuation</span>
        <span className="text-sm px-3 py-1 bg-red-100 text-red-700 rounded-full font-bold uppercase tracking-wider">
          Pipeline Mode
        </span>
      </h1>
      <p className="text-slate-500 mb-8 font-medium">
        Upload class submissions collectively. Generates 4-in-1 report booklets (Evaluation, Script, Question, Key) at standard 15-minute intervals.
      </p>

      {/* Queue Groups Manager Tabs */}
      <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-sm mb-6 flex flex-col md:flex-row md:items-center justify-between gap-4 w-full min-w-0 max-w-full">
        {/* Scrollable Tabs Container with Controls */}
        <div className="flex items-center min-w-0 flex-1 w-full gap-2">
          {/* Scroll Left Button */}
          <button
            type="button"
            onClick={() => scrollTabs('left')}
            className="p-2 rounded-xl bg-slate-100 hover:bg-slate-200 active:bg-slate-300 text-slate-600 shrink-0 transition-colors cursor-pointer flex items-center justify-center border border-slate-200/60 shadow-xs"
            title="Scroll batches left"
            aria-label="Scroll batches left"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>

          {/* Horizontal Scroll Track */}
          <div 
            ref={tabsContainerRef}
            onWheel={(e) => {
              if (tabsContainerRef.current && Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
                tabsContainerRef.current.scrollLeft += e.deltaY;
              }
            }}
            tabIndex={0}
            aria-label="Queue Batch Tabs"
            className="flex items-center gap-2 overflow-x-auto overflow-y-hidden py-1 px-1 min-w-0 flex-1 scroll-smooth focus:outline-none [scrollbar-width:thin] [scrollbar-color:#cbd5e1_transparent] [&::-webkit-scrollbar]:h-2 [&::-webkit-scrollbar-track]:bg-slate-100 [&::-webkit-scrollbar-track]:rounded-full [&::-webkit-scrollbar-thumb]:bg-slate-300 [&::-webkit-scrollbar-thumb]:rounded-full hover:[&::-webkit-scrollbar-thumb]:bg-slate-400"
          >
            {queueGroups.map((group) => {
              const isSelected = group.id === activeGroupId;
              const bgClass = isSelected ? 'bg-red-600 text-white shadow-md shadow-red-600/20' : 'bg-slate-100 text-slate-600 hover:bg-slate-200';
              return (
                <div key={group.id} data-group-id={group.id} className="flex items-center gap-1 shrink-0">
                  <button
                    type="button"
                    onClick={() => setActiveGroupId(group.id)}
                    className={`px-3.5 py-2.5 rounded-xl text-xs font-bold transition-all flex items-center gap-2 cursor-pointer whitespace-nowrap ${bgClass}`}
                  >
                    <span>{group.name}</span>
                    <span className="bg-black/10 text-current px-2 py-0.5 rounded-md text-[10px] font-extrabold">
                      {queue.filter(item => item.queueGroupId === group.id).length}
                    </span>
                    {queueGroups.length > 1 && (
                      <span
                        role="button"
                        tabIndex={0}
                        onClick={(e) => {
                          e.stopPropagation();
                          handleRemoveGroup(group.id);
                        }}
                        className="ml-1 -mr-1 p-0.5 rounded-md hover:bg-black/20 text-current opacity-70 hover:opacity-100 transition-opacity"
                        title={`Delete ${group.name}`}
                        aria-label={`Delete ${group.name}`}
                      >
                        <X className="w-3.5 h-3.5" />
                      </span>
                    )}
                  </button>
                </div>
              );
            })}
            
            <button
              type="button"
              onClick={() => {
                const newId = crypto.randomUUID();
                const newNum = queueGroups.length + 1;
                setQueueGroups(prev => [
                  ...prev,
                  {
                    id: newId,
                    name: `Queue Batch ${newNum}`,
                    questionPaperFile: null,
                    answerKeyFile: null
                  }
                ]);
                setActiveGroupId(newId);
                setCurrentActionLog(`Created new batch: Queue Batch ${newNum}`);
                setTimeout(() => {
                  if (tabsContainerRef.current) {
                    tabsContainerRef.current.scrollTo({ left: tabsContainerRef.current.scrollWidth, behavior: 'smooth' });
                  }
                }, 50);
              }}
              className="px-4 py-2.5 bg-slate-900 hover:bg-slate-800 text-white rounded-xl text-xs font-black transition-all flex items-center gap-1.5 shrink-0 cursor-pointer whitespace-nowrap shadow-xs"
            >
              <Plus className="w-4 h-4" /> Add New Queue
            </button>
          </div>

          {/* Scroll Right Button */}
          <button
            type="button"
            onClick={() => scrollTabs('right')}
            className="p-2 rounded-xl bg-slate-100 hover:bg-slate-200 active:bg-slate-300 text-slate-600 shrink-0 transition-colors cursor-pointer flex items-center justify-center border border-slate-200/60 shadow-xs"
            title="Scroll batches right"
            aria-label="Scroll batches right"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>

        {/* Selected group controls (Rename / Delete) */}
        <div className="flex items-center gap-2 shrink-0 md:pl-2 md:border-l md:border-slate-200">
          <input 
            type="text" 
            value={activeGroup ? activeGroup.name : ''}
            onChange={(e) => handleUpdateGroupName(activeGroupId, e.target.value)}
            placeholder="Rename active batch..."
            className="bg-slate-50 border border-slate-200 px-3 py-2 rounded-xl text-xs font-bold text-slate-800 focus:outline-none focus:border-red-500 w-36 sm:w-44"
            title="Edit current batch display name"
          />
          <button
            type="button"
            onClick={() => handleRemoveGroup(activeGroupId)}
            className="p-2.5 bg-red-50 text-red-600 border border-red-200 rounded-xl hover:bg-red-600 hover:text-white transition-all cursor-pointer flex items-center gap-1.5 shadow-xs"
            title={queueGroups.length > 1 ? `Delete ${activeGroup?.name || 'Queue'}` : "Reset Queue Batch"}
            aria-label={queueGroups.length > 1 ? `Delete ${activeGroup?.name || 'Queue'}` : "Reset Queue Batch"}
          >
            <Trash2 className="w-4 h-4" />
            <span className="text-xs font-bold hidden sm:inline">
              {queueGroups.length > 1 ? 'Delete Queue' : 'Reset Queue'}
            </span>
          </button>
        </div>
      </div>

      {/* Main grids */}
      <div className="grid lg:grid-cols-3 gap-8">
        
        {/* Left Side: Upload materials */}
        <div className="lg:col-span-1 space-y-6">
          
          {/* Shared Assets Card */}
          <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm space-y-4">
            <h3 className="text-lg font-black text-slate-900 border-b pb-2 flex items-center gap-2">
              <Sparkles className="w-5 h-5 text-red-500" />
              <span>Shared Evaluation Core</span>
            </h3>

            {/* Question Paper */}
            <div>
              <label className="block text-xs font-black text-slate-500 uppercase tracking-wider mb-1.5">
                Valuation Question Paper
              </label>
              <div className="border border-dashed border-slate-200 rounded-xl p-3 bg-slate-50/50 hover:bg-slate-50 transition-colors flex items-center justify-between relative cursor-pointer">
                <div className="flex items-center gap-3 overflow-hidden">
                  <input 
                    type="file" 
                    accept="application/pdf,image/*,.docx"
                    onChange={(e) => e.target.files && setQuestionPaperFile(e.target.files[0])}
                    className="absolute inset-0 opacity-0 cursor-pointer"
                  />
                  <FileText className={`w-8 h-8 flex-shrink-0 ${questionPaperFile ? 'text-blue-500' : 'text-slate-300'}`} />
                  <div className="overflow-hidden">
                    <p className="text-xs font-bold text-slate-800 truncate">
                      {questionPaperFile ? questionPaperFile.name : 'Choose Question Paper PDF'}
                    </p>
                    <p className="text-[10px] text-slate-400">PDF, Word, or image sheet</p>
                  </div>
                </div>
                {questionPaperFile && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      e.preventDefault();
                      setQuestionPaperFile(null);
                    }}
                    className="relative z-10 p-1.5 bg-red-50 hover:bg-red-100 text-red-600 rounded-full cursor-pointer border border-red-100"
                    title="Discard File"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            </div>

            {/* Answer Key */}
            <div>
              <label className="block text-xs font-black text-slate-500 uppercase tracking-wider mb-1.5">
                Official Answer Key (Absolute Truth)
              </label>
              <div className="border border-dashed border-slate-200 rounded-xl p-3 bg-slate-50/50 hover:bg-slate-50 transition-colors flex items-center justify-between relative cursor-pointer">
                <div className="flex items-center gap-3 overflow-hidden">
                  <input 
                    type="file" 
                    accept="application/pdf,image/*,.docx"
                    onChange={(e) => e.target.files && setAnswerKeyFile(e.target.files[0])}
                    className="absolute inset-0 opacity-0 cursor-pointer"
                  />
                  <FileText className={`w-8 h-8 flex-shrink-0 ${answerKeyFile ? 'text-green-500' : 'text-slate-300'}`} />
                  <div className="overflow-hidden">
                    <p className="text-xs font-bold text-slate-800 truncate">
                      {answerKeyFile ? answerKeyFile.name : 'Choose Answer Key PDF'}
                    </p>
                    <p className="text-[10px] text-slate-400 text-transparent">Official reference parameters</p>
                  </div>
                </div>
                {answerKeyFile && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      e.preventDefault();
                      setAnswerKeyFile(null);
                    }}
                    className="relative z-10 p-1.5 bg-red-50 hover:bg-red-100 text-red-600 rounded-full cursor-pointer border border-red-100"
                    title="Discard File"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* Student Submissions Input */}
          <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm space-y-4">
            <h3 className="text-lg font-black text-slate-900 border-b pb-2 flex items-center gap-2">
              <Upload className="w-5 h-5 text-blue-500" />
              <span>Student Answer Sheets</span>
            </h3>

            <div className="border-2 border-dashed border-slate-200 rounded-xl p-6 bg-slate-50/50 hover:border-slate-300 transition-colors cursor-pointer relative flex flex-col items-center justify-center text-center">
              <input 
                type="file" 
                multiple 
                accept="application/pdf,image/*,.docx"
                onChange={(e) => {
                  if (e.target.files) {
                    setStudentFiles(Array.from(e.target.files));
                  }
                }}
                className="absolute inset-0 opacity-0 cursor-pointer"
              />
              <Upload className="w-8 h-8 text-slate-400 mb-2" />
              <p className="text-xs font-bold text-slate-700">Drag & Drop Student Scripts</p>
              <p className="text-[10px] text-slate-400 mt-1">Upload multiple files at once</p>
            </div>
          </div>

          {/* Action configurations toggler */}
          <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-sm">
            <button 
              onClick={() => setShowConfig(!showConfig)}
              className="w-full flex items-center justify-between text-xs font-black text-slate-600 uppercase tracking-widest"
            >
              <span className="flex items-center gap-2"><Sliders className="w-4 h-4" /> Queue Configurations</span>
              <span>{showConfig ? '▲' : '▼'}</span>
            </button>

            {showConfig && (
              <div className="mt-4 pt-4 border-t border-slate-100 space-y-4 animate-fade-in text-xs font-bold text-slate-700">
                
                {/* Mode Select */}
                <div>
                  <label className="block text-[10px] uppercase text-slate-400 tracking-wider mb-1">Valuation Method</label>
                  <select 
                    value={evalMode} 
                    onChange={(e) => setEvalMode(e.target.value as EvaluationMode)}
                    className="w-full bg-slate-100 p-2 rounded-lg text-slate-800"
                  >
                    <option value="without-manual">Automatic Answer Key Only</option>
                    <option value="with-manual">Enhanced Verification (With Notes)</option>
                  </select>
                </div>

                {/* Delay minute input */}
                <div>
                  <label className="block text-[10px] uppercase text-slate-400 tracking-wider mb-1">
                    Upload Timeout Gap (Minutes)
                  </label>
                  <div className="flex items-center gap-2">
                    <input 
                      type="number" 
                      min={0}
                      max={120}
                      value={delayMinutes} 
                      onChange={(e) => setDelayMinutes(Math.max(0, parseInt(e.target.value) || 0))}
                      className="w-20 bg-slate-100 p-2 rounded-lg text-slate-800 text-center"
                    />
                    <span className="text-slate-500">minute gap between uploads</span>
                  </div>
                </div>

                {/* Renaming convention */}
                <div>
                  <label className="block text-[10px] uppercase text-slate-400 tracking-wider mb-1">
                    Auto PDF Naming Format
                  </label>
                  <input 
                    type="text" 
                    value={namingPattern} 
                    onChange={(e) => setNamingPattern(e.target.value)}
                    className="w-full bg-slate-100 p-2 rounded-lg text-slate-800"
                  />
                  <p className="text-[9px] text-slate-400 mt-1 font-normal">
                    Supported tags: <code className="bg-slate-100 px-1 py-0.5 rounded text-red-500">{'{student}'}</code>, <code className="bg-slate-100 px-1 py-0.5 rounded text-red-500">{'{test}'}</code>, <code className="bg-slate-100 px-1 py-0.5 rounded text-red-500">{'{date}'}</code>, <code className="bg-slate-100 px-1 py-0.5 rounded text-red-500">{'{random_id}'}</code>
                  </p>
                </div>
              </div>
            )}
          </div>

        </div>

        {/* Right Side: Active Queue Table */}
        <div className="lg:col-span-2 space-y-6">
          
          {/* Operations Orchestrator Dashboard */}
          <div className="bg-slate-900 text-white p-6 rounded-2xl border border-slate-800 shadow-xl flex flex-col md:flex-row md:items-center justify-between gap-6">
            <div>
              <div className="flex items-center gap-2 text-red-400 font-bold uppercase tracking-widest text-xs mb-1">
                <Clock className="w-4 h-4 animate-pulse" />
                <span>VALUATION SCHEDULING UNIT</span>
              </div>
              <h2 className="text-xl font-bold">
                {isBatchRunning ? 'Queue processing active...' : 'Valuation Pipeline Standby'}
              </h2>
              {currentActionLog && (
                <p className="text-slate-300 text-xs mt-2 font-mono bg-black/30 px-3 py-1.5 rounded-lg inline-block border border-white/5 truncate max-w-md">
                  Log: {currentActionLog}
                </p>
              )}
            </div>

            <div className="flex items-center gap-2 flex-wrap">
              {isBatchRunning ? (
                <button 
                  onClick={handlePauseBatch}
                  className="px-4 py-2.5 bg-amber-500 text-slate-950 font-black rounded-xl text-xs hover:bg-amber-400 hover:-translate-y-0.5 transition-all flex items-center gap-1.5"
                >
                  <Pause className="w-4 h-4" /> Pause
                </button>
              ) : (
                <button 
                  onClick={handleStartBatch}
                  disabled={queue.length === 0}
                  className="px-5 py-2.5 bg-red-600 text-white font-black rounded-xl text-xs hover:bg-red-500 hover:-translate-y-0.5 shadow-lg shadow-red-600/30 transition-all flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <Play className="w-4 h-4 fill-current" /> Start Valuation Cycle
                </button>
              )}
              
              <button 
                onClick={handleClearQueue}
                disabled={queue.length === 0}
                className="p-2.5 bg-slate-800 text-slate-300 rounded-xl hover:bg-slate-700 hover:text-white transition-colors"
                title="Clear Queue"
              >
                <RotateCcw className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Queue item grid list */}
          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
            <div className="bg-slate-50 px-6 py-4 border-b border-slate-200 flex items-center justify-between">
              <h3 className="font-extrabold text-slate-800 text-sm">
                QUEUE PIPELINE ({queue.length} Student Scripts Loaded)
              </h3>
              <p className="text-xs text-slate-500 font-bold">
                {queue.filter(q => q.status === 'completed').length} / {queue.length} Complete
              </p>
            </div>

            {queue.length === 0 ? (
              <div className="p-16 text-center text-slate-400 font-bold">
                <FileText className="w-12 h-12 stroke-1 mx-auto text-slate-300 mb-2" />
                <p className="text-xs">Valuation pipeline queue is empty.</p>
                <p className="text-[10px] font-normal text-slate-400 mt-1">Please drag and drop student materials on the left to queue.</p>
              </div>
            ) : (
              <div className="divide-y divide-slate-100 bg-slate-50/50 p-4 space-y-4">
                {queueGroups.map((group) => {
                  const groupItemsWithFlatIdx = queue
                    .map((item, idx) => ({ item, idx }))
                    .filter(({ item }) => item.queueGroupId === group.id);

                  if (groupItemsWithFlatIdx.length === 0) {
                    return null;
                  }

                  return (
                    <div key={group.id} className="bg-white rounded-xl border border-slate-200 overflow-hidden shadow-sm">
                      {/* Group Header info bar */}
                      <div className="bg-slate-50 border-b border-slate-200 px-4 py-2.5 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs">
                        <div className="flex items-center gap-2">
                          <span className="font-extrabold text-slate-800 bg-slate-100 px-2 py-0.5 rounded-lg border border-slate-200">
                            {group.name}
                          </span>
                          <span className="font-normal text-slate-400">
                            (QP: {group.questionPaperFile ? group.questionPaperFile.name.substring(0, 20) : 'None'}, AK: {group.answerKeyFile ? group.answerKeyFile.name.substring(0, 20) : 'None'})
                          </span>
                        </div>
                        <div className="flex items-center gap-2 text-[10px] font-black text-slate-400 uppercase">
                          <span>
                            {groupItemsWithFlatIdx.filter(({ item }) => item.status === 'completed').length} / {groupItemsWithFlatIdx.length} Done
                          </span>
                        </div>
                      </div>

                      <div className="divide-y divide-slate-100">
                        {groupItemsWithFlatIdx.map(({ item, idx }) => {
                          const isActive = idx === currentQueueIndex;
                          return (
                            <div 
                              key={item.id}
                              draggable={!(isBatchRunning && isActive)}
                              onDragStart={(e) => handleDragStart(e, idx)}
                              onDragOver={(e) => handleDragOver(e, idx)}
                              onDrop={(e) => handleDrop(e, idx)}
                              onDragEnd={handleDragEnd}
                              className={`p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4 transition-all ${
                                isActive ? 'bg-red-50/40 border-l-4 border-l-red-600' : 'hover:bg-slate-50/50'
                              } ${draggedIndex === idx ? 'opacity-40 bg-slate-100 border border-dashed border-slate-300' : ''}`}
                            >
                              {/* Name / file & reorder triggers */}
                              <div className="flex items-center gap-3 overflow-hidden max-w-md w-full">
                                {/* Drag and manual reorder controls */}
                                <div className="flex items-center gap-1 shrink-0 select-none">
                                  <div 
                                    className={`text-slate-300 hover:text-slate-500 p-1 rounded hidden sm:block ${
                                      isBatchRunning && isActive ? 'cursor-not-allowed opacity-30' : 'cursor-grab active:cursor-grabbing'
                                    }`}
                                    title={isBatchRunning && isActive ? "Cannot reorder while running" : "Drag to reorder"}
                                  >
                                    <GripVertical className="w-4 h-4" />
                                  </div>
                                  <div className="flex flex-col gap-0.5">
                                    <button
                                      onClick={(e) => { e.stopPropagation(); moveQueueItem(idx, 'up'); }}
                                      disabled={idx === 0 || (isBatchRunning && (isActive || idx - 1 === currentQueueIndex))}
                                      className="p-0.5 hover:bg-slate-100 text-slate-400 hover:text-slate-800 disabled:opacity-25 disabled:hover:bg-transparent rounded transition-colors cursor-pointer"
                                      title="Move Up"
                                    >
                                      <ArrowUp className="w-3.5 h-3.5" />
                                    </button>
                                    <button
                                      onClick={(e) => { e.stopPropagation(); moveQueueItem(idx, 'down'); }}
                                      disabled={idx === queue.length - 1 || (isBatchRunning && (isActive || idx + 1 === currentQueueIndex))}
                                      className="p-0.5 hover:bg-slate-100 text-slate-400 hover:text-slate-800 disabled:opacity-25 disabled:hover:bg-transparent rounded transition-colors cursor-pointer"
                                      title="Move Down"
                                    >
                                      <ArrowDown className="w-3.5 h-3.5" />
                                    </button>
                                  </div>
                                </div>

                                <div className="space-y-1 overflow-hidden flex-1">
                                  <div className="flex items-center gap-2">
                                    <input 
                                      type="text" 
                                      value={item.studentName} 
                                      onChange={(e) => handleUpdateStudentName(item.id, e.target.value)}
                                      disabled={isBatchRunning && isActive}
                                      className="font-extrabold text-slate-900 border-b border-transparent hover:border-slate-300 focus:border-blue-500 transition-colors bg-transparent outline-none max-w-xs py-0.5 text-sm"
                                      title="Click to change student name"
                                    />
                                  </div>
                                  <div className="flex items-center gap-1.5 text-[10px] text-slate-400 truncate">
                                    <FileText className="w-3.5 h-3.5" />
                                    <span>{item.file.name} ({(item.file.size / 1024).toFixed(1)} KB)</span>
                                  </div>
                                  {item.fileNameFormatted && (
                                    <div className="text-[9px] font-mono text-slate-500 italic">
                                      Output: {item.fileNameFormatted}
                                    </div>
                                  )}
                                  {item.error && (
                                    <div className="text-xs font-semibold text-red-600 flex items-center gap-1">
                                      <AlertCircle className="w-3.5 h-3.5" />
                                      <span>{item.error}</span>
                                    </div>
                                  )}
                                </div>
                              </div>

                              {/* Right actions / status */}
                              <div className="flex items-center gap-4 self-end sm:self-center">
                                
                                {/* Countdown widget */}
                                {item.countdown > 0 && item.status === 'pending' && (
                                  <div className="flex items-center gap-2 bg-amber-50 text-amber-800 border border-amber-100 font-bold text-xs px-2.5 py-1.5 rounded-xl">
                                    <Clock className="w-3.5 h-3.5 animate-spin" />
                                    <span>Gap timeout: {formatTime(item.countdown)}</span>
                                    <button 
                                      onClick={() => handleSkipDelay(idx)}
                                      className="ml-1 text-[10px] underline hover:text-amber-900 flex items-center gap-0.5"
                                      title="Skip current interval countdown and evaluate now"
                                    >
                                      <SkipForward className="w-3 h-3" /> Skip
                                    </button>
                                  </div>
                                )}

                                {/* Badges */}
                                <div className="text-right">
                                  {item.status === 'pending' && item.countdown === 0 && (
                                    <span className="px-2.5 py-1 bg-slate-100 text-slate-500 rounded-full text-xs font-black uppercase tracking-wider">
                                      Queued
                                    </span>
                                  )}
                                  {item.status === 'extracting' && (
                                    <span className="px-2.5 py-1 bg-blue-50 text-blue-700 border border-blue-100 rounded-full text-xs font-black uppercase animate-pulse">
                                      Extracting...
                                    </span>
                                  )}
                                  {item.status === 'evaluating' && (
                                    <span className="px-2.5 py-1 bg-violet-50 text-violet-700 border border-violet-100 rounded-full text-xs font-black uppercase animate-pulse">
                                      AI Grader...
                                    </span>
                                  )}
                                  {item.status === 'merging' && (
                                    <span className="px-2.5 py-1 bg-amber-50 text-amber-700 border border-amber-100 rounded-full text-xs font-black uppercase animate-pulse">
                                      Merging PDFs...
                                    </span>
                                  )}
                                  {item.status === 'completed' && (
                                    <div className="flex items-center gap-1 text-emerald-600 bg-emerald-50 border border-emerald-100 px-2 py-1 rounded-full">
                                      <CheckCircle className="w-3.5 h-3.5" />
                                      <span className="text-[10px] font-black uppercase tracking-wider">Ready</span>
                                    </div>
                                  )}
                                  {item.status === 'failed' && (
                                    <div className="flex items-center gap-1.5">
                                      <span className="px-2.5 py-1 bg-red-50 text-red-700 border border-red-100 rounded-full text-xs font-black uppercase">
                                        Failed
                                      </span>
                                      <button
                                        type="button"
                                        onClick={async () => {
                                          setQueue(prev => prev.map(q => q.id === item.id ? { ...q, status: 'pending', error: undefined, countdown: 0 } : q));
                                          setIsBatchRunning(true);
                                          try {
                                            if (!item.cachedBase64) {
                                              const b64 = await safeFileToBase64(item.file);
                                              item.cachedBase64 = b64;
                                            }
                                          } catch (_) {}
                                          processQueueItem(idx);
                                        }}
                                        className="px-2 py-1 bg-red-600 hover:bg-red-700 text-white rounded-lg text-[10px] font-bold flex items-center gap-1 transition-all cursor-pointer shadow-sm"
                                        title="Retry evaluating this student script"
                                      >
                                        <Play className="w-3 h-3" />
                                        <span>Retry</span>
                                      </button>
                                      <label
                                        className="px-2 py-1 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg text-[10px] font-bold flex items-center gap-1 transition-all cursor-pointer border border-slate-200"
                                        title="Re-attach file if browser lost access to disk"
                                      >
                                        <Upload className="w-3 h-3" />
                                        <span>Re-link</span>
                                        <input
                                          type="file"
                                          className="hidden"
                                          accept=".pdf,.docx,image/*"
                                          onChange={async (e) => {
                                            const newFile = e.target.files?.[0];
                                            if (newFile) {
                                              try {
                                                const b64 = await safeFileToBase64(newFile);
                                                const bytes = await safeFileToBytes(newFile);
                                                setQueue(prev => prev.map(q => q.id === item.id ? {
                                                  ...q,
                                                  file: newFile,
                                                  cachedBase64: b64,
                                                  cachedPdfBytes: bytes,
                                                  status: 'pending',
                                                  error: undefined,
                                                  countdown: 0
                                                } : q));
                                                setIsBatchRunning(true);
                                                processQueueItem(idx);
                                              } catch (readErr) {
                                                console.error('Failed to reload file:', readErr);
                                              }
                                            }
                                          }}
                                        />
                                      </label>
                                    </div>
                                  )}
                                </div>

                                {/* Merged corrections panel / manual download */}
                                <div className="flex items-center gap-2">
                                  {item.report && (
                                    <button 
                                      onClick={() => setEditingItem(item)}
                                      className="p-1.5 text-slate-400 hover:text-slate-800 hover:bg-slate-100 rounded transition-colors cursor-pointer"
                                      title="Edit Evaluation Report (Apply Corrections)"
                                    >
                                      <Edit3 className="w-4 h-4" />
                                    </button>
                                  )}
                                  
                                  {item.status === 'completed' && (
                                    <div className="flex items-center gap-1.5 bg-slate-100/60 p-1 rounded-xl border border-slate-200/40">
                                      {/* Option A: Evaluation Report Only */}
                                      <button
                                        onClick={() => {
                                          if (item.reportOnlyPdfBytes) {
                                            const baseName = (item.fileNameFormatted || 'Anatomy_Guru_Report.pdf')
                                              .replace(/\.[^/.]+$/, "");
                                            downloadBytes(item.reportOnlyPdfBytes, `${baseName}_Report_Only.pdf`);
                                          } else {
                                            alert("Evaluation report cover page only is not compiled.");
                                          }
                                        }}
                                        className="px-2 py-1 bg-white text-slate-700 hover:bg-slate-50 hover:text-red-600 border border-slate-200/60 rounded-lg text-[10px] font-black flex items-center gap-1 transition-all cursor-pointer shadow-sm"
                                        title="Download the evaluated cover sheet report only"
                                      >
                                        <FileText className="w-3 h-3 text-red-500" />
                                        <span>Report Only</span>
                                      </button>

                                      {/* Option B: Unified Booklet */}
                                      {item.mergedPdfBytes && (
                                        <button
                                          onClick={() => downloadBytes(item.mergedPdfBytes!, item.fileNameFormatted || 'Anatomy_Guru_Report.pdf')}
                                          className="px-2 py-1 bg-red-600 text-white hover:bg-red-700 rounded-lg text-[10px] font-black flex items-center gap-1 transition-all cursor-pointer shadow-sm"
                                          title="Download combined booklet PDF (Report + Answers + QP + AK)"
                                        >
                                          <Download className="w-3 h-3" />
                                          <span>4-in-1 Booklet</span>
                                        </button>
                                      )}
                                    </div>
                                  )}

                                  <button 
                                    onClick={() => handleRemoveItem(item.id)}
                                    className="p-1.5 text-slate-300 hover:text-red-500 rounded transition-colors cursor-pointer"
                                    title="Remove file from queue"
                                  >
                                    <Trash2 className="w-4 h-4" />
                                  </button>
                                </div>

                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

        </div>

      </div>

      {/* BACK NAVIGATION BUTTON FOOTER */}
      <div className="mt-12 text-center border-t border-slate-200 pt-8">
        <button 
          onClick={onBack}
          className="px-6 py-2.5 bg-slate-100 text-slate-700 font-bold rounded-xl text-xs hover:bg-slate-200 transition-colors"
        >
          ← Return to Dashboard
        </button>
      </div>

      {/* ======================================================= */}
      {/* 11. ACADEMIC EDITORIAL & SUMMARY CORRECTION DESK   */}
      {/* ======================================================= */}
      {editingItem && editingItem.report && (() => {
        const report = editingItem.report;
        const studentName = editingItem.studentName;
        const calculatedSum = report.questions?.reduce((acc: number, q: any) => acc + (Number(q.marks) || 0), 0) || 0;

        return (
          <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-md z-50 overflow-y-auto px-4 py-8 flex justify-center">
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
                      value={editingItem.studentName}
                      onChange={(e) => {
                        const newName = e.target.value;
                        setEditingItem({
                          ...editingItem,
                          studentName: newName,
                          report: editingItem.report ? {
                            ...editingItem.report,
                            studentName: newName
                          } : null
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
                        setEditingItem({
                          ...editingItem,
                          report: editingItem.report ? {
                            ...editingItem.report,
                            testTitle: newTitle
                          } : null
                        });
                      }}
                      className="w-full px-4 py-2 bg-white border border-slate-300 focus:border-red-500 rounded-xl text-sm font-bold text-slate-800 outline-none transition-colors"
                      placeholder="Enter Test Title"
                    />
                  </div>
                </div>

                {/* Question Feedback Table Editor */}
                <div>
                  <h4 className="text-xs font-black text-slate-800 uppercase tracking-widest border-b pb-1.5 mb-4 flex items-center justify-between">
                    <span>Question-wise Scoring & Feedback Points</span>
                    <button 
                      onClick={handleAddQuestionToReport}
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
                              onChange={(e) => handleEditQuestionMark(qIdx, parseFloat(e.target.value) || 0)}
                              className="bg-white border border-slate-200 rounded p-1.5 text-center w-16"
                            />
                            <span>/ Max:</span>
                            <input 
                              type="number" 
                              step="0.5"
                              value={q.maxMarks} 
                              onChange={(e) => handleEditQuestionMaxMark(qIdx, parseFloat(e.target.value) || 0)}
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
                                onChange={(e) => handleEditQuestionFeedbackBullet(qIdx, bIdx, e.target.value)}
                                className="w-full bg-white border border-slate-200 rounded p-2 text-xs text-slate-800 font-normal shadow-sm"
                              />
                              <button 
                                onClick={() => handleRemoveQuestionFeedbackBullet(qIdx, bIdx)}
                                className="p-2 text-slate-300 hover:text-red-500 hover:bg-slate-100 rounded transition-colors cursor-pointer"
                                title="Delete Bullet"
                              >
                                <Trash className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          ))}
                          <button 
                            onClick={() => handleAddQuestionFeedbackBullet(qIdx)}
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
                            onChange={(e) => handleEditQuestionFlaggedComment(qIdx, e.target.value)}
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
                      {(Object.keys(report.generalFeedback) as Array<keyof GeneralFeedbackSection>).map((field, fIdx) => {
                        const bullets = report.generalFeedback ? (report.generalFeedback[field] || []) : [];
                        
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
                              {bullets.map((b, bIdx) => (
                                <div key={bIdx} className="flex gap-1.5">
                                  <input 
                                    type="text" 
                                    value={b} 
                                    onChange={(e) => handleEditGeneralFeedbackBullet(field, bIdx, e.target.value)}
                                    className="w-full bg-white border border-slate-200 rounded p-1.5 text-xs text-slate-700 font-normal"
                                  />
                                  <button 
                                    onClick={() => handleRemoveGeneralFeedbackBullet(field, bIdx)}
                                    className="p-1 text-slate-300 hover:text-red-500 rounded cursor-pointer"
                                  >
                                    <Trash className="w-3 h-3" />
                                  </button>
                                </div>
                              ))}
                              <button 
                                onClick={() => handleAddGeneralFeedbackBullet(field)}
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
                  onClick={() => setEditingItem(null)}
                  className="px-5 py-2.5 bg-slate-200 hover:bg-slate-300 rounded-xl text-slate-700 text-xs font-bold cursor-pointer"
                >
                  Discard Corrections
                </button>
                <button 
                  onClick={handleApplyCorrections}
                  className="px-6 py-2.5 bg-[#F93A2C] hover:bg-[#E5281B] rounded-xl text-white text-xs font-extrabold flex items-center gap-1.5 cursor-pointer shadow-md"
                >
                  <Check className="w-4 h-4" /> Apply & Download Updated PDF
                </button>
              </div>

            </div>
          </div>
        );
      })()}

    </div>
  );
};

export default BatchProcessor;
