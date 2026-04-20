"""Browser-playable MP4 proxies for sources HTML5 <video> can't decode.

A source is considered browser-compatible when both its container and its
video codec fall in the sets below — covering the intersection of modern
Chrome/Firefox/Safari. Anything else (e.g. AVI+Xvid, MP4+HEVC) gets
transcoded once to <PREVIEW_CACHE_DIR>/<video_id>.mp4 and served from
/stream. Preview stays approximate; exports still use the original.
"""
import re
import subprocess
from pathlib import Path
from typing import Callable, Optional

import config

# ffprobe format_name first token (see probe.py). "matroska" covers both
# .mkv and .webm (ffprobe reports "matroska,webm" for webm too).
COMPATIBLE_CONTAINERS = frozenset({"mp4", "mov", "matroska"})
COMPATIBLE_CODECS = frozenset({"h264", "vp8", "vp9", "av1"})


class ProxyError(RuntimeError):
    pass


def needs_proxy(container: Optional[str], codec: Optional[str]) -> bool:
    """Returns True if the source likely won't play in HTML5 <video>.

    NULL container or codec (probe failed / hasn't run) returns False — the
    worker only builds proxies for probed videos, and we don't want to
    transcode blind.
    """
    if container is None or codec is None:
        return False
    return container not in COMPATIBLE_CONTAINERS or codec not in COMPATIBLE_CODECS


def proxy_path(video_id: int) -> Path:
    return config.PREVIEW_CACHE_DIR / f"{video_id}.mp4"


def has_proxy(video_id: int) -> bool:
    return proxy_path(video_id).exists()


_FRAME_RE = re.compile(r"^frame=(\d+)")


def generate(
    source: Path,
    dest: Path,
    total_frames: int = 0,
    on_progress: Optional[Callable[[float], None]] = None,
) -> None:
    """Transcode source to a browser-friendly MP4 at dest (atomic rename).

    If `total_frames` > 0 and `on_progress` is given, `-progress pipe:1` is
    parsed for output-frame counts and the callback receives a percentage.
    """
    dest.parent.mkdir(parents=True, exist_ok=True)
    # Keep a ".part" temp so crashed runs don't leave a file that looks
    # finished. Force `-f mp4` because ffmpeg can't infer the muxer from
    # the ".part" extension.
    tmp = dest.with_suffix(dest.suffix + ".part")
    cmd = [
        config.FFMPEG_BIN,
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostats",
        "-progress",
        "pipe:1",
        "-y",
        "-i",
        str(source),
        "-c:v",
        "libx264",
        "-crf",
        "23",
        "-preset",
        "veryfast",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        "-an",
        "-f",
        "mp4",
        str(tmp),
    ]
    try:
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        )
    except FileNotFoundError as e:
        raise ProxyError(f"ffmpeg not found: {e}") from e

    with proc:
        assert proc.stdout is not None
        for raw in proc.stdout:
            m = _FRAME_RE.match(raw)
            if m and total_frames > 0 and on_progress is not None:
                frames = int(m.group(1))
                pct = min(100.0, 100.0 * frames / total_frames)
                on_progress(pct)
        proc.wait()
        if proc.returncode != 0:
            stderr = (proc.stderr.read() if proc.stderr else "") or ""
            tmp.unlink(missing_ok=True)
            raise ProxyError(f"ffmpeg failed: {stderr.strip()}")
    tmp.replace(dest)
