import React, { useState } from 'react';
import { CanonicalAnswerKey, CanonicalQuestionKey, getCompleteQuestionIdentifier, calculateCanonicalKeyMarks } from '../types';
import { ExamDocViewer } from './ExamDocViewer';
import { 
  CheckCircle, 
  AlertTriangle, 
  Clock, 
  Plus, 
  Trash2, 
  Save, 
  X, 
  Sparkles, 
  FileText, 
  ShieldCheck,
  Edit2,
  Check,
  AlertCircle,
  Columns,
  Eye,
  Sliders,
  HelpCircle
} from 'lucide-react';

interface AnswerKeyReviewModalProps {
  isOpen: boolean;
  answerKey: CanonicalAnswerKey;
  questionPaperFile?: File | null;
  answerKeyFile?: File | null;
  onClose: () => void;
  onSave: (updated: CanonicalAnswerKey) => Promise<void>;
  onApprove: (keyId: string) => Promise<void>;
  isLoading?: boolean;
}

export const AnswerKeyReviewModal: React.FC<AnswerKeyReviewModalProps> = ({
  isOpen,
  answerKey,
  questionPaperFile,
  answerKeyFile,
  onClose,
  onSave,
  onApprove,
  isLoading = false,
}) => {
  const [editedKey, setEditedKey] = useState<CanonicalAnswerKey>(() => JSON.parse(JSON.stringify(answerKey)));
  const [saveStatus, setSaveStatus] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [activeFilter, setActiveFilter] = useState<'all' | 'flagged'>('all');
  const [isApproving, setIsApproving] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [viewMode, setViewMode] = useState<'split' | 'editor_only' | 'doc_only'>('split');

  if (!isOpen) return null;

  const questions = editedKey.questions || [];

  // Validation Checks
  const validationErrors: string[] = [];
  const seenIds = new Set<string>();

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const completeId = getCompleteQuestionIdentifier(q);
    if (!completeId) {
      validationErrors.push(`Question #${i + 1} has an empty identifier.`);
    } else if (seenIds.has(completeId)) {
      validationErrors.push(`Duplicate question number: "${completeId}". Each question must have a unique identifier.`);
    } else {
      seenIds.add(completeId);
    }

    const marks = Number(q.maxMarks);
    if (!Number.isFinite(marks) || marks <= 0) {
      validationErrors.push(`Question "${completeId || i + 1}" has invalid maximum marks (${q.maxMarks}). Must be positive (> 0).`);
    }

    if (!q.referenceAnswer || q.referenceAnswer.trim().length === 0) {
      validationErrors.push(`Question "${completeId || i + 1}" is missing a reference model answer.`);
    }
  }

  const marksValidation = calculateCanonicalKeyMarks(questions, editedKey.printedMaxMarks);
  const calculatedTotal = marksValidation.calculatedTotalMarks;
  const printedMax = editedKey.printedMaxMarks;
  const hasMarksMismatch = printedMax !== undefined && printedMax > 0 && Math.abs(calculatedTotal - printedMax) > 0.05;
  const flaggedCount = questions.filter((q) => Boolean(q.flaggedIssue)).length;
  const isApproved = editedKey.status === 'approved';
  const isValidForApproval = validationErrors.length === 0 && questions.length > 0;

  const handleQuestionChange = (idx: number, field: keyof CanonicalQuestionKey, value: any) => {
    const nextQuestions = [...questions];
    nextQuestions[idx] = {
      ...nextQuestions[idx],
      [field]: value,
    };

    if (field === 'maxMarks' && Number(value) > 0 && nextQuestions[idx].flaggedIssue?.includes('maximum marks')) {
      nextQuestions[idx].flaggedIssue = undefined;
    }

    const nextVal = calculateCanonicalKeyMarks(nextQuestions, editedKey.printedMaxMarks);
    setEditedKey({
      ...editedKey,
      questions: nextQuestions,
      totalMaxMarks: nextVal.calculatedTotalMarks,
      marksValidation: nextVal,
    });
  };

  const handleResolveFlag = (idx: number) => {
    const nextQuestions = [...questions];
    nextQuestions[idx] = {
      ...nextQuestions[idx],
      flaggedIssue: undefined,
    };
    setEditedKey({
      ...editedKey,
      questions: nextQuestions,
    });
  };

  const handleAddConcept = (qIdx: number) => {
    const nextQuestions = [...questions];
    const concepts = [...(nextQuestions[qIdx].expectedConcepts || []), 'New key concept'];
    nextQuestions[qIdx] = { ...nextQuestions[qIdx], expectedConcepts: concepts };
    setEditedKey({ ...editedKey, questions: nextQuestions });
  };

  const handleRemoveConcept = (qIdx: number, cIdx: number) => {
    const nextQuestions = [...questions];
    const concepts = (nextQuestions[qIdx].expectedConcepts || []).filter((_, idx) => idx !== cIdx);
    nextQuestions[qIdx] = { ...nextQuestions[qIdx], expectedConcepts: concepts };
    setEditedKey({ ...editedKey, questions: nextQuestions });
  };

  const handleConceptChange = (qIdx: number, cIdx: number, val: string) => {
    const nextQuestions = [...questions];
    const concepts = [...(nextQuestions[qIdx].expectedConcepts || [])];
    concepts[cIdx] = val;
    nextQuestions[qIdx] = { ...nextQuestions[qIdx], expectedConcepts: concepts };
    setEditedKey({ ...editedKey, questions: nextQuestions });
  };

  const handleAddCriteria = (qIdx: number) => {
    const nextQuestions = [...questions];
    const criteria = [...(nextQuestions[qIdx].markingCriteria || []), 'Award full marks for thorough explanation'];
    nextQuestions[qIdx] = { ...nextQuestions[qIdx], markingCriteria: criteria };
    setEditedKey({ ...editedKey, questions: nextQuestions });
  };

  const handleRemoveCriteria = (qIdx: number, crIdx: number) => {
    const nextQuestions = [...questions];
    const criteria = (nextQuestions[qIdx].markingCriteria || []).filter((_, idx) => idx !== crIdx);
    nextQuestions[qIdx] = { ...nextQuestions[qIdx], markingCriteria: criteria };
    setEditedKey({ ...editedKey, questions: nextQuestions });
  };

  const handleCriteriaChange = (qIdx: number, crIdx: number, val: string) => {
    const nextQuestions = [...questions];
    const criteria = [...(nextQuestions[qIdx].markingCriteria || [])];
    criteria[crIdx] = val;
    nextQuestions[qIdx] = { ...nextQuestions[qIdx], markingCriteria: criteria };
    setEditedKey({ ...editedKey, questions: nextQuestions });
  };

  const handleAddAlternative = (qIdx: number) => {
    const nextQuestions = [...questions];
    const alts = [...(nextQuestions[qIdx].acceptableAlternatives || []), 'Accept alternative valid approach or synonym'];
    nextQuestions[qIdx] = { ...nextQuestions[qIdx], acceptableAlternatives: alts };
    setEditedKey({ ...editedKey, questions: nextQuestions });
  };

  const handleRemoveAlternative = (qIdx: number, aIdx: number) => {
    const nextQuestions = [...questions];
    const alts = (nextQuestions[qIdx].acceptableAlternatives || []).filter((_, idx) => idx !== aIdx);
    nextQuestions[qIdx] = { ...nextQuestions[qIdx], acceptableAlternatives: alts };
    setEditedKey({ ...editedKey, questions: nextQuestions });
  };

  const handleAlternativeChange = (qIdx: number, aIdx: number, val: string) => {
    const nextQuestions = [...questions];
    const alts = [...(nextQuestions[qIdx].acceptableAlternatives || [])];
    alts[aIdx] = val;
    nextQuestions[qIdx] = { ...nextQuestions[qIdx], acceptableAlternatives: alts };
    setEditedKey({ ...editedKey, questions: nextQuestions });
  };

  const handleAddQuestion = () => {
    const nextQId = String(questions.length + 1);
    const newQuestion: CanonicalQuestionKey = {
      questionId: nextQId,
      maxMarks: 5,
      referenceAnswer: 'Model answer for Question ' + nextQId,
      expectedConcepts: ['Key concept 1', 'Key concept 2'],
      acceptableAlternatives: ['Acceptable equivalent formulation, method, or alternative phrasing'],
      markingCriteria: ['Award full marks for complete solution or definition', 'Award partial credit for sound intermediate steps/working'],
    };
    const nextQuestions = [...questions, newQuestion];
    const nextVal = calculateCanonicalKeyMarks(nextQuestions, editedKey.printedMaxMarks);
    setEditedKey({
      ...editedKey,
      questions: nextQuestions,
      totalMaxMarks: nextVal.calculatedTotalMarks,
      marksValidation: nextVal,
    });
  };

  const handleRemoveQuestion = (idx: number) => {
    if (questions.length <= 1) {
      alert('Answer key must contain at least one question.');
      return;
    }
    const nextQuestions = questions.filter((_, i) => i !== idx);
    const nextVal = calculateCanonicalKeyMarks(nextQuestions, editedKey.printedMaxMarks);
    setEditedKey({
      ...editedKey,
      questions: nextQuestions,
      totalMaxMarks: nextVal.calculatedTotalMarks,
      marksValidation: nextVal,
    });
  };

  const handleSaveOnly = async () => {
    setIsSaving(true);
    setErrorMsg(null);
    setSaveStatus(null);
    try {
      await onSave(editedKey);
      setSaveStatus('Changes saved successfully. Answer key remains in draft until approved.');
      setTimeout(() => setSaveStatus(null), 4000);
    } catch (err: any) {
      setErrorMsg(err.message || 'Failed to save changes.');
    } finally {
      setIsSaving(false);
    }
  };

  const handleApproveKey = async () => {
    if (!isValidForApproval) {
      setErrorMsg('Cannot approve answer key. Please resolve all validation errors first.');
      return;
    }

    setIsApproving(true);
    setErrorMsg(null);
    try {
      // 1. Save any pending question edits first
      await onSave(editedKey);
      // 2. Explicitly sign-off and approve
      await onApprove(editedKey.id);
      onClose();
    } catch (err: any) {
      setErrorMsg(err.message || 'Approval failed.');
    } finally {
      setIsApproving(false);
    }
  };

  const displayedQuestions = questions.filter((q) => {
    if (activeFilter === 'flagged') return Boolean(q.flaggedIssue);
    return true;
  });

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-md flex items-center justify-center p-2 sm:p-4">
      <div className="bg-white w-full h-[95vh] max-w-[1400px] rounded-3xl shadow-2xl flex flex-col overflow-hidden border border-slate-200 animate-in fade-in zoom-in-95 duration-200">
        {/* Header Bar */}
        <div className="bg-white px-6 py-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-4 shrink-0">
          <div className="flex items-center gap-3">
            <div className={`w-10 h-10 rounded-2xl flex items-center justify-center ${
              editedKey.sourceMode === 'ai_generated' ? 'bg-purple-100 text-purple-600' : 'bg-emerald-100 text-emerald-600'
            }`}>
              {editedKey.sourceMode === 'ai_generated' ? <Sparkles className="w-5 h-5" /> : <FileText className="w-5 h-5" />}
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="font-black text-slate-900 text-base tracking-tight">
                  {editedKey.title || 'Exam Answer Key'}
                </h3>
                {isApproved ? (
                  <span className="inline-flex items-center gap-1 px-2.5 py-0.5 bg-emerald-100 text-emerald-800 text-[11px] font-black rounded-full border border-emerald-200">
                    <CheckCircle className="w-3 h-3 text-emerald-600" />
                    Approved v{editedKey.version}
                  </span>
                ) : editedKey.status === 'needs_review' ? (
                  <span className="inline-flex items-center gap-1 px-2.5 py-0.5 bg-orange-100 text-orange-800 text-[11px] font-black rounded-full border border-orange-200">
                    <AlertTriangle className="w-3 h-3 text-orange-600" />
                    Needs Review (v{editedKey.version})
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 px-2.5 py-0.5 bg-amber-100 text-amber-800 text-[11px] font-black rounded-full border border-amber-200">
                    <Clock className="w-3 h-3 text-amber-600" />
                    Draft (v{editedKey.version})
                  </span>
                )}
              </div>
              <p className="text-xs text-slate-500 font-medium">
                Mode: {editedKey.sourceMode === 'ai_generated' ? 'AI-Generated from Question Paper' : 'Extracted from Uploaded Answer Key'} • 
                Total Marks: <strong className="text-slate-800 font-bold">{calculatedTotal}</strong>
                {hasMarksMismatch && (
                  <span className="text-amber-600 font-semibold"> (Printed: {printedMax} max marks)</span>
                )}
                {flaggedCount > 0 && (
                  <span className="text-amber-600 font-bold"> • {flaggedCount} flagged issue{flaggedCount > 1 ? 's' : ''}</span>
                )}
              </p>
            </div>
          </div>

          {/* View Toggles & Close */}
          <div className="flex items-center gap-3">
            <div className="hidden md:flex items-center bg-slate-100 p-1 rounded-xl border border-slate-200 text-xs font-bold text-slate-600">
              <button
                type="button"
                onClick={() => setViewMode('split')}
                className={`px-3 py-1 rounded-lg transition-all cursor-pointer ${
                  viewMode === 'split' ? 'bg-white text-slate-900 shadow-sm' : 'hover:text-slate-900'
                }`}
              >
                Side-by-Side Coordinated View
              </button>
              <button
                type="button"
                onClick={() => setViewMode('editor_only')}
                className={`px-3 py-1 rounded-lg transition-all cursor-pointer ${
                  viewMode === 'editor_only' ? 'bg-white text-slate-900 shadow-sm' : 'hover:text-slate-900'
                }`}
              >
                Structured Editor Only
              </button>
              <button
                type="button"
                onClick={() => setViewMode('doc_only')}
                className={`px-3 py-1 rounded-lg transition-all cursor-pointer ${
                  viewMode === 'doc_only' ? 'bg-white text-slate-900 shadow-sm' : 'hover:text-slate-900'
                }`}
              >
                PDF View Only
              </button>
            </div>

            <button
              type="button"
              onClick={onClose}
              className="p-2 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-xl transition-all cursor-pointer"
              title="Close Workspace"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Validation / Notice Banners */}
        {errorMsg && (
          <div className="bg-red-50 border-b border-red-200 px-6 py-2.5 flex items-center gap-2 text-xs text-red-700 font-bold">
            <AlertCircle className="w-4 h-4 shrink-0 text-red-600" />
            <span>{errorMsg}</span>
          </div>
        )}
        {saveStatus && (
          <div className="bg-emerald-50 border-b border-emerald-200 px-6 py-2.5 flex items-center gap-2 text-xs text-emerald-800 font-bold">
            <CheckCircle className="w-4 h-4 shrink-0 text-emerald-600" />
            <span>{saveStatus}</span>
          </div>
        )}
        {validationErrors.length > 0 && (
          <div className="bg-amber-50 border-b border-amber-200 px-6 py-2.5 flex items-center gap-2 text-xs text-amber-800 font-medium">
            <AlertTriangle className="w-4 h-4 shrink-0 text-amber-600" />
            <span>
              <strong>Validation Notice:</strong> {validationErrors[0]}
              {validationErrors.length > 1 && ` (+${validationErrors.length - 1} more issues)`}
            </span>
          </div>
        )}
        {hasMarksMismatch && validationErrors.length === 0 && (
          <div className="bg-amber-50 border-b border-amber-200 px-6 py-2.5 flex items-center gap-2 text-xs text-amber-800 font-medium">
            <AlertTriangle className="w-4 h-4 shrink-0 text-amber-600" />
            <span>
              <strong>Note:</strong> Calculated total marks ({calculatedTotal}) differs from printed paper maximum marks ({printedMax}). You may review and adjust question marks if needed before approving.
            </span>
          </div>
        )}
        {marksValidation.hasAmbiguousChoices && (
          <div className="bg-amber-50 border-b border-amber-200 px-6 py-2.5 flex items-center gap-2 text-xs text-amber-800 font-medium">
            <AlertTriangle className="w-4 h-4 shrink-0 text-amber-600" />
            <span>
              <strong>OR-Choice Review:</strong> {marksValidation.ambiguousChoices[0]}
              {marksValidation.ambiguousChoices.length > 1 && ` (+${marksValidation.ambiguousChoices.length - 1} more choices flagged)`}
            </span>
          </div>
        )}

        {/* Workspace Body: Split View */}
        <div className="flex-1 flex overflow-hidden">
          {/* Left Pane: PDF Document Viewer */}
          {(viewMode === 'split' || viewMode === 'doc_only') && (
            <div className={`p-4 bg-slate-900 ${viewMode === 'split' ? 'w-full md:w-1/2 border-r border-slate-200' : 'w-full'} flex flex-col`}>
              <ExamDocViewer
                answerKey={editedKey}
                questionPaperFile={questionPaperFile}
                answerKeyFile={answerKeyFile}
                className="h-full"
              />
            </div>
          )}

          {/* Right Pane: Structured Answer Key Editor */}
          {(viewMode === 'split' || viewMode === 'editor_only') && (
            <div className={`flex-1 flex flex-col bg-slate-50 overflow-hidden ${viewMode === 'split' ? 'w-full md:w-1/2' : 'w-full'}`}>
              {/* Question Filter & Actions Bar */}
              <div className="bg-white px-6 py-3 border-b border-slate-200 flex items-center justify-between gap-3 shrink-0">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-black uppercase tracking-wider text-slate-400">Filter:</span>
                  <button
                    type="button"
                    onClick={() => setActiveFilter('all')}
                    className={`px-3 py-1 rounded-lg text-xs font-bold transition-all cursor-pointer ${
                      activeFilter === 'all' ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                    }`}
                  >
                    All ({questions.length})
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveFilter('flagged')}
                    className={`px-3 py-1 rounded-lg text-xs font-bold transition-all cursor-pointer ${
                      activeFilter === 'flagged' ? 'bg-amber-600 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                    }`}
                  >
                    Needs Review ({flaggedCount})
                  </button>
                </div>

                <button
                  type="button"
                  onClick={handleAddQuestion}
                  className="px-3 py-1.5 bg-blue-50 text-blue-700 hover:bg-blue-100 rounded-xl text-xs font-bold transition-all flex items-center gap-1.5 cursor-pointer"
                >
                  <Plus className="w-3.5 h-3.5" />
                  Add Question
                </button>
              </div>

              {/* Scrollable Questions List */}
              <div className="flex-1 overflow-y-auto p-6 space-y-6">
                {displayedQuestions.map((q, qIndex) => {
                  const actualIndex = questions.findIndex((orig) => orig === q);
                  const isFlagged = Boolean(q.flaggedIssue);
                  const isInvalidMark = !Number.isFinite(Number(q.maxMarks)) || Number(q.maxMarks) <= 0;

                  return (
                    <div
                      key={actualIndex}
                      className={`bg-white rounded-2xl border p-5 shadow-sm transition-all ${
                        isInvalidMark
                          ? 'border-red-300 ring-2 ring-red-100'
                          : isFlagged
                          ? 'border-amber-300 ring-2 ring-amber-100'
                          : 'border-slate-200'
                      }`}
                    >
                      {/* Flagged Issue Alert */}
                      {isFlagged && (
                        <div className="mb-4 p-3 bg-amber-50 border border-amber-200 rounded-xl flex items-center justify-between text-xs text-amber-800">
                          <div className="flex items-center gap-2">
                            <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
                            <span><strong>Attention:</strong> {q.flaggedIssue}</span>
                          </div>
                          <button
                            type="button"
                            onClick={() => handleResolveFlag(actualIndex)}
                            className="px-2.5 py-1 bg-amber-600 hover:bg-amber-700 text-white rounded-lg text-[11px] font-bold cursor-pointer shrink-0"
                          >
                            Mark Resolved
                          </button>
                        </div>
                      )}

                      {/* Header Row: Q Number, Sub-Q, Max Marks, Delete */}
                      <div className="grid grid-cols-1 sm:grid-cols-12 gap-3 mb-4">
                        <div className="sm:col-span-3">
                          <label className="text-[10px] font-black uppercase tracking-wider text-slate-400 block mb-1">
                            Question ID *
                          </label>
                          <input
                            type="text"
                            value={q.questionId}
                            onChange={(e) => handleQuestionChange(actualIndex, 'questionId', e.target.value)}
                            className="w-full text-xs font-bold text-slate-900 px-3 py-2 rounded-xl border border-slate-200 focus:outline-none focus:border-blue-500"
                            placeholder="e.g. 1 or 2.a"
                          />
                        </div>

                        <div className="sm:col-span-3">
                          <label className="text-[10px] font-black uppercase tracking-wider text-slate-400 block mb-1">
                            Subquestion ID
                          </label>
                          <input
                            type="text"
                            value={q.subquestionId || ''}
                            onChange={(e) => handleQuestionChange(actualIndex, 'subquestionId', e.target.value)}
                            className="w-full text-xs font-bold text-slate-900 px-3 py-2 rounded-xl border border-slate-200 focus:outline-none focus:border-blue-500"
                            placeholder="e.g. a or b"
                          />
                        </div>

                        <div className="sm:col-span-4">
                          <label className="text-[10px] font-black uppercase tracking-wider text-slate-400 block mb-1">
                            Max Marks * {isInvalidMark && <span className="text-red-500">(Required &gt; 0)</span>}
                          </label>
                          <input
                            type="number"
                            step="0.5"
                            min="0.5"
                            value={q.maxMarks || ''}
                            onChange={(e) => handleQuestionChange(actualIndex, 'maxMarks', parseFloat(e.target.value) || 0)}
                            className={`w-full text-xs font-bold px-3 py-2 rounded-xl border focus:outline-none ${
                              isInvalidMark
                                ? 'border-red-400 bg-red-50/50 text-red-900'
                                : 'border-slate-200 text-slate-900 focus:border-blue-500'
                            }`}
                            placeholder="e.g. 10"
                          />
                        </div>

                        <div className="sm:col-span-2 flex items-end justify-end">
                          <button
                            type="button"
                            onClick={() => handleRemoveQuestion(actualIndex)}
                            className="p-2 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-xl transition-all cursor-pointer"
                            title="Remove Question"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </div>

                      {/* Alternative / OR Choice Configuration */}
                      <div className="mb-4 p-2.5 bg-slate-50 border border-slate-200 rounded-xl flex flex-wrap items-center gap-4 text-xs">
                        <label className="flex items-center gap-2 cursor-pointer font-bold text-slate-700">
                          <input
                            type="checkbox"
                            checked={Boolean(q.isAlternative)}
                            onChange={(e) => handleQuestionChange(actualIndex, 'isAlternative', e.target.checked)}
                            className="rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                          />
                          <span>OR Alternative Choice</span>
                        </label>
                        {q.isAlternative && (
                          <div className="flex items-center gap-2 flex-1 min-w-[200px]">
                            <span className="text-[10px] font-black uppercase tracking-wider text-slate-400 shrink-0">
                              Choice Group ID:
                            </span>
                            <input
                              type="text"
                              value={q.alternativeGroup || ''}
                              onChange={(e) => handleQuestionChange(actualIndex, 'alternativeGroup', e.target.value)}
                              placeholder="e.g. Q2_OR or SecB_Choice1"
                              className="flex-1 text-xs font-semibold px-2.5 py-1 bg-white rounded-lg border border-slate-200 focus:outline-none focus:border-blue-500"
                            />
                          </div>
                        )}
                      </div>

                      {/* Question Text */}
                      <div className="mb-4">
                        <label className="text-[10px] font-black uppercase tracking-wider text-slate-400 block mb-1">
                          Question Prompt / Syllabus Text
                        </label>
                        <input
                          type="text"
                          value={q.questionText || ''}
                          onChange={(e) => handleQuestionChange(actualIndex, 'questionText', e.target.value)}
                          className="w-full text-xs font-medium text-slate-800 px-3 py-2 rounded-xl border border-slate-200 focus:outline-none focus:border-blue-500"
                          placeholder="e.g. Describe the origin, course, relations and branches of median nerve in forearm."
                        />
                      </div>

                      {/* Reference Answer */}
                      <div className="mb-4">
                        <label className="text-[10px] font-black uppercase tracking-wider text-slate-400 block mb-1">
                          Authoritative Reference / Model Answer *
                        </label>
                        <textarea
                          rows={3}
                          value={q.referenceAnswer}
                          onChange={(e) => handleQuestionChange(actualIndex, 'referenceAnswer', e.target.value)}
                          className="w-full text-xs font-medium text-slate-800 p-3 rounded-xl border border-slate-200 focus:outline-none focus:border-blue-500 leading-relaxed font-sans"
                          placeholder="Provide the complete standard answer expected from the student..."
                        />
                      </div>

                      {/* Expected Key Concepts */}
                      <div className="mb-4">
                        <div className="flex items-center justify-between mb-1.5">
                          <label className="text-[10px] font-black uppercase tracking-wider text-slate-400">
                            Key Concepts & Core Terminology Required
                          </label>
                          <button
                            type="button"
                            onClick={() => handleAddConcept(actualIndex)}
                            className="text-[11px] font-bold text-blue-600 hover:text-blue-800 flex items-center gap-1 cursor-pointer"
                          >
                            <Plus className="w-3 h-3" /> Add Concept
                          </button>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          {(q.expectedConcepts || []).map((concept, cIdx) => (
                            <div
                              key={cIdx}
                              className="flex items-center gap-1.5 bg-blue-50 text-blue-900 px-2.5 py-1 rounded-lg border border-blue-200 text-xs font-medium"
                            >
                              <input
                                type="text"
                                value={concept}
                                onChange={(e) => handleConceptChange(actualIndex, cIdx, e.target.value)}
                                className="bg-transparent border-none text-xs text-blue-900 focus:outline-none font-medium"
                                style={{ width: `${Math.max(concept.length * 8, 80)}px` }}
                              />
                              <button
                                type="button"
                                onClick={() => handleRemoveConcept(actualIndex, cIdx)}
                                className="text-blue-400 hover:text-blue-700 cursor-pointer"
                              >
                                <X className="w-3 h-3" />
                              </button>
                            </div>
                          ))}
                          {(q.expectedConcepts || []).length === 0 && (
                            <span className="text-xs text-slate-400 italic">No concepts specified. Click Add Concept above.</span>
                          )}
                        </div>
                      </div>

                      {/* Marking Criteria (Rubric Points) */}
                      <div>
                        <div className="flex items-center justify-between mb-1.5">
                          <label className="text-[10px] font-black uppercase tracking-wider text-slate-400">
                            Partial Credit Marking Scheme & Rubrics
                          </label>
                          <button
                            type="button"
                            onClick={() => handleAddCriteria(actualIndex)}
                            className="text-[11px] font-bold text-emerald-600 hover:text-emerald-800 flex items-center gap-1 cursor-pointer"
                          >
                            <Plus className="w-3 h-3" /> Add Rubric Point
                          </button>
                        </div>
                        <div className="space-y-1.5">
                          {(q.markingCriteria || []).map((crit, crIdx) => (
                            <div key={crIdx} className="flex items-center gap-2">
                              <span className="w-4 h-4 rounded-full bg-emerald-100 text-emerald-700 text-[10px] font-bold flex items-center justify-center shrink-0">
                                {crIdx + 1}
                              </span>
                              <input
                                type="text"
                                value={crit}
                                onChange={(e) => handleCriteriaChange(actualIndex, crIdx, e.target.value)}
                                className="flex-1 text-xs text-slate-800 px-3 py-1.5 rounded-lg border border-slate-200 focus:outline-none focus:border-emerald-500 font-medium"
                                placeholder="e.g. Award 2 marks for boundaries, 3 marks for branches..."
                              />
                              <button
                                type="button"
                                onClick={() => handleRemoveCriteria(actualIndex, crIdx)}
                                className="text-slate-400 hover:text-red-600 p-1 cursor-pointer"
                              >
                                <X className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* Footer Actions Bar */}
        <div className="bg-white px-6 py-4 border-t border-slate-200 flex flex-col sm:flex-row items-center justify-between gap-4 shrink-0">
          <div className="flex items-center gap-2">
            {isValidForApproval ? (
              <div className="flex items-center gap-1.5 text-xs font-bold text-emerald-700">
                <CheckCircle className="w-4 h-4 text-emerald-600" />
                <span>Validation passed: {questions.length} questions • Total {calculatedTotal} Marks</span>
              </div>
            ) : (
              <div className="flex items-center gap-1.5 text-xs font-bold text-red-600">
                <AlertCircle className="w-4 h-4 text-red-600" />
                <span>Fix validation errors before approving: {validationErrors[0]}</span>
              </div>
            )}
          </div>

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onClose}
              disabled={isSaving || isApproving}
              className="px-4 py-2.5 text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded-xl text-xs font-bold transition-all cursor-pointer"
            >
              Cancel
            </button>

            <button
              type="button"
              onClick={handleSaveOnly}
              disabled={isSaving || isApproving}
              className="px-5 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-800 rounded-xl text-xs font-bold transition-all flex items-center gap-2 cursor-pointer"
            >
              {isSaving ? (
                <>
                  <div className="w-3.5 h-3.5 border-2 border-slate-700 border-t-transparent rounded-full animate-spin"></div>
                  <span>Saving...</span>
                </>
              ) : (
                <>
                  <Save className="w-3.5 h-3.5" />
                  <span>Save Draft</span>
                </>
              )}
            </button>

            <button
              type="button"
              onClick={handleApproveKey}
              disabled={!isValidForApproval || isApproving || isSaving}
              className={`px-6 py-2.5 rounded-xl text-xs font-black shadow-md transition-all flex items-center gap-2 cursor-pointer ${
                !isValidForApproval || isApproving || isSaving
                  ? 'bg-slate-200 text-slate-400 cursor-not-allowed shadow-none'
                  : 'bg-emerald-600 hover:bg-emerald-700 text-white shadow-emerald-600/20'
              }`}
            >
              {isApproving ? (
                <>
                  <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                  <span>Approving Key...</span>
                </>
              ) : (
                <>
                  <ShieldCheck className="w-4 h-4" />
                  <span>Validate & Approve Answer Key</span>
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
