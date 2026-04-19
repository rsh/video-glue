/**
 * Composition preview: gapless playback via a double-buffered <video> pair.
 *
 * Layer 1 — if the next clip is the same source AND frame-contiguous with
 * the current one, don't seek at the boundary. The video naturally keeps
 * playing; we just advance the clip index. Truly gapless.
 *
 * Layer 2 — otherwise we use two <video> elements. The hidden "preloader"
 * is pre-seeked to the next clip's start while the visible "active"
 * element plays. A scheduled swap (role+visibility swap + preloader.play)
 * fires right at the boundary, masking seek / source-switch latency.
 *
 * Preview is still approximate — browser seek isn't frame-exact. Export is.
 */

import { apiClient, type Clip } from "../api";

// timeupdate fires ~every 250ms; arm within 200ms of clip end so we can
// schedule the swap precisely via setTimeout.
const LEAD_SECONDS = 0.2;
// Fire the swap ~1 frame before the real boundary so the preloader's first
// frame is rendered by the time the old active's clip would have ended.
const SWAP_UNDERSHOOT = 0.02;

interface Role {
  el: HTMLVideoElement;
  preparedClipIndex: number | null;
  preparedVideoId: number | null;
}

interface State {
  clips: Clip[];
  currentClipIndex: number;
  playing: boolean;
  active: Role;
  preloader: Role;
  swapTimer: number | null;
}

export interface PreviewHandle {
  element: HTMLElement;
  setClips: (clips: Clip[]) => void;
  play: () => void;
  pause: () => void;
  seekToClip: (index: number) => void;
}

function makeVideo(): HTMLVideoElement {
  const v = document.createElement("video");
  v.controls = false;
  v.playsInline = true;
  v.preload = "auto";
  v.className = "vg-preview-video";
  return v;
}

export function createPreview(initialClips: Clip[]): PreviewHandle {
  const container = document.createElement("div");
  container.className = "vg-preview";

  const stack = document.createElement("div");
  stack.className = "vg-preview-stack";
  container.appendChild(stack);

  const elA = makeVideo();
  const elB = makeVideo();
  stack.appendChild(elA);
  stack.appendChild(elB);
  elB.style.visibility = "hidden";

  const controls = document.createElement("div");
  controls.className = "vg-preview-controls d-flex gap-2 align-items-center mt-2";
  controls.innerHTML = `
    <button type="button" class="btn btn-sm btn-outline-secondary" id="vg-pv-play">▶ Play</button>
    <button type="button" class="btn btn-sm btn-outline-secondary" id="vg-pv-pause">❚❚ Pause</button>
    <small class="text-muted ms-auto">Preview is approximate; exports are frame-exact.</small>
  `;
  container.appendChild(controls);

  const state: State = {
    clips: initialClips,
    currentClipIndex: 0,
    playing: false,
    active: { el: elA, preparedClipIndex: null, preparedVideoId: null },
    preloader: { el: elB, preparedClipIndex: null, preparedVideoId: null },
    swapTimer: null,
  };

  function clipEffective(clip: Clip): {
    startTime: number;
    endTime: number;
    videoId: number;
  } {
    const seg = clip.segment!;
    const fps = seg.duration_seconds > 0 ? seg.frame_count / seg.duration_seconds : 24;
    return {
      videoId: seg.video_id,
      startTime: seg.start_pts_seconds + clip.trim_start_frame / fps,
      endTime: seg.end_pts_seconds - clip.trim_end_frame / fps,
    };
  }

  function contiguous(a: Clip, b: Clip): boolean {
    if (!a.segment || !b.segment) return false;
    if (a.segment.video_id !== b.segment.video_id) return false;
    const aEnd = a.segment.end_frame - a.trim_end_frame;
    const bStart = b.segment.start_frame + b.trim_start_frame;
    return aEnd === bStart;
  }

  function prepareRole(role: Role, clipIndex: number, andPlay: boolean): void {
    const clip = state.clips[clipIndex];
    if (!clip || !clip.segment) return;
    const { startTime, videoId } = clipEffective(clip);

    const needsSrcChange = role.preparedVideoId !== videoId;
    role.preparedClipIndex = clipIndex;
    role.preparedVideoId = videoId;

    if (!needsSrcChange) {
      role.el.currentTime = startTime;
      if (andPlay) void role.el.play();
      return;
    }

    role.el.src = apiClient.videoStreamUrl(videoId);
    role.el.addEventListener(
      "loadedmetadata",
      () => {
        role.el.currentTime = startTime;
        if (andPlay) void role.el.play();
      },
      { once: true }
    );
  }

  function primePreloader(nextIndex: number): void {
    if (nextIndex < 0 || nextIndex >= state.clips.length) return;
    const currentClip = state.clips[state.currentClipIndex];
    const nextClip = state.clips[nextIndex];
    // Layer 1 — preloader not needed; the active video will just keep playing.
    if (currentClip && nextClip && contiguous(currentClip, nextClip)) return;
    prepareRole(state.preloader, nextIndex, false);
    state.preloader.el.pause();
  }

  function cancelScheduledSwap(): void {
    if (state.swapTimer !== null) {
      window.clearTimeout(state.swapTimer);
      state.swapTimer = null;
    }
  }

  function executeSwap(targetIndex: number): void {
    state.swapTimer = null;
    if (!state.playing) return;
    if (targetIndex >= state.clips.length) return;

    // Preloader wasn't ready in time (very short clip or laggy load) —
    // fall back to seeking the active element in place.
    if (state.preloader.preparedClipIndex !== targetIndex) {
      state.currentClipIndex = targetIndex;
      prepareRole(state.active, targetIndex, true);
      primePreloader(targetIndex + 1);
      return;
    }

    state.currentClipIndex = targetIndex;
    void state.preloader.el.play();
    const oldActive = state.active;
    state.active = state.preloader;
    state.preloader = oldActive;
    state.active.el.style.visibility = "visible";
    state.preloader.el.style.visibility = "hidden";
    state.preloader.el.pause();

    primePreloader(targetIndex + 1);
  }

  function onTimeUpdate(el: HTMLVideoElement): void {
    if (el !== state.active.el) return;
    if (!state.playing) return;

    const clip = state.clips[state.currentClipIndex];
    if (!clip || !clip.segment) return;
    const { endTime } = clipEffective(clip);
    const nextIndex = state.currentClipIndex + 1;
    const hasNext = nextIndex < state.clips.length;

    if (!hasNext) {
      if (el.currentTime >= endTime) {
        state.playing = false;
        el.pause();
      }
      return;
    }

    const nextClip = state.clips[nextIndex]!;
    if (contiguous(clip, nextClip)) {
      // Layer 1: the element rolls through the boundary naturally.
      if (el.currentTime >= endTime) {
        state.currentClipIndex = nextIndex;
        primePreloader(nextIndex + 1);
      }
      return;
    }

    // Layer 2: schedule the swap precisely for the boundary.
    if (state.swapTimer !== null) return;
    const remaining = endTime - el.currentTime;
    if (remaining > LEAD_SECONDS) return;

    if (state.preloader.preparedClipIndex !== nextIndex) {
      prepareRole(state.preloader, nextIndex, false);
    }
    const delayMs = Math.max(0, (remaining - SWAP_UNDERSHOOT) * 1000);
    state.swapTimer = window.setTimeout(() => executeSwap(nextIndex), delayMs);
  }

  elA.addEventListener("timeupdate", () => onTimeUpdate(elA));
  elB.addEventListener("timeupdate", () => onTimeUpdate(elB));

  const play = (): void => {
    if (state.clips.length === 0) return;
    if (state.currentClipIndex >= state.clips.length) state.currentClipIndex = 0;
    state.playing = true;
    prepareRole(state.active, state.currentClipIndex, true);
    primePreloader(state.currentClipIndex + 1);
  };

  const pause = (): void => {
    state.playing = false;
    cancelScheduledSwap();
    state.active.el.pause();
    state.preloader.el.pause();
  };

  const seekToClip = (index: number): void => {
    if (index < 0 || index >= state.clips.length) return;
    cancelScheduledSwap();
    state.currentClipIndex = index;
    prepareRole(state.active, index, state.playing);
    primePreloader(index + 1);
  };

  controls.querySelector("#vg-pv-play")?.addEventListener("click", play);
  controls.querySelector("#vg-pv-pause")?.addEventListener("click", pause);

  return {
    element: container,
    setClips: (clips) => {
      state.clips = clips;
      if (state.currentClipIndex >= clips.length) state.currentClipIndex = 0;
      cancelScheduledSwap();
      // Re-prime preloader for the (possibly new) next clip. Don't disturb
      // the active element — mid-playback edits shouldn't cause a visible
      // pause on what the user is currently watching.
      primePreloader(state.currentClipIndex + 1);
    },
    play,
    pause,
    seekToClip,
  };
}
