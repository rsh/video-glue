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


def ensure_dirs() -> None:
    for p in (
        DATA_DIR,
        VIDEO_LIBRARY_DIR,
        THUMBNAIL_DIR,
        EXPORT_DIR,
        PREVIEW_CACHE_DIR,
    ):
        p.mkdir(parents=True, exist_ok=True)
