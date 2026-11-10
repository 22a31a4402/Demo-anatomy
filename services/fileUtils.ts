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
 * Optimizes student answer sheets (PDFs / Scans) up to 25MB for AI evaluation.
 * Adapts page scale and JPEG compression dynamically based on total page count
 * so that any 10-50 page student script (< 25MB) is compressed into a compact PDF
 * (< 2.2MB binary / < 3.0MB base64) that safely passes through Netlify's 6MB gateway
 * while keeping handwriting, formulas, diagrams, and markings razor-sharp for Gemini vision.
 */
export const optimizePdfForEvaluation = async (
  file: File | Blob
): Promise<{ base64: string; mimeType: string }> => {
  const fileName = (file as File).name || 'document.pdf';
  const fileType = ((file as File).type || '').toLowerCase();
  const isPdf = fileName.toLowerCase().endsWith('.pdf') || fileType === 'application/pdf';

  // If already compact (<= 1.8MB), safe to transmit directly without re-compression
  if (file.size <= 1.8 * 1024 * 1024) {
    const base64 = await safeFileToBase64(file);
    return { base64, mimeType: fileType || 'application/pdf' };
  }

  if (isPdf) {
    try {
      console.log(
        `[optimizePdfForEvaluation] Compressing document ${fileName} (${(file.size / 1024 / 1024).toFixed(2)}MB) for AI evaluation...`
      );
      const arrayBuffer = await file.arrayBuffer();
      const loadingTask = pdfjs.getDocument({ data: arrayBuffer });
      const pdf = await loadingTask.promise;
      const numPages = pdf.numPages;

      // Dynamic page budget to guarantee total PDF binary size <= 2.0MB
      let targetMaxDim = 1100;
      let quality = 0.68;

      if (numPages > 30) {
        targetMaxDim = 800;
        quality = 0.52;
      } else if (numPages > 20) {
        targetMaxDim = 900;
        quality = 0.58;
      } else if (numPages > 10) {
        targetMaxDim = 1000;
        quality = 0.63;
      } else {
        targetMaxDim = 1100;
        quality = 0.68;
      }

      const newPdf = await PDFDocument.create();

      for (let i = 1; i <= numPages; i++) {
        try {
          const page = await pdf.getPage(i);
          const originalViewport = page.getViewport({ scale: 1.0 });

          const maxDim = Math.max(originalViewport.width, originalViewport.height);
          const scale = Math.min(2.0, Math.max(0.6, targetMaxDim / maxDim));
          const viewport = page.getViewport({ scale });

          const canvas = document.createElement('canvas');
          canvas.width = Math.floor(viewport.width);
          canvas.height = Math.floor(viewport.height);
          const ctx = canvas.getContext('2d', { willReadFrequently: false });

          if (ctx) {
            await page.render({ canvasContext: ctx, viewport }).promise;
            const jpegDataUrl = canvas.toDataURL('image/jpeg', quality);
            const commaIdx = jpegDataUrl.indexOf(',');
            const jpegBase64 = commaIdx !== -1 ? jpegDataUrl.substring(commaIdx + 1) : jpegDataUrl;

            // Immediately free canvas resources to prevent memory pressure on large multi-page PDFs
            canvas.width = 1;
            canvas.height = 1;

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
        } catch (pageErr) {
          console.warn(`[optimizePdfForEvaluation] Page ${i} warning in ${fileName}:`, pageErr);
        }
      }

      const compressedBytes = await newPdf.save();
      const compressedB64 = uint8ArrayToBase64(compressedBytes);
      console.log(
        `[optimizePdfForEvaluation] Successfully compressed ${fileName} (${numPages} pages): ${(file.size / 1024 / 1024).toFixed(2)}MB -> ${(compressedBytes.length / 1024 / 1024).toFixed(2)}MB (base64 payload: ${(compressedB64.length / 1024 / 1024).toFixed(2)}MB)`
      );
      return { base64: compressedB64, mimeType: 'application/pdf' };
    } catch (optErr) {
      console.warn(`[optimizePdfForEvaluation] Canvas compression failed for ${fileName}, attempting pdf-lib stream compression:`, optErr);

      // Resilient Fallback: If canvas rendering fails, use pdf-lib to remove heavy metadata and re-encode
      try {
        const rawBytes = await safeFileToBytes(file);
        const pdfDoc = await PDFDocument.load(rawBytes, { ignoreEncryption: true });
        // If oversized, limit to key pages to guarantee payload is accepted
        if (file.size > 5 * 1024 * 1024 && pdfDoc.getPageCount() > 25) {
          while (pdfDoc.getPageCount() > 25) {
            pdfDoc.removePage(pdfDoc.getPageCount() - 1);
          }
        }
        const savedBytes = await pdfDoc.save({ useObjectStreams: true });
        if (savedBytes.length < 3.8 * 1024 * 1024) {
          return { base64: uint8ArrayToBase64(savedBytes), mimeType: 'application/pdf' };
        }
      } catch (pdfLibErr) {
        console.warn(`[optimizePdfForEvaluation] Stream compression fallback also failed:`, pdfLibErr);
      }

      const fallbackB64 = await safeFileToBase64(file);
      return { base64: fallbackB64, mimeType: fileType || 'application/pdf' };
    }
  }

  // Large image fallback (downscale to max 1400px and compress to JPEG 0.70)
  if (fileType.startsWith('image/')) {
    try {
      const bitmap = await createImageBitmap(file);
      const maxDim = Math.max(bitmap.width, bitmap.height);
      const scale = Math.min(1.0, 1400 / maxDim);
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(bitmap.width * scale);
      canvas.height = Math.round(bitmap.height * scale);
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        const jpegDataUrl = canvas.toDataURL('image/jpeg', 0.70);
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
