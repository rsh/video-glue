/**
 * Segment grid: videos grouped, thumbnails draggable to the timeline.
 */

import { apiClient, type Segment, type Video } from "../api";
import { escapeHtml, formatDuration } from "./feedback";
import { setSegmentDragData } from "./drag";

export interface VideoGridProps {
  videos: Video[];
  segmentsByVideo: Map<number, Segment[]>;
  scannerFilter: string | "all";
  onRescan: () => void;
  onScanVideo: (videoId: number) => void;
  onToggleExpand: (videoId: number) => void;
  expanded: Set<number>;
}

export function createVideoGrid(props: VideoGridProps): HTMLElement {
  const el = document.createElement("div");
  el.className = "vg-grid";

  const header = document.createElement("div");
  header.className = "vg-grid-header d-flex align-items-center gap-2 mb-2";
  header.innerHTML = `
    <h5 class="mb-0 me-auto">Library</h5>
    <button type="button" class="btn btn-sm btn-primary" id="btn-rescan">Rescan library</button>
  `;
  el.appendChild(header);
  header.querySelector("#btn-rescan")?.addEventListener("click", props.onRescan);

  if (props.videos.length === 0) {
    const empty = document.createElement("p");
    empty.className = "text-muted";
    empty.textContent =
      "No videos yet. Drop some files into your library directory and click Rescan library.";
    el.appendChild(empty);
    return el;
  }

  for (const v of props.videos) {
    el.appendChild(renderVideoRow(v, props));
  }
  return el;
}

function renderVideoRow(video: Video, props: VideoGridProps): HTMLElement {
  const row = document.createElement("div");
  row.className = "vg-video card mb-2";

  const header = document.createElement("div");
  header.className = "card-body py-2 d-flex align-items-center gap-2";
  const isExpanded = props.expanded.has(video.id);
  const statusBadge = statusBadgeHtml(video.status, video.scan_progress_percent);
  const segCount = video.segment_count ?? 0;
  header.innerHTML = `
    <button type="button" class="btn btn-sm btn-light vg-expand">${isExpanded ? "▾" : "▸"}</button>
    <div class="flex-grow-1 text-truncate">
      <strong>${escapeHtml(video.filename)}</strong>
      <small class="text-muted ms-2">${segCount} segments · ${formatDuration(video.duration_seconds)}</small>
    </div>
    ${statusBadge}
    <button type="button" class="btn btn-sm btn-outline-secondary vg-rescan-video">Rescan</button>
  `;
  header
    .querySelector(".vg-expand")
    ?.addEventListener("click", () => props.onToggleExpand(video.id));
  header
    .querySelector(".vg-rescan-video")
    ?.addEventListener("click", () => props.onScanVideo(video.id));
  row.appendChild(header);

  if (video.status === "scanning") {
    const bar = document.createElement("div");
    bar.className = "vg-scan-progress";
    const pct = Math.max(0, Math.min(100, video.scan_progress_percent));
    const eta = estimateScanEta(video);
    bar.innerHTML = `
      <div class="progress" style="height: 4px;">
        <div class="progress-bar" role="progressbar" style="width: ${pct}%" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"></div>
      </div>
      <div class="vg-scan-eta"><small class="text-muted">${eta}</small></div>
    `;
    row.appendChild(bar);
  }

  if (video.error_message) {
    const err = document.createElement("div");
    err.className = "card-body py-2 text-danger small";
    err.textContent = video.error_message;
    row.appendChild(err);
  }

  if (video.preview_proxy_status === "building") {
    const row2 = document.createElement("div");
    row2.className = "vg-proxy-status text-muted small";
    const elapsed = elapsedSince(video.preview_proxy_started_at);
    row2.innerHTML = `
      <span class="spinner-border spinner-border-sm me-1" role="status" aria-hidden="true"></span>
      Building browser-playable preview${elapsed ? ` · ${elapsed} elapsed` : ""}
    `;
    row.appendChild(row2);
  } else if (video.preview_proxy_status === "error") {
    const row2 = document.createElement("div");
    row2.className = "vg-proxy-status text-danger small";
    row2.textContent = `Preview transcode failed: ${video.preview_proxy_error_message ?? "unknown"}`;
    row.appendChild(row2);
  }

  if (isExpanded) {
    const segments = (props.segmentsByVideo.get(video.id) ?? []).filter(
      (s) => props.scannerFilter === "all" || s.scanner_name === props.scannerFilter
    );
    const body = document.createElement("div");
    body.className = "card-body pt-0";
    if (segments.length === 0) {
      body.innerHTML =
        '<p class="text-muted small mb-0">No segments yet for this video.</p>';
    } else {
      const tileGrid = document.createElement("div");
      tileGrid.className = "vg-tile-grid";
      for (const seg of segments) {
        tileGrid.appendChild(renderSegmentTile(seg));
      }
      body.appendChild(tileGrid);
    }
    row.appendChild(body);
  }

  return row;
}

function renderSegmentTile(seg: Segment): HTMLElement {
  const tile = document.createElement("div");
  tile.className = "vg-tile";
  tile.draggable = true;
  tile.dataset["segmentId"] = String(seg.id);
  tile.title = `#${seg.id} · frames ${seg.start_frame}–${seg.end_frame} · ${formatDuration(seg.duration_seconds)}`;

  const thumb =
    seg.thumbnail_path !== null ? apiClient.thumbnailUrl(seg.thumbnail_path) : "";
  tile.innerHTML = `
    ${
      thumb
        ? `<img src="${escapeHtml(thumb)}" alt="segment ${seg.id}" class="vg-tile-img"/>`
        : '<div class="vg-tile-img vg-tile-img-missing">no thumbnail</div>'
    }
    <div class="vg-tile-meta">
      <span class="vg-tile-duration">${formatDuration(seg.duration_seconds)}</span>
      <span class="vg-tile-scanner">${escapeHtml(seg.scanner_name)}</span>
    </div>
  `;

  tile.addEventListener("dragstart", (e) => setSegmentDragData(e, seg.id));
  return tile;
}

function elapsedSince(iso: string | null): string {
  if (!iso) return "";
  const started = Date.parse(iso);
  if (!Number.isFinite(started)) return "";
  const ms = Math.max(0, Date.now() - started);
  return formatRemaining(ms);
}

function estimateScanEta(video: Video): string {
  const pct = video.scan_progress_percent;
  if (!video.scan_started_at || pct <= 0.5) return "estimating remaining time…";
  const started = Date.parse(video.scan_started_at);
  if (!Number.isFinite(started)) return "";
  const elapsedMs = Date.now() - started;
  if (elapsedMs <= 0) return "";
  const totalMs = (elapsedMs / pct) * 100;
  const remainingMs = Math.max(0, totalMs - elapsedMs);
  return `~${formatRemaining(remainingMs)} remaining · elapsed ${formatRemaining(elapsedMs)}`;
}

function formatRemaining(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return `${m}m ${rs.toString().padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h}h ${rm.toString().padStart(2, "0")}m`;
}

function statusBadgeHtml(status: Video["status"], progress: number): string {
  const colors: Record<Video["status"], string> = {
    discovered: "secondary",
    probing: "info",
    probed: "info",
    scanning: "warning",
    thumbnailing: "info",
    subtitles_importing: "info",
    ready: "success",
    error: "danger",
  };
  const label =
    status === "scanning"
      ? `scanning · ${Math.round(Math.max(0, Math.min(100, progress)))}%`
      : status;
  return `<span class="badge bg-${colors[status]}">${label}</span>`;
}
