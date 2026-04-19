/**
 * Composition preview: HTML5 <video> that plays clips back-to-back.
 *
 * Preview is approximate — browser seek is not frame-exact. Exports are.
 */

import { apiClient, type Clip } from "../api";

interface PreviewState {
  video: HTMLVideoElement;
  clips: Clip[];
  currentClipIndex: number;
  playing: boolean;
  currentVideoId: number | null;
}

export interface PreviewHandle {
  element: HTMLElement;
  setClips: (clips: Clip[]) => void;
  play: () => void;
  pause: () => void;
  seekToClip: (index: number) => void;
}

export function createPreview(initialClips: Clip[]): PreviewHandle {
  const container = document.createElement("div");
  container.className = "vg-preview";

  const video = document.createElement("video");
  video.controls = false;
  video.playsInline = true;
  video.preload = "metadata";
  video.className = "vg-preview-video";
  container.appendChild(video);

  const controls = document.createElement("div");
  controls.className = "vg-preview-controls d-flex gap-2 align-items-center mt-2";
  controls.innerHTML = `
    <button type="button" class="btn btn-sm btn-outline-secondary" id="vg-pv-play">▶ Play</button>
    <button type="button" class="btn btn-sm btn-outline-secondary" id="vg-pv-pause">❚❚ Pause</button>
    <small class="text-muted ms-auto">Preview is approximate; exports are frame-exact.</small>
  `;
  container.appendChild(controls);

  const state: PreviewState = {
    video,
    clips: initialClips,
    currentClipIndex: 0,
    playing: false,
    currentVideoId: null,
  };

  const seekToClip = (index: number): void => {
    if (index < 0 || index >= state.clips.length) return;
    const clip = state.clips[index]!;
    const seg = clip.segment;
    if (!seg) return;
    state.currentClipIndex = index;
    const fps = seg.duration_seconds > 0 ? seg.frame_count / seg.duration_seconds : 24;
    const startTime = seg.start_pts_seconds + clip.trim_start_frame / fps;
    const desiredSrc = apiClient.videoStreamUrl(seg.video_id);
    if (state.currentVideoId !== seg.video_id) {
      state.currentVideoId = seg.video_id;
      video.src = desiredSrc;
      video.addEventListener(
        "loadedmetadata",
        () => {
          video.currentTime = startTime;
          if (state.playing) void video.play();
        },
        { once: true }
      );
    } else {
      video.currentTime = startTime;
    }
  };

  video.addEventListener("timeupdate", () => {
    if (!state.playing) return;
    const clip = state.clips[state.currentClipIndex];
    if (!clip || !clip.segment) return;
    const seg = clip.segment;
    const fps = seg.duration_seconds > 0 ? seg.frame_count / seg.duration_seconds : 24;
    const endTime = seg.end_pts_seconds - clip.trim_end_frame / fps;
    if (video.currentTime >= endTime) {
      if (state.currentClipIndex + 1 < state.clips.length) {
        seekToClip(state.currentClipIndex + 1);
      } else {
        state.playing = false;
        video.pause();
      }
    }
  });

  const play = (): void => {
    if (state.clips.length === 0) return;
    state.playing = true;
    if (state.currentClipIndex >= state.clips.length) state.currentClipIndex = 0;
    seekToClip(state.currentClipIndex);
    void video.play();
  };
  const pause = (): void => {
    state.playing = false;
    video.pause();
  };

  controls.querySelector("#vg-pv-play")?.addEventListener("click", play);
  controls.querySelector("#vg-pv-pause")?.addEventListener("click", pause);

  return {
    element: container,
    setClips: (clips) => {
      state.clips = clips;
      if (state.currentClipIndex >= clips.length) state.currentClipIndex = 0;
    },
    play,
    pause,
    seekToClip,
  };
}
