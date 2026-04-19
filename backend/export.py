"""ffmpeg-based composition export.

Single-pass filter_complex approach:
  - per clip i: [N:v]trim=start_frame=S_i:end_frame=E_i,setpts=PTS-STARTPTS[v_i]
  - concat them: [v_0][v_1]...concat=n=N:v=1:a=0[out]
Frame-exact because `trim` uses frame indices, not timestamps.
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
    start_frame: int  # effective in-point (segment.start + trim_start)
    end_frame: int  # effective out-point (segment.end - trim_end), exclusive


class ExportError(RuntimeError):
    pass


def _input_indices(clips: List[ClipSpec]) -> List[int]:
    """Map each clip to an ffmpeg input index, dedup'd by source path."""
    seen: dict[str, int] = {}
    result: List[int] = []
    for c in clips:
        key = str(c.source_path)
        if key not in seen:
            seen[key] = len(seen)
        result.append(seen[key])
    return result


def _unique_sources(clips: List[ClipSpec]) -> List[Path]:
    seen: set[str] = set()
    out: List[Path] = []
    for c in clips:
        k = str(c.source_path)
        if k not in seen:
            seen.add(k)
            out.append(c.source_path)
    return out


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


def build_command(clips: List[ClipSpec], fmt: str, output_path: Path) -> List[str]:
    """Build the ffmpeg argv for exporting `clips` to `output_path` as `fmt`."""
    if not clips:
        raise ExportError("composition is empty")

    sources = _unique_sources(clips)
    input_idx = _input_indices(clips)

    cmd: List[str] = [config.FFMPEG_BIN, "-hide_banner", "-y"]
    for src in sources:
        cmd.extend(["-i", str(src)])

    filter_parts: List[str] = []
    for i, clip in enumerate(clips):
        src_i = input_idx[i]
        filter_parts.append(
            f"[{src_i}:v]"
            f"trim=start_frame={clip.start_frame}:end_frame={clip.end_frame},"
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

    filter_parts.append(f"{concat_inputs}concat=n={len(clips)}:v=1:a=0[out]")
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
