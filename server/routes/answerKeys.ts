/**
 * Answer Key Management and Workflow API Routes for NextGen Eval
 *
 * Implements:
 * - Mode 1: POST /api/answer-keys/generate (Generate using AI from Question Paper)
 * - Mode 2: POST /api/answer-keys/extract (Extract from Uploaded Answer Key Document)
 * - GET /api/answer-keys (List scoped by institution)
 * - GET /api/answer-keys/:id (Get specific answer key)
 * - PUT /api/answer-keys/:id (Edit answer key; bumps version & resets to draft if approved)
 * - POST /api/answer-keys/:id/approve (Explicit instructor approval)
 * - DELETE /api/answer-keys/:id (Delete answer key)
 */

import { Router, Request, Response } from 'express';
import { requireAuth, UserContext } from '../auth';
import {
  answerKeyService,
  AnswerKeyValidationError,
} from '../answerKeyService';

export const answerKeysRouter = Router();

// Apply authentication middleware to all answer keys routes
answerKeysRouter.use(requireAuth);

const ALLOWED_MIME_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'text/plain',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
];

function validateDoc(doc: any, fieldName: string): string | null {
  if (!doc) return `${fieldName} is required.`;
  if (typeof doc !== 'object') {
    return `${fieldName} must be an object.`;
  }
  if (doc.mimeType && !ALLOWED_MIME_TYPES.includes(String(doc.mimeType).toLowerCase())) {
    return `${fieldName} has unsupported MIME type: '${doc.mimeType}'. Allowed formats: PDF, JPEG, PNG, WebP, plain text, DOCX.`;
  }
  if (!doc.text && !doc.base64) {
    return `${fieldName} must contain text or visual base64 content.`;
  }
  return null;
}

/**
 * POST /api/answer-keys/find-pair
 * Finds approved answer key by full content hash of (Question Paper + Answer Key) pair
 */
answerKeysRouter.post('/find-pair', async (req: Request, res: Response): Promise<void> => {
  try {
    const user = (req as any).user as UserContext;
    const { questionPaperDoc, answerKeyDoc } = req.body;
    const found = answerKeyService.findApprovedKeyForReferencePair(questionPaperDoc, answerKeyDoc, user);
    if (found) {
      res.json(found);
    } else {
      res.status(404).json({ error: 'No approved key found for this document pair.' });
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Error looking up reference pair' });
  }
});

/**
 * POST /api/answer-keys/extract
 * Mode 2: Upload Existing Answer Key
 */
answerKeysRouter.post('/extract', async (req: Request, res: Response): Promise<void> => {
  try {
    const user = (req as any).user as UserContext;
    const { answerKeyDoc, questionPaperDoc, title, subject, grade, totalMaxMarks } = req.body;

    const docErr = validateDoc(answerKeyDoc, 'answerKeyDoc');
    if (docErr) {
      res.status(400).json({ error: docErr });
      return;
    }

    if (!questionPaperDoc) {
      res.status(400).json({ error: 'questionPaperDoc is required in Mode 2 for cross-referencing and verification.' });
      return;
    }

    const qpErr = validateDoc(questionPaperDoc, 'questionPaperDoc');
    if (qpErr) {
      res.status(400).json({ error: qpErr });
      return;
    }

    const key = await answerKeyService.extractFromUploadedKey({
      answerKeyDoc,
      questionPaperDoc,
      title: title || 'Uploaded Answer Key',
      subject,
      grade,
      totalMaxMarks: totalMaxMarks ? Number(totalMaxMarks) : undefined,
      metadata: {
        institutionId: user.institutionId,
        createdBy: user.userId,
      },
    });

    res.status(201).json(key);
  } catch (err: any) {
    console.error('[answerKeysRouter] Extract error:', err);
    const isApiKeyMissing = /GEMINI_API_KEY is not configured/i.test(err?.message || '');
    if (isApiKeyMissing) {
      res.status(503).json({
        error: 'GEMINI_API_KEY is not configured in Netlify environment variables. Please add GEMINI_API_KEY in your Netlify site settings (Site configuration > Environment variables).',
        category: 'Configuration Error',
        retryable: false,
        statusCode: 503,
      });
      return;
    }
    res.status(500).json({ error: err.message || 'Failed to extract answer key.' });
  }
});

/**
 * GET /api/answer-keys
 * List answer keys for user's institution
 */
answerKeysRouter.get('/', (req: Request, res: Response): void => {
  try {
    const user = (req as any).user as UserContext;
    const keys = answerKeyService.listAnswerKeys(user);
    res.json({ answerKeys: keys });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to list answer keys.' });
  }
});

/**
 * POST /api/answer-keys/find-pair
 * Look up an approved answer key mapped to a question paper + answer key document pair (SHA-256 hash)
 */
answerKeysRouter.post('/find-pair', (req: Request, res: Response): void => {
  try {
    const user = (req as any).user as UserContext;
    const { questionPaper, answerKey } = req.body;
    if (!questionPaper || !answerKey) {
      res.status(400).json({ error: 'Both questionPaper and answerKey documents are required.' });
      return;
    }
    const found = answerKeyService.findApprovedKeyForReferencePair(questionPaper, answerKey, user);
    res.json({ answerKey: found || null });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to search answer keys by pair.' });
  }
});

/**
 * POST /api/answer-keys/find-by-qp
 * Look up an approved answer key mapped to a question paper
 */
answerKeysRouter.post('/find-by-qp', (req: Request, res: Response): void => {
  try {
    const user = (req as any).user as UserContext;
    const { questionPaper } = req.body;
    if (!questionPaper) {
      res.status(400).json({ error: 'questionPaper document is required.' });
      return;
    }
    const found = answerKeyService.findApprovedKeyForQuestionPaper(questionPaper, user);
    res.json({ answerKey: found || null });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to search answer keys.' });
  }
});

/**
 * GET /api/answer-keys/latest-approved
 * Retrieve the latest approved answer key for the user's institution
 */
answerKeysRouter.get('/latest-approved', (req: Request, res: Response): void => {
  try {
    const user = (req as any).user as UserContext;
    const latest = answerKeyService.getLatestApprovedKey(user);
    res.json({ answerKey: latest || null });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to fetch latest approved answer key.' });
  }
});

/**
 * GET /api/answer-keys/:id
 * Retrieve specific answer key
 */
answerKeysRouter.get('/:id', (req: Request, res: Response): void => {
  try {
    const user = (req as any).user as UserContext;
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const key = answerKeyService.getAnswerKey(id, user);

    if (!key) {
      res.status(404).json({ error: `Answer key ${id} not found.` });
      return;
    }

    res.json(key);
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to fetch answer key.' });
  }
});

/**
 * PUT /api/answer-keys/:id
 * Edit answer key (increments version and resets approval if previously approved)
 */
answerKeysRouter.put('/:id', (req: Request, res: Response): void => {
  try {
    const user = (req as any).user as UserContext;
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

    const updated = answerKeyService.updateAnswerKey(id, req.body, user);
    res.json(updated);
  } catch (err: any) {
    if (err instanceof AnswerKeyValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    res.status(500).json({ error: err.message || 'Failed to update answer key.' });
  }
});

/**
 * POST /api/answer-keys/:id/approve
 * Explicitly approve an answer key (validates all questions have maxMarks > 0)
 */
answerKeysRouter.post('/:id/approve', (req: Request, res: Response): void => {
  try {
    const user = (req as any).user as UserContext;
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

    const approved = answerKeyService.approveAnswerKey(id, user, req.body?.notes);
    res.json({
      message: 'Answer key approved successfully.',
      answerKey: approved,
    });
  } catch (err: any) {
    if (err instanceof AnswerKeyValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    res.status(500).json({ error: err.message || 'Failed to approve answer key.' });
  }
});

/**
 * DELETE /api/answer-keys/:id
 * Delete answer key
 */
answerKeysRouter.delete('/:id', (req: Request, res: Response): void => {
  try {
    const user = (req as any).user as UserContext;
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

    const deleted = answerKeyService.deleteAnswerKey(id, user);
    if (!deleted) {
      res.status(404).json({ error: `Answer key ${id} not found or could not be deleted.` });
      return;
    }

    res.status(204).send();
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to delete answer key.' });
  }
});
