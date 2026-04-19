"""Export routes: create, poll, download."""
from pathlib import Path

from flask import Blueprint, abort, request, send_file
from pydantic import ValidationError

from auth import login_required
from models import Composition, CompositionClip, ExportJob, User, db
from schemas import ExportCreateRequest

exports_bp = Blueprint("exports", __name__, url_prefix="/api")


@exports_bp.route("/compositions/<int:comp_id>/export", methods=["POST"])
@login_required
def create_export(comp_id: int, current_user: User) -> tuple[dict, int]:
    comp = db.session.get(Composition, comp_id)
    if comp is None or comp.owner_id != current_user.id:
        return {"error": "not found"}, 404

    try:
        data = ExportCreateRequest(**(request.get_json(silent=True) or {}))
    except ValidationError as e:
        return {"error": e.errors()}, 400

    if not CompositionClip.query.filter_by(composition_id=comp.id).first():
        return {"error": "composition is empty"}, 400

    job = ExportJob(composition_id=comp.id, format=data.format, status="queued")
    db.session.add(job)
    db.session.commit()
    return {"export": job.to_dict()}, 202


@exports_bp.route("/exports/<int:job_id>", methods=["GET"])
@login_required
def get_export(job_id: int, current_user: User) -> tuple[dict, int]:
    job = db.session.get(ExportJob, job_id)
    if job is None:
        return {"error": "not found"}, 404
    comp = db.session.get(Composition, job.composition_id)
    if comp is None or comp.owner_id != current_user.id:
        return {"error": "not found"}, 404
    return {"export": job.to_dict()}, 200


@exports_bp.route("/exports/<int:job_id>/download", methods=["GET"])
@login_required
def download_export(job_id: int, current_user: User):  # type: ignore[no-untyped-def]
    job = db.session.get(ExportJob, job_id)
    if job is None:
        abort(404)
    comp = db.session.get(Composition, job.composition_id)
    if comp is None or comp.owner_id != current_user.id:
        abort(404)
    if job.status != "done" or not job.output_path:
        abort(409)
    path = Path(job.output_path)
    if not path.exists():
        abort(404)
    return send_file(path, as_attachment=True, download_name=path.name)
