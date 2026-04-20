"""Library routes: scan the VIDEO_LIBRARY_DIR for new video files."""
import shutil
from datetime import datetime, timezone
from pathlib import Path

from flask import Blueprint

import config
from auth import login_required
from models import CompositionClip, Segment, User, Video, db

library_bp = Blueprint("library", __name__, url_prefix="/api/library")


@library_bp.route("/rescan", methods=["POST"])
@login_required
def rescan(current_user: User) -> tuple[dict, int]:
    """Walk the configured library directory; upsert Video rows and drop
    rows for files that are no longer on disk."""
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

    # Prune videos whose files are gone. Clip.segment_id is RESTRICT at the DB
    # layer — any composition clips referencing a removed video's segments
    # have to go first, or the cascade-delete would be blocked.
    removed_ids: list[int] = []
    for v in Video.query.all():
        if v.path in seen_paths:
            continue
        seg_ids = [s.id for s in Segment.query.filter_by(video_id=v.id).all()]
        if seg_ids:
            CompositionClip.query.filter(
                CompositionClip.segment_id.in_(seg_ids)
            ).delete(synchronize_session=False)
        removed_ids.append(v.id)
        db.session.delete(v)

    db.session.commit()

    # Best-effort disk cleanup for removed videos. Failures here shouldn't
    # fail the rescan — the DB is already consistent.
    for vid in removed_ids:
        shutil.rmtree(config.THUMBNAIL_DIR / str(vid), ignore_errors=True)
        proxy = config.PREVIEW_CACHE_DIR / f"{vid}.mp4"
        try:
            proxy.unlink(missing_ok=True)
        except OSError:
            pass

    total = Video.query.count()
    return {
        "added": added,
        "removed": len(removed_ids),
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
