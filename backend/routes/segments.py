"""Segment routes: trigger scans, serve thumbnails."""
from flask import Blueprint, abort, send_from_directory

import config
import scanners
from auth import login_required
from models import Segment, User, Video, db

segments_bp = Blueprint("segments", __name__, url_prefix="/api")


@segments_bp.route("/videos/<int:video_id>/scan", methods=["POST"])
@login_required
def trigger_scan(video_id: int, current_user: User) -> tuple[dict, int]:
    """Queue a scanner run by resetting the video's status.

    The worker picks it up based on status. For v1 we only have hard_cut and
    we always run it on probed videos — so this endpoint simply resets
    status=probed (or discovered) if the file needs re-probing.
    """
    video = db.session.get(Video, video_id)
    if video is None:
        return {"error": "not found"}, 404

    scanner_name = "hard_cut"
    if not scanners.has(scanner_name):
        return {"error": f"unknown scanner: {scanner_name}"}, 400

    Segment.query.filter_by(video_id=video.id, scanner_name=scanner_name).delete()

    if video.total_frames is None:
        video.status = "discovered"
    else:
        video.status = "probed"
    video.error_message = None
    db.session.commit()
    return {"video": video.to_dict()}, 202


@segments_bp.route("/thumbnails/<path:subpath>", methods=["GET"])
@login_required
def get_thumbnail(subpath: str, current_user: User):  # type: ignore[no-untyped-def]
    root = config.THUMBNAIL_DIR
    target = (root / subpath).resolve()
    try:
        target.relative_to(root.resolve())
    except ValueError:
        abort(404)
    if not target.exists():
        abort(404)
    return send_from_directory(root, subpath)
