import { PDFDocument } from 'pdf-lib';
import { jsPDF } from 'jspdf';
import mammoth from 'mammoth';
import { safeFileToBytes } from './fileUtils';

/**
 * Converts any supported file (PDF, Image, or DOCX) into standard PDF bytes
 * so that they can be easily merged.
 */
export const fileToPdfBytes = async (file: File): Promise<Uint8Array> => {
  const fileType = file.type.toLowerCase();
  const fileName = file.name.toLowerCase();

  // 1. If it is already a PDF
  if (fileType === 'application/pdf' || fileName.endsWith('.pdf')) {
    return await safeFileToBytes(file);
  }

  // 2. If it is an image
  if (fileType.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp)$/.test(fileName)) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const imgData = reader.result as string;
          const pdf = new jsPDF({
            orientation: 'portrait',
            unit: 'px',
            format: 'a4',
          });
          
          const pageWidth = pdf.internal.pageSize.getWidth();
          const pageHeight = pdf.internal.pageSize.getHeight();
          
          // Add image and scale to fit page margins
          pdf.addImage(imgData, 'JPEG', 20, 20, pageWidth - 40, pageHeight - 40);
          const arrayBuffer = pdf.output('arraybuffer');
          resolve(new Uint8Array(arrayBuffer));
        } catch (err) {
          reject(err);
        }
      };
      reader.onerror = () => {
        const domError = reader.error;
        const msg = domError ? `${domError.name}: ${domError.message}` : 'Failed to read image file data';
        reject(new Error(`Image reading error for "${fileName}": ${msg}`));
      };
      reader.readAsDataURL(file);
    });
  }

  // 3. If it is a DOCX
  if (fileType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || fileName.endsWith('.docx')) {
    try {
      const arrayBuffer = await file.arrayBuffer();
      const result = await mammoth.extractRawText({ arrayBuffer });
      const text = result.value || 'Empty DOCX document';

      const pdf = new jsPDF({
        orientation: 'portrait',
        unit: 'pt',
        format: 'letter',
      });

      pdf.setFont('Times', 'normal');
      pdf.setFontSize(11);
      
      const margin = 54; // 0.75 in
      const pageWidth = pdf.internal.pageSize.getWidth();
      const pageHeight = pdf.internal.pageSize.getHeight();
      const listWidth = pageWidth - margin * 2;
      
      const textLines = pdf.splitTextToSize(text, listWidth);
      let cursorY = margin;

      textLines.forEach((line: string) => {
        if (cursorY + 15 > pageHeight - margin) {
          pdf.addPage();
          cursorY = margin;
        }
        pdf.text(line, margin, cursorY);
        cursorY += 15;
      });

      return new Uint8Array(pdf.output('arraybuffer'));
    } catch (err) {
      console.error('Error translating DOCX to PDF for merging:', err);
    }
  }

  // Fallback: create a simple PDF with file name
  const pdf = new jsPDF();
  pdf.setFontSize(14);
  pdf.text(`File: ${file.name}`, 20, 20);
  pdf.setFontSize(10);
  pdf.text('This file format is text-extracted but could not be rendered visually.', 20, 40);
  return new Uint8Array(pdf.output('arraybuffer'));
};

/**
 * Merges multiple PDF files (represented as Uint8Array bytes) sequentially.
 */
export const mergePdfs = async (pdfsToMerge: Uint8Array[]): Promise<Uint8Array> => {
  const mergedPdf = await PDFDocument.create();

  const targetWidth = 595.28; // standard A4 width in pt
  const targetHeight = 841.89; // standard A4 height in pt

  for (const pdfBytes of pdfsToMerge) {
    if (!pdfBytes || pdfBytes.length === 0) continue;
    try {
      const pdf = await PDFDocument.load(pdfBytes);
      const pages = pdf.getPages();
      
      for (let i = 0; i < pages.length; i++) {
        const page = pages[i];
        const { width, height } = page.getSize();
        
        try {
          // Embed the page from other doc inside mergedDoc and scale it to fit A4 perfectly
          const [embeddedPage] = await mergedPdf.embedPages([page]);
          const newPage = mergedPdf.addPage([targetWidth, targetHeight]);
          
          const scaleX = targetWidth / width;
          const scaleY = targetHeight / height;
          const scale = Math.min(scaleX, scaleY);
          
          const dWidth = width * scale;
          const dHeight = height * scale;
          
          const dx = (targetWidth - dWidth) / 2;
          const dy = (targetHeight - dHeight) / 2;
          
          newPage.drawPage(embeddedPage, {
            x: dx,
            y: dy,
            width: dWidth,
            height: dHeight,
          });
        } catch (embedErr) {
          console.warn('Embedding page failed, fallback to native copy:', embedErr);
          // Fallback to native copy
          const copied = await mergedPdf.copyPages(pdf, [i]);
          copied.forEach((p) => mergedPdf.addPage(p));
        }
      }
    } catch (err) {
      console.error('Failed to parse a PDF chunk during merger:', err);
    }
  }

  return await mergedPdf.save();
};

/**
 * Helper to download raw bytes as a file.
 */
export const downloadBytes = (bytes: Uint8Array, filename: string, mimeType = 'application/pdf') => {
  const blob = new Blob([bytes] as any, { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
};
