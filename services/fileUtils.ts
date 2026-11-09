/**
 * Resilient File & Binary Stream Utility for NextGen Eval
 * Prevents DOM Event / FileReader failures, handles large files via chunking,
 * and eliminates the infamous {"isTrusted":true} error by avoiding unhandled
 * browser event rejections.
 */

/**
 * Converts an ArrayBuffer to a base64 string using fast, chunked binary processing.
 * Prevents "Maximum call stack size exceeded" errors with large files.
 */
export const arrayBufferToBase64 = (buffer: ArrayBuffer): string => {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const len = bytes.byteLength;
  const chunkSize = 16384; // 16KB safe chunk size
  for (let i = 0; i < len; i += chunkSize) {
    const chunk = bytes.subarray(i, Math.min(i + chunkSize, len));
    binary += String.fromCharCode.apply(null, chunk as unknown as number[]);
  }
  return btoa(binary);
};

/**
 * Converts a Uint8Array to a base64 string using fast, chunked binary processing.
 */
export const uint8ArrayToBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  const len = bytes.byteLength;
  const chunkSize = 16384;
  for (let i = 0; i < len; i += chunkSize) {
    const chunk = bytes.subarray(i, Math.min(i + chunkSize, len));
    binary += String.fromCharCode.apply(null, chunk as unknown as number[]);
  }
  return btoa(binary);
};

/**
 * Safely converts any File or Blob to a pure Base64 string (without the data URL prefix).
 * Prioritizes file.arrayBuffer() to bypass FileReader lifecycle quirks, memory leaks,
 * and DOM ProgressEvent rejections entirely.
 */
export const safeFileToBase64 = async (file: File | Blob): Promise<string> => {
  const fileName = (file as File).name || 'document';
  
  // Strategy 1: Modern Native stream reading via arrayBuffer()
  try {
    if (typeof file.arrayBuffer === 'function') {
      const buffer = await file.arrayBuffer();
      if (buffer && buffer.byteLength > 0) {
        return arrayBufferToBase64(buffer);
      }
    }
  } catch (bufferErr: any) {
    console.warn(`[safeFileToBase64] arrayBuffer() read failed for ${fileName}, falling back to FileReader:`, bufferErr);
  }

  // Strategy 2: Resilient FileReader fallback with strictly typed Error handling (NO raw Events passed to reject)
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => {
      try {
        const result = reader.result as string;
        if (!result) {
          throw new Error(`Empty file content received for "${fileName}".`);
        }
        const commaIndex = result.indexOf(',');
        resolve(commaIndex !== -1 ? result.substring(commaIndex + 1) : result);
      } catch (err) {
        reject(err instanceof Error ? err : new Error(`Failed to decode base64 for "${fileName}": ${String(err)}`));
      }
    };

    reader.onerror = () => {
      const domError = reader.error;
      const errorDetail = domError 
        ? `${domError.name}: ${domError.message}` 
        : 'Browser could not read file from storage (file descriptor may have expired).';
      reject(new Error(`File read failure for "${fileName}": ${errorDetail}`));
    };

    reader.onabort = () => {
      reject(new Error(`File read operation aborted for "${fileName}".`));
    };

    try {
      reader.readAsDataURL(file);
    } catch (readSyncErr: any) {
      reject(new Error(`Synchronous error starting file read for "${fileName}": ${readSyncErr?.message || String(readSyncErr)}`));
    }
  });
};

/**
 * Safely converts any File or Blob to a Uint8Array byte buffer.
 */
export const safeFileToBytes = async (file: File | Blob): Promise<Uint8Array> => {
  const fileName = (file as File).name || 'document';

  // Strategy 1: Modern arrayBuffer()
  try {
    if (typeof file.arrayBuffer === 'function') {
      const buffer = await file.arrayBuffer();
      return new Uint8Array(buffer);
    }
  } catch (bufferErr: any) {
    console.warn(`[safeFileToBytes] arrayBuffer() read failed for ${fileName}, falling back to FileReader:`, bufferErr);
  }

  // Strategy 2: FileReader arrayBuffer fallback
  return new Promise<Uint8Array>((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => {
      try {
        const result = reader.result as ArrayBuffer;
        if (!result) {
          throw new Error(`Empty buffer returned for "${fileName}".`);
        }
        resolve(new Uint8Array(result));
      } catch (err) {
        reject(err instanceof Error ? err : new Error(`Failed to parse buffer for "${fileName}": ${String(err)}`));
      }
    };

    reader.onerror = () => {
      const domError = reader.error;
      const errorDetail = domError 
        ? `${domError.name}: ${domError.message}` 
        : 'Browser could not read byte stream from storage.';
      reject(new Error(`File byte read failure for "${fileName}": ${errorDetail}`));
    };

    reader.onabort = () => {
      reject(new Error(`File byte read aborted for "${fileName}".`));
    };

    try {
      reader.readAsArrayBuffer(file);
    } catch (readSyncErr: any) {
      reject(new Error(`Synchronous error starting byte read for "${fileName}": ${readSyncErr?.message || String(readSyncErr)}`));
    }
  });
};

import { PDFDocument } from 'pdf-lib';
// @ts-ignore
import * as pdfjsLib from 'pdfjs-dist';
// @ts-ignore
import pdfjsWorker from 'pdfjs-dist/build/pdf.worker.mjs?url';

const pdfjs: any = pdfjsLib;
if (pdfjs && pdfjs.GlobalWorkerOptions) {
  pdfjs.GlobalWorkerOptions.workerSrc = pdfjsWorker;
}

/**
 * Optimizes student answer sheets (PDFs / Scans) for AI evaluation.
 * If a PDF is larger than 2.5MB (e.g. 7-15MB uncompressed 300dpi phone scans),
 * this renders each page at high legibility (~1400px, JPEG 0.72) and re-encodes
 * into a lightweight compact PDF (< 2.5MB base64) that safely fits within Netlify's
 * 6MB serverless payload limit while preserving crisp handwriting and diagrams.
 */
export const optimizePdfForEvaluation = async (
  file: File | Blob
): Promise<{ base64: string; mimeType: string }> => {
  const fileName = (file as File).name || 'document.pdf';
  const fileType = ((file as File).type || '').toLowerCase();
  const isPdf = fileName.toLowerCase().endsWith('.pdf') || fileType === 'application/pdf';

  // If already compact (<= 2.5MB), use safeFileToBase64 directly
  if (file.size <= 2.5 * 1024 * 1024) {
    const base64 = await safeFileToBase64(file);
    return { base64, mimeType: fileType || 'application/pdf' };
  }

  if (isPdf) {
    try {
      console.log(`[optimizePdfForEvaluation] Compressing oversized PDF ${fileName} (${(file.size / 1024 / 1024).toFixed(2)}MB) for Netlify...`);
      const arrayBuffer = await file.arrayBuffer();
      const loadingTask = pdfjs.getDocument({ data: arrayBuffer });
      const pdf = await loadingTask.promise;
      const numPages = pdf.numPages;

      const newPdf = await PDFDocument.create();

      for (let i = 1; i <= numPages; i++) {
        const page = await pdf.getPage(i);
        const originalViewport = page.getViewport({ scale: 1.0 });

        // Cap maximum dimension at 1400px (ideal for Gemini vision handwriting & diagrams)
        const maxDim = Math.max(originalViewport.width, originalViewport.height);
        const scale = Math.min(2.0, Math.max(0.8, 1400 / maxDim));
        const viewport = page.getViewport({ scale });

        const canvas = document.createElement('canvas');
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        const ctx = canvas.getContext('2d');

        if (ctx) {
          await page.render({ canvasContext: ctx, viewport }).promise;
          const jpegDataUrl = canvas.toDataURL('image/jpeg', 0.72);
          const commaIdx = jpegDataUrl.indexOf(',');
          const jpegBase64 = commaIdx !== -1 ? jpegDataUrl.substring(commaIdx + 1) : jpegDataUrl;

          // Convert base64 to binary bytes for pdf-lib embedJpg
          const binaryStr = atob(jpegBase64);
          const bytes = new Uint8Array(binaryStr.length);
          for (let b = 0; b < binaryStr.length; b++) {
            bytes[b] = binaryStr.charCodeAt(b);
          }

          const embeddedImg = await newPdf.embedJpg(bytes);
          const newPage = newPdf.addPage([embeddedImg.width, embeddedImg.height]);
          newPage.drawImage(embeddedImg, {
            x: 0,
            y: 0,
            width: embeddedImg.width,
            height: embeddedImg.height,
          });
        }
      }

      const compressedBytes = await newPdf.save();
      const compressedB64 = uint8ArrayToBase64(compressedBytes);
      console.log(
        `[optimizePdfForEvaluation] Successfully compressed ${fileName}: ${(file.size / 1024 / 1024).toFixed(2)}MB -> ${(compressedBytes.length / 1024 / 1024).toFixed(2)}MB`
      );
      return { base64: compressedB64, mimeType: 'application/pdf' };
    } catch (optErr) {
      console.warn(`[optimizePdfForEvaluation] Compression failed for ${fileName}, falling back to original:`, optErr);
      const fallbackB64 = await safeFileToBase64(file);
      return { base64: fallbackB64, mimeType: fileType || 'application/pdf' };
    }
  }

  // Large image fallback
  if (fileType.startsWith('image/')) {
    try {
      const bitmap = await createImageBitmap(file);
      const maxDim = Math.max(bitmap.width, bitmap.height);
      const scale = Math.min(1.0, 1500 / maxDim);
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(bitmap.width * scale);
      canvas.height = Math.round(bitmap.height * scale);
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        const jpegDataUrl = canvas.toDataURL('image/jpeg', 0.75);
        const commaIdx = jpegDataUrl.indexOf(',');
        const b64 = commaIdx !== -1 ? jpegDataUrl.substring(commaIdx + 1) : jpegDataUrl;
        return { base64: b64, mimeType: 'image/jpeg' };
      }
    } catch (imgErr) {
      console.warn('[optimizePdfForEvaluation] Image optimization fallback:', imgErr);
    }
  }

  const base64 = await safeFileToBase64(file);
  return { base64, mimeType: fileType || 'application/pdf' };
};
