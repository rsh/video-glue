"""Library routes: scan the VIDEO_LIBRARY_DIR for new video files."""
from datetime import datetime, timezone
from pathlib import Path

from flask import Blueprint

import config
from auth import login_required
from models import User, Video, db

library_bp = Blueprint("library", __name__, url_prefix="/api/library")


@library_bp.route("/rescan", methods=["POST"])
@login_required
def rescan(current_user: User) -> tuple[dict, int]:
    """Walk the configured library directory; upsert Video rows."""
    config.ensure_dirs()
    root = config.VIDEO_LIBRARY_DIR
    added = 0
    seen_paths: set[str] = set()

    for path in _walk_videos(root):
        path_str = str(path)
        seen_paths.add(path_str)
        stat = path.stat()
        mtime = datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc)
        existing = Video.query.filter_by(path=path_str).first()
        if existing is None:
            video = Video(
                path=path_str,
                filename=path.name,
                size_bytes=stat.st_size,
                date_modified=mtime,
                status="discovered",
            )
            db.session.add(video)
            added += 1
        else:
            if (
                existing.size_bytes != stat.st_size
                or existing.date_modified.replace(tzinfo=timezone.utc) != mtime
            ):
                existing.size_bytes = stat.st_size
                existing.date_modified = mtime
                existing.status = "discovered"
                existing.error_message = None

    db.session.commit()

    total = Video.query.count()
    return {
        "added": added,
        "total": total,
        "library_dir": str(root),
    }, 200


def _walk_videos(root: Path):  # type: ignore[no-untyped-def]
    if not root.exists():
        return
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        if path.suffix.lower() not in config.VIDEO_EXTENSIONS:
            continue
        if any(part.startswith(".") for part in path.relative_to(root).parts):
            continue
        yield path
