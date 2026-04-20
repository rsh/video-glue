/**
 * Composition sidebar: name, load, save, export.
 */

import type {
  Composition,
  ExportFormat,
  ExportJob,
  ExportScaleDivisor,
} from "../api";
import { escapeHtml } from "./feedback";

export interface CompositionPanelProps {
  current: Composition | null;
  compositions: Composition[];
  exportJob: ExportJob | null;
  exportDownloadUrl: string | null;
  exportScaleDivisor: ExportScaleDivisor;
  onNew: () => void;
  onLoad: (id: number) => void;
  onRename: (name: string) => void;
  onSave: () => void;
  onDelete: () => void;
  onExport: (format: ExportFormat, scaleDivisor: ExportScaleDivisor) => void;
  onExportScaleChange: (scaleDivisor: ExportScaleDivisor) => void;
}

export function createCompositionPanel(props: CompositionPanelProps): HTMLElement {
  const el = document.createElement("div");
  el.className = "vg-panel";

  const current = props.current;
  el.innerHTML = `
    <div class="card mb-3">
      <div class="card-body">
        <div class="d-flex gap-2 align-items-end mb-2">
          <div class="flex-grow-1">
            <label class="form-label small mb-1">Composition name</label>
            <input type="text" class="form-control form-control-sm" id="vg-comp-name"
                   value="${escapeHtml(current?.name ?? "")}" ${current ? "" : "disabled"}/>
          </div>
          <button type="button" class="btn btn-sm btn-outline-secondary" id="vg-comp-new">New</button>
          <button type="button" class="btn btn-sm btn-primary" id="vg-comp-save" ${current ? "" : "disabled"}>Save</button>
        </div>
        <div class="d-flex gap-2">
          <button type="button" class="btn btn-sm btn-outline-danger" id="vg-comp-delete" ${current ? "" : "disabled"}>Delete</button>
          <small class="text-muted align-self-center ms-auto">
            ${current ? `${current.clips?.length ?? 0} clips · updated ${formatDateTime(current.updated_at)}` : "no composition loaded"}
          </small>
        </div>
      </div>
    </div>

    <div class="card mb-3">
      <div class="card-body">
        <label class="form-label small mb-1">Load saved composition</label>
        <select class="form-select form-select-sm" id="vg-comp-list">
          <option value="">—</option>
          ${props.compositions
            .map(
              (c) =>
                `<option value="${c.id}" ${current && current.id === c.id ? "selected" : ""}>${escapeHtml(c.name)}</option>`
            )
            .join("")}
        </select>
      </div>
    </div>

    <div class="card">
      <div class="card-body">
        <div class="d-flex align-items-center mb-2">
          <strong>Export</strong>
          <small class="text-muted ms-auto">${exportStatusText(props.exportJob)}</small>
        </div>
        <div class="d-flex gap-2 align-items-center mb-2">
          <label class="form-label small mb-0">Resolution</label>
          <select class="form-select form-select-sm" id="vg-export-scale" style="width: auto;" ${current ? "" : "disabled"}>
            <option value="1" ${props.exportScaleDivisor === 1 ? "selected" : ""}>Full</option>
            <option value="2" ${props.exportScaleDivisor === 2 ? "selected" : ""}>½ size</option>
            <option value="4" ${props.exportScaleDivisor === 4 ? "selected" : ""}>¼ size</option>
          </select>
          <small class="text-muted ms-auto">gif uses a fixed size</small>
        </div>
        <div class="d-flex gap-2 mb-2">
          <button type="button" class="btn btn-sm btn-success" data-fmt="mp4" ${current ? "" : "disabled"}>MP4</button>
          <button type="button" class="btn btn-sm btn-success" data-fmt="webm" ${current ? "" : "disabled"}>WebM</button>
          <button type="button" class="btn btn-sm btn-success" data-fmt="gif" ${current ? "" : "disabled"}>GIF</button>
        </div>
        ${renderProgress(props.exportJob)}
        ${
          props.exportDownloadUrl
            ? `<a class="btn btn-sm btn-outline-primary mt-2" href="${escapeHtml(props.exportDownloadUrl)}" download>Download result</a>`
            : ""
        }
      </div>
    </div>
  `;

  const nameInput = el.querySelector("#vg-comp-name") as HTMLInputElement;
  nameInput.addEventListener("change", () => {
    if (nameInput.value.trim()) props.onRename(nameInput.value.trim());
  });

  el.querySelector("#vg-comp-new")?.addEventListener("click", props.onNew);
  el.querySelector("#vg-comp-save")?.addEventListener("click", props.onSave);
  el.querySelector("#vg-comp-delete")?.addEventListener("click", props.onDelete);

  const listSel = el.querySelector("#vg-comp-list") as HTMLSelectElement;
  listSel.addEventListener("change", () => {
    const id = parseInt(listSel.value, 10);
    if (Number.isFinite(id)) props.onLoad(id);
  });

  const scaleSel = el.querySelector("#vg-export-scale") as HTMLSelectElement | null;
  scaleSel?.addEventListener("change", () => {
    const value = parseInt(scaleSel.value, 10);
    if (value === 1 || value === 2 || value === 4) {
      props.onExportScaleChange(value);
    }
  });

  el.querySelectorAll("button[data-fmt]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const fmt = (e.currentTarget as HTMLElement).dataset["fmt"] as ExportFormat;
      props.onExport(fmt, props.exportScaleDivisor);
    });
  });

  return el;
}

function exportStatusText(job: ExportJob | null): string {
  if (!job) return "idle";
  if (job.status === "error") return `error: ${job.error_message ?? "unknown"}`;
  if (job.status === "done") return "done";
  if (job.status === "running") return `running · ${job.progress_percent.toFixed(0)}%`;
  return job.status;
}

function renderProgress(job: ExportJob | null): string {
  if (!job) return "";
  if (job.status !== "running" && job.status !== "queued") return "";
  const pct = Math.max(0, Math.min(100, job.progress_percent));
  return `
    <div class="progress" style="height: 6px;">
      <div class="progress-bar" role="progressbar" style="width: ${pct}%" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"></div>
    </div>
  `;
}

function formatDateTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}
