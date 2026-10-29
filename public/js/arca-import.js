import * as pdfjsLib from '/vendor/pdfjs/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';

const form = document.getElementById('arca-import-form');
if (form) {
  const messages = window.ARCA_IMPORT_MESSAGES || {};
  const fileInput = document.getElementById('arca-pdf');
  const manualInput = document.getElementById('arca-manual-qr');
  const qrData = document.getElementById('arca-qr-data');
  const source = document.getElementById('arca-source');
  const filename = document.getElementById('arca-pdf-filename');
  const sha256 = document.getElementById('arca-pdf-sha256');
  const status = document.getElementById('arca-import-status');
  const submit = document.getElementById('arca-import-submit');
  const baseStatusClass = 'rounded-xl border px-4 py-3 text-sm';
  let submitting = false;

  function showStatus(message, tone = 'info') {
    if (!status) return;
    status.textContent = message;
    status.className = `${baseStatusClass} ${
      tone === 'error'
        ? 'border-error-200 bg-error-50 text-error-700 dark:border-error-500/30 dark:bg-error-500/10 dark:text-error-400'
        : 'border-brand-200 bg-brand-50 text-brand-700 dark:border-brand-500/30 dark:bg-brand-500/10 dark:text-brand-300'
    }`;
    status.classList.remove('hidden');
  }

  function clearStatus() {
    if (!status) return;
    status.classList.add('hidden');
    status.textContent = '';
  }

  async function hashArrayBuffer(buffer) {
    if (!window.crypto || !window.crypto.subtle) return '';
    try {
      const digest = await window.crypto.subtle.digest('SHA-256', buffer);
      return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    } catch {
      return '';
    }
  }

  function renderQrFromPage(page, scale) {
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    return page.render({ canvasContext: context, viewport }).promise.then(() => {
      const image = context.getImageData(0, 0, canvas.width, canvas.height);
      if (typeof window.jsQR !== 'function') return null;
      return window.jsQR(image.data, canvas.width, canvas.height, {
        inversionAttempts: 'attemptBoth',
      });
    });
  }

  async function scanPdf(file) {
    if (!file) throw new Error(messages.noFile || 'Select a PDF.');
    if (file.size > 20 * 1024 * 1024) {
      throw new Error(messages.pdfTooLarge || 'The PDF is too large.');
    }
    const buffer = await file.arrayBuffer();
    const header = new TextDecoder('latin1').decode(new Uint8Array(buffer.slice(0, 5)));
    if (header !== '%PDF-') {
      throw new Error(messages.pdfError || 'The file is not a valid PDF.');
    }
    const digest = await hashArrayBuffer(buffer);

    showStatus(messages.reading || 'Reading PDF...');
    const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(buffer) });
    const pdf = await loadingTask.promise;
    try {
      if (!pdf.numPages) throw new Error(messages.pdfError || 'The PDF has no pages.');

      const page = await pdf.getPage(1);
      const base = page.getViewport({ scale: 1 });
      const firstScale = Math.min(4, Math.max(2, 1800 / base.width));
      let result = await renderQrFromPage(page, firstScale);

      if (!result) {
        showStatus(messages.scanning || 'Scanning the first PDF page...');
        result = await renderQrFromPage(page, 4);
      }

      if (!result || !result.data) {
        throw new Error(messages.noQr || 'No QR code was found on the first page.');
      }

      return {
        data: result.data,
        filename: file.name,
        sha256: digest,
      };
    } finally {
      await loadingTask.destroy().catch(() => {});
    }
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (submitting) return;

    clearStatus();
    const manual = manualInput ? manualInput.value.trim() : '';
    if (manual) {
      qrData.value = manual;
      source.value = 'manual_qr';
      filename.value = '';
      sha256.value = '';
      submitting = true;
      form.submit();
      return;
    }

    const file = fileInput && fileInput.files ? fileInput.files[0] : null;
    if (!file) {
      showStatus(messages.noFile || 'Select an ARCA PDF or paste the QR link.', 'error');
      return;
    }

    submitting = true;
    submit.disabled = true;
    try {
      const result = await scanPdf(file);
      qrData.value = result.data;
      source.value = 'pdf_qr';
      filename.value = result.filename || '';
      sha256.value = result.sha256 || '';
      showStatus(messages.scanned || 'QR code found. Opening the review...');
      form.submit();
    } catch (error) {
      console.error('[arca-import]', error);
      showStatus(error.message || messages.qrError || 'The QR code could not be read.', 'error');
      submitting = false;
      submit.disabled = false;
    }
  });
}
