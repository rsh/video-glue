"""Flask application entry point."""
from pathlib import Path

from alembic import command
from alembic.config import Config

import config
import worker
from api import app

BASE_DIR = Path(__file__).resolve().parent


def _alembic_config() -> Config:
    cfg = Config(str(BASE_DIR / "alembic.ini"))
    cfg.set_main_option("script_location", str(BASE_DIR / "migrations"))
    cfg.set_main_option("sqlalchemy.url", config.DATABASE_URL)
    return cfg


def _upgrade_db() -> None:
    """Run any pending alembic migrations against the configured DB."""
    command.upgrade(_alembic_config(), "head")


if __name__ == "__main__":
    _upgrade_db()

    if config.WORKER_ENABLED:
        worker.start(app)

    app.run(host="0.0.0.0", port=5000, debug=True)
