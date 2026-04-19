"""SQLAlchemy models for video-glue."""
import json
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, cast

from flask_sqlalchemy import SQLAlchemy
from sqlalchemy import event
from sqlalchemy.engine import Connection
from sqlalchemy.sql.schema import Table
from werkzeug.security import check_password_hash, generate_password_hash

db = SQLAlchemy()


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class User(db.Model):  # type: ignore[name-defined,misc]
    """User account."""

    __tablename__ = "users"

    id = db.Column(db.Integer, primary_key=True)
    email = db.Column(db.String(120), unique=True, nullable=False, index=True)
    username = db.Column(db.String(120), unique=True, nullable=False, index=True)
    password_hash = db.Column(db.String(255), nullable=False)
    created_at = db.Column(db.DateTime, nullable=False, default=_utcnow)
    updated_at = db.Column(
        db.DateTime, nullable=False, default=_utcnow, onupdate=_utcnow
    )

    compositions = cast(
        List["Composition"],
        db.relationship(
            "Composition", back_populates="owner", cascade="all, delete-orphan"
        ),
    )

    def set_password(self, password: str) -> None:
        self.password_hash = generate_password_hash(password)

    def check_password(self, password: str) -> bool:
        return check_password_hash(self.password_hash, password)

    def to_dict(self, include_email: bool = False) -> Dict[str, Any]:
        data: Dict[str, Any] = {
            "id": self.id,
            "username": self.username,
            "created_at": self.created_at.isoformat(),
        }
        if include_email:
            data["email"] = self.email
        return data


class Video(db.Model):  # type: ignore[name-defined,misc]
    """A video file discovered in the library."""

    __tablename__ = "videos"

    id = db.Column(db.Integer, primary_key=True)
    path = db.Column(db.String(1024), unique=True, nullable=False, index=True)
    filename = db.Column(db.String(512), nullable=False)
    size_bytes = db.Column(db.BigInteger, nullable=False)
    date_modified = db.Column(db.DateTime, nullable=False)
    duration_seconds = db.Column(db.Float, nullable=True)
    width = db.Column(db.Integer, nullable=True)
    height = db.Column(db.Integer, nullable=True)
    fps_num = db.Column(db.Integer, nullable=True)
    fps_den = db.Column(db.Integer, nullable=True)
    total_frames = db.Column(db.Integer, nullable=True)
    container = db.Column(db.String(32), nullable=True)
    codec = db.Column(db.String(32), nullable=True)
    status = db.Column(db.String(32), nullable=False, default="discovered", index=True)
    scan_progress_percent = db.Column(db.Float, nullable=False, default=0.0)
    scan_started_at = db.Column(db.DateTime, nullable=True)
    error_message = db.Column(db.Text, nullable=True)
    discovered_at = db.Column(db.DateTime, nullable=False, default=_utcnow)
    updated_at = db.Column(
        db.DateTime, nullable=False, default=_utcnow, onupdate=_utcnow
    )

    segments = cast(
        List["Segment"],
        db.relationship(
            "Segment", back_populates="video", cascade="all, delete-orphan"
        ),
    )
    scan_runs = cast(
        List["ScanRun"],
        db.relationship(
            "ScanRun", back_populates="video", cascade="all, delete-orphan"
        ),
    )

    @property
    def fps(self) -> Optional[float]:
        if self.fps_num and self.fps_den:
            return self.fps_num / self.fps_den
        return None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "path": self.path,
            "filename": self.filename,
            "size_bytes": self.size_bytes,
            "date_modified": self.date_modified.isoformat(),
            "duration_seconds": self.duration_seconds,
            "width": self.width,
            "height": self.height,
            "fps": self.fps,
            "total_frames": self.total_frames,
            "container": self.container,
            "codec": self.codec,
            "status": self.status,
            "scan_progress_percent": self.scan_progress_percent,
            "scan_started_at": (
                self.scan_started_at.isoformat() if self.scan_started_at else None
            ),
            "error_message": self.error_message,
            "discovered_at": self.discovered_at.isoformat(),
            "updated_at": self.updated_at.isoformat(),
        }


class Scanner(db.Model):  # type: ignore[name-defined,misc]
    """A named, versioned scanner implementation (registry row)."""

    __tablename__ = "scanners"

    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(64), nullable=False, index=True)
    version = db.Column(db.String(64), nullable=False)
    config_json = db.Column(db.Text, nullable=False, default="{}")
    created_at = db.Column(db.DateTime, nullable=False, default=_utcnow)

    __table_args__ = (
        db.UniqueConstraint("name", "version", name="uq_scanner_name_version"),
    )

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "version": self.version,
            "config": json.loads(self.config_json or "{}"),
        }


class ScanRun(db.Model):  # type: ignore[name-defined,misc]
    """One execution of a scanner against a video."""

    __tablename__ = "scan_runs"

    id = db.Column(db.Integer, primary_key=True)
    video_id = db.Column(
        db.Integer, db.ForeignKey("videos.id", ondelete="CASCADE"), nullable=False
    )
    scanner_id = db.Column(
        db.Integer, db.ForeignKey("scanners.id", ondelete="RESTRICT"), nullable=False
    )
    status = db.Column(db.String(32), nullable=False, default="queued")
    started_at = db.Column(db.DateTime, nullable=True)
    finished_at = db.Column(db.DateTime, nullable=True)
    error_message = db.Column(db.Text, nullable=True)
    created_at = db.Column(db.DateTime, nullable=False, default=_utcnow)

    video = cast("Video", db.relationship("Video", back_populates="scan_runs"))
    scanner = cast("Scanner", db.relationship("Scanner"))

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "video_id": self.video_id,
            "scanner_id": self.scanner_id,
            "scanner_name": self.scanner.name if self.scanner else None,
            "status": self.status,
            "started_at": self.started_at.isoformat() if self.started_at else None,
            "finished_at": self.finished_at.isoformat() if self.finished_at else None,
            "error_message": self.error_message,
        }


class Segment(db.Model):  # type: ignore[name-defined,misc]
    """A frame-accurate segment produced by a scanner.

    Half-open interval: [start_frame, end_frame).
    """

    __tablename__ = "segments"

    id = db.Column(db.Integer, primary_key=True)
    scan_run_id = db.Column(
        db.Integer, db.ForeignKey("scan_runs.id", ondelete="CASCADE"), nullable=False
    )
    video_id = db.Column(
        db.Integer,
        db.ForeignKey("videos.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    scanner_name = db.Column(db.String(64), nullable=False, index=True)
    start_frame = db.Column(db.Integer, nullable=False)
    end_frame = db.Column(db.Integer, nullable=False)
    start_pts_seconds = db.Column(db.Float, nullable=False)
    end_pts_seconds = db.Column(db.Float, nullable=False)
    thumbnail_path = db.Column(db.String(1024), nullable=True)
    meta_json = db.Column(db.Text, nullable=False, default="{}")
    created_at = db.Column(db.DateTime, nullable=False, default=_utcnow)

    video = cast("Video", db.relationship("Video", back_populates="segments"))

    __table_args__ = (
        db.Index(
            "ix_segment_video_scanner_start", "video_id", "scanner_name", "start_frame"
        ),
        db.CheckConstraint("end_frame > start_frame", name="ck_segment_frames_valid"),
    )

    @property
    def frame_count(self) -> int:
        return self.end_frame - self.start_frame

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "video_id": self.video_id,
            "scanner_name": self.scanner_name,
            "start_frame": self.start_frame,
            "end_frame": self.end_frame,
            "frame_count": self.frame_count,
            "start_pts_seconds": self.start_pts_seconds,
            "end_pts_seconds": self.end_pts_seconds,
            "duration_seconds": self.end_pts_seconds - self.start_pts_seconds,
            "thumbnail_path": self.thumbnail_path,
            "meta": json.loads(self.meta_json or "{}"),
        }


class Composition(db.Model):  # type: ignore[name-defined,misc]
    """A saved sequence of clips (the 'project' in design.md)."""

    __tablename__ = "compositions"

    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(200), nullable=False)
    owner_id = db.Column(
        db.Integer, db.ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    notes = db.Column(db.Text, nullable=True)
    created_at = db.Column(db.DateTime, nullable=False, default=_utcnow)
    updated_at = db.Column(
        db.DateTime, nullable=False, default=_utcnow, onupdate=_utcnow
    )

    owner = cast("User", db.relationship("User", back_populates="compositions"))
    clips = cast(
        List["CompositionClip"],
        db.relationship(
            "CompositionClip",
            back_populates="composition",
            cascade="all, delete-orphan",
            order_by="CompositionClip.position",
        ),
    )

    def to_dict(self, include_clips: bool = True) -> Dict[str, Any]:
        data: Dict[str, Any] = {
            "id": self.id,
            "name": self.name,
            "owner_id": self.owner_id,
            "notes": self.notes,
            "created_at": self.created_at.isoformat(),
            "updated_at": self.updated_at.isoformat(),
        }
        if include_clips:
            data["clips"] = [c.to_dict() for c in self.clips]
        return data


class CompositionClip(db.Model):  # type: ignore[name-defined,misc]
    """A single clip on a composition's single track, possibly trimmed."""

    __tablename__ = "composition_clips"

    id = db.Column(db.Integer, primary_key=True)
    composition_id = db.Column(
        db.Integer,
        db.ForeignKey("compositions.id", ondelete="CASCADE"),
        nullable=False,
    )
    segment_id = db.Column(
        db.Integer, db.ForeignKey("segments.id", ondelete="RESTRICT"), nullable=False
    )
    position = db.Column(db.Integer, nullable=False)
    trim_start_frame = db.Column(db.Integer, nullable=False, default=0)
    trim_end_frame = db.Column(db.Integer, nullable=False, default=0)

    composition = cast(
        "Composition", db.relationship("Composition", back_populates="clips")
    )
    segment = cast("Segment", db.relationship("Segment"))

    __table_args__ = (
        db.UniqueConstraint(
            "composition_id", "position", name="uq_composition_clip_position"
        ),
        db.CheckConstraint(
            "trim_start_frame >= 0 AND trim_end_frame >= 0",
            name="ck_trim_nonneg",
        ),
    )

    def to_dict(self) -> Dict[str, Any]:
        seg = self.segment.to_dict() if self.segment else None
        return {
            "id": self.id,
            "composition_id": self.composition_id,
            "segment_id": self.segment_id,
            "position": self.position,
            "trim_start_frame": self.trim_start_frame,
            "trim_end_frame": self.trim_end_frame,
            "segment": seg,
        }


class ExportJob(db.Model):  # type: ignore[name-defined,misc]
    """An ffmpeg export rendering a composition to a file."""

    __tablename__ = "export_jobs"

    id = db.Column(db.Integer, primary_key=True)
    composition_id = db.Column(
        db.Integer,
        db.ForeignKey("compositions.id", ondelete="CASCADE"),
        nullable=False,
    )
    format = db.Column(db.String(16), nullable=False)  # mp4 | webm | gif
    status = db.Column(db.String(32), nullable=False, default="queued")
    output_path = db.Column(db.String(1024), nullable=True)
    progress_percent = db.Column(db.Float, nullable=False, default=0.0)
    error_message = db.Column(db.Text, nullable=True)
    created_at = db.Column(db.DateTime, nullable=False, default=_utcnow)
    finished_at = db.Column(db.DateTime, nullable=True)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "composition_id": self.composition_id,
            "format": self.format,
            "status": self.status,
            "progress_percent": self.progress_percent,
            "error_message": self.error_message,
            "created_at": self.created_at.isoformat(),
            "finished_at": self.finished_at.isoformat() if self.finished_at else None,
            "download_available": self.status == "done",
        }


class SubtitleTrack(db.Model):  # type: ignore[name-defined,misc]
    """A single subtitle source imported for a video (embedded stream or sidecar).

    Origin uniquely identifies the source within its kind — the ffprobe stream
    index for embedded tracks, the absolute sidecar path for sidecar tracks.
    """

    __tablename__ = "subtitle_tracks"

    id = db.Column(db.Integer, primary_key=True)
    video_id = db.Column(
        db.Integer,
        db.ForeignKey("videos.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    source = db.Column(db.String(16), nullable=False)  # embedded | sidecar
    language = db.Column(db.String(8), nullable=True, index=True)
    origin = db.Column(db.String(1024), nullable=False)
    cue_count = db.Column(db.Integer, nullable=False, default=0)
    imported_at = db.Column(db.DateTime, nullable=False, default=_utcnow)
    meta_json = db.Column(db.Text, nullable=False, default="{}")

    cues = cast(
        List["SubtitleCue"],
        db.relationship(
            "SubtitleCue",
            back_populates="track",
            cascade="all, delete-orphan",
            order_by="SubtitleCue.ordinal",
        ),
    )

    __table_args__ = (
        db.UniqueConstraint(
            "video_id", "source", "origin", name="uq_subtitle_track_video_source_origin"
        ),
    )

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "video_id": self.video_id,
            "source": self.source,
            "language": self.language,
            "origin": self.origin,
            "cue_count": self.cue_count,
            "imported_at": self.imported_at.isoformat(),
            "meta": json.loads(self.meta_json or "{}"),
        }


class SubtitleCue(db.Model):  # type: ignore[name-defined,misc]
    """A single dialogue cue within a track. Half-open frame interval."""

    __tablename__ = "subtitle_cues"

    id = db.Column(db.Integer, primary_key=True)
    track_id = db.Column(
        db.Integer,
        db.ForeignKey("subtitle_tracks.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    video_id = db.Column(
        db.Integer,
        db.ForeignKey("videos.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    language = db.Column(db.String(8), nullable=True, index=True)
    ordinal = db.Column(db.Integer, nullable=False)
    start_frame = db.Column(db.Integer, nullable=False)
    end_frame = db.Column(db.Integer, nullable=False)
    start_pts_seconds = db.Column(db.Float, nullable=False)
    end_pts_seconds = db.Column(db.Float, nullable=False)
    text = db.Column(db.Text, nullable=False)

    track = cast(
        "SubtitleTrack",
        db.relationship("SubtitleTrack", back_populates="cues"),
    )

    __table_args__ = (
        db.UniqueConstraint(
            "track_id", "ordinal", name="uq_subtitle_cue_track_ordinal"
        ),
        db.Index("ix_subtitle_cue_video_frames", "video_id", "start_frame"),
    )


# ---------------------------------------------------------------------------
# FTS5 virtual table + sync triggers.
#
# SQLAlchemy's metadata doesn't model SQLite virtual tables or triggers
# natively, so we hook into the DDL lifecycle: after the regular
# subtitle_cues table is created, issue the CREATE VIRTUAL TABLE and three
# triggers in the same transaction. Contentless FTS5 (content=subtitle_cues,
# content_rowid=id) avoids duplicating the text column.
# ---------------------------------------------------------------------------


_FTS_DDL_STATEMENTS = (
    """
    CREATE VIRTUAL TABLE IF NOT EXISTS subtitle_cues_fts USING fts5(
        text,
        content='subtitle_cues',
        content_rowid='id',
        tokenize='porter unicode61'
    )
    """,
    """
    CREATE TRIGGER IF NOT EXISTS subtitle_cues_ai
    AFTER INSERT ON subtitle_cues
    BEGIN
        INSERT INTO subtitle_cues_fts(rowid, text) VALUES (new.id, new.text);
    END
    """,
    """
    CREATE TRIGGER IF NOT EXISTS subtitle_cues_ad
    AFTER DELETE ON subtitle_cues
    BEGIN
        INSERT INTO subtitle_cues_fts(subtitle_cues_fts, rowid, text)
            VALUES ('delete', old.id, old.text);
    END
    """,
    """
    CREATE TRIGGER IF NOT EXISTS subtitle_cues_au
    AFTER UPDATE ON subtitle_cues
    BEGIN
        INSERT INTO subtitle_cues_fts(subtitle_cues_fts, rowid, text)
            VALUES ('delete', old.id, old.text);
        INSERT INTO subtitle_cues_fts(rowid, text) VALUES (new.id, new.text);
    END
    """,
)


def _after_subtitle_cues_create(
    target: Table, connection: Connection, **_: Any
) -> None:
    # Only applies to SQLite; no-op on other backends (not that we have any).
    dialect = connection.engine.dialect.name
    if dialect != "sqlite":
        return
    for stmt in _FTS_DDL_STATEMENTS:
        connection.exec_driver_sql(stmt.strip())


event.listen(
    SubtitleCue.__table__, "after_create", _after_subtitle_cues_create
)
