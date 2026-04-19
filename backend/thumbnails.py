"""Per-segment first-frame JPEG thumbnail extraction."""
import subprocess
from pathlib import Path

import config


def extract(video_path: Path, start_pts_seconds: float, output_path: Path) -> None:
    """Extract a single JPEG thumbnail at start_pts_seconds of video_path.

    Uses input-side -ss for speed; acceptable because thumbnails don't need
    frame-exactness (they're only UI tiles; export uses a separate code path).
    """
    output_path.parent.mkdir(parents=True, exist_ok=True)
    # Offset by a tiny epsilon past the cut so we don't land on a transition frame.
    seek_at = max(0.0, start_pts_seconds + 0.05)
    cmd = [
        config.FFMPEG_BIN,
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-ss",
        f"{seek_at:.3f}",
        "-i",
        str(video_path),
        "-frames:v",
        "1",
        "-vf",
        "scale=320:-1",
        "-q:v",
        "3",
        str(output_path),
    ]
    subprocess.run(cmd, check=True, capture_output=True, text=True, timeout=60)
