"""Scanner routes: list registered scanners."""
from flask import Blueprint

import scanners
from auth import login_required
from models import User

scanners_bp = Blueprint("scanners", __name__, url_prefix="/api/scanners")


@scanners_bp.route("", methods=["GET"])
@login_required
def list_scanners(current_user: User) -> tuple[dict, int]:
    return {
        "scanners": [
            {
                "name": s.name,
                "version": s.version,
                "default_config": s.default_config,
            }
            for s in scanners.all_scanners()
        ]
    }, 200
