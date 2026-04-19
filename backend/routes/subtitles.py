"""Subtitle search route — FTS5-backed full-text search over cues."""
from typing import Any, Dict, List

from flask import Blueprint, request
from sqlalchemy import text

from auth import login_required
from models import Segment, SubtitleCue, User, Video, db

subtitles_bp = Blueprint("subtitles", __name__, url_prefix="/api/subtitles")

DEFAULT_LIMIT = 200
MAX_LIMIT = 500


@subtitles_bp.route("/search", methods=["GET"])
@login_required
def search(current_user: User) -> tuple[dict, int]:
    q = (request.args.get("q") or "").strip()
    if not q:
        return {"results": []}, 200

    try:
        limit = int(request.args.get("limit", DEFAULT_LIMIT))
    except (TypeError, ValueError):
        limit = DEFAULT_LIMIT
    limit = max(1, min(MAX_LIMIT, limit))

    language = request.args.get("language", "en")

    # FTS5 MATCH + snippet. snippet(table, col_index, open, close, ellipsis, tokens)
    rows = (
        db.session.execute(
            text(
                """
            SELECT
                c.id AS cue_id,
                c.video_id AS video_id,
                c.track_id AS track_id,
                c.ordinal AS ordinal,
                c.start_frame AS start_frame,
                c.end_frame AS end_frame,
                c.start_pts_seconds AS start_pts,
                c.end_pts_seconds AS end_pts,
                snippet(subtitle_cues_fts, 0, '<b>', '</b>', '…', 12) AS snippet_html
            FROM subtitle_cues_fts
            JOIN subtitle_cues c ON c.id = subtitle_cues_fts.rowid
            WHERE subtitle_cues_fts MATCH :q AND c.language = :lang
            ORDER BY rank
            LIMIT :limit
            """
            ),
            {"q": q, "lang": language, "limit": limit},
        )
        .mappings()
        .all()
    )

    if not rows:
        return {"results": []}, 200

    # Batch-fetch prev/next cue text. For each hit, we want track_id+ordinal-1
    # and track_id+ordinal+1. Build a set of wanted (track_id, ordinal) pairs.
    wanted: set[tuple[int, int]] = set()
    for r in rows:
        wanted.add((r["track_id"], r["ordinal"] - 1))
        wanted.add((r["track_id"], r["ordinal"] + 1))
    # Query them all at once.
    neighbor_map: Dict[tuple[int, int], str] = {}
    if wanted:
        track_ids = list({t for t, _ in wanted})
        ords = list({o for _, o in wanted})
        neighbors = SubtitleCue.query.filter(
            SubtitleCue.track_id.in_(track_ids),
            SubtitleCue.ordinal.in_(ords),
        ).all()
        for n in neighbors:
            neighbor_map[(n.track_id, n.ordinal)] = n.text

    # Fetch video filenames and overlapping segments in one pass.
    video_ids = list({r["video_id"] for r in rows})
    videos: Dict[int, str] = {
        v.id: v.filename for v in Video.query.filter(Video.id.in_(video_ids)).all()
    }

    results: List[Dict[str, Any]] = []
    for r in rows:
        seg = (
            Segment.query.filter(
                Segment.video_id == r["video_id"],
                Segment.scanner_name == "hard_cut",
                Segment.end_frame > r["start_frame"],
                Segment.start_frame < r["end_frame"],
            )
            .order_by(Segment.start_frame.asc())
            .first()
        )
        results.append(
            {
                "cue_id": r["cue_id"],
                "video_id": r["video_id"],
                "video_filename": videos.get(r["video_id"], ""),
                "segment_id": seg.id if seg else None,
                "thumbnail_path": seg.thumbnail_path if seg else None,
                "start_pts_seconds": r["start_pts"],
                "end_pts_seconds": r["end_pts"],
                "prev_cue_text": neighbor_map.get((r["track_id"], r["ordinal"] - 1)),
                "cue_snippet_html": r["snippet_html"],
                "next_cue_text": neighbor_map.get((r["track_id"], r["ordinal"] + 1)),
            }
        )

    return {"results": results}, 200
