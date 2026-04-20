"""Runtime configuration sourced from environment variables."""
import os
from pathlib import Path


def _resolve(path_str: str) -> Path:
    return Path(path_str).expanduser().resolve()


BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = _resolve(os.getenv("VIDEOGLUE_DATA_DIR", str(BASE_DIR.parent / "data")))

VIDEO_LIBRARY_DIR = _resolve(os.getenv("VIDEO_LIBRARY_DIR", str(DATA_DIR / "library")))
THUMBNAIL_DIR = _resolve(
    os.getenv("VIDEOGLUE_THUMBNAIL_DIR", str(DATA_DIR / "thumbnails"))
)
EXPORT_DIR = _resolve(os.getenv("VIDEOGLUE_EXPORT_DIR", str(DATA_DIR / "exports")))
PREVIEW_CACHE_DIR = _resolve(
    os.getenv("VIDEOGLUE_PREVIEW_CACHE_DIR", str(DATA_DIR / "preview_cache"))
)

DATABASE_URL = os.getenv("DATABASE_URL", f"sqlite:///{DATA_DIR / 'video-glue.db'}")

WORKER_POLL_INTERVAL_SECONDS = float(os.getenv("VIDEOGLUE_WORKER_POLL_SECONDS", "2.0"))
WORKER_ENABLED = os.getenv("VIDEOGLUE_WORKER", "0") == "1"

VIDEO_EXTENSIONS = {".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v"}

FFMPEG_BIN = os.getenv("FFMPEG_BIN", "ffmpeg")
FFPROBE_BIN = os.getenv("FFPROBE_BIN", "ffprobe")

# GPU-accelerated H264 encoder to use in place of libx264. Set by setup.sh.
# Supported: "libx264", "h264_nvenc", "h264_videotoolbox".
H264_ENCODER = os.getenv("VIDEOGLUE_H264_ENCODER", "libx264")


def h264_encoder_args(crf: int, preset: str) -> list[str]:
    """Return `-c:v ... [quality/preset flags]` for the configured encoder.

    `crf` and `preset` are expressed in libx264 terms (CRF 0-51, presets
    ultrafast..veryslow) and translated for hardware encoders.
    """
    if H264_ENCODER == "h264_nvenc":
        # NVENC's -cq constant-quality target aligns well with libx264 CRF.
        # -preset p1 (fastest) .. p7 (slowest).
        nvenc_preset = {
            "ultrafast": "p1",
            "veryfast": "p1",
            "faster": "p2",
            "fast": "p3",
            "medium": "p5",
            "slow": "p6",
            "slower": "p7",
            "veryslow": "p7",
        }.get(preset, "p5")
        return ["-c:v", "h264_nvenc", "-cq", str(crf), "-preset", nvenc_preset]
    if H264_ENCODER == "h264_videotoolbox":
        # VideoToolbox exposes quality as 1..100 (higher = better).
        # Map CRF 0->100, 51->0 via a linear fit clamped to sane bounds.
        q = max(1, min(100, 100 - crf * 2))
        return ["-c:v", "h264_videotoolbox", "-q:v", str(q)]
    return ["-c:v", "libx264", "-crf", str(crf), "-preset", preset]


def ensure_dirs() -> None:
    for p in (
        DATA_DIR,
        VIDEO_LIBRARY_DIR,
        THUMBNAIL_DIR,
        EXPORT_DIR,
        PREVIEW_CACHE_DIR,
    ):
        p.mkdir(parents=True, exist_ok=True)
