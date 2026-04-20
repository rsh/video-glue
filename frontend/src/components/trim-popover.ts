/**
 * Trim popover: two frame inputs + live thumbnails of the new first/last frame.
 *
 * Frame extraction is client-side — a hidden <video> is seeked to the target
 * time and drawn into a <canvas>. Browser seek isn't frame-exact on H.264
 * proxies, so the preview may drift a frame or two near GOP boundaries; good
 * enough for eyeballing, not for precision editing.
 */

import { apiClient, type Clip, type Segment } from "../api";

export interface TrimPopoverParams {
  clip: Clip;
  anchor: HTMLElement;
  onChange: (trimStart: number, trimEnd: number) => void;
}

export interface TrimPopoverHandle {
  element: HTMLElement;
  close: () => void;
}

export function openTrimPopover(params: TrimPopoverParams): TrimPopoverHandle {
  const { clip, anchor, onChange } = params;
  if (!clip.segment) {
    throw new Error("openTrimPopover requires a clip with an embedded segment");
  }
  const seg: Segment = clip.segment;
  const fps = seg.duration_seconds > 0 ? seg.frame_count / seg.duration_seconds : 24;
  const maxTrim = Math.max(0, seg.frame_count - 1);

  const el = document.createElement("div");
  el.className = "vg3-trim-popover";
  el.innerHTML = `
    <div class="vg3-trim-header">
      <span>Trim clip (${seg.frame_count} frames)</span>
      <button type="button" class="vg3-trim-close-x" title="Close">×</button>
    </div>
    <div class="vg3-trim-body">
      <div class="vg3-trim-col">
        <div class="vg3-trim-label">New first frame</div>
        <canvas class="vg3-trim-canvas vg3-trim-start-canvas" width="192" height="108"></canvas>
        <div class="vg3-trim-input-row">
          <span class="vg3-trim-input-label">Trim start</span>
          <input type="number" class="form-control form-control-sm vg3-trim-start-input" min="0" max="${maxTrim}" step="1" value="${clip.trim_start_frame}">
          <span class="vg3-trim-unit">fr</span>
        </div>
      </div>
      <div class="vg3-trim-col">
        <div class="vg3-trim-label">New last frame</div>
        <canvas class="vg3-trim-canvas vg3-trim-end-canvas" width="192" height="108"></canvas>
        <div class="vg3-trim-input-row">
          <span class="vg3-trim-input-label">Trim end</span>
          <input type="number" class="form-control form-control-sm vg3-trim-end-input" min="0" max="${maxTrim}" step="1" value="${clip.trim_end_frame}">
          <span class="vg3-trim-unit">fr</span>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(el);
  positionNearAnchor(el, anchor);

  const startInput = el.querySelector<HTMLInputElement>(".vg3-trim-start-input")!;
  const endInput = el.querySelector<HTMLInputElement>(".vg3-trim-end-input")!;
  const startCanvas = el.querySelector<HTMLCanvasElement>(".vg3-trim-start-canvas")!;
  const endCanvas = el.querySelector<HTMLCanvasElement>(".vg3-trim-end-canvas")!;
  const closeX = el.querySelector<HTMLButtonElement>(".vg3-trim-close-x")!;

  // Hidden video for frame extraction. Same source the preview already streams
  // from, so the browser should reuse its media cache.
  const video = document.createElement("video");
  video.src = apiClient.videoStreamUrl(seg.video_id);
  video.preload = "auto";
  video.muted = true;
  video.playsInline = true;
  video.style.position = "fixed";
  video.style.width = "1px";
  video.style.height = "1px";
  video.style.opacity = "0";
  video.style.pointerEvents = "none";
  document.body.appendChild(video);

  let loaded = false;
  let seekQueue = Promise.resolve();

  video.addEventListener("loadedmetadata", () => {
    loaded = true;
    void refreshStart();
    void refreshEnd();
  });

  function seekTo(time: number): Promise<void> {
    // Serialize seeks — the browser can only honor one at a time.
    const next = seekQueue.then(
      () =>
        new Promise<void>((resolve) => {
          const onSeeked = (): void => {
            video.removeEventListener("seeked", onSeeked);
            resolve();
          };
          video.addEventListener("seeked", onSeeked);
          video.currentTime = Math.max(0, time);
        })
    );
    seekQueue = next.catch(() => undefined);
    return next;
  }

  async function drawTo(canvas: HTMLCanvasElement, time: number): Promise<void> {
    if (!loaded) return;
    await seekTo(time);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  }

  function trimStartValue(): number {
    return clamp(parseInt(startInput.value, 10) || 0, 0, maxTrim - trimEndValue());
  }
  function trimEndValue(): number {
    return clamp(parseInt(endInput.value, 10) || 0, 0, maxTrim);
  }

  async function refreshStart(): Promise<void> {
    const t = seg.start_pts_seconds + trimStartValue() / fps;
    await drawTo(startCanvas, t);
  }

  async function refreshEnd(): Promise<void> {
    // Show the last frame that's still in the clip — one frame before the cut.
    const t = seg.end_pts_seconds - trimEndValue() / fps - 1 / fps;
    await drawTo(endCanvas, t);
  }

  function applyAndEmit(): void {
    const ts = clamp(parseInt(startInput.value, 10) || 0, 0, maxTrim);
    const te = clamp(parseInt(endInput.value, 10) || 0, 0, maxTrim);
    // Keep at least one frame.
    const cappedStart = Math.min(ts, maxTrim - te);
    const cappedEnd = Math.min(te, maxTrim - cappedStart);
    if (String(cappedStart) !== startInput.value)
      startInput.value = String(cappedStart);
    if (String(cappedEnd) !== endInput.value) endInput.value = String(cappedEnd);
    onChange(cappedStart, cappedEnd);
  }

  startInput.addEventListener("input", () => {
    applyAndEmit();
    void refreshStart();
  });
  endInput.addEventListener("input", () => {
    applyAndEmit();
    void refreshEnd();
  });

  function onDocPointerDown(e: PointerEvent): void {
    const target = e.target as Node;
    if (el.contains(target)) return;
    if (anchor.contains(target)) return;
    close();
  }
  // Defer so the click that opened the popover doesn't close it.
  window.setTimeout(() => {
    document.addEventListener("pointerdown", onDocPointerDown);
  }, 0);

  closeX.addEventListener("click", close);

  function close(): void {
    document.removeEventListener("pointerdown", onDocPointerDown);
    el.remove();
    video.remove();
  }

  return { element: el, close };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function positionNearAnchor(el: HTMLElement, anchor: HTMLElement): void {
  const r = anchor.getBoundingClientRect();
  el.style.position = "fixed";
  el.style.zIndex = "1080";
  // Show below the anchor by default; flip above if no room.
  const viewportH = window.innerHeight;
  const approxH = 280; // rough height — we don't know until after mount
  const below = r.bottom + 8;
  const useAbove = below + approxH > viewportH;
  el.style.top = useAbove ? `${Math.max(8, r.top - approxH - 8)}px` : `${below}px`;
  // Align to the anchor's left, but keep within viewport width.
  const approxW = 460;
  const leftRaw = Math.min(r.left, window.innerWidth - approxW - 8);
  el.style.left = `${Math.max(8, leftRaw)}px`;
}
