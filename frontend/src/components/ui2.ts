/**
 * UI 2 — three-section editor: video list + player (top),
 * segment viewer scrolling through the current playhead (middle),
 * composition timeline with drag-drop + yellow playhead (bottom).
 */

import { apiClient, type Clip, type Segment, type Video } from "../api";
import {
  MIME_SEGMENT,
  readSegmentDragData,
  setSegmentDragData,
} from "./drag";
import { formatDuration } from "./feedback";

export interface UI2Params {
  videos: Video[];
  segmentsByVideo: Map<number, Segment[]>;
  clips: Clip[];
  onAddClip: (segmentId: number, insertIndex: number) => void;
  onRemoveClip: (index: number) => void;
}

export interface UI2Handle {
  element: HTMLElement;
  update: (params: UI2Params) => void;
  /** Fast path: only the clips changed. Skips video list + segment lanes. */
  setClips: (clips: Clip[]) => void;
  /** Fast path: only videos/segments changed. Skips composition timeline. */
  setVideos: (videos: Video[], segmentsByVideo: Map<number, Segment[]>) => void;
}

type PlayMode = "idle" | "source" | "composition";

interface ClipTiming {
  videoId: number;
  startTime: number;
  endTime: number;
  duration: number;
  fps: number;
}

const SEG_TILE = 72; // square tile size (px) in segment viewer
const COMP_TILE = 72; // square tile size (px) in composition timeline

function clipTiming(clip: Clip): ClipTiming | null {
  const seg = clip.segment;
  if (!seg) return null;
  const fps = seg.duration_seconds > 0 ? seg.frame_count / seg.duration_seconds : 24;
  const startTime = seg.start_pts_seconds + clip.trim_start_frame / fps;
  const endTime = seg.end_pts_seconds - clip.trim_end_frame / fps;
  return {
    videoId: seg.video_id,
    startTime,
    endTime,
    duration: Math.max(0, endTime - startTime),
    fps,
  };
}

/**
 * Same source video and the trim boundaries touch exactly at a frame — playback
 * can roll through with no seek.
 */
function areContiguous(a: Clip, b: Clip): boolean {
  if (!a.segment || !b.segment) return false;
  if (a.segment.video_id !== b.segment.video_id) return false;
  const aEndFrame = a.segment.end_frame - a.trim_end_frame;
  const bStartFrame = b.segment.start_frame + b.trim_start_frame;
  return aEndFrame === bStartFrame;
}

function scannerColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i += 1) {
    h = (h * 31 + name.charCodeAt(i)) >>> 0;
  }
  const hue = h % 360;
  return `hsl(${hue}, 65%, 55%)`;
}

export function createUI2(initial: UI2Params): UI2Handle {
  let params: UI2Params = initial;

  // ---------- root layout ----------
  const root = document.createElement("div");
  root.className = "vg2-root";
  root.innerHTML = `
    <div class="vg2-top">
      <div class="vg2-video-list"></div>
      <div class="vg2-player">
        <div class="vg2-player-frame">
          <video class="vg2-player-video" playsinline preload="auto"></video>
          <div class="vg2-player-empty">Pick a video on the left to start.</div>
        </div>
        <div class="vg2-player-controls">
          <button type="button" class="btn btn-sm btn-outline-light vg2-player-play">▶</button>
          <span class="vg2-player-time">0:00 / 0:00</span>
          <input type="range" class="vg2-player-seek form-range" min="0" max="1000" value="0" step="1" />
        </div>
      </div>
    </div>
    <div class="vg2-middle">
      <button type="button" class="vg2-seg-play" title="Play video">▶</button>
      <div class="vg2-seg-viewer">
        <div class="vg2-seg-lanes"></div>
        <div class="vg2-seg-playhead"></div>
        <div class="vg2-seg-empty">Select a video to see its segments here.</div>
      </div>
    </div>
    <div class="vg2-bottom">
      <button type="button" class="vg2-comp-play" title="Play composition">▶</button>
      <div class="vg2-comp-track-wrap">
        <div class="vg2-comp-track">
          <div class="vg2-comp-clips"></div>
          <div class="vg2-comp-playhead"></div>
        </div>
        <div class="vg2-comp-empty">Drag segments here to build a clip.</div>
      </div>
    </div>
  `;

  const videoListEl = root.querySelector<HTMLElement>(".vg2-video-list")!;
  const playerVideoEl = root.querySelector<HTMLVideoElement>(".vg2-player-video")!;
  const playerEmptyEl = root.querySelector<HTMLElement>(".vg2-player-empty")!;
  const playBtn = root.querySelector<HTMLButtonElement>(".vg2-player-play")!;
  const timeLabel = root.querySelector<HTMLElement>(".vg2-player-time")!;
  const seekEl = root.querySelector<HTMLInputElement>(".vg2-player-seek")!;

  const segPlayBtn = root.querySelector<HTMLButtonElement>(".vg2-seg-play")!;
  const segLanesEl = root.querySelector<HTMLElement>(".vg2-seg-lanes")!;
  const segEmptyEl = root.querySelector<HTMLElement>(".vg2-seg-empty")!;

  const compPlayBtn = root.querySelector<HTMLButtonElement>(".vg2-comp-play")!;
  const compTrackWrap = root.querySelector<HTMLElement>(".vg2-comp-track-wrap")!;
  const compClipsEl = root.querySelector<HTMLElement>(".vg2-comp-clips")!;
  const compPlayheadEl = root.querySelector<HTMLElement>(".vg2-comp-playhead")!;
  const compEmptyEl = root.querySelector<HTMLElement>(".vg2-comp-empty")!;

  // ---------- playback state ----------
  let mode: PlayMode = "idle";
  let selectedVideoId: number | null = null;
  let compClipIndex = 0;
  let rafId: number | null = null;
  let seeking = false;

  // ---------- render: video list ----------
  function renderVideoList(): void {
    videoListEl.innerHTML = "";
    if (params.videos.length === 0) {
      const empty = document.createElement("div");
      empty.className = "vg2-vl-empty text-muted small p-2";
      empty.textContent = "No videos in library.";
      videoListEl.appendChild(empty);
      return;
    }
    for (const v of params.videos) {
      const row = document.createElement("button");
      row.type = "button";
      row.className =
        "vg2-vl-row text-start" + (v.id === selectedVideoId ? " active" : "");
      const status = v.preview_ready
        ? ""
        : `<span class="badge bg-warning text-dark vg2-vl-badge">${v.preview_proxy_status}</span>`;
      row.innerHTML = `
        <div class="vg2-vl-name" title="${escapeAttr(v.filename)}">${escapeHtml(v.filename)}</div>
        <div class="vg2-vl-meta">
          <span>${formatDuration(v.duration_seconds)}</span>
          <span>${v.segment_count ?? 0} seg</span>
          ${status}
        </div>
      `;
      row.addEventListener("click", () => selectVideo(v.id));
      videoListEl.appendChild(row);
    }
  }

  // ---------- render: segment viewer ----------
  // Tracks sorted segments per scanner for the current video so we can cheaply
  // compute sub-tile scroll offsets on every animation frame.
  let laneSegments: { name: string; segs: Segment[] }[] = [];

  function renderSegmentLanes(): void {
    segLanesEl.innerHTML = "";
    laneSegments = [];
    const videoId = currentPlaybackVideoId();
    if (videoId === null) {
      segEmptyEl.style.display = "flex";
      segEmptyEl.textContent = "Select a video to see its segments here.";
      return;
    }
    const segs = params.segmentsByVideo.get(videoId) ?? [];
    if (segs.length === 0) {
      segEmptyEl.style.display = "flex";
      segEmptyEl.textContent = "This video has no segments yet.";
      return;
    }
    segEmptyEl.style.display = "none";

    // Group by scanner for vertical lanes; within a lane, segments are laid
    // out as fixed-size squares in time order.
    const byScanner = new Map<string, Segment[]>();
    for (const s of segs) {
      const list = byScanner.get(s.scanner_name) ?? [];
      list.push(s);
      byScanner.set(s.scanner_name, list);
    }
    const scanners = Array.from(byScanner.keys()).sort();

    for (const name of scanners) {
      const sorted = (byScanner.get(name) ?? [])
        .slice()
        .sort((a, b) => a.start_pts_seconds - b.start_pts_seconds);
      laneSegments.push({ name, segs: sorted });

      const lane = document.createElement("div");
      lane.className = "vg2-seg-lane";
      const label = document.createElement("div");
      label.className = "vg2-seg-lane-label";
      label.textContent = name;
      label.style.background = scannerColor(name);
      lane.appendChild(label);

      const row = document.createElement("div");
      row.className = "vg2-seg-row";
      row.dataset["scanner"] = name;

      sorted.forEach((s, idx) => {
        const tile = document.createElement("div");
        tile.className = "vg2-seg-tile";
        tile.draggable = true;
        tile.style.left = `${idx * SEG_TILE}px`;
        tile.style.width = `${SEG_TILE}px`;
        tile.style.height = `${SEG_TILE}px`;
        if (s.thumbnail_path) {
          const img = document.createElement("img");
          img.className = "vg2-seg-tile-img";
          img.loading = "lazy";
          img.decoding = "async";
          img.src = apiClient.thumbnailUrl(s.thumbnail_path);
          img.alt = "";
          tile.appendChild(img);
        }
        const dur = document.createElement("span");
        dur.className = "vg2-seg-tile-dur";
        dur.textContent = formatDuration(s.duration_seconds);
        tile.appendChild(dur);
        tile.title = `${name} · ${formatDuration(s.duration_seconds)}`;
        tile.addEventListener("dragstart", (e) => setSegmentDragData(e, s.id));
        row.appendChild(tile);
      });

      lane.appendChild(row);
      segLanesEl.appendChild(lane);
    }

    updateSegmentPlayhead();
  }

  function updateSegmentPlayhead(): void {
    const t = currentPlaybackTime();
    const viewerWidth = segLanesEl.parentElement?.clientWidth ?? 0;
    const centerX = viewerWidth / 2;
    // Each lane scrolls independently: its "current" tile + sub-tile fraction
    // determines the translate so the playing moment is under the playhead.
    const rows = segLanesEl.querySelectorAll<HTMLElement>(".vg2-seg-row");
    rows.forEach((row) => {
      const name = row.dataset["scanner"];
      if (!name) return;
      const lane = laneSegments.find((l) => l.name === name);
      if (!lane || lane.segs.length === 0) {
        row.style.transform = `translateX(${centerX}px)`;
        return;
      }
      // Find index of segment containing t (or closest).
      let idx = lane.segs.findIndex(
        (s) => t >= s.start_pts_seconds && t < s.end_pts_seconds
      );
      let fraction = 0;
      if (idx === -1) {
        if (t < lane.segs[0]!.start_pts_seconds) {
          idx = 0;
          fraction = 0;
        } else {
          idx = lane.segs.length - 1;
          fraction = 1;
        }
      } else {
        const seg = lane.segs[idx]!;
        const d = seg.end_pts_seconds - seg.start_pts_seconds;
        fraction = d > 0 ? (t - seg.start_pts_seconds) / d : 0;
      }
      const pos = (idx + fraction) * SEG_TILE + SEG_TILE / 2;
      row.style.transform = `translateX(${centerX - pos}px)`;
    });
  }

  // ---------- render: composition timeline ----------
  function renderCompTimeline(): void {
    compClipsEl.innerHTML = "";
    if (params.clips.length === 0) {
      compEmptyEl.style.display = "flex";
      compPlayheadEl.style.display = "none";
      return;
    }
    compEmptyEl.style.display = "none";

    params.clips.forEach((clip, i) => {
      const t = clipTiming(clip);
      if (!t) return;
      const block = document.createElement("div");
      block.className = "vg2-comp-clip";
      block.style.width = `${COMP_TILE}px`;
      block.style.height = `${COMP_TILE}px`;
      if (clip.segment?.thumbnail_path) {
        const img = document.createElement("img");
        img.className = "vg2-comp-clip-img";
        img.loading = "lazy";
        img.decoding = "async";
        img.src = apiClient.thumbnailUrl(clip.segment.thumbnail_path);
        img.alt = "";
        block.appendChild(img);
      }
      const label = document.createElement("span");
      label.className = "vg2-comp-clip-label";
      label.textContent = formatDuration(t.duration);
      block.appendChild(label);
      const rm = document.createElement("button");
      rm.type = "button";
      rm.className = "vg2-comp-clip-remove";
      rm.textContent = "×";
      rm.title = "Remove";
      rm.addEventListener("click", (e) => {
        e.stopPropagation();
        params.onRemoveClip(i);
      });
      block.appendChild(rm);
      compClipsEl.appendChild(block);
    });

    updateCompPlayhead();
  }

  function updateCompPlayhead(): void {
    if (mode !== "composition" || params.clips.length === 0) {
      compPlayheadEl.style.display = "none";
      return;
    }
    const clip = params.clips[compClipIndex];
    const t = clip ? clipTiming(clip) : null;
    if (!t) {
      compPlayheadEl.style.display = "none";
      return;
    }
    // Each clip occupies one fixed-size tile; playhead advances proportionally
    // through the tile as the clip plays.
    const within = Math.max(
      0,
      Math.min(t.duration, playerVideoEl.currentTime - t.startTime)
    );
    const fraction = t.duration > 0 ? within / t.duration : 0;
    const px = (compClipIndex + fraction) * COMP_TILE;
    compPlayheadEl.style.display = "block";
    compPlayheadEl.style.left = `${px}px`;
  }

  // ---------- playback helpers ----------
  function currentPlaybackVideoId(): number | null {
    if (mode === "composition") {
      const c = params.clips[compClipIndex];
      return c?.segment?.video_id ?? null;
    }
    return selectedVideoId;
  }

  function currentPlaybackTime(): number {
    if (Number.isFinite(playerVideoEl.currentTime)) return playerVideoEl.currentTime;
    return 0;
  }

  function selectVideo(id: number): void {
    selectedVideoId = id;
    mode = "idle";
    playerVideoEl.pause();
    playerEmptyEl.style.display = "none";
    playerVideoEl.style.visibility = "visible";
    playerVideoEl.src = apiClient.videoStreamUrl(id);
    playerVideoEl.currentTime = 0;
    renderVideoList();
    renderSegmentLanes();
    updateModeButtons();
  }

  function enterSourceMode(autoplay: boolean): void {
    if (selectedVideoId === null) return;
    mode = "source";
    // If the video element currently holds a different source (e.g. we were
    // just playing the composition), reload the selected source video.
    const needsReload = !playerVideoEl.currentSrc.includes(
      `/videos/${selectedVideoId}/stream`
    );
    if (needsReload) {
      playerVideoEl.src = apiClient.videoStreamUrl(selectedVideoId);
      playerVideoEl.currentTime = 0;
    }
    if (autoplay) void playerVideoEl.play();
    updateModeButtons();
    renderSegmentLanes();
  }

  function startComposition(): void {
    if (params.clips.length === 0) return;
    mode = "composition";
    compClipIndex = 0;
    loadCompositionClip(0, true);
    playerEmptyEl.style.display = "none";
    updateModeButtons();
  }

  function updateModeButtons(): void {
    segPlayBtn.classList.toggle("active", mode === "source");
    compPlayBtn.classList.toggle("active", mode === "composition");
    segPlayBtn.disabled = selectedVideoId === null;
    compPlayBtn.disabled = params.clips.length === 0;
  }

  function endComposition(): void {
    playerVideoEl.pause();
    compClipIndex = 0;
    mode = "idle";
    updateModeButtons();
    updateCompPlayhead();
  }

  function loadCompositionClip(index: number, autoplay: boolean): void {
    const clip = params.clips[index];
    const t = clip ? clipTiming(clip) : null;
    if (!t) {
      endComposition();
      return;
    }
    compClipIndex = index;
    const needsSrc =
      !playerVideoEl.currentSrc ||
      !playerVideoEl.currentSrc.includes(`/videos/${t.videoId}/stream`);
    const seekAndPlay = (): void => {
      playerVideoEl.currentTime = t.startTime;
      if (autoplay) void playerVideoEl.play();
    };
    if (needsSrc) {
      playerVideoEl.src = apiClient.videoStreamUrl(t.videoId);
      playerVideoEl.addEventListener("loadedmetadata", seekAndPlay, { once: true });
    } else {
      seekAndPlay();
    }
    renderSegmentLanes();
  }

  function onTimeUpdate(): void {
    if (mode === "composition") {
      const clip = params.clips[compClipIndex];
      const t = clip ? clipTiming(clip) : null;
      if (t && playerVideoEl.currentTime >= t.endTime - 0.03) {
        const nextIdx = compClipIndex + 1;
        if (nextIdx >= params.clips.length) {
          endComposition();
          return;
        }
        const nextClip = params.clips[nextIdx]!;
        if (clip && areContiguous(clip, nextClip)) {
          // Same source, frame-touching — let playback roll through without a seek.
          compClipIndex = nextIdx;
          renderSegmentLanes();
          // Fall through to refreshSeek so the seek slider updates.
        } else {
          loadCompositionClip(nextIdx, true);
          return;
        }
      }
    }
    refreshSeek();
  }

  function refreshSeek(): void {
    if (seeking) return;
    const dur = playerVideoEl.duration;
    const cur = playerVideoEl.currentTime;
    if (Number.isFinite(dur) && dur > 0) {
      seekEl.value = String(Math.round((cur / dur) * 1000));
    }
    timeLabel.textContent = `${formatDuration(cur)} / ${formatDuration(
      Number.isFinite(dur) ? dur : null
    )}`;
  }

  function startRaf(): void {
    if (rafId !== null) return;
    const tick = (): void => {
      updateSegmentPlayhead();
      updateCompPlayhead();
      if (!playerVideoEl.paused) rafId = requestAnimationFrame(tick);
      else rafId = null;
    };
    rafId = requestAnimationFrame(tick);
  }

  function stopRaf(): void {
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  }

  // ---------- wire events ----------
  playerVideoEl.addEventListener("timeupdate", onTimeUpdate);
  playerVideoEl.addEventListener("loadedmetadata", refreshSeek);
  playerVideoEl.addEventListener("play", () => {
    playBtn.textContent = "❚❚";
    startRaf();
    // Playing from idle state (e.g. via the embedded player control) implies
    // source mode. Composition mode is entered explicitly via comp-play.
    if (mode === "idle" && selectedVideoId !== null) {
      mode = "source";
      updateModeButtons();
    }
  });
  playerVideoEl.addEventListener("pause", () => {
    playBtn.textContent = "▶";
    stopRaf();
    // Freeze playhead in place.
    updateSegmentPlayhead();
    updateCompPlayhead();
  });
  playerVideoEl.addEventListener("ended", () => {
    if (mode === "composition") {
      const nextIdx = compClipIndex + 1;
      if (nextIdx < params.clips.length) {
        loadCompositionClip(nextIdx, true);
      } else {
        endComposition();
      }
    }
  });

  playBtn.addEventListener("click", () => {
    // Hitting play from idle promotes to full-video (source) mode.
    if (mode === "idle") {
      if (selectedVideoId !== null) enterSourceMode(true);
      return;
    }
    if (playerVideoEl.paused) void playerVideoEl.play();
    else playerVideoEl.pause();
  });

  seekEl.addEventListener("pointerdown", () => {
    seeking = true;
  });
  seekEl.addEventListener("pointerup", () => {
    seeking = false;
  });
  seekEl.addEventListener("input", () => {
    const dur = playerVideoEl.duration;
    if (!Number.isFinite(dur) || dur <= 0) return;
    const frac = parseFloat(seekEl.value) / 1000;
    if (mode === "composition") {
      // Scrubbing the seek bar means the user is driving the full source video
      // now — switch to full-video mode, pinned to whatever clip was on screen.
      const clip = params.clips[compClipIndex];
      if (clip?.segment) selectedVideoId = clip.segment.video_id;
      mode = "source";
      updateModeButtons();
      renderVideoList();
      renderSegmentLanes();
    }
    playerVideoEl.currentTime = frac * dur;
    updateSegmentPlayhead();
    updateCompPlayhead();
  });

  segPlayBtn.addEventListener("click", () => {
    if (selectedVideoId === null) return;
    if (mode === "source") {
      // Already in video-play mode — toggle pause/play.
      if (playerVideoEl.paused) void playerVideoEl.play();
      else playerVideoEl.pause();
    } else {
      // Switching in from composition (or idle).
      enterSourceMode(true);
    }
  });

  compPlayBtn.addEventListener("click", () => {
    if (params.clips.length === 0) return;
    if (mode === "composition") {
      // Already in composition-play mode — toggle pause/play.
      if (playerVideoEl.paused) void playerVideoEl.play();
      else playerVideoEl.pause();
    } else {
      startComposition();
    }
  });

  // Composition timeline drop zone
  compTrackWrap.addEventListener("dragover", (e) => {
    if (!e.dataTransfer?.types.includes(MIME_SEGMENT)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    compTrackWrap.classList.add("vg2-drop-active");
  });
  compTrackWrap.addEventListener("dragleave", (e) => {
    if (e.target === compTrackWrap) {
      compTrackWrap.classList.remove("vg2-drop-active");
    }
  });
  compTrackWrap.addEventListener("drop", (e) => {
    compTrackWrap.classList.remove("vg2-drop-active");
    const id = readSegmentDragData(e);
    if (id === null) return;
    e.preventDefault();
    const index = insertIndexFromClientX(e.clientX);
    params.onAddClip(id, index);
  });

  function insertIndexFromClientX(clientX: number): number {
    const children = Array.from(
      compClipsEl.querySelectorAll<HTMLElement>(".vg2-comp-clip")
    );
    for (let i = 0; i < children.length; i += 1) {
      const rect = children[i]!.getBoundingClientRect();
      if (clientX < rect.left + rect.width / 2) return i;
    }
    return children.length;
  }

  // Keep segment playhead aligned on resize.
  const ro = new ResizeObserver(() => {
    updateSegmentPlayhead();
  });
  ro.observe(segLanesEl.parentElement!);

  // ---------- initial render ----------
  renderVideoList();
  renderSegmentLanes();
  renderCompTimeline();
  updateModeButtons();

  return {
    element: root,
    update: (next) => {
      params = next;
      renderVideoList();
      renderSegmentLanes();
      renderCompTimeline();
      updateModeButtons();
    },
    setClips: (nextClips) => {
      params = { ...params, clips: nextClips };
      renderCompTimeline();
      updateModeButtons();
    },
    setVideos: (nextVideos, nextSegs) => {
      params = { ...params, videos: nextVideos, segmentsByVideo: nextSegs };
      renderVideoList();
      renderSegmentLanes();
      updateModeButtons();
    },
  };
}

function escapeHtml(text: string): string {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function escapeAttr(text: string): string {
  return escapeHtml(text).replace(/"/g, "&quot;");
}
