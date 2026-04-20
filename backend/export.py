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
Audio is stripped (`-an`) in v1.
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


class ExportError(RuntimeError):
    pass


def _encoder_args(fmt: str, output_path: Path) -> List[str]:
    if fmt == "mp4":
        return [
            "-c:v",
            "libx264",
            "-crf",
            "18",
            "-preset",
            "medium",
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+faststart",
            "-an",
            str(output_path),
        ]
    if fmt == "webm":
        return [
            "-c:v",
            "libvpx-vp9",
            "-crf",
            "32",
            "-b:v",
            "0",
            "-pix_fmt",
            "yuv420p",
            "-an",
            str(output_path),
        ]
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
) -> List[str]:
    """Build the ffmpeg argv for exporting `clips` to `output_path` as `fmt`.

    `scale_divisor` downscales the output resolution by that factor (1 = full,
    2 = half, 4 = quarter). Ignored for gif, which already has a fixed
    scale stage.
    """
    if not clips:
        raise ExportError("composition is empty")
    if scale_divisor not in (1, 2, 4):
        raise ExportError(f"scale_divisor must be 1, 2, or 4 (got {scale_divisor})")

    cmd: List[str] = [config.FFMPEG_BIN, "-hide_banner", "-y"]
    for clip in clips:
        # -ss before -i uses fast keyframe seek + accurate decode-to-time, so
        # the decoded stream starts at (approximately) the clip's in-point.
        start_time = clip.start_frame / clip.source_fps if clip.source_fps > 0 else 0.0
        cmd.extend(["-ss", f"{start_time:.6f}", "-i", str(clip.source_path)])

    filter_parts: List[str] = []
    for i, clip in enumerate(clips):
        length = clip.end_frame - clip.start_frame
        filter_parts.append(
            f"[{i}:v]"
            f"trim=start_frame=0:end_frame={length},"
            f"setpts=PTS-STARTPTS[v{i}]"
        )
    concat_inputs = "".join(f"[v{i}]" for i in range(len(clips)))

    if fmt == "gif":
        # Build: concat -> fps=20,scale=480 -> split -> palettegen/paletteuse
        filter_parts.append(
            f"{concat_inputs}concat=n={len(clips)}:v=1:a=0,"
            f"fps=20,scale=480:-1:flags=lanczos,split[a][b];"
            f"[a]palettegen=stats_mode=diff[p];"
            f"[b][p]paletteuse=dither=bayer:bayer_scale=5[out]"
        )
        filter_complex = ";".join(filter_parts)
        cmd.extend(
            [
                "-filter_complex",
                filter_complex,
                "-map",
                "[out]",
                "-an",
                str(output_path),
            ]
        )
        return cmd

    # trunc(...)*2 keeps dimensions even, required by yuv420p / libx264.
    scale_stage = (
        ""
        if scale_divisor == 1
        else f",scale=trunc(iw/{scale_divisor}/2)*2:trunc(ih/{scale_divisor}/2)*2"
    )
    filter_parts.append(
        f"{concat_inputs}concat=n={len(clips)}:v=1:a=0{scale_stage}[out]"
    )
    filter_complex = ";".join(filter_parts)
    cmd.extend(["-filter_complex", filter_complex, "-map", "[out]"])
    cmd.extend(_encoder_args(fmt, output_path))
    return cmd


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
