"""Background worker: probes + scans + thumbnails + exports.

Single stdlib thread; SQLite rows are the queue. Started from app.py behind
VIDEOGLUE_WORKER=1 so Flask's debug reloader doesn't double-start it.
"""
# pylint: disable=broad-exception-caught,too-many-locals,too-many-statements
# pylint: disable=global-statement
from __future__ import annotations

import json
import logging
import os
import threading
import time
import traceback
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import config
import export as export_mod
import preview_cache
import scanners
import subtitles as subtitles_mod
import thumbnails
from models import CompositionClip, ExportJob
from models import Scanner as ScannerRow
from models import ScanRun, Segment, Video, db
from probe import ProbeError, probe
from scanners.base import VideoContext

logger = logging.getLogger(__name__)

_stop_event = threading.Event()
_thread: Optional[threading.Thread] = None


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _probe_one(video: Video) -> None:
    video.status = "probing"
    db.session.commit()
    try:
        result = probe(Path(video.path))
    except ProbeError as e:
        video.status = "error"
        video.error_message = f"probe failed: {e}"
        db.session.commit()
        logger.warning("probe failed for %s: %s", video.path, e)
        return

    video.duration_seconds = result.duration_seconds
    video.width = result.width
    video.height = result.height
    video.fps_num = result.fps_num
    video.fps_den = result.fps_den
    video.total_frames = result.total_frames
    video.container = result.container
    video.codec = result.codec
    video.status = "probed"
    video.error_message = None
    db.session.commit()


def _ensure_scanner_row(scanner: scanners.Scanner) -> ScannerRow:
    row = ScannerRow.query.filter_by(name=scanner.name, version=scanner.version).first()
    if row is None:
        row = ScannerRow(
            name=scanner.name,
            version=scanner.version,
            config_json=json.dumps(scanner.default_config),
        )
        db.session.add(row)
        db.session.commit()
    return row


def _scan_one(video: Video, scanner_name: str = "hard_cut") -> None:
    video.status = "scanning"
    video.scan_progress_percent = 0.0
    video.scan_started_at = _utcnow()
    video.error_message = None
    db.session.commit()

    scanner = scanners.get(scanner_name)
    scanner_row = _ensure_scanner_row(scanner)

    run = ScanRun(
        video_id=video.id,
        scanner_id=scanner_row.id,
        status="running",
        started_at=_utcnow(),
    )
    db.session.add(run)
    db.session.commit()

    if not (video.fps_num and video.fps_den and video.total_frames):
        run.status = "error"
        run.error_message = "video missing probe data"
        run.finished_at = _utcnow()
        video.status = "error"
        video.error_message = run.error_message
        db.session.commit()
        return

    ctx = VideoContext(
        video_id=video.id,
        path=Path(video.path),
        fps_num=video.fps_num,
        fps_den=video.fps_den,
        total_frames=video.total_frames,
        duration_seconds=video.duration_seconds or 0.0,
    )

    # Throttled progress reporter — writes to the DB only if the percent moved
    # by >= 1.0 or 1s elapsed since the last write. PySceneDetect calls this
    # once per frame; we must not commit on every call.
    video_id = video.id
    last = {"pct": 0.0, "t": 0.0}

    def on_progress(frac: float) -> None:
        pct = max(0.0, min(100.0, frac * 100.0))
        now = time.monotonic()
        if pct - last["pct"] < 1.0 and now - last["t"] < 1.0:
            return
        last["pct"] = pct
        last["t"] = now
        # Use a minimal UPDATE rather than mutating the attached ORM instance —
        # keeps this callback thread-safe w.r.t. any other session state the
        # caller is building up (e.g. pending segments below).
        db.session.execute(
            db.update(Video)
            .where(Video.id == video_id)
            .values(scan_progress_percent=pct)
        )
        db.session.commit()

    try:
        scanner_segments = list(
            scanner.scan(
                ctx, json.loads(scanner_row.config_json), on_progress=on_progress
            )
        )
    except Exception as e:
        logger.exception("scanner %s failed on %s", scanner_name, video.path)
        run.status = "error"
        run.error_message = f"{type(e).__name__}: {e}"
        run.finished_at = _utcnow()
        video.status = "error"
        video.error_message = run.error_message
        db.session.commit()
        return

    # Sanity: ensure contiguous [0, total_frames). If not, log but keep going —
    # we trust the scanner to have normalized.
    scanner_segments.sort(key=lambda s: s.start_frame)

    fps_ratio = video.fps_num / video.fps_den
    persisted: list[Segment] = []
    for ss in scanner_segments:
        seg = Segment(
            scan_run_id=run.id,
            video_id=video.id,
            scanner_name=scanner.name,
            start_frame=ss.start_frame,
            end_frame=ss.end_frame,
            start_pts_seconds=ss.start_frame / fps_ratio,
            end_pts_seconds=ss.end_frame / fps_ratio,
            meta_json=json.dumps(ss.meta),
        )
        db.session.add(seg)
        persisted.append(seg)

    run.status = "done"
    run.finished_at = _utcnow()
    # Flip to "thumbnailing" now so the UI can start showing segment tiles
    # (with placeholder thumbnails) while the JPEGs render in the background.
    video.status = "thumbnailing"
    video.scan_progress_percent = 100.0
    db.session.commit()

    # Thumbnails outside the main transaction; commit each one so the UI sees
    # them appear progressively instead of waiting for the whole batch.
    for seg in persisted:
        thumb_rel = f"{video.id}/{seg.id}.jpg"
        thumb_abs = config.THUMBNAIL_DIR / thumb_rel
        try:
            thumbnails.extract(Path(video.path), seg.start_pts_seconds, thumb_abs)
            seg.thumbnail_path = thumb_rel
            db.session.commit()
        except Exception as e:  # noqa: BLE001
            logger.warning("thumbnail failed for segment %s: %s", seg.id, e)
            db.session.rollback()

    # Subtitle import — cheap for sidecar/embedded (seconds). Best-effort;
    # any error is logged and we still advance to "ready" so the user can
    # continue using the library.
    video.status = "subtitles_importing"
    db.session.commit()
    try:
        # Re-probe just to list subtitle streams. It's a fast ffprobe call
        # and keeps us stateless with respect to the earlier probe.
        result = probe(Path(video.path))
        streams = result.subtitle_streams
    except Exception:  # noqa: BLE001
        logger.exception("subtitle streams re-probe failed for video %s", video.id)
        streams = []
    try:
        subtitles_mod.import_subtitles(video, streams)
    except Exception:  # noqa: BLE001
        logger.exception("subtitle import failed for video %s", video.id)
        db.session.rollback()

    video.status = "ready"
    db.session.commit()


def _find_video_needing_preview_proxy() -> Optional[Video]:
    """Return the oldest ready video whose source needs a proxy that isn't yet
    built or in progress. `error` is terminal — a failed proxy is not retried
    automatically; users can clear it by resetting the status manually."""
    return (
        Video.query.filter(
            Video.status == "ready",
            Video.container.isnot(None),
            Video.codec.isnot(None),
            Video.preview_proxy_status == "none",
            db.or_(
                Video.container.notin_(preview_cache.COMPATIBLE_CONTAINERS),
                Video.codec.notin_(preview_cache.COMPATIBLE_CODECS),
            ),
        )
        .order_by(Video.discovered_at.asc())
        .first()
    )


def _ensure_preview_proxy(video: Video) -> None:
    src = Path(video.path)
    if not src.exists():
        video.preview_proxy_status = "error"
        video.preview_proxy_error_message = f"source missing: {video.path}"
        db.session.commit()
        return

    video.preview_proxy_status = "building"
    video.preview_proxy_started_at = _utcnow()
    video.preview_proxy_error_message = None
    db.session.commit()

    dest = preview_cache.proxy_path(video.id)
    logger.info("building preview proxy for video %s (%s)", video.id, video.path)
    try:
        preview_cache.generate(src, dest)
    except preview_cache.ProxyError as e:
        logger.warning("preview proxy failed for %s: %s", video.path, e)
        video.preview_proxy_status = "error"
        video.preview_proxy_error_message = str(e)
        db.session.commit()
        return

    video.preview_proxy_status = "ready"
    video.preview_proxy_error_message = None
    db.session.commit()


def _run_export(job: ExportJob) -> None:
    job.status = "running"
    db.session.commit()

    clips_rows: list[CompositionClip] = (
        CompositionClip.query.filter_by(composition_id=job.composition_id)
        .order_by(CompositionClip.position.asc())
        .all()
    )
    if not clips_rows:
        job.status = "error"
        job.error_message = "composition has no clips"
        job.finished_at = _utcnow()
        db.session.commit()
        return

    specs: list[export_mod.ClipSpec] = []
    for cc in clips_rows:
        seg = cc.segment
        if seg is None or seg.video is None:
            job.status = "error"
            job.error_message = "missing segment/video for clip"
            job.finished_at = _utcnow()
            db.session.commit()
            return
        specs.append(
            export_mod.ClipSpec(
                source_path=Path(seg.video.path),
                source_total_frames=seg.video.total_frames or 0,
                start_frame=seg.start_frame + cc.trim_start_frame,
                end_frame=seg.end_frame - cc.trim_end_frame,
            )
        )

    out_rel = f"composition-{job.composition_id}-export-{job.id}.{job.format}"
    out_path = config.EXPORT_DIR / out_rel
    out_path.parent.mkdir(parents=True, exist_ok=True)

    try:
        cmd = export_mod.build_command(specs, job.format, out_path)
        total_frames = export_mod.total_output_frames(specs)

        def on_progress(pct: float) -> None:
            job.progress_percent = pct
            db.session.commit()

        export_mod.run(cmd, total_frames, on_progress)
    except Exception as e:
        logger.exception("export %s failed", job.id)
        job.status = "error"
        job.error_message = f"{type(e).__name__}: {e}"
        job.finished_at = _utcnow()
        db.session.commit()
        return

    job.output_path = str(out_path)
    job.progress_percent = 100.0
    job.status = "done"
    job.finished_at = _utcnow()
    db.session.commit()


def tick(app) -> bool:
    """Do one unit of background work. Returns True if anything was done."""
    with app.app_context():
        # 1. Probe any discovered videos.
        video = (
            Video.query.filter_by(status="discovered")
            .order_by(Video.discovered_at.asc())
            .first()
        )
        if video is not None:
            try:
                _probe_one(video)
            except Exception:  # noqa: BLE001
                logger.exception("probe crashed")
                video.status = "error"
                video.error_message = traceback.format_exc(limit=2)
                db.session.commit()
            return True

        # 2. Scan any probed videos.
        video = (
            Video.query.filter_by(status="probed")
            .order_by(Video.discovered_at.asc())
            .first()
        )
        if video is not None:
            try:
                _scan_one(video)
            except Exception:  # noqa: BLE001
                logger.exception("scan crashed")
                video.status = "error"
                video.error_message = traceback.format_exc(limit=2)
                db.session.commit()
            return True

        # 3. Build preview proxies for browser-incompatible containers (e.g. AVI).
        needs_proxy_video = _find_video_needing_preview_proxy()
        if needs_proxy_video is not None:
            try:
                _ensure_preview_proxy(needs_proxy_video)
            except Exception:  # noqa: BLE001
                logger.exception("preview proxy crashed")
            return True

        # 4. Run any queued exports.
        job = (
            ExportJob.query.filter_by(status="queued")
            .order_by(ExportJob.created_at.asc())
            .first()
        )
        if job is not None:
            try:
                _run_export(job)
            except Exception:  # noqa: BLE001
                logger.exception("export crashed")
                job.status = "error"
                job.error_message = traceback.format_exc(limit=2)
                job.finished_at = _utcnow()
                db.session.commit()
            return True

    return False


def _loop(app) -> None:
    while not _stop_event.is_set():
        try:
            did_work = tick(app)
        except Exception:  # noqa: BLE001
            logger.exception("worker loop crashed")
            did_work = False
        if not did_work:
            _stop_event.wait(config.WORKER_POLL_INTERVAL_SECONDS)


def _reset_orphaned_statuses(app) -> None:
    """Clear any `building` proxy statuses left over from a crashed backend
    so the next tick picks them up again."""
    with app.app_context():
        orphans = Video.query.filter_by(preview_proxy_status="building").all()
        if not orphans:
            return
        for v in orphans:
            v.preview_proxy_status = "none"
            v.preview_proxy_started_at = None
        db.session.commit()
        logger.info("reset %d orphaned preview_proxy='building' rows", len(orphans))


def start(app) -> None:
    """Start the worker thread if not already running.

    Guards against Flask's debug reloader double-start via WERKZEUG_RUN_MAIN:
    only the reloaded child sets that to 'true'.
    """
    global _thread
    if _thread is not None and _thread.is_alive():
        return
    if app.debug and os.environ.get("WERKZEUG_RUN_MAIN") != "true":
        return
    _reset_orphaned_statuses(app)
    _stop_event.clear()
    _thread = threading.Thread(
        target=_loop, args=(app,), name="video-glue-worker", daemon=True
    )
    _thread.start()
    logger.info("video-glue worker started")


def stop() -> None:
    _stop_event.set()
    if _thread is not None:
        _thread.join(timeout=5)
