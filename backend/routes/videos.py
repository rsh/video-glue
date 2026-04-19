"""Video routes: list, fetch, stream, segments."""
from pathlib import Path

from typing import Any

from flask import Blueprint, abort, jsonify, send_file
from sqlalchemy import func

import preview_cache
from auth import login_required
from models import Segment, User, Video, db

videos_bp = Blueprint("videos", __name__, url_prefix="/api/videos")


@videos_bp.route("", methods=["GET"])
@login_required
def list_videos(current_user: User) -> tuple[dict, int]:
    videos = Video.query.order_by(Video.discovered_at.desc()).all()

    counts = dict(
        db.session.query(
            Segment.video_id, func.count(Segment.id)  # pylint: disable=not-callable
        )
        .group_by(Segment.video_id)
        .all()
    )

    out = []
    for v in videos:
        d = v.to_dict()
        d["segment_count"] = int(counts.get(v.id, 0))
        out.append(d)
    return {"videos": out}, 200


@videos_bp.route("/<int:video_id>", methods=["GET"])
@login_required
def get_video(video_id: int, current_user: User) -> tuple[dict, int]:
    video = db.session.get(Video, video_id)
    if video is None:
        return {"error": "not found"}, 404
    return {"video": video.to_dict()}, 200


@videos_bp.route("/<int:video_id>/segments", methods=["GET"])
@login_required
def list_segments(video_id: int, current_user: User) -> tuple[dict, int]:
    video = db.session.get(Video, video_id)
    if video is None:
        return {"error": "not found"}, 404
    segs = (
        Segment.query.filter_by(video_id=video_id)
        .order_by(Segment.scanner_name.asc(), Segment.start_frame.asc())
        .all()
    )
    return {"segments": [s.to_dict() for s in segs]}, 200


@videos_bp.route("/<int:video_id>/stream", methods=["GET"])
@login_required
def stream_video(video_id: int, current_user: User) -> Any:
    video = db.session.get(Video, video_id)
    if video is None:
        abort(404)
    path = Path(video.path)
    if preview_cache.needs_proxy(video.container, video.codec):
        proxy = preview_cache.proxy_path(video_id)
        if proxy.exists():
            return send_file(proxy, conditional=True)
        # Proxy required but not yet materialized — tell the caller, don't
        # fall through to serving the unplayable original.
        return (
            jsonify(
                {
                    "error": "preview proxy not ready",
                    "preview_proxy_status": video.preview_proxy_status,
                    "preview_proxy_error_message": video.preview_proxy_error_message,
                }
            ),
            409,
        )
    if not path.exists():
        abort(404)
    return send_file(path, conditional=True)
