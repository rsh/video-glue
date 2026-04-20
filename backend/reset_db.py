"""Reset the database: downgrade everything, then re-apply migrations."""
from alembic import command

from app import _alembic_config

if __name__ == "__main__":
    cfg = _alembic_config()
    print("Rolling schema back to base...")
    command.downgrade(cfg, "base")
    print("Upgrading to head...")
    command.upgrade(cfg, "head")
    print("Database schema recreated.")
