"""Scanner protocol + shared types."""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, Optional, Protocol

# (fraction_complete: 0.0–1.0) -> None. Safe to call frequently; the caller
# throttles before writing to durable storage.
ProgressCallback = Callable[[float], None]


@dataclass
class VideoContext:
    """Everything a scanner needs to know about its input."""

    video_id: int
    path: Path
    fps_num: int
    fps_den: int
    total_frames: int
    duration_seconds: float


@dataclass
class ScannerSegment:
    """A single segment produced by a scanner, half-open [start, end)."""

    start_frame: int
    end_frame: int
    meta: Dict[str, Any] = field(default_factory=dict)


class Scanner(Protocol):
    name: str
    version: str
    default_config: Dict[str, Any]

    def scan(
        self,
        video: VideoContext,
        config: Dict[str, Any],
        on_progress: Optional[ProgressCallback] = None,
    ) -> Iterable[ScannerSegment]:
        ...
