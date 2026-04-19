"""Hard-cut scene detector backed by PySceneDetect."""
# pylint: disable=too-many-locals,import-outside-toplevel
from __future__ import annotations

from typing import Any, Dict, Iterable, List, Optional

from .base import ProgressCallback, ScannerSegment, VideoContext


class HardCutScanner:
    name = "hard_cut"
    version = "pyscenedetect-0.6-contentv1"
    default_config: Dict[str, Any] = {
        "threshold": 27.0,
        "min_scene_len": 15,
        "show_progress": True,  # tqdm bar to stderr (visible in backend terminal)
    }

    def scan(
        self,
        video: VideoContext,
        config: Dict[str, Any],
        on_progress: Optional[ProgressCallback] = None,
    ) -> Iterable[ScannerSegment]:
        # Imported lazily so tests / the API layer can import this module
        # without requiring opencv to be present.
        from scenedetect import SceneManager  # type: ignore
        from scenedetect import ContentDetector, open_video

        threshold = float(config.get("threshold", self.default_config["threshold"]))
        min_scene_len = int(
            config.get("min_scene_len", self.default_config["min_scene_len"])
        )
        show_progress = bool(
            config.get("show_progress", self.default_config["show_progress"])
        )

        sd_video = open_video(str(video.path))
        scene_manager = SceneManager()
        scene_manager.add_detector(
            ContentDetector(threshold=threshold, min_scene_len=min_scene_len)
        )

        if on_progress is not None:
            # Swap in a tqdm-compatible wrapper that fans out progress to our
            # callback. scenedetect.scene_manager imports tqdm at module load
            # and instantiates it inside detect_scenes when show_progress=True,
            # so a monkey-patch here is the least-invasive hook.
            with _progress_bridge(on_progress):
                scene_manager.detect_scenes(sd_video, show_progress=True)
        else:
            scene_manager.detect_scenes(sd_video, show_progress=show_progress)

        scene_list = scene_manager.get_scene_list()

        segments: List[ScannerSegment] = []
        if not scene_list:
            # No cuts: treat the whole video as one segment.
            segments.append(
                ScannerSegment(
                    start_frame=0,
                    end_frame=video.total_frames,
                    meta={"confidence": 1.0, "note": "no_cuts_detected"},
                )
            )
            return segments

        # Guarantee contiguity: fill any gaps, extend to total_frames.
        prev_end = 0
        for start_tc, end_tc in scene_list:
            start = int(start_tc.get_frames())
            end = int(end_tc.get_frames())
            if start > prev_end:
                segments.append(
                    ScannerSegment(
                        start_frame=prev_end, end_frame=start, meta={"filled": True}
                    )
                )
            if end > start:
                segments.append(
                    ScannerSegment(start_frame=start, end_frame=end, meta={})
                )
                prev_end = end
        if prev_end < video.total_frames:
            segments.append(
                ScannerSegment(
                    start_frame=prev_end,
                    end_frame=video.total_frames,
                    meta={"trailing": True},
                )
            )
        return segments


# ---------------------------------------------------------------------------
# tqdm monkey-patch bridge — forwards scene_manager's progress into our callback.
# ---------------------------------------------------------------------------


class _TqdmBridge:
    """Minimal tqdm-compatible shim. Forwards update() to a callback."""

    def __init__(self, on_progress: ProgressCallback, real_tqdm, **kwargs: Any) -> None:
        self._on_progress = on_progress
        self._total = int(kwargs.get("total") or 0)
        self._n = 0
        # Keep a real tqdm alongside so the stderr bar still shows.
        self._real = real_tqdm(**kwargs) if real_tqdm is not None else None

    def update(self, n: int = 1) -> None:
        self._n += int(n)
        if self._real is not None:
            self._real.update(n)
        if self._total > 0:
            frac = min(1.0, self._n / self._total)
            self._on_progress(frac)

    def set_description(self, *args: Any, **kwargs: Any) -> None:
        if self._real is not None:
            self._real.set_description(*args, **kwargs)

    def close(self) -> None:
        if self._real is not None:
            self._real.close()

    def __enter__(self) -> "_TqdmBridge":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()


class _progress_bridge:
    """Context manager that swaps scenedetect.scene_manager.tqdm for our bridge."""

    def __init__(self, on_progress: ProgressCallback) -> None:
        self._on_progress = on_progress
        self._original: Any = None
        self._sm_mod: Any = None

    def __enter__(self) -> "_progress_bridge":
        from scenedetect import scene_manager as sm_mod  # type: ignore

        self._sm_mod = sm_mod
        self._original = sm_mod.tqdm
        on_progress = self._on_progress
        original = self._original

        def factory(**kwargs: Any) -> _TqdmBridge:
            return _TqdmBridge(on_progress, original, **kwargs)

        sm_mod.tqdm = factory  # type: ignore[assignment]
        return self

    def __exit__(self, *exc: Any) -> None:
        if self._sm_mod is not None:
            self._sm_mod.tqdm = self._original
