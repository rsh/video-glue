/**
 * Single-track timeline: ordered clips with trim handles and drag-reorder.
 */

import type { Clip } from "../api";
import { escapeHtml, formatDuration } from "./feedback";
import { readClipDragData, readSegmentDragData, setClipDragData } from "./drag";

export interface TimelineProps {
  clips: Clip[];
  selectedIndex: number | null;
  pixelsPerSecond: number;
  onSelectClip: (index: number) => void;
  onRemoveClip: (index: number) => void;
  onReorder: (fromIndex: number, toIndex: number) => void;
  onDropSegment: (segmentId: number, insertIndex: number) => void;
  onTrimStartChange: (index: number, trimStartFrames: number) => void;
  onTrimEndChange: (index: number, trimEndFrames: number) => void;
  onZoomChange: (pps: number) => void;
}

export function createTimeline(props: TimelineProps): HTMLElement {
  const el = document.createElement("div");
  el.className = "vg-timeline";

  el.appendChild(renderToolbar(props));
  el.appendChild(renderTrack(props));
  el.appendChild(renderInspector(props));

  return el;
}

function renderToolbar(props: TimelineProps): HTMLElement {
  const bar = document.createElement("div");
  bar.className = "vg-tl-toolbar d-flex align-items-center gap-2 mb-2";
  const total = props.clips.reduce((acc, c) => {
    const seg = c.segment;
    if (!seg) return acc;
    const effFrames = seg.frame_count - c.trim_start_frame - c.trim_end_frame;
    const fps = seg.duration_seconds > 0 ? seg.frame_count / seg.duration_seconds : 0;
    return acc + (fps > 0 ? effFrames / fps : 0);
  }, 0);
  bar.innerHTML = `
    <strong>Timeline</strong>
    <small class="text-muted">${props.clips.length} clips · ${formatDuration(total)}</small>
    <div class="ms-auto d-flex align-items-center gap-2">
      <label class="form-label mb-0 small">Zoom</label>
      <input type="range" class="form-range vg-zoom" min="20" max="300" step="5" value="${props.pixelsPerSecond}" style="width: 140px;"/>
      <span class="small text-muted">${props.pixelsPerSecond} px/s</span>
    </div>
  `;
  const slider = bar.querySelector(".vg-zoom") as HTMLInputElement;
  slider.addEventListener("input", () => {
    props.onZoomChange(parseInt(slider.value, 10));
  });
  return bar;
}

function renderTrack(props: TimelineProps): HTMLElement {
  const track = document.createElement("div");
  track.className = "vg-tl-track";
  track.addEventListener("dragover", (e) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
  });
  track.addEventListener("drop", (e) => {
    e.preventDefault();
    const segId = readSegmentDragData(e);
    if (segId !== null) {
      const insertAt = indexFromClientX(track, e.clientX, props.clips.length);
      props.onDropSegment(segId, insertAt);
      return;
    }
    const fromIdx = readClipDragData(e);
    if (fromIdx !== null) {
      const to = indexFromClientX(track, e.clientX, props.clips.length);
      if (to !== fromIdx) props.onReorder(fromIdx, to);
    }
  });

  if (props.clips.length === 0) {
    const empty = document.createElement("div");
    empty.className = "vg-tl-empty text-muted small";
    empty.textContent = "Drop segments here to build your composition.";
    track.appendChild(empty);
    return track;
  }

  props.clips.forEach((clip, i) => {
    track.appendChild(renderClip(clip, i, props));
  });

  return track;
}

function renderClip(clip: Clip, index: number, props: TimelineProps): HTMLElement {
  const el = document.createElement("div");
  el.className = "vg-clip";
  if (index === props.selectedIndex) el.classList.add("selected");
  el.draggable = true;

  const seg = clip.segment;
  const fps =
    seg && seg.duration_seconds > 0 ? seg.frame_count / seg.duration_seconds : 24;
  const effFrames = seg
    ? seg.frame_count - clip.trim_start_frame - clip.trim_end_frame
    : 0;
  const effSeconds = fps > 0 ? effFrames / fps : 0;
  const widthPx = Math.max(60, effSeconds * props.pixelsPerSecond);
  el.style.width = `${widthPx}px`;

  const thumbUrl = seg?.thumbnail_path ?? null;
  el.innerHTML = `
    <div class="vg-clip-inner">
      ${
        thumbUrl
          ? `<div class="vg-clip-thumb" style="background-image: url('/api/thumbnails/${escapeHtml(thumbUrl)}');"></div>`
          : '<div class="vg-clip-thumb vg-clip-thumb-missing"></div>'
      }
      <div class="vg-clip-label">
        <span>${escapeHtml(seg ? seg.scanner_name : "missing")}</span>
        <small>${formatDuration(effSeconds)}</small>
      </div>
      <button type="button" class="vg-clip-remove" title="Remove clip">×</button>
      <div class="vg-clip-handle left" data-side="left"></div>
      <div class="vg-clip-handle right" data-side="right"></div>
    </div>
  `;

  el.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).classList.contains("vg-clip-remove")) return;
    props.onSelectClip(index);
  });
  el.querySelector(".vg-clip-remove")?.addEventListener("click", (e) => {
    e.stopPropagation();
    props.onRemoveClip(index);
  });
  el.addEventListener("dragstart", (e) => setClipDragData(e, index));

  wireHandle(
    el.querySelector(".vg-clip-handle.left") as HTMLElement,
    "left",
    clip,
    index,
    props
  );
  wireHandle(
    el.querySelector(".vg-clip-handle.right") as HTMLElement,
    "right",
    clip,
    index,
    props
  );

  return el;
}

function wireHandle(
  handle: HTMLElement,
  side: "left" | "right",
  clip: Clip,
  index: number,
  props: TimelineProps
): void {
  if (!handle) return;
  handle.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const seg = clip.segment;
    if (!seg) return;
    const fps = seg.duration_seconds > 0 ? seg.frame_count / seg.duration_seconds : 24;
    const startX = e.clientX;
    const startTrim = side === "left" ? clip.trim_start_frame : clip.trim_end_frame;

    const onMove = (ev: MouseEvent) => {
      const dx = ev.clientX - startX;
      const deltaFrames = (dx / props.pixelsPerSecond) * fps;
      const minTrim = 0;
      const maxTrim =
        seg.frame_count -
        (side === "left" ? clip.trim_end_frame : clip.trim_start_frame) -
        1;
      const proposed = Math.round(
        side === "left" ? startTrim + deltaFrames : startTrim - deltaFrames
      );
      const bounded = Math.max(minTrim, Math.min(maxTrim, proposed));
      if (side === "left") props.onTrimStartChange(index, bounded);
      else props.onTrimEndChange(index, bounded);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  });
}

function renderInspector(props: TimelineProps): HTMLElement {
  const panel = document.createElement("div");
  panel.className = "vg-tl-inspector mt-2";
  if (props.selectedIndex === null) {
    panel.innerHTML =
      '<small class="text-muted">Select a clip to trim frame-exactly.</small>';
    return panel;
  }
  const clip = props.clips[props.selectedIndex];
  if (!clip || !clip.segment) {
    panel.innerHTML =
      '<small class="text-muted">Selected clip is missing its segment.</small>';
    return panel;
  }
  const seg = clip.segment;
  const maxTrim = seg.frame_count - 1;
  panel.innerHTML = `
    <div class="card card-body py-2">
      <div class="row g-2 align-items-end">
        <div class="col-auto">
          <small class="text-muted d-block">Segment</small>
          <code>#${seg.id}</code>
        </div>
        <div class="col-auto">
          <label class="form-label small mb-0">Trim start (frames)</label>
          <input type="number" class="form-control form-control-sm" id="vg-trim-start"
                 min="0" max="${maxTrim}" value="${clip.trim_start_frame}" style="width: 110px;"/>
        </div>
        <div class="col-auto">
          <label class="form-label small mb-0">Trim end (frames)</label>
          <input type="number" class="form-control form-control-sm" id="vg-trim-end"
                 min="0" max="${maxTrim}" value="${clip.trim_end_frame}" style="width: 110px;"/>
        </div>
        <div class="col text-end">
          <small class="text-muted">effective frames:
            <strong>${seg.frame_count - clip.trim_start_frame - clip.trim_end_frame}</strong>
            of ${seg.frame_count}
          </small>
        </div>
      </div>
    </div>
  `;
  const selectedIdx = props.selectedIndex;
  const startInput = panel.querySelector("#vg-trim-start") as HTMLInputElement;
  const endInput = panel.querySelector("#vg-trim-end") as HTMLInputElement;
  startInput.addEventListener("change", () => {
    props.onTrimStartChange(selectedIdx, parseInt(startInput.value, 10) || 0);
  });
  endInput.addEventListener("change", () => {
    props.onTrimEndChange(selectedIdx, parseInt(endInput.value, 10) || 0);
  });
  return panel;
}

function indexFromClientX(
  track: HTMLElement,
  clientX: number,
  clipCount: number
): number {
  const children = Array.from(track.querySelectorAll(".vg-clip")) as HTMLElement[];
  for (let i = 0; i < children.length; i++) {
    const rect = children[i]!.getBoundingClientRect();
    const mid = rect.left + rect.width / 2;
    if (clientX < mid) return i;
  }
  return clipCount;
}
