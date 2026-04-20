/**
 * Export composition modal: format + scale radios, progress polling, download link.
 */

import * as bootstrap from "bootstrap";

import {
  apiClient,
  type Composition,
  type ExportFormat,
  type ExportJob,
  type ExportScaleDivisor,
} from "../api";
import { showError } from "./feedback";

export interface ExportDialogParams {
  composition: Composition;
  defaultScaleDivisor?: ExportScaleDivisor;
}

export function openExportDialog(params: ExportDialogParams): void {
  const defaultScale = params.defaultScaleDivisor ?? 1;
  const modalEl = document.createElement("div");
  modalEl.className = "modal fade";
  modalEl.tabIndex = -1;
  modalEl.innerHTML = `
    <div class="modal-dialog">
      <div class="modal-content">
        <div class="modal-header">
          <h5 class="modal-title">Export composition</h5>
          <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
        </div>
        <div class="modal-body">
          <div class="mb-3">
            <label class="form-label small text-muted">Format</label>
            <div class="btn-group w-100" role="group">
              <input type="radio" class="btn-check" name="fmt" id="fmt-mp4" value="mp4" checked>
              <label class="btn btn-outline-primary" for="fmt-mp4">MP4</label>
              <input type="radio" class="btn-check" name="fmt" id="fmt-webm" value="webm">
              <label class="btn btn-outline-primary" for="fmt-webm">WebM</label>
              <input type="radio" class="btn-check" name="fmt" id="fmt-gif" value="gif">
              <label class="btn btn-outline-primary" for="fmt-gif">GIF</label>
            </div>
          </div>
          <div class="mb-3">
            <label class="form-label small text-muted">Resolution</label>
            <div class="btn-group w-100" role="group">
              <input type="radio" class="btn-check" name="scale" id="scale-1" value="1" ${defaultScale === 1 ? "checked" : ""}>
              <label class="btn btn-outline-primary" for="scale-1">1:1</label>
              <input type="radio" class="btn-check" name="scale" id="scale-2" value="2" ${defaultScale === 2 ? "checked" : ""}>
              <label class="btn btn-outline-primary" for="scale-2">½ size</label>
              <input type="radio" class="btn-check" name="scale" id="scale-4" value="4" ${defaultScale === 4 ? "checked" : ""}>
              <label class="btn btn-outline-primary" for="scale-4">¼ size</label>
            </div>
          </div>
          <div class="form-check mb-3">
            <input type="checkbox" class="form-check-input vg3-export-audio" id="vg3-export-audio">
            <label class="form-check-label" for="vg3-export-audio">Sound</label>
          </div>
          <div class="vg3-export-status d-none">
            <div class="progress">
              <div class="progress-bar progress-bar-striped progress-bar-animated" role="progressbar" style="width: 0%"></div>
            </div>
            <div class="small text-muted mt-2 vg3-export-status-msg">Starting…</div>
          </div>
          <a class="btn btn-success w-100 d-none mt-3 vg3-export-download" href="#" download>Download</a>
        </div>
        <div class="modal-footer">
          <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Close</button>
          <button type="button" class="btn btn-primary vg3-export-start">Start export</button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(modalEl);
  const modal = new bootstrap.Modal(modalEl);

  const startBtn = modalEl.querySelector<HTMLButtonElement>(".vg3-export-start")!;
  const statusBox = modalEl.querySelector<HTMLElement>(".vg3-export-status")!;
  const progressBar = modalEl.querySelector<HTMLElement>(".progress-bar")!;
  const statusMsg = modalEl.querySelector<HTMLElement>(".vg3-export-status-msg")!;
  const downloadBtn = modalEl.querySelector<HTMLAnchorElement>(".vg3-export-download")!;

  let pollTimer: number | null = null;

  function onJobUpdate(job: ExportJob): void {
    progressBar.style.width = `${job.progress_percent}%`;
    statusMsg.textContent = `${job.status}… (${job.progress_percent}%)`;
    if (job.status === "done") {
      downloadBtn.href = apiClient.exportDownloadUrl(job.id);
      downloadBtn.classList.remove("d-none");
      statusMsg.textContent = `Done — ${job.format.toUpperCase()} @ 1/${job.scale_divisor}`;
      progressBar.classList.remove("progress-bar-striped", "progress-bar-animated");
      startBtn.disabled = false;
      stopPoll();
    } else if (job.status === "error") {
      statusMsg.textContent = `Error: ${job.error_message ?? "unknown"}`;
      progressBar.classList.remove("progress-bar-striped", "progress-bar-animated");
      startBtn.disabled = false;
      stopPoll();
    }
  }

  function stopPoll(): void {
    if (pollTimer !== null) {
      window.clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  startBtn.addEventListener("click", async () => {
    const fmtEl = modalEl.querySelector<HTMLInputElement>("input[name='fmt']:checked");
    const scaleElInput = modalEl.querySelector<HTMLInputElement>(
      "input[name='scale']:checked"
    );
    const audioEl = modalEl.querySelector<HTMLInputElement>(".vg3-export-audio");
    if (!fmtEl || !scaleElInput) return;
    const format = fmtEl.value as ExportFormat;
    const scale = parseInt(scaleElInput.value, 10) as ExportScaleDivisor;
    const includeAudio = audioEl ? audioEl.checked : false;

    startBtn.disabled = true;
    statusBox.classList.remove("d-none");
    downloadBtn.classList.add("d-none");
    progressBar.classList.add("progress-bar-striped", "progress-bar-animated");
    progressBar.style.width = "0%";
    statusMsg.textContent = "Queuing…";

    try {
      const job = await apiClient.startExport(
        params.composition.id,
        format,
        scale,
        includeAudio
      );
      onJobUpdate(job);
      pollTimer = window.setInterval(async () => {
        try {
          const fresh = await apiClient.getExport(job.id);
          onJobUpdate(fresh);
        } catch (err) {
          console.error("export poll", err);
        }
      }, 1500);
    } catch (err) {
      showError(err instanceof Error ? err.message : String(err));
      startBtn.disabled = false;
      statusBox.classList.add("d-none");
    }
  });

  modalEl.addEventListener("hidden.bs.modal", () => {
    stopPoll();
    modalEl.remove();
  });

  modal.show();
}
