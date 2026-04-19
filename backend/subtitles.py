"""Subtitle import: embedded streams + sidecar files, English detection, parse.

Entrypoint: ``import_subtitles(video)`` runs the full per-video flow. Called
from the worker during the ``subtitles_importing`` status transition. Must
tolerate every failure mode (missing ffmpeg, unreadable file, unknown codec)
by logging and continuing — never raises.
"""
# pylint: disable=too-many-locals,import-outside-toplevel,broad-exception-caught
from __future__ import annotations

import json
import logging
import re
import subprocess
from dataclasses import dataclass
from datetime import timedelta
from pathlib import Path
from typing import Iterable, List, Optional, Tuple

import config
from models import SubtitleCue, SubtitleTrack, Video, db

logger = logging.getLogger(__name__)

SUBTITLE_CODEC_TO_EXT = {
    "srt": "srt",
    "subrip": "srt",
    "webvtt": "vtt",
    "mov_text": "srt",
    "ass": "srt",
    "ssa": "srt",
}

SIDECAR_EXTENSIONS = (".srt", ".vtt")

_FILENAME_LANG_RE = re.compile(
    r"[.\-_](?P<code>[A-Za-z]{2,3}(?:[_\-][A-Za-z]{2})?)(?=\.[^.]+$)"
)

_ISO3_TO_ISO1 = {
    "eng": "en",
    "spa": "es",
    "fra": "fr",
    "fre": "fr",
    "deu": "de",
    "ger": "de",
    "ita": "it",
    "por": "pt",
    "rus": "ru",
    "jpn": "ja",
    "kor": "ko",
    "zho": "zh",
    "chi": "zh",
    "ara": "ar",
    "hin": "hi",
    "nld": "nl",
    "dut": "nl",
    "swe": "sv",
    "nor": "no",
    "dan": "da",
    "fin": "fi",
    "pol": "pl",
    "tur": "tr",
}

# Distinctly-English function words and common verbs — tokens of length >= 3
# so we avoid the noise of 1- and 2-letter cognates that overlap with
# Spanish/Italian/Portuguese/French ("a", "no", "si", "it", "me", …).
ENGLISH_STOPWORDS = frozenset(
    [
        "the", "and", "you", "that", "was", "for", "are", "with", "his",
        "they", "this", "have", "from", "had", "not", "but", "what",
        "all", "were", "when", "your", "can", "said", "there", "has",
        "been", "would", "will", "does", "did", "her", "him", "she",
        "them", "out", "just", "now", "here", "well", "because", "about",
        "who", "why", "how", "some", "any", "than", "then", "one", "two",
        "down", "over", "into", "only", "where", "their", "could",
        "should", "these", "those", "which", "think", "know", "want",
        "going", "gonna", "really", "yeah", "okay",
    ]
)

# Strip common SRT/ASS inline formatting (`<i>…</i>`, `{\an8}`, curly tags).
_MARKUP_RE = re.compile(
    r"(?:\{\\[^}]*\}|</?[A-Za-z][^>]*>|\{[^}]*\})"
)


@dataclass
class SubtitleSource:
    """A candidate subtitle source for a video."""

    kind: str  # "embedded" | "sidecar"
    origin: str  # ffprobe stream index (str) or absolute sidecar path
    language_hint: Optional[str]  # ISO-639-1 if known at discovery time
    codec: Optional[str]  # for embedded; extension for sidecar


@dataclass
class ParsedCue:
    start: timedelta
    end: timedelta
    text: str


# ---------------------------------------------------------------------------
# Discovery
# ---------------------------------------------------------------------------


def find_sources(
    video: Video, probed_subtitle_streams: List[dict]
) -> List[SubtitleSource]:
    """Enumerate embedded + sidecar sources for a video."""
    sources: List[SubtitleSource] = []
    for s in probed_subtitle_streams:
        index = s.get("index")
        if index is None:
            continue
        sources.append(
            SubtitleSource(
                kind="embedded",
                origin=str(index),
                language_hint=_normalize_lang(s.get("language")),
                codec=s.get("codec_name"),
            )
        )

    video_path = Path(video.path)
    stem = video_path.stem
    parent = video_path.parent
    for candidate in sorted(parent.iterdir()) if parent.exists() else []:
        if not candidate.is_file():
            continue
        if candidate.suffix.lower() not in SIDECAR_EXTENSIONS:
            continue
        # Must begin with the video's stem (allows `<stem>.en.srt`, `<stem>.srt`).
        if not candidate.name.startswith(stem):
            continue
        sources.append(
            SubtitleSource(
                kind="sidecar",
                origin=str(candidate.resolve()),
                language_hint=_detect_lang_from_filename(candidate.name),
                codec=candidate.suffix.lower().lstrip("."),
            )
        )
    return sources


# ---------------------------------------------------------------------------
# Extraction
# ---------------------------------------------------------------------------


class ExtractError(RuntimeError):
    pass


def extract_to_srt(video_path: Path, source: SubtitleSource) -> str:
    """Return the SRT text for the given source."""
    if source.kind == "embedded":
        cmd = [
            config.FFMPEG_BIN,
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-i",
            str(video_path),
            "-map",
            f"0:{source.origin}",
            "-c:s",
            "srt",
            "-f",
            "srt",
            "pipe:1",
        ]
        return _run_ffmpeg_capture(cmd)

    # sidecar
    path = Path(source.origin)
    if source.codec == "srt":
        return path.read_text(encoding="utf-8", errors="replace")
    # VTT or anything else: convert through ffmpeg.
    cmd = [
        config.FFMPEG_BIN,
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        str(path),
        "-f",
        "srt",
        "pipe:1",
    ]
    return _run_ffmpeg_capture(cmd)


def _run_ffmpeg_capture(cmd: list) -> str:
    try:
        completed = subprocess.run(
            cmd, capture_output=True, check=True, timeout=120
        )
    except FileNotFoundError as e:
        raise ExtractError(f"ffmpeg not found: {e}") from e
    except subprocess.CalledProcessError as e:
        stderr = (e.stderr or b"").decode("utf-8", errors="replace").strip()
        raise ExtractError(f"ffmpeg failed: {stderr}") from e
    except subprocess.TimeoutExpired as e:
        raise ExtractError("ffmpeg timed out") from e
    return completed.stdout.decode("utf-8", errors="replace")


# ---------------------------------------------------------------------------
# Parsing
# ---------------------------------------------------------------------------


def parse_srt(srt_text: str) -> List[ParsedCue]:
    """Parse an SRT string into ParsedCue[]. Silently skips malformed cues."""
    import srt as srt_lib  # type: ignore  # lazy to keep import cheap

    cues: List[ParsedCue] = []
    for cue in srt_lib.parse(srt_text):
        text = _clean_text(cue.content or "")
        if not text:
            continue
        cues.append(ParsedCue(start=cue.start, end=cue.end, text=text))
    return cues


def _clean_text(raw: str) -> str:
    stripped = _MARKUP_RE.sub("", raw)
    # Collapse whitespace and newlines into single spaces.
    return " ".join(stripped.split()).strip()


# ---------------------------------------------------------------------------
# Language detection — three-tier waterfall
# ---------------------------------------------------------------------------


def _normalize_lang(code: Optional[str]) -> Optional[str]:
    if not code:
        return None
    lower = code.strip().lower()
    if len(lower) == 2:
        return lower
    return _ISO3_TO_ISO1.get(lower, lower if len(lower) < 8 else None)


def _detect_lang_from_filename(name: str) -> Optional[str]:
    # Looks for a language code in positions like "Movie.en.srt" or
    # "Movie.eng.srt" or "Movie.en-US.srt". We check the segment right before
    # the extension.
    m = _FILENAME_LANG_RE.search(name)
    if m is None:
        return None
    return _normalize_lang(m.group("code").split("_")[0].split("-")[0])


def detect_language(cues: Iterable[ParsedCue], hint: Optional[str]) -> Optional[str]:
    if hint:
        return hint
    # Stopword-ratio heuristic for English vs. anything else.
    words: List[str] = []
    for c in cues:
        words.extend(re.findall(r"[A-Za-z']+", c.text.lower()))
        if len(words) >= 500:
            break
    if len(words) < 10:
        return None
    hits = sum(1 for w in words if w in ENGLISH_STOPWORDS)
    ratio = hits / len(words)
    # Real English dialogue runs ~18-28% stopwords by token count; even
    # short-phrase captions hit ~10%. Anything below ~6% is ~certainly not EN.
    return "en" if ratio >= 0.06 else None


# ---------------------------------------------------------------------------
# Top-level orchestration
# ---------------------------------------------------------------------------


def _pts_to_frame(pts_seconds: float, fps_num: int, fps_den: int) -> int:
    return int(round(pts_seconds * fps_num / fps_den))


def _timestamps_for(
    cue: ParsedCue, fps_num: int, fps_den: int, total_frames: int
) -> Tuple[int, int, float, float]:
    start_s = cue.start.total_seconds()
    end_s = cue.end.total_seconds()
    start_frame = max(0, min(total_frames, _pts_to_frame(start_s, fps_num, fps_den)))
    end_frame = max(
        start_frame + 1,
        min(total_frames, _pts_to_frame(end_s, fps_num, fps_den)),
    )
    return start_frame, end_frame, start_s, end_s


def import_subtitles(video: Video, probed_subtitle_streams: List[dict]) -> int:
    """Import all available subtitles for a video. Returns cues written.

    Never raises. Per-source errors are logged; the function returns whatever
    was successfully imported.
    """
    if not (video.fps_num and video.fps_den and video.total_frames):
        logger.info("skipping subtitles for video %s: missing fps/frames", video.id)
        return 0

    sources = find_sources(video, probed_subtitle_streams)
    if not sources:
        return 0

    cues_written = 0
    for source in sources:
        existing = SubtitleTrack.query.filter_by(
            video_id=video.id, source=source.kind, origin=source.origin
        ).first()
        if existing is not None:
            continue

        try:
            srt_text = extract_to_srt(Path(video.path), source)
        except ExtractError as e:
            logger.warning(
                "subtitle extract failed (video=%s source=%s origin=%s): %s",
                video.id, source.kind, source.origin, e,
            )
            continue

        try:
            parsed = parse_srt(srt_text)
        except Exception as e:  # noqa: BLE001 — third-party parser
            logger.warning(
                "subtitle parse failed (video=%s source=%s): %s",
                video.id, source.kind, e,
            )
            continue
        if not parsed:
            continue

        language = detect_language(parsed, source.language_hint)

        track = SubtitleTrack(
            video_id=video.id,
            source=source.kind,
            language=language,
            origin=source.origin,
            cue_count=len(parsed),
            meta_json=json.dumps({"codec": source.codec}),
        )
        db.session.add(track)
        db.session.flush()  # need track.id for cue FK

        for ordinal, cue in enumerate(parsed):
            start_frame, end_frame, start_s, end_s = _timestamps_for(
                cue, video.fps_num, video.fps_den, video.total_frames
            )
            db.session.add(
                SubtitleCue(
                    track_id=track.id,
                    video_id=video.id,
                    language=language,
                    ordinal=ordinal,
                    start_frame=start_frame,
                    end_frame=end_frame,
                    start_pts_seconds=start_s,
                    end_pts_seconds=end_s,
                    text=cue.text,
                )
            )
            cues_written += 1
        db.session.commit()
    return cues_written
