/**
 * video-glue — main entry: auth gating + editor view.
 */

import "bootstrap/dist/css/bootstrap.min.css";
import * as bootstrap from "bootstrap";
import "./styles.css";

(window as typeof window & { bootstrap: typeof bootstrap }).bootstrap = bootstrap;

import {
  apiClient,
  type Clip,
  type Composition,
  type ExportFormat,
  type ExportJob,
  type ExportScaleDivisor,
  type Segment,
  type SubtitleHit,
  type Video,
} from "./api";
import {
  getCurrentUser,
  initAuth,
  isAuthenticated,
  logout,
  setCurrentUser,
} from "./auth";
import {
  createCompositionPanel,
  createLoginForm,
  createPreview,
  createRegisterForm,
  createSubtitleSearch,
  createTimeline,
  createUI2,
  createUI3,
  createVideoGrid,
  openExportDialog,
  showError,
  showSuccess,
  type PreviewHandle,
  type UI2Handle,
  type UI3Handle,
} from "./components";

// ---------- global editor state ----------

type TopView = "library" | "search";

interface EditorState {
  videos: Video[];
  segmentsByVideo: Map<number, Segment[]>;
  compositions: Composition[];
  current: Composition | null;
  clips: Clip[]; // working-copy with embedded segment objects
  selectedClipIndex: number | null;
  pixelsPerSecond: number;
  expandedVideos: Set<number>;
  scannerFilter: string | "all";
  exportJob: ExportJob | null;
  exportDownloadUrl: string | null;
  exportScaleDivisor: ExportScaleDivisor;
  dirty: boolean;
  topView: TopView;
  subtitleQuery: string;
  subtitleResults: SubtitleHit[];
}

const state: EditorState = {
  videos: [],
  segmentsByVideo: new Map(),
  compositions: [],
  current: null,
  clips: [],
  selectedClipIndex: null,
  pixelsPerSecond: 80,
  expandedVideos: new Set(),
  scannerFilter: "all",
  exportJob: null,
  exportDownloadUrl: null,
  exportScaleDivisor: 1,
  dirty: false,
  topView: "library",
  subtitleQuery: "",
  subtitleResults: [],
};

let previewHandle: PreviewHandle | null = null;
let ui2Handle: UI2Handle | null = null;
let ui3Handle: UI3Handle | null = null;
let activeTab: "ui1" | "ui2" | "ui3" = "ui3";
let videoPollTimer: number | null = null;
let exportPollTimer: number | null = null;

// ---------- bootstrap ----------

async function init(): Promise<void> {
  await initAuth();
  if (isAuthenticated()) {
    await showEditor();
  } else {
    showAuthView();
  }
}

function showAuthView(showRegister = false): void {
  const app = document.getElementById("app");
  if (!app) return;
  app.innerHTML = `
    <nav class="navbar navbar-dark bg-dark">
      <div class="container">
        <span class="navbar-brand mb-0 h1">video-glue</span>
      </div>
    </nav>
    <div class="container mt-5">
      <div class="row justify-content-center">
        <div class="col-md-6" id="auth-container"></div>
      </div>
    </div>
  `;
  const container = document.getElementById("auth-container");
  if (!container) return;

  if (showRegister) {
    const form = createRegisterForm();
    container.appendChild(form);
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target as HTMLFormElement);
      try {
        const res = await apiClient.register({
          email: fd.get("email") as string,
          username: fd.get("username") as string,
          password: fd.get("password") as string,
        });
        setCurrentUser(res.user);
        await showEditor();
      } catch (err) {
        showError(errorMessage(err));
      }
    });
    form
      .querySelector("#switch-to-login")
      ?.addEventListener("click", () => showAuthView(false));
  } else {
    const form = createLoginForm();
    container.appendChild(form);
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target as HTMLFormElement);
      try {
        const res = await apiClient.login({
          email: fd.get("email") as string,
          password: fd.get("password") as string,
        });
        setCurrentUser(res.user);
        await showEditor();
      } catch (err) {
        showError(errorMessage(err));
      }
    });
    form
      .querySelector("#switch-to-register")
      ?.addEventListener("click", () => showAuthView(true));
  }
}

// ---------- editor ----------

async function showEditor(): Promise<void> {
  const app = document.getElementById("app");
  const user = getCurrentUser();
  if (!app || !user) return;

  app.innerHTML = `
    <nav class="navbar navbar-dark bg-dark">
      <div class="container-fluid">
        <span class="navbar-brand mb-0 h1">video-glue</span>
        <div class="d-flex align-items-center gap-3">
          <span class="text-white small">${escapeHtml(user.username)}</span>
          <button class="btn btn-outline-light btn-sm" id="logout-btn">Logout</button>
        </div>
      </div>
    </nav>
    <div class="vg-tabs" role="tablist">
      <button type="button" class="vg-tab-btn" data-tab="ui1">UI 1</button>
      <button type="button" class="vg-tab-btn" data-tab="ui2">UI 2</button>
      <button type="button" class="vg-tab-btn active" data-tab="ui3">UI 3</button>
    </div>
    <div class="vg-tab-pane" data-tab-pane="ui1">
      <div class="vg-layout">
        <div class="vg-layout-main">
          <div id="vg-grid-pane"></div>
          <div class="vg-bottom">
            <div id="vg-preview-pane"></div>
            <div id="vg-timeline-pane"></div>
          </div>
        </div>
        <div id="vg-side-pane"></div>
      </div>
    </div>
    <div class="vg-tab-pane" data-tab-pane="ui2">
      <div id="vg-ui2-pane"></div>
    </div>
    <div class="vg-tab-pane active" data-tab-pane="ui3">
      <div id="vg-ui3-pane"></div>
    </div>
  `;
  document.getElementById("logout-btn")?.addEventListener("click", () => {
    stopPolling();
    logout();
  });

  document.querySelectorAll<HTMLElement>(".vg-tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const tab = btn.dataset["tab"] as "ui1" | "ui2" | "ui3";
      if (tab === activeTab) return;
      activeTab = tab;
      document.querySelectorAll<HTMLElement>(".vg-tab-btn").forEach((b) => {
        b.classList.toggle("active", b.dataset["tab"] === tab);
      });
      document.querySelectorAll<HTMLElement>(".vg-tab-pane").forEach((p) => {
        p.classList.toggle("active", p.dataset["tabPane"] === tab);
      });
      if (tab === "ui2") renderUI2();
      if (tab === "ui3") renderUI3();
    });
  });

  previewHandle = createPreview(state.clips);
  document.getElementById("vg-preview-pane")?.appendChild(previewHandle.element);

  ui2Handle = createUI2({
    videos: state.videos,
    segmentsByVideo: state.segmentsByVideo,
    clips: state.clips,
    onAddClip: handleAddClipFromUI2,
    onRemoveClip: handleRemoveClipFromUI2,
  });
  document.getElementById("vg-ui2-pane")?.appendChild(ui2Handle.element);

  ui3Handle = createUI3({
    videos: state.videos,
    segmentsByVideo: state.segmentsByVideo,
    clips: state.clips,
    composition: state.current,
    onAddClip: handleAddClipFromUI2,
    onRemoveClip: handleRemoveClipFromUI2,
    onTrimClip: handleTrimClipFromUI3,
    onExport: handleExportFromUI3,
    onRescanLibrary: handleRescanLibrary,
  });
  document.getElementById("vg-ui3-pane")?.appendChild(ui3Handle.element);

  // New empty composition on first load (no auto-select of existing ones).
  await loadCompositions();
  await createBlankComposition();
  await loadVideos();
  renderAll();
  startVideoPolling();
}

async function loadVideos(): Promise<void> {
  try {
    state.videos = await apiClient.getVideos();
    for (const v of state.videos) {
      if (!state.segmentsByVideo.has(v.id) && (v.segment_count ?? 0) > 0) {
        state.segmentsByVideo.set(v.id, await apiClient.getVideoSegments(v.id));
      }
    }
  } catch (err) {
    showError(errorMessage(err));
  }
}

async function loadCompositions(): Promise<void> {
  try {
    state.compositions = await apiClient.getCompositions();
  } catch (err) {
    showError(errorMessage(err));
  }
}

async function createBlankComposition(): Promise<void> {
  try {
    const comp = await apiClient.createComposition({});
    state.current = comp;
    state.clips = [];
    state.selectedClipIndex = null;
    state.dirty = false;
    await loadCompositions();
  } catch (err) {
    showError(errorMessage(err));
  }
}

async function loadComposition(id: number): Promise<void> {
  try {
    const comp = await apiClient.getComposition(id);
    state.current = comp;
    state.clips = (comp.clips ?? []).map((c) => ({ ...c }));
    state.selectedClipIndex = null;
    state.dirty = false;
  } catch (err) {
    showError(errorMessage(err));
  }
}

// ---------- rendering ----------

function renderAll(): void {
  renderGrid();
  renderTimeline();
  renderPanel();
  if (previewHandle) {
    previewHandle.setVideoStates(state.videos);
    previewHandle.setClips(state.clips);
  }
  renderUI2();
  renderUI3();
}

function renderUI2(): void {
  if (!ui2Handle) return;
  ui2Handle.update({
    videos: state.videos,
    segmentsByVideo: state.segmentsByVideo,
    clips: state.clips,
    onAddClip: handleAddClipFromUI2,
    onRemoveClip: handleRemoveClipFromUI2,
  });
}

function renderUI3(): void {
  if (!ui3Handle) return;
  ui3Handle.update({
    videos: state.videos,
    segmentsByVideo: state.segmentsByVideo,
    clips: state.clips,
    composition: state.current,
    onAddClip: handleAddClipFromUI2,
    onRemoveClip: handleRemoveClipFromUI2,
    onTrimClip: handleTrimClipFromUI3,
    onExport: handleExportFromUI3,
    onRescanLibrary: handleRescanLibrary,
  });
}

function handleAddClipFromUI2(segmentId: number, insertIndex: number): void {
  const seg = findSegment(segmentId);
  if (!seg) {
    showError("Segment not found");
    return;
  }
  const clip: Clip = {
    id: -1 - state.clips.length,
    composition_id: state.current?.id ?? 0,
    segment_id: seg.id,
    position: insertIndex,
    trim_start_frame: 0,
    trim_end_frame: 0,
    segment: seg,
  };
  state.clips.splice(insertIndex, 0, clip);
  state.dirty = true;
  renderClipsOnly();
}

function handleRemoveClipFromUI2(index: number): void {
  state.clips.splice(index, 1);
  if (state.selectedClipIndex === index) state.selectedClipIndex = null;
  state.dirty = true;
  renderClipsOnly();
}

function handleTrimClipFromUI3(
  index: number,
  trimStart: number,
  trimEnd: number
): void {
  const clip = state.clips[index];
  if (!clip || !clip.segment) return;
  const max = clip.segment.frame_count - 1;
  clip.trim_start_frame = Math.max(0, Math.min(max - trimEnd, trimStart));
  clip.trim_end_frame = Math.max(0, Math.min(max - clip.trim_start_frame, trimEnd));
  state.dirty = true;
  renderClipsOnly();
}

async function handleExportFromUI3(): Promise<void> {
  if (!state.current) return;
  // The composition's clips live in frontend state until saved — the backend
  // would see an empty composition otherwise and reject the export.
  if (state.dirty) {
    await handleSave();
    if (state.dirty) return; // save failed; showError already fired
  }
  if (!state.current) return;
  openExportDialog({
    composition: state.current,
    defaultScaleDivisor: state.exportScaleDivisor,
  });
}

/**
 * Granular refresh for clip-list mutations. Rebuilds only the pieces of the
 * UI whose output depends on `state.clips` — skips the (expensive) library
 * grid and segment viewer.
 */
function renderClipsOnly(): void {
  renderTimeline();
  renderPanel();
  if (previewHandle) previewHandle.setClips(state.clips);
  if (ui2Handle) ui2Handle.setClips(state.clips);
  if (ui3Handle) ui3Handle.setClips(state.clips);
}

function renderGrid(): void {
  const host = document.getElementById("vg-grid-pane");
  if (!host) return;
  host.innerHTML = "";
  host.appendChild(renderTopPaneToggle());
  if (state.topView === "library") {
    host.appendChild(
      createVideoGrid({
        videos: state.videos,
        segmentsByVideo: state.segmentsByVideo,
        scannerFilter: state.scannerFilter,
        expanded: state.expandedVideos,
        onRescan: handleRescanLibrary,
        onScanVideo: handleRescanVideo,
        onToggleExpand: handleToggleExpand,
      })
    );
  } else {
    host.appendChild(
      createSubtitleSearch({
        initialQuery: state.subtitleQuery,
        initialResults: state.subtitleResults,
        onSearch: (q, results) => {
          state.subtitleQuery = q;
          state.subtitleResults = results;
        },
        onError: (m) => showError(m),
      })
    );
  }
}

function renderTopPaneToggle(): HTMLElement {
  const bar = document.createElement("div");
  bar.className = "vg-top-toggle btn-group mb-2";
  bar.setAttribute("role", "group");
  bar.innerHTML = `
    <button type="button" class="btn btn-sm ${
      state.topView === "library" ? "btn-primary" : "btn-outline-primary"
    }" data-view="library">Library</button>
    <button type="button" class="btn btn-sm ${
      state.topView === "search" ? "btn-primary" : "btn-outline-primary"
    }" data-view="search">Search subtitles</button>
  `;
  bar.querySelectorAll("button[data-view]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const v = (btn as HTMLElement).dataset["view"] as TopView;
      if (v === state.topView) return;
      state.topView = v;
      renderGrid();
    });
  });
  return bar;
}

function renderTimeline(): void {
  const host = document.getElementById("vg-timeline-pane");
  if (!host) return;
  host.innerHTML = "";
  host.appendChild(
    createTimeline({
      clips: state.clips,
      selectedIndex: state.selectedClipIndex,
      pixelsPerSecond: state.pixelsPerSecond,
      onSelectClip: (i) => {
        state.selectedClipIndex = i;
        renderTimeline();
        if (previewHandle) previewHandle.seekToClip(i);
      },
      onRemoveClip: (i) => {
        state.clips.splice(i, 1);
        if (state.selectedClipIndex === i) state.selectedClipIndex = null;
        state.dirty = true;
        renderClipsOnly();
      },
      onReorder: (from, to) => {
        const [moved] = state.clips.splice(from, 1);
        if (!moved) return;
        const insertAt = to > from ? to - 1 : to;
        state.clips.splice(insertAt, 0, moved);
        state.dirty = true;
        renderClipsOnly();
      },
      onDropSegment: (segmentId, insertIndex) => {
        const seg = findSegment(segmentId);
        if (!seg) {
          showError("Segment not found");
          return;
        }
        const clip: Clip = {
          id: -1 - state.clips.length, // temporary negative IDs for unsaved clips
          composition_id: state.current?.id ?? 0,
          segment_id: seg.id,
          position: insertIndex,
          trim_start_frame: 0,
          trim_end_frame: 0,
          segment: seg,
        };
        state.clips.splice(insertIndex, 0, clip);
        state.dirty = true;
        renderClipsOnly();
      },
      onTrimStartChange: (i, frames) => {
        const clip = state.clips[i];
        if (!clip || !clip.segment) return;
        const max = clip.segment.frame_count - clip.trim_end_frame - 1;
        clip.trim_start_frame = Math.max(0, Math.min(max, frames));
        state.dirty = true;
        renderClipsOnly();
      },
      onTrimEndChange: (i, frames) => {
        const clip = state.clips[i];
        if (!clip || !clip.segment) return;
        const max = clip.segment.frame_count - clip.trim_start_frame - 1;
        clip.trim_end_frame = Math.max(0, Math.min(max, frames));
        state.dirty = true;
        renderClipsOnly();
      },
      onZoomChange: (pps) => {
        state.pixelsPerSecond = pps;
        renderTimeline();
      },
    })
  );
}

function renderPanel(): void {
  const host = document.getElementById("vg-side-pane");
  if (!host) return;
  host.innerHTML = "";
  host.appendChild(
    createCompositionPanel({
      current: state.current,
      compositions: state.compositions,
      exportJob: state.exportJob,
      exportDownloadUrl: state.exportDownloadUrl,
      exportScaleDivisor: state.exportScaleDivisor,
      onNew: async () => {
        await createBlankComposition();
        renderAll();
      },
      onLoad: async (id) => {
        await loadComposition(id);
        renderAll();
      },
      onRename: async (name) => {
        if (!state.current) return;
        try {
          const updated = await apiClient.updateComposition(state.current.id, {
            name,
          });
          state.current = updated;
          await loadCompositions();
          renderPanel();
        } catch (err) {
          showError(errorMessage(err));
        }
      },
      onSave: handleSave,
      onDelete: handleDelete,
      onExport: handleExport,
      onExportScaleChange: (divisor) => {
        state.exportScaleDivisor = divisor;
      },
    })
  );
}

// ---------- handlers ----------

async function handleRescanLibrary(): Promise<void> {
  try {
    const res = await apiClient.rescanLibrary();
    showSuccess(
      `Library rescanned: +${res.added}, -${res.removed}, total ${res.total}`
    );
    await loadVideos();
    // If videos were pruned, any clips in the current composition that
    // referenced those videos have been deleted server-side too. Drop stale
    // per-video segments from the cache, then resync the composition.
    if (res.removed > 0) {
      const liveIds = new Set(state.videos.map((v) => v.id));
      for (const id of Array.from(state.segmentsByVideo.keys())) {
        if (!liveIds.has(id)) state.segmentsByVideo.delete(id);
      }
      if (state.current) await loadComposition(state.current.id);
    }
    renderAll();
    startVideoPolling();
  } catch (err) {
    showError(errorMessage(err));
  }
}

async function handleRescanVideo(videoId: number): Promise<void> {
  try {
    await apiClient.rescanVideo(videoId);
    showSuccess("Scan queued");
    state.segmentsByVideo.delete(videoId);
    startVideoPolling();
  } catch (err) {
    showError(errorMessage(err));
  }
}

function handleToggleExpand(videoId: number): void {
  if (state.expandedVideos.has(videoId)) state.expandedVideos.delete(videoId);
  else {
    state.expandedVideos.add(videoId);
    if (!state.segmentsByVideo.has(videoId)) {
      void apiClient
        .getVideoSegments(videoId)
        .then((segs) => {
          state.segmentsByVideo.set(videoId, segs);
          renderGrid();
        })
        .catch((err) => showError(errorMessage(err)));
    }
  }
  renderGrid();
}

async function handleSave(): Promise<void> {
  if (!state.current) return;
  try {
    const comp = await apiClient.replaceClips(
      state.current.id,
      state.clips.map((c) => ({
        segment_id: c.segment_id,
        trim_start_frame: c.trim_start_frame,
        trim_end_frame: c.trim_end_frame,
      }))
    );
    state.current = comp;
    state.clips = (comp.clips ?? []).map((c) => ({ ...c }));
    state.dirty = false;
    showSuccess("Saved");
    await loadCompositions();
    renderAll();
  } catch (err) {
    showError(errorMessage(err));
  }
}

async function handleDelete(): Promise<void> {
  if (!state.current) return;
  if (!confirm(`Delete composition "${state.current.name}"?`)) return;
  try {
    await apiClient.deleteComposition(state.current.id);
    state.current = null;
    state.clips = [];
    await loadCompositions();
    await createBlankComposition();
    await loadVideos();
    renderAll();
  } catch (err) {
    showError(errorMessage(err));
  }
}

async function handleExport(
  format: ExportFormat,
  scaleDivisor: ExportScaleDivisor
): Promise<void> {
  if (!state.current) return;
  if (state.dirty) {
    if (
      !confirm("You have unsaved changes. Save first to include them in the export?")
    ) {
      return;
    }
    await handleSave();
  }
  try {
    const job = await apiClient.startExport(state.current.id, format, scaleDivisor);
    state.exportJob = job;
    state.exportDownloadUrl = null;
    renderPanel();
    startExportPolling(job.id);
  } catch (err) {
    showError(errorMessage(err));
  }
}

// ---------- polling ----------

function startVideoPolling(): void {
  stopVideoPolling();
  videoPollTimer = window.setInterval(async () => {
    try {
      const before = new Map(state.videos.map((v) => [v.id, v.status]));
      state.videos = await apiClient.getVideos();
      for (const v of state.videos) {
        // Pull segments on first entry into thumbnailing (segments now exist)
        // and keep refreshing them while thumbnailing so tile thumbnails
        // populate progressively. Also pull on the final transition to ready.
        const wasThumbnailing = before.get(v.id) === "thumbnailing";
        const becameThumbnailing = !wasThumbnailing && v.status === "thumbnailing";
        const becameReady = before.get(v.id) !== "ready" && v.status === "ready";
        const refreshWhileThumbnailing = wasThumbnailing && v.status === "thumbnailing";
        if (becameThumbnailing || refreshWhileThumbnailing || becameReady) {
          state.segmentsByVideo.set(v.id, await apiClient.getVideoSegments(v.id));
        }
      }
      renderGrid();
      if (previewHandle) previewHandle.setVideoStates(state.videos);
      // Granular: videos/segments changed, but clips didn't — skip composer rebuild.
      if (ui2Handle) ui2Handle.setVideos(state.videos, state.segmentsByVideo);
      if (ui3Handle) ui3Handle.setVideos(state.videos, state.segmentsByVideo);
      const anyActive = state.videos.some(
        (v) =>
          [
            "discovered",
            "probing",
            "probed",
            "scanning",
            "thumbnailing",
            "subtitles_importing",
          ].includes(v.status) || v.preview_proxy_status === "building"
      );
      if (!anyActive) stopVideoPolling();
    } catch (err) {
      console.error("video poll", err);
    }
  }, 2000);
}

function stopVideoPolling(): void {
  if (videoPollTimer !== null) {
    window.clearInterval(videoPollTimer);
    videoPollTimer = null;
  }
}

function startExportPolling(jobId: number): void {
  stopExportPolling();
  exportPollTimer = window.setInterval(async () => {
    try {
      const job = await apiClient.getExport(jobId);
      state.exportJob = job;
      if (job.status === "done") {
        state.exportDownloadUrl = apiClient.exportDownloadUrl(job.id);
        showSuccess(`Export ready (${job.format})`);
        stopExportPolling();
      } else if (job.status === "error") {
        showError(`Export failed: ${job.error_message ?? "unknown"}`);
        stopExportPolling();
      }
      renderPanel();
    } catch (err) {
      console.error("export poll", err);
    }
  }, 1500);
}

function stopExportPolling(): void {
  if (exportPollTimer !== null) {
    window.clearInterval(exportPollTimer);
    exportPollTimer = null;
  }
}

function stopPolling(): void {
  stopVideoPolling();
  stopExportPolling();
}

// ---------- utilities ----------

function findSegment(segmentId: number): Segment | undefined {
  for (const segs of state.segmentsByVideo.values()) {
    const hit = segs.find((s) => s.id === segmentId);
    if (hit) return hit;
  }
  return undefined;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function escapeHtml(text: string): string {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

// ---------- boot ----------

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  void init();
}
