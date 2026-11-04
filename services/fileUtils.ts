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
