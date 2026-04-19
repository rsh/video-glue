"""ffprobe wrapper — extract metadata from a video file."""
# pylint: disable=too-many-locals
import json
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import config


class ProbeError(RuntimeError):
    pass


@dataclass
class ProbeResult:
    duration_seconds: Optional[float]
    width: Optional[int]
    height: Optional[int]
    fps_num: Optional[int]
    fps_den: Optional[int]
    total_frames: Optional[int]
    container: Optional[str]
    codec: Optional[str]


def _parse_rational(value: str) -> tuple[Optional[int], Optional[int]]:
    if not value or "/" not in value:
        return None, None
    num, _, den = value.partition("/")
    try:
        n, d = int(num), int(den)
    except ValueError:
        return None, None
    if d == 0:
        return None, None
    return n, d


def probe(path: Path) -> ProbeResult:
    """Run ffprobe on path and return parsed metadata.

    Raises ProbeError if ffprobe fails or no video stream is found.
    """
    cmd = [
        config.FFPROBE_BIN,
        "-v",
        "error",
        "-print_format",
        "json",
        "-show_format",
        "-show_streams",
        str(path),
    ]
    try:
        completed = subprocess.run(
            cmd, capture_output=True, text=True, check=True, timeout=60
        )
    except FileNotFoundError as e:
        raise ProbeError(f"ffprobe not found: {e}") from e
    except subprocess.CalledProcessError as e:
        raise ProbeError(f"ffprobe failed: {e.stderr.strip()}") from e
    except subprocess.TimeoutExpired as e:
        raise ProbeError("ffprobe timed out") from e

    data = json.loads(completed.stdout)
    fmt = data.get("format", {})
    streams = data.get("streams", [])
    video_stream = next((s for s in streams if s.get("codec_type") == "video"), None)
    if video_stream is None:
        raise ProbeError("No video stream found")

    duration: Optional[float] = None
    if "duration" in fmt:
        try:
            duration = float(fmt["duration"])
        except (TypeError, ValueError):
            duration = None
    if duration is None and "duration" in video_stream:
        try:
            duration = float(video_stream["duration"])
        except (TypeError, ValueError):
            duration = None

    fps_num, fps_den = _parse_rational(
        video_stream.get("avg_frame_rate") or video_stream.get("r_frame_rate") or ""
    )

    total_frames: Optional[int] = None
    nb = video_stream.get("nb_frames")
    if nb is not None:
        try:
            total_frames = int(nb)
        except (TypeError, ValueError):
            total_frames = None
    if total_frames is None and duration and fps_num and fps_den:
        total_frames = int(round(duration * fps_num / fps_den))

    container = fmt.get("format_name")
    if container:
        container = container.split(",")[0]

    width = video_stream.get("width")
    height = video_stream.get("height")

    return ProbeResult(
        duration_seconds=duration,
        width=int(width) if width is not None else None,
        height=int(height) if height is not None else None,
        fps_num=fps_num,
        fps_den=fps_den,
        total_frames=total_frames,
        container=container,
        codec=video_stream.get("codec_name"),
    )
