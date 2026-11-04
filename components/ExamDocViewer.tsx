import React, { useState, useEffect, useRef } from 'react';
// @ts-ignore
import * as pdfjsLib from 'pdfjs-dist';
// @ts-ignore
import pdfjsWorker from 'pdfjs-dist/build/pdf.worker.mjs?url';
import { 
  FileText, 
  ChevronLeft, 
  ChevronRight, 
  ZoomIn, 
  ZoomOut, 
  RotateCcw, 
  AlertCircle,
  Eye,
  Layers
} from 'lucide-react';
import { CanonicalAnswerKey } from '../types';

const pdfjs: any = pdfjsLib;

if (pdfjs && pdfjs.GlobalWorkerOptions) {
  pdfjs.GlobalWorkerOptions.workerSrc = pdfjsWorker;
}

function base64ToUint8Array(base64: string): Uint8Array {
  const clean = base64.replace(/^data:[^;]+;base64,/, '');
  const binaryString = atob(clean);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

interface ExamDocViewerProps {
  answerKey: CanonicalAnswerKey;
  questionPaperFile?: File | null;
  answerKeyFile?: File | null;
  className?: string;
}

type ActiveDocType = 'question_paper' | 'official_answer_key';

export const ExamDocViewer: React.FC<ExamDocViewerProps> = ({
  answerKey,
  questionPaperFile,
  answerKeyFile,
  className = '',
}) => {
  const [activeDoc, setActiveDoc] = useState<ActiveDocType>('question_paper');
  const [pageNum, setPageNum] = useState<number>(1);
  const [numPages, setNumPages] = useState<number>(1);
  const [scale, setScale] = useState<number>(1.1);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pdfDocRef = useRef<any>(null);
  const renderTaskRef = useRef<any>(null);

  // Determine availability of documents
  const hasQP = Boolean(questionPaperFile || answerKey.sourceQuestionPaperDoc);
  const hasAK = Boolean(answerKeyFile || answerKey.sourceAnswerKeyDoc);

  // If activeDoc is official_answer_key but not available, fallback to question_paper
  useEffect(() => {
    if (activeDoc === 'official_answer_key' && !hasAK && hasQP) {
      setActiveDoc('question_paper');
    }
  }, [hasAK, hasQP, activeDoc]);

  // Load PDF when active doc changes
  useEffect(() => {
    let isCancelled = false;

    const loadDocument = async () => {
      setLoading(true);
      setError(null);
      setPageNum(1);

      try {
        let pdfData: Uint8Array | ArrayBuffer | null = null;
        let textFallback: string | null = null;
        let mimeType: string = 'application/pdf';

        if (activeDoc === 'question_paper') {
          if (questionPaperFile) {
            mimeType = questionPaperFile.type || 'application/pdf';
            if (mimeType === 'application/pdf' || questionPaperFile.name.endsWith('.pdf')) {
              pdfData = await questionPaperFile.arrayBuffer();
            }
          } else if (answerKey.sourceQuestionPaperDoc) {
            const doc = answerKey.sourceQuestionPaperDoc;
            mimeType = doc.mimeType || 'application/pdf';
            if (doc.base64) {
              pdfData = base64ToUint8Array(doc.base64);
            } else if (doc.text) {
              textFallback = doc.text;
            }
          }
        } else {
          // official_answer_key
          if (answerKeyFile) {
            mimeType = answerKeyFile.type || 'application/pdf';
            if (mimeType === 'application/pdf' || answerKeyFile.name.endsWith('.pdf')) {
              pdfData = await answerKeyFile.arrayBuffer();
            }
          } else if (answerKey.sourceAnswerKeyDoc) {
            const doc = answerKey.sourceAnswerKeyDoc;
            mimeType = doc.mimeType || 'application/pdf';
            if (doc.base64) {
              pdfData = base64ToUint8Array(doc.base64);
            } else if (doc.text) {
              textFallback = doc.text;
            }
          }
        }

        if (isCancelled) return;

        if (pdfData && pdfjs && pdfjs.getDocument) {
          const loadingTask = pdfjs.getDocument({ data: pdfData });
          const loadedPdf = await loadingTask.promise;
          if (isCancelled) return;
          pdfDocRef.current = loadedPdf;
          setNumPages(loadedPdf.numPages);
          setLoading(false);
        } else if (textFallback) {
          pdfDocRef.current = null;
          setNumPages(1);
          setLoading(false);
        } else {
          pdfDocRef.current = null;
          setLoading(false);
        }
      } catch (err: any) {
        if (!isCancelled) {
          console.error('[ExamDocViewer] Error loading document:', err);
          setError(err.message || 'Failed to render PDF document.');
          setLoading(false);
        }
      }
    };

    loadDocument();

    return () => {
      isCancelled = true;
      if (renderTaskRef.current) {
        try {
          renderTaskRef.current.cancel();
        } catch (e) {
          // Ignore cancellation errors
        }
      }
    };
  }, [activeDoc, questionPaperFile, answerKeyFile, answerKey]);

  // Render current page to canvas
  useEffect(() => {
    let isCancelled = false;

    const renderPage = async () => {
      if (!pdfDocRef.current || !canvasRef.current) return;

      try {
        if (renderTaskRef.current) {
          try {
            renderTaskRef.current.cancel();
          } catch (e) {
            // Ignore
          }
        }

        const page = await pdfDocRef.current.getPage(pageNum);
        if (isCancelled) return;

        const canvas = canvasRef.current;
        const context = canvas.getContext('2d');
        if (!context) return;

        const viewport = page.getViewport({ scale });
        
        // High-DPI support
        const pixelRatio = window.devicePixelRatio || 1;
        canvas.width = Math.floor(viewport.width * pixelRatio);
        canvas.height = Math.floor(viewport.height * pixelRatio);
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;

        context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);

        const renderContext = {
          canvasContext: context,
          viewport: viewport,
        };

        const task = page.render(renderContext);
        renderTaskRef.current = task;
        await task.promise;
      } catch (err: any) {
        if (err?.name !== 'RenderingCancelledException' && !isCancelled) {
          console.warn('[ExamDocViewer] Render page warning:', err);
        }
      }
    };

    renderPage();

    return () => {
      isCancelled = true;
    };
  }, [pageNum, scale, loading]);

  const handlePrevPage = () => {
    setPageNum((prev) => Math.max(prev - 1, 1));
  };

  const handleNextPage = () => {
    setPageNum((prev) => Math.min(prev + 1, numPages));
  };

  const handleZoomIn = () => {
    setScale((prev) => Math.min(prev + 0.2, 2.5));
  };

  const handleZoomOut = () => {
    setScale((prev) => Math.max(prev - 0.2, 0.6));
  };

  const handleResetZoom = () => {
    setScale(1.1);
  };

  const activeDocName =
    activeDoc === 'question_paper'
      ? questionPaperFile?.name || answerKey.sourceQuestionPaperDoc?.name || 'Question Paper'
      : answerKeyFile?.name || answerKey.sourceAnswerKeyDoc?.name || 'Official Answer Key';

  const textContent =
    activeDoc === 'question_paper'
      ? answerKey.sourceQuestionPaperDoc?.text
      : answerKey.sourceAnswerKeyDoc?.text;

  return (
    <div className={`flex flex-col h-full bg-slate-900 rounded-2xl overflow-hidden border border-slate-800 ${className}`}>
      {/* Top Document Selector Tabs & Toolbar */}
      <div className="bg-slate-950 px-4 py-2.5 border-b border-slate-800 flex flex-wrap items-center justify-between gap-3 shrink-0">
        {/* Document Tabs */}
        <div className="flex items-center gap-1.5 bg-slate-900 p-1 rounded-xl border border-slate-800">
          <button
            type="button"
            onClick={() => setActiveDoc('question_paper')}
            className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all flex items-center gap-1.5 cursor-pointer ${
              activeDoc === 'question_paper'
                ? 'bg-purple-600 text-white shadow-sm'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <FileText className="w-3.5 h-3.5" />
            <span>Question Paper</span>
          </button>

          {hasAK && (
            <button
              type="button"
              onClick={() => setActiveDoc('official_answer_key')}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all flex items-center gap-1.5 cursor-pointer ${
                activeDoc === 'official_answer_key'
                  ? 'bg-emerald-600 text-white shadow-sm'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Layers className="w-3.5 h-3.5" />
              <span>Official Answer Key</span>
            </button>
          )}
        </div>

        {/* Page Navigation & Zoom Toolbar */}
        <div className="flex items-center gap-2">
          {numPages > 1 && (
            <div className="flex items-center gap-1 bg-slate-900 px-2 py-1 rounded-xl border border-slate-800 text-slate-300 text-xs">
              <button
                type="button"
                onClick={handlePrevPage}
                disabled={pageNum <= 1}
                className="p-1 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
                title="Previous Page"
              >
                <ChevronLeft className="w-3.5 h-3.5" />
              </button>
              <span className="font-mono font-bold text-[11px] px-1">
                {pageNum} / {numPages}
              </span>
              <button
                type="button"
                onClick={handleNextPage}
                disabled={pageNum >= numPages}
                className="p-1 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
                title="Next Page"
              >
                <ChevronRight className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

          {/* Zoom controls */}
          <div className="flex items-center gap-1 bg-slate-900 px-1.5 py-1 rounded-xl border border-slate-800 text-slate-400">
            <button
              type="button"
              onClick={handleZoomOut}
              className="p-1 hover:text-white cursor-pointer"
              title="Zoom Out"
            >
              <ZoomOut className="w-3.5 h-3.5" />
            </button>
            <span className="font-mono text-[10px] font-bold text-slate-400 w-9 text-center">
              {Math.round(scale * 100)}%
            </span>
            <button
              type="button"
              onClick={handleZoomIn}
              className="p-1 hover:text-white cursor-pointer"
              title="Zoom In"
            >
              <ZoomIn className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={handleResetZoom}
              className="p-1 hover:text-white cursor-pointer"
              title="Reset Zoom"
            >
              <RotateCcw className="w-3 h-3" />
            </button>
          </div>
        </div>
      </div>

      {/* Document Subheader with Filename */}
      <div className="bg-slate-950/60 px-4 py-1.5 border-b border-slate-800/80 flex items-center justify-between text-[11px] text-slate-400 shrink-0">
        <span className="truncate max-w-xs font-mono font-medium">
          Source: {activeDocName}
        </span>
        <span className="text-[10px] uppercase font-bold tracking-wider text-slate-500">
          Built-in PDF Viewer
        </span>
      </div>

      {/* Canvas / Content Viewer Area */}
      <div className="flex-1 overflow-auto p-4 flex items-start justify-center bg-slate-900/60 min-h-0">
        {loading ? (
          <div className="flex flex-col items-center justify-center h-64 text-slate-400 gap-3">
            <div className="w-8 h-8 border-2 border-purple-500 border-t-transparent rounded-full animate-spin"></div>
            <span className="text-xs font-semibold">Rendering document preview...</span>
          </div>
        ) : error ? (
          <div className="p-6 bg-red-950/40 border border-red-800/50 rounded-2xl text-red-300 text-xs max-w-md flex flex-col items-center text-center gap-2">
            <AlertCircle className="w-6 h-6 text-red-400 shrink-0" />
            <p className="font-bold">PDF Rendering Notice</p>
            <p className="text-slate-400">{error}</p>
          </div>
        ) : pdfDocRef.current ? (
          <div className="shadow-2xl rounded-lg overflow-hidden bg-white max-w-full">
            <canvas ref={canvasRef} className="block max-w-full" />
          </div>
        ) : textContent ? (
          <div className="w-full bg-slate-950 p-6 rounded-xl border border-slate-800 text-slate-300 font-mono text-xs leading-relaxed max-w-2xl whitespace-pre-wrap">
            <div className="text-[10px] uppercase font-black tracking-widest text-slate-500 mb-3 pb-2 border-b border-slate-800">
              Extracted Document Text
            </div>
            {textContent}
          </div>
        ) : (
          <div className="text-center text-slate-500 text-xs py-16 flex flex-col items-center gap-2">
            <Eye className="w-8 h-8 text-slate-600" />
            <p>No visual PDF preview available for this document.</p>
            <p className="text-[11px] text-slate-600">The structured questions on the right will be used for grading.</p>
          </div>
        )}
      </div>
    </div>
  );
};
