import React, { useState } from 'react';
import { CanonicalAnswerKey, FileData, AnswerKeySourceMode } from '../types';
import FileUploader from './FileUploader';
import { 
  Sparkles, 
  Upload, 
  CheckCircle, 
  Clock, 
  AlertTriangle, 
  Edit3, 
  ShieldCheck, 
  FileText, 
  RotateCcw,
  Check
} from 'lucide-react';
import { 
  generateAnswerKeyApi, 
  extractAnswerKeyApi, 
  updateAnswerKeyApi, 
  approveAnswerKeyApi,
  listAnswerKeysApi,
  findApprovedKeyForQuestionPaperApi
} from '../services/geminiService';
import { AnswerKeyReviewModal } from './AnswerKeyReviewModal';

interface AnswerKeySelectorProps {
  currentAnswerKey: CanonicalAnswerKey | null;
  onAnswerKeyChange: (key: CanonicalAnswerKey | null) => void;
  questionPaperFile: File | null;
  onQuestionPaperFileChange: (file: File | null) => void;
  answerKeyFile: File | null;
  onAnswerKeyFileChange: (file: File | null) => void;
  fileToData: (file: File) => Promise<FileData>;
}

export const AnswerKeySelector: React.FC<AnswerKeySelectorProps> = ({
  currentAnswerKey,
  onAnswerKeyChange,
  questionPaperFile,
  onQuestionPaperFileChange,
  answerKeyFile,
  onAnswerKeyFileChange,
  fileToData,
}) => {
  const [selectedMode, setSelectedMode] = useState<AnswerKeySourceMode>('ai_generated');
  const [examTitle, setExamTitle] = useState('Academic Assessment');
  const [subject, setSubject] = useState('');
  const [grade, setGrade] = useState('');
  const [totalMarksInput, setTotalMarksInput] = useState<string>('');
  
  const [isProcessing, setIsProcessing] = useState(false);
  const [processingStep, setProcessingStep] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isReviewModalOpen, setIsReviewModalOpen] = useState(false);
  const [approvedKeysList, setApprovedKeysList] = useState<CanonicalAnswerKey[]>([]);
  const [isCheckingMappedKey, setIsCheckingMappedKey] = useState(false);

  // Fetch previously approved answer keys for the user's institution
  const loadApprovedKeys = async () => {
    try {
      const keys = await listAnswerKeysApi();
      const approved = (keys || []).filter((k) => k.status === 'approved');
      setApprovedKeysList(approved);
    } catch (e) {
      console.warn('[AnswerKeySelector] Failed loading approved keys:', e);
    }
  };

  React.useEffect(() => {
    loadApprovedKeys();
  }, []);

  // When a Question Paper file is selected or uploaded, auto-check if an approved answer key is already mapped
  React.useEffect(() => {
    let isCancelled = false;
    const checkMatchingKey = async () => {
      if (!questionPaperFile || currentAnswerKey?.status === 'approved') return;
      setIsCheckingMappedKey(true);
      try {
        const qpData = await fileToData(questionPaperFile);
        const mapped = await findApprovedKeyForQuestionPaperApi(qpData);
        if (mapped && !isCancelled) {
          onAnswerKeyChange(mapped);
          setErrorMessage(null);
        }
      } catch (err) {
        // Silently continue if no match
      } finally {
        if (!isCancelled) setIsCheckingMappedKey(false);
      }
    };
    checkMatchingKey();
    return () => {
      isCancelled = true;
    };
  }, [questionPaperFile]);

  // Handle Mode 1: Generate Answer Key Using AI
  const handleGenerateKey = async () => {
    if (!questionPaperFile) {
      setErrorMessage('Question Paper (Required) is missing. Upload the question paper to extract questions and generate model answers.');
      return;
    }

    setErrorMessage(null);
    setIsProcessing(true);
    setProcessingStep('Extracting questions and generating answer key with AI...');

    try {
      throw new Error('Answer key generation has been removed in Anatomy Guru. Please upload the official answer key.');
    } catch (err: any) {
      setErrorMessage(err.message || 'Failed to generate answer key.');
    } finally {
      setIsProcessing(false);
      setProcessingStep('');
    }
  };

  // Handle Mode 2: Upload Existing Answer Key
  const handleExtractKey = async () => {
    if (!questionPaperFile || !answerKeyFile) {
      setErrorMessage(
        'Both Question Paper (Required) and Official Answer Key (Required) must be uploaded in Mode 2 to cross-check question numbering and mark allocation.'
      );
      return;
    }

    setErrorMessage(null);
    setIsProcessing(true);
    setProcessingStep('Parsing uploaded answer key and cross-validating against question paper...');

    try {
      const akData = await fileToData(answerKeyFile);
      const qpData = await fileToData(questionPaperFile);

      const extracted = await extractAnswerKeyApi({
        answerKeyDoc: akData,
        questionPaperDoc: qpData,
        title: examTitle || 'Official Answer Key',
        subject: subject || undefined,
        grade: grade || undefined,
        totalMaxMarks: totalMarksInput ? parseFloat(totalMarksInput) : undefined,
      });

      onAnswerKeyChange(extracted);
      setIsReviewModalOpen(true); // Open review modal immediately for faculty review & approval
    } catch (err: any) {
      setErrorMessage(err.message || 'Failed to extract answer key.');
    } finally {
      setIsProcessing(false);
      setProcessingStep('');
    }
  };

  const handleSaveModal = async (updated: CanonicalAnswerKey) => {
    const saved = await updateAnswerKeyApi(updated.id, updated);
    onAnswerKeyChange(saved);
  };

  const handleApproveModal = async (keyId: string) => {
    const res = await approveAnswerKeyApi(keyId);
    onAnswerKeyChange(res.answerKey);
  };

  return (
    <div className="space-y-6">
      {/* If an answer key is already prepared and selected */}
      {currentAnswerKey ? (
        <div className="p-6 bg-white rounded-3xl border border-slate-200 shadow-sm">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="space-y-1">
              <div className="flex items-center gap-2.5">
                <span className="text-xs font-black uppercase tracking-wider text-slate-400">
                  Configured Answer Key
                </span>
                {currentAnswerKey.status === 'approved' ? (
                  <span className="inline-flex items-center gap-1 px-2.5 py-0.5 bg-emerald-100 text-emerald-800 text-[11px] font-black rounded-full border border-emerald-200">
                    <CheckCircle className="w-3 h-3 text-emerald-600" />
                    Approved v{currentAnswerKey.version}
                  </span>
                ) : currentAnswerKey.status === 'needs_review' ? (
                  <span className="inline-flex items-center gap-1 px-2.5 py-0.5 bg-orange-100 text-orange-800 text-[11px] font-black rounded-full border border-orange-200">
                    <AlertTriangle className="w-3 h-3 text-orange-600" />
                    Needs Review (v{currentAnswerKey.version})
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 px-2.5 py-0.5 bg-amber-100 text-amber-800 text-[11px] font-black rounded-full border border-amber-200">
                    <Clock className="w-3 h-3 text-amber-600" />
                    Draft (v{currentAnswerKey.version})
                  </span>
                )}
              </div>

              <h4 className="text-lg font-black text-slate-900 tracking-tight flex items-center gap-2">
                {currentAnswerKey.sourceMode === 'ai_generated' ? (
                  <Sparkles className="w-4 h-4 text-purple-600 shrink-0" />
                ) : (
                  <FileText className="w-4 h-4 text-emerald-600 shrink-0" />
                )}
                {currentAnswerKey.title}
              </h4>

              <p className="text-xs text-slate-500 font-medium">
                {currentAnswerKey.questions?.length || 0} Questions • Total {currentAnswerKey.totalMaxMarks} Marks • Mode: {currentAnswerKey.sourceMode === 'ai_generated' ? 'AI Generated (Mode 1)' : 'Uploaded Key (Mode 2)'}
                {currentAnswerKey.metadata?.approvedBy && (
                  <span> • Approved by: {currentAnswerKey.metadata.approvedBy}</span>
                )}
              </p>
            </div>

            <div className="flex items-center gap-2.5 shrink-0">
              <button
                type="button"
                onClick={() => setIsReviewModalOpen(true)}
                className="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-800 rounded-xl text-xs font-bold transition-all flex items-center gap-1.5 cursor-pointer"
              >
                <Edit3 className="w-3.5 h-3.5" />
                Review & Edit
              </button>

              {currentAnswerKey.status !== 'approved' ? (
                <button
                  type="button"
                  onClick={() => setIsReviewModalOpen(true)}
                  className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-xs font-black shadow-md shadow-emerald-600/20 transition-all flex items-center gap-1.5 cursor-pointer"
                >
                  <ShieldCheck className="w-3.5 h-3.5" />
                  Approve Key
                </button>
              ) : (
                <span className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-emerald-50 text-emerald-700 rounded-xl text-xs font-bold border border-emerald-200">
                  <Check className="w-3.5 h-3.5 text-emerald-600" />
                  Ready for Evaluation
                </span>
              )}

              <button
                type="button"
                onClick={() => onAnswerKeyChange(null)}
                className="p-2 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-xl transition-all cursor-pointer"
                title="Prepare different answer key"
              >
                <RotateCcw className="w-4 h-4" />
              </button>
            </div>
          </div>

          {currentAnswerKey.status !== 'approved' ? (
            <div className="mt-4 p-3 bg-amber-50 border border-amber-200 rounded-xl flex items-center gap-2.5 text-xs text-amber-800">
              <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
              <span>
                <strong>Human approval required:</strong> The student grading pipeline strictly requires an <strong>approved</strong> answer key. Click "Approve Key" above to open the coordinated PDF review workspace and sign off.
              </span>
            </div>
          ) : (
            <div className="mt-4 p-3 bg-emerald-50 border border-emerald-200 rounded-xl flex items-center gap-2.5 text-xs text-emerald-800">
              <CheckCircle className="w-4 h-4 text-emerald-600 shrink-0" />
              <span>
                <strong>Approved & Locked:</strong> This canonical answer key will be reused across student submissions without re-evaluating exam questions. Any subsequent edits will increment version and require re-approval.
              </span>
            </div>
          )}
        </div>
      ) : (
        /* If no answer key is selected: Mode selection and generation form */
        <div className="space-y-6">
          {/* Quick Select: Previously Approved Answer Keys */}
          {approvedKeysList.length > 0 && (
            <div className="p-4 bg-slate-900 text-white rounded-2xl shadow-md border border-slate-800">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-3">
                <div className="flex items-center gap-2">
                  <div className="w-7 h-7 rounded-lg bg-emerald-500/20 text-emerald-400 flex items-center justify-center font-bold text-xs">
                    ✓
                  </div>
                  <div>
                    <h5 className="text-xs font-black uppercase tracking-wider text-slate-200">
                      Previously Approved Answer Keys ({approvedKeysList.length})
                    </h5>
                    <p className="text-[11px] text-slate-400">
                      Select an existing approved exam to directly evaluate student scripts without re-uploading documents.
                    </p>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2">
                {approvedKeysList.map((key) => (
                  <button
                    key={key.id}
                    type="button"
                    onClick={() => {
                      onAnswerKeyChange(key);
                      setErrorMessage(null);
                    }}
                    className="p-3 bg-slate-800 hover:bg-slate-700 text-left rounded-xl border border-slate-700/60 hover:border-emerald-500/50 transition-all cursor-pointer group flex flex-col justify-between"
                  >
                    <div>
                      <div className="flex items-center justify-between gap-1 mb-1">
                        <span className="text-xs font-bold text-white group-hover:text-emerald-300 transition-colors truncate">
                          {key.title || 'Examination Key'}
                        </span>
                        <span className="px-1.5 py-0.5 bg-emerald-950 text-emerald-400 text-[9px] font-black rounded-md border border-emerald-800 shrink-0">
                          v{key.version}
                        </span>
                      </div>
                      <p className="text-[10px] text-slate-400">
                        {key.subject ? `${key.subject} • ` : ''}{key.questions?.length || 0} Questions • {key.totalMaxMarks} Marks
                      </p>
                    </div>
                    <div className="mt-2 pt-1 border-t border-slate-700/40 flex items-center justify-between text-[10px] text-emerald-400 font-bold">
                      <span>Use this key</span>
                      <span>→</span>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {isCheckingMappedKey && (
            <div className="p-3 bg-blue-50 border border-blue-200 rounded-xl flex items-center gap-2 text-xs font-medium text-blue-800">
              <div className="w-3.5 h-3.5 border-2 border-blue-600 border-t-transparent rounded-full animate-spin"></div>
              <span>Checking if an approved answer key is already mapped to this question paper...</span>
            </div>
          )}

          {/* Mode Selection Cards */}
          <div className="grid sm:grid-cols-2 gap-4">
            {/* Mode 1 Card */}
            <div
              onClick={() => {
                setSelectedMode('ai_generated');
                setErrorMessage(null);
              }}
              className={`p-5 rounded-2xl border-2 transition-all cursor-pointer flex flex-col justify-between ${
                selectedMode === 'ai_generated'
                  ? 'border-purple-600 bg-purple-50/40 shadow-sm'
                  : 'border-slate-200 bg-white hover:border-slate-300 opacity-80'
              }`}
            >
              <div>
                <div className="flex items-center justify-between mb-2">
                  <div className="w-10 h-10 rounded-xl bg-purple-100 text-purple-600 flex items-center justify-center">
                    <Sparkles className="w-5 h-5" />
                  </div>
                  {selectedMode === 'ai_generated' && (
                    <span className="w-5 h-5 rounded-full bg-purple-600 text-white flex items-center justify-center">
                      <Check className="w-3 h-3" />
                    </span>
                  )}
                </div>
                <h4 className="font-extrabold text-slate-900 text-sm">
                  1. Generate Answer Key Using AI
                </h4>
                <p className="text-xs text-slate-500 mt-1 leading-relaxed">
                  Upload the question paper to extract questions, generate model answers, and prepare marking rubrics for faculty review.
                </p>
              </div>
              <div className="mt-3 pt-2 border-t border-purple-100/50 flex items-center gap-1.5 text-[11px] font-bold text-purple-700">
                <span>Requires Question Paper (Required) only</span>
              </div>
            </div>

            {/* Mode 2 Card */}
            <div
              onClick={() => {
                setSelectedMode('uploaded');
                setErrorMessage(null);
              }}
              className={`p-5 rounded-2xl border-2 transition-all cursor-pointer flex flex-col justify-between ${
                selectedMode === 'uploaded'
                  ? 'border-emerald-600 bg-emerald-50/40 shadow-sm'
                  : 'border-slate-200 bg-white hover:border-slate-300 opacity-80'
              }`}
            >
              <div>
                <div className="flex items-center justify-between mb-2">
                  <div className="w-10 h-10 rounded-xl bg-emerald-100 text-emerald-600 flex items-center justify-center">
                    <Upload className="w-5 h-5" />
                  </div>
                  {selectedMode === 'uploaded' && (
                    <span className="w-5 h-5 rounded-full bg-emerald-600 text-white flex items-center justify-center">
                      <Check className="w-3 h-3" />
                    </span>
                  )}
                </div>
                <h4 className="font-extrabold text-slate-900 text-sm">
                  2. Upload Existing Answer Key
                </h4>
                <p className="text-xs text-slate-500 mt-1 leading-relaxed">
                  Upload both documents to structure the official answers and cross-check question numbering, subquestions, and mark allocation.
                </p>
              </div>
              <div className="mt-3 pt-2 border-t border-emerald-100/50 flex items-center gap-1.5 text-[11px] font-bold text-emerald-700">
                <span>Requires Question Paper (Required) & Official Answer Key (Required)</span>
              </div>
            </div>
          </div>

          {/* Metadata Controls */}
          <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="text-[10px] font-black uppercase tracking-wider text-slate-400 block mb-1">
                Exam Title
              </label>
              <input
                type="text"
                value={examTitle}
                onChange={(e) => setExamTitle(e.target.value)}
                className="w-full text-xs font-bold text-slate-800 px-3 py-2 rounded-xl border border-slate-200 focus:outline-none focus:border-blue-500"
                placeholder="e.g. Calculus / Data Structures / Chemistry / Economics"
              />
            </div>
            <div>
              <label className="text-[10px] font-black uppercase tracking-wider text-slate-400 block mb-1">
                Subject
              </label>
              <input
                type="text"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                className="w-full text-xs font-bold text-slate-800 px-3 py-2 rounded-xl border border-slate-200 focus:outline-none focus:border-blue-500"
                placeholder="e.g. Mathematics / Computer Science / Sciences / Humanities"
              />
            </div>
            <div>
              <label className="text-[10px] font-black uppercase tracking-wider text-slate-400 block mb-1">
                Target Total Marks (Optional)
              </label>
              <input
                type="number"
                value={totalMarksInput}
                onChange={(e) => setTotalMarksInput(e.target.value)}
                className="w-full text-xs font-bold text-slate-800 px-3 py-2 rounded-xl border border-slate-200 focus:outline-none focus:border-blue-500"
                placeholder="e.g. 50"
              />
            </div>
          </div>

          {/* Mode 1 Form: Question Paper Upload & Generate */}
          {selectedMode === 'ai_generated' && (
            <div className="space-y-4">
              <FileUploader
                label="Question Paper (Required)"
                description="Upload the question paper to extract questions, generate model answers, and prepare marking rubrics for faculty review."
                onFileSelect={onQuestionPaperFileChange}
                selectedFile={questionPaperFile}
                icon={<svg className="w-8 h-8 text-purple-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253"></path></svg>}
              />

              <button
                type="button"
                onClick={handleGenerateKey}
                disabled={!questionPaperFile || isProcessing}
                className={`w-full py-3.5 rounded-xl font-bold text-sm shadow-md transition-all flex items-center justify-center gap-2 cursor-pointer ${
                  !questionPaperFile || isProcessing
                    ? 'bg-slate-100 text-slate-400 cursor-not-allowed border border-slate-200'
                    : 'bg-purple-600 hover:bg-purple-700 text-white shadow-purple-600/20'
                }`}
              >
                {isProcessing ? (
                  <>
                    <svg className="animate-spin h-4 w-4 text-white" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
                    <span>{processingStep}</span>
                  </>
                ) : (
                  <>
                    <Sparkles className="w-4 h-4" />
                    <span>Generate Answer Key Using AI</span>
                  </>
                )}
              </button>
            </div>
          )}

          {/* Mode 2 Form: Upload Existing Answer Key */}
          {selectedMode === 'uploaded' && (
            <div className="space-y-4">
              <div className="grid md:grid-cols-2 gap-4">
                <FileUploader
                  label="Question Paper (Required)"
                  description="Question Paper for question number cross-verification and missing question checks."
                  onFileSelect={onQuestionPaperFileChange}
                  selectedFile={questionPaperFile}
                  icon={<svg className="w-8 h-8 text-amber-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253"></path></svg>}
                />

                <FileUploader
                  label="Official Answer Key / Model Answers / Marking Scheme (Required)"
                  description="Official model answers or marking scheme (PDF, DOCX, or Image)."
                  onFileSelect={onAnswerKeyFileChange}
                  selectedFile={answerKeyFile}
                  icon={<svg className="w-8 h-8 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"></path></svg>}
                />
              </div>

              <button
                type="button"
                onClick={handleExtractKey}
                disabled={!answerKeyFile || !questionPaperFile || isProcessing}
                className={`w-full py-3.5 rounded-xl font-bold text-sm shadow-md transition-all flex items-center justify-center gap-2 cursor-pointer ${
                  !answerKeyFile || !questionPaperFile || isProcessing
                    ? 'bg-slate-100 text-slate-400 cursor-not-allowed border border-slate-200'
                    : 'bg-emerald-600 hover:bg-emerald-700 text-white shadow-emerald-600/20'
                }`}
              >
                {isProcessing ? (
                  <>
                    <svg className="animate-spin h-4 w-4 text-white" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
                    <span>{processingStep}</span>
                  </>
                ) : (
                  <>
                    <Upload className="w-4 h-4" />
                    <span>Extract & Structure Answer Key</span>
                  </>
                )}
              </button>
            </div>
          )}

          {/* Error Message */}
          {errorMessage && (
            <div className="bg-red-50 border border-red-200 text-red-700 p-3.5 rounded-xl flex items-center gap-2 text-xs font-bold">
              <AlertTriangle className="w-4 h-4 shrink-0 text-red-600" />
              <span>{errorMessage}</span>
            </div>
          )}
        </div>
      )}

      {/* Review & Approval Modal with Coordinated PDF Workspace */}
      {currentAnswerKey && (
        <AnswerKeyReviewModal
          isOpen={isReviewModalOpen}
          answerKey={currentAnswerKey}
          questionPaperFile={questionPaperFile}
          answerKeyFile={answerKeyFile}
          onClose={() => setIsReviewModalOpen(false)}
          onSave={handleSaveModal}
          onApprove={handleApproveModal}
          isLoading={isProcessing}
        />
      )}
    </div>
  );
};
