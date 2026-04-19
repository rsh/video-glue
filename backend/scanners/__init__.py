"""Scanner registry."""
from __future__ import annotations

from typing import Dict, List

from .base import Scanner, ScannerSegment, VideoContext
from .hard_cut import HardCutScanner

_REGISTRY: Dict[str, Scanner] = {}


def register(scanner: Scanner) -> None:
    _REGISTRY[scanner.name] = scanner


def get(name: str) -> Scanner:
    if name not in _REGISTRY:
        raise KeyError(f"Unknown scanner: {name}")
    return _REGISTRY[name]


def all_scanners() -> List[Scanner]:
    return list(_REGISTRY.values())


def has(name: str) -> bool:
    return name in _REGISTRY


# Built-in scanners — add new ones here when they arrive.
register(HardCutScanner())


__all__ = [
    "Scanner",
    "ScannerSegment",
    "VideoContext",
    "register",
    "get",
    "all_scanners",
    "has",
]
