"""Composition routes: CRUD plus replace-clips for the timeline."""
from datetime import datetime, timezone

from flask import Blueprint, request
from pydantic import ValidationError

from auth import login_required
from models import Composition, CompositionClip, Segment, User, db
from naming import generate_name
from schemas import (ClipsReplaceRequest, CompositionCreateRequest,
                     CompositionUpdateRequest)

compositions_bp = Blueprint("compositions", __name__, url_prefix="/api/compositions")


@compositions_bp.route("", methods=["GET"])
@login_required
def list_compositions(current_user: User) -> tuple[dict, int]:
    comps = (
        Composition.query.filter_by(owner_id=current_user.id)
        .order_by(Composition.updated_at.desc())
        .all()
    )
    return {"compositions": [c.to_dict(include_clips=False) for c in comps]}, 200


@compositions_bp.route("", methods=["POST"])
@login_required
def create_composition(current_user: User) -> tuple[dict, int]:
    try:
        data = CompositionCreateRequest(**(request.get_json(silent=True) or {}))
    except ValidationError as e:
        return {"error": e.errors()}, 400
    comp = Composition(
        name=data.name or generate_name(),
        owner_id=current_user.id,
        notes=data.notes,
    )
    db.session.add(comp)
    db.session.commit()
    return {"composition": comp.to_dict()}, 201


@compositions_bp.route("/<int:comp_id>", methods=["GET"])
@login_required
def get_composition(comp_id: int, current_user: User) -> tuple[dict, int]:
    comp = db.session.get(Composition, comp_id)
    if comp is None or comp.owner_id != current_user.id:
        return {"error": "not found"}, 404
    return {"composition": comp.to_dict()}, 200


@compositions_bp.route("/<int:comp_id>", methods=["PATCH"])
@login_required
def update_composition(comp_id: int, current_user: User) -> tuple[dict, int]:
    comp = db.session.get(Composition, comp_id)
    if comp is None or comp.owner_id != current_user.id:
        return {"error": "not found"}, 404
    try:
        data = CompositionUpdateRequest(**(request.get_json(silent=True) or {}))
    except ValidationError as e:
        return {"error": e.errors()}, 400
    if data.name is not None:
        comp.name = data.name
    if data.notes is not None:
        comp.notes = data.notes
    db.session.commit()
    return {"composition": comp.to_dict()}, 200


@compositions_bp.route("/<int:comp_id>", methods=["DELETE"])
@login_required
def delete_composition(comp_id: int, current_user: User) -> tuple[dict, int]:
    comp = db.session.get(Composition, comp_id)
    if comp is None or comp.owner_id != current_user.id:
        return {"error": "not found"}, 404
    db.session.delete(comp)
    db.session.commit()
    return {"message": "deleted"}, 200


@compositions_bp.route("/<int:comp_id>/clips", methods=["PUT"])
@login_required
def replace_clips(comp_id: int, current_user: User) -> tuple[dict, int]:
    """Replace the full ordered list of clips atomically."""
    comp = db.session.get(Composition, comp_id)
    if comp is None or comp.owner_id != current_user.id:
        return {"error": "not found"}, 404

    try:
        data = ClipsReplaceRequest(**(request.get_json(silent=True) or {}))
    except ValidationError as e:
        return {"error": e.errors()}, 400

    for idx, c in enumerate(data.clips):
        seg = db.session.get(Segment, c.segment_id)
        if seg is None:
            return {"error": f"clip {idx}: segment {c.segment_id} not found"}, 400
        seg_frames = seg.end_frame - seg.start_frame
        if c.trim_start_frame + c.trim_end_frame >= seg_frames:
            return (
                {
                    "error": (
                        f"clip {idx}: trim leaves no frames "
                        f"(segment has {seg_frames}, "
                        f"trim_start={c.trim_start_frame}, "
                        f"trim_end={c.trim_end_frame})"
                    )
                },
                400,
            )

    CompositionClip.query.filter_by(composition_id=comp.id).delete()
    db.session.flush()
    for pos, c in enumerate(data.clips):
        db.session.add(
            CompositionClip(
                composition_id=comp.id,
                segment_id=c.segment_id,
                position=pos,
                trim_start_frame=c.trim_start_frame,
                trim_end_frame=c.trim_end_frame,
            )
        )
    comp.updated_at = datetime.now(timezone.utc)
    db.session.commit()
    return {"composition": comp.to_dict()}, 200
