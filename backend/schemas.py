"""Pydantic schemas for request validation."""
from typing import List, Optional

from pydantic import BaseModel, EmailStr, Field, field_validator


class RegisterRequest(BaseModel):
    email: EmailStr
    username: str = Field(min_length=3, max_length=120)
    password: str = Field(min_length=8)

    @field_validator("username")
    @classmethod
    def username_alphanumeric(cls, v: str) -> str:
        if not v.replace("_", "").replace("-", "").isalnum():
            raise ValueError(
                "Username must be alphanumeric (underscores and hyphens allowed)"
            )
        return v


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class CompositionCreateRequest(BaseModel):
    name: Optional[str] = Field(default=None, max_length=200)
    notes: Optional[str] = None


class CompositionUpdateRequest(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=200)
    notes: Optional[str] = None


class ClipInput(BaseModel):
    segment_id: int
    trim_start_frame: int = Field(default=0, ge=0)
    trim_end_frame: int = Field(default=0, ge=0)


class ClipsReplaceRequest(BaseModel):
    """Replace the full ordered list of clips on a composition."""

    clips: List[ClipInput]


class ExportCreateRequest(BaseModel):
    format: str = Field(pattern="^(mp4|webm|gif)$")
    scale_divisor: int = Field(default=1)
    include_audio: bool = Field(default=False)

    @field_validator("scale_divisor")
    @classmethod
    def scale_divisor_allowed(cls, v: int) -> int:
        if v not in (1, 2, 4):
            raise ValueError("scale_divisor must be 1, 2, or 4")
        return v
