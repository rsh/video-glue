"""ffmpeg-based composition export.

Single-pass filter_complex approach:
  - per clip i: dedicated `-ss <clip_start_time> -i <source>` input so ffmpeg
    seeks to the clip's location via keyframe + accurate decode instead of
    decoding the whole file from frame 0. Without this, a clip deep into a
    long source pegs ffmpeg at 0% output for minutes while it decode-discards
    everything before the trim window.
  - per clip i: [N:v]trim=start_frame=0:end_frame=L_i,setpts=PTS-STARTPTS[v_i]
    (trim is frame-exact from the decoded stream's start, which `-ss` places
    at the clip's in-point).
  - concat them: [v_0][v_1]...concat=n=N:v=1:a=0[out]
Audio is opt-in: when `include_audio=True`, each clip contributes an `atrim`
stage too and the concat filter produces a paired [vout][aout].
"""
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, List, Optional

import config


@dataclass
class ClipSpec:
    source_path: Path
    source_total_frames: int
    source_fps: float  # frames-per-second of the source, for -ss seek math
    start_frame: int  # effective in-point (segment.start + trim_start)
    end_frame: int  # effective out-point (segment.end - trim_end), exclusive
    # Source pixel dimensions; used only when the composition mixes clips of
    # different resolutions (then we letterbox each clip to a shared canvas).
    # 0 = unknown — treated as "same as the rest" so the simple path is kept.
    source_width: int = 0
    source_height: int = 0


class ExportError(RuntimeError):
    pass


def _encoder_args(fmt: str, output_path: Path, include_audio: bool) -> List[str]:
    if fmt == "mp4":
        args = config.h264_encoder_args(crf=18, preset="medium") + [
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+faststart",
        ]
        args += (
            ["-c:a", "aac", "-b:a", "192k", "-ac", "2", "-ar", "48000"]
            if include_audio
            else ["-an"]
        )
        args.append(str(output_path))
        return args
    if fmt == "webm":
        args = [
            "-c:v",
            "libvpx-vp9",
            "-crf",
            "32",
            "-b:v",
            "0",
            "-pix_fmt",
            "yuv420p",
        ]
        args += (
            ["-c:a", "libopus", "-b:a", "160k", "-ac", "2"]
            if include_audio
            else ["-an"]
        )
        args.append(str(output_path))
        return args
    if fmt == "gif":
        # Gif uses a palette pass but we keep it single-command by appending a
        # post-filter: split + palettegen + paletteuse.
        raise ValueError("gif is handled by build_gif_command")
    raise ValueError(f"unknown format: {fmt}")


def build_command(
    clips: List[ClipSpec],
    fmt: str,
    output_path: Path,
    scale_divisor: int = 1,
    include_audio: bool = False,
) -> List[str]:
    """Build the ffmpeg argv for exporting `clips` to `output_path` as `fmt`.

    `scale_divisor` downscales the output resolution by that factor (1 = full,
    2 = half, 4 = quarter). Ignored for gif, which already has a fixed
    scale stage.

    `include_audio` opts into carrying the source audio through. Gif output
    ignores it — gif has no audio track.
    """
    if not clips:
        raise ExportError("composition is empty")
    if scale_divisor not in (1, 2, 4):
        raise ExportError(f"scale_divisor must be 1, 2, or 4 (got {scale_divisor})")

    want_audio = include_audio and fmt != "gif"
    cmd: List[str] = [config.FFMPEG_BIN, "-hide_banner", "-y"]
    cmd.extend(_input_args(clips))

    filter_parts = _per_clip_filters(clips, want_audio)
    if fmt == "gif":
        cmd.extend(_gif_output_args(filter_parts, clips, output_path))
        return cmd

    cmd.extend(_concat_output_args(filter_parts, clips, scale_divisor, want_audio))
    cmd.extend(_encoder_args(fmt, output_path, include_audio=want_audio))
    return cmd


def _input_args(clips: List[ClipSpec]) -> List[str]:
    """One `-ss … -i path` pair per clip. `-ss` before `-i` seeks via keyframe
    so decoding doesn't start at frame 0 of the source."""
    args: List[str] = []
    for clip in clips:
        start_time = clip.start_frame / clip.source_fps if clip.source_fps > 0 else 0.0
        args.extend(["-ss", f"{start_time:.6f}", "-i", str(clip.source_path)])
    return args


def _per_clip_filters(clips: List[ClipSpec], want_audio: bool) -> List[str]:
    """Video (and optional audio) trim+setpts filters, one per clip.

    When clips pull from different resolutions, every clip is letterboxed onto
    a shared canvas so the downstream concat filter sees matching W/H/SAR. For
    single-source comps the normalization stage is skipped entirely.
    """
    target_w, target_h, mixed = _pick_target_resolution(clips)
    parts: List[str] = []
    for i, clip in enumerate(clips):
        length = clip.end_frame - clip.start_frame
        chain = f"trim=start_frame=0:end_frame={length},setpts=PTS-STARTPTS"
        if mixed:
            chain += (
                f",scale={target_w}:{target_h}:force_original_aspect_ratio=decrease"
                f",pad={target_w}:{target_h}:(ow-iw)/2:(oh-ih)/2:color=black"
                f",setsar=1"
            )
        parts.append(f"[{i}:v]{chain}[v{i}]")
        if want_audio:
            duration = length / clip.source_fps if clip.source_fps > 0 else 0.0
            parts.append(
                f"[{i}:a]"
                f"atrim=start=0:duration={duration:.6f},"
                f"asetpts=PTS-STARTPTS[a{i}]"
            )
    return parts


def _gif_output_args(
    filter_parts: List[str], clips: List[ClipSpec], output_path: Path
) -> List[str]:
    concat_inputs = "".join(f"[v{i}]" for i in range(len(clips)))
    filter_parts.append(
        f"{concat_inputs}concat=n={len(clips)}:v=1:a=0,"
        f"fps=20,scale=480:-1:flags=lanczos,split[a][b];"
        f"[a]palettegen=stats_mode=diff[p];"
        f"[b][p]paletteuse=dither=bayer:bayer_scale=5[out]"
    )
    return [
        "-filter_complex",
        ";".join(filter_parts),
        "-map",
        "[out]",
        "-an",
        str(output_path),
    ]


def _concat_output_args(
    filter_parts: List[str],
    clips: List[ClipSpec],
    scale_divisor: int,
    want_audio: bool,
) -> List[str]:
    # trunc(...)*2 keeps dimensions even, required by yuv420p / libx264.
    scale = (
        None
        if scale_divisor == 1
        else f"scale=trunc(iw/{scale_divisor}/2)*2:trunc(ih/{scale_divisor}/2)*2"
    )
    n = len(clips)
    if want_audio:
        concat_inputs = "".join(f"[v{i}][a{i}]" for i in range(n))
        if scale is None:
            filter_parts.append(f"{concat_inputs}concat=n={n}:v=1:a=1[vout][aout]")
        else:
            filter_parts.append(
                f"{concat_inputs}concat=n={n}:v=1:a=1[vraw][aout];"
                f"[vraw]{scale}[vout]"
            )
        return [
            "-filter_complex",
            ";".join(filter_parts),
            "-map",
            "[vout]",
            "-map",
            "[aout]",
        ]
    concat_inputs = "".join(f"[v{i}]" for i in range(n))
    tail = f",{scale}" if scale else ""
    filter_parts.append(f"{concat_inputs}concat=n={n}:v=1:a=0{tail}[vout]")
    return ["-filter_complex", ";".join(filter_parts), "-map", "[vout]"]


def _pick_target_resolution(clips: List[ClipSpec]) -> tuple[int, int, bool]:
    """Choose a canvas (W, H) for concat when clip resolutions differ.

    Strategy: the resolution with the most total screen-time wins — that keeps
    the look the user sees the most and avoids touching it. Ties are broken by
    larger area, so if screen-time splits evenly, the higher-res wins and the
    lower-res clips are the ones that get letterboxed (better than downscaling
    the higher-res clips, which would lose quality unrecoverably).

    Returns (width, height, mixed). `mixed` is False whenever the clips all
    share one resolution or dimensions aren't known — callers should skip the
    per-clip scale+pad stage in that case.
    """
    by_dim: dict[tuple[int, int], float] = {}
    for c in clips:
        if c.source_width <= 0 or c.source_height <= 0:
            return (0, 0, False)  # Unknowns — fall back to the simple path.
        dur = (c.end_frame - c.start_frame) / c.source_fps if c.source_fps > 0 else 0.0
        key = (c.source_width, c.source_height)
        by_dim[key] = by_dim.get(key, 0.0) + dur
    if len(by_dim) <= 1:
        w, h = next(iter(by_dim))
        return (w, h, False)
    # Most screen-time first; on tie, larger area wins.
    (w, h), _ = max(by_dim.items(), key=lambda kv: (kv[1], kv[0][0] * kv[0][1]))
    return (w, h, True)


def total_output_frames(clips: List[ClipSpec]) -> int:
    return sum(c.end_frame - c.start_frame for c in clips)


_FRAME_RE = re.compile(r"frame=(\d+)")


def run(
    cmd: List[str],
    expected_total_frames: int,
    on_progress: Optional[Callable[[float], None]] = None,
) -> None:
    """Run ffmpeg, parsing `-progress pipe:1` output for percent updates."""
    full_cmd = list(cmd)
    # Insert progress flag after the binary name.
    full_cmd[1:1] = ["-progress", "pipe:1", "-nostats"]

    try:
        proc_ctx = subprocess.Popen(
            full_cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        )
    except FileNotFoundError as e:
        raise ExportError(f"ffmpeg not found: {e}") from e

    with proc_ctx as proc:
        assert proc.stdout is not None
        for raw in proc.stdout:
            m = _FRAME_RE.search(raw)
            if m and expected_total_frames > 0 and on_progress is not None:
                frames = int(m.group(1))
                pct = min(100.0, 100.0 * frames / expected_total_frames)
                on_progress(pct)
        proc.wait()
        if proc.returncode != 0:
            stderr = (proc.stderr.read() if proc.stderr else "") or ""
            raise ExportError(f"ffmpeg exited {proc.returncode}: {stderr.strip()}")
