"""Pytest configuration and fixtures."""
import os
import tempfile
from typing import Generator

import pytest
from alembic import command
from flask import Flask
from flask.testing import FlaskClient

# Set test environment before importing app. Use a real SQLite file per test
# session (not :memory:) so alembic — which opens its own connection — sees
# the same DB the Flask app does.
_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ["SECRET_KEY"] = "test-secret-key"

from api import \
    app as \
    flask_app  # noqa: E402 - imports after setting test environment variables
from app import _alembic_config  # noqa: E402
from models import (  # noqa: E402 - imports after setting test environment variables
    User, db)


@pytest.fixture
def app() -> Generator[Flask, None, None]:
    """Create application for testing."""
    flask_app.config["TESTING"] = True

    # Migrate the test DB to head, yield, then roll back to base so the next
    # test starts from a clean slate.
    cfg = _alembic_config()
    command.upgrade(cfg, "head")
    try:
        with flask_app.app_context():
            yield flask_app
            db.session.remove()
    finally:
        command.downgrade(cfg, "base")


@pytest.fixture
def client(app: Flask) -> FlaskClient:
    """Create test client."""
    return app.test_client()


@pytest.fixture
def sample_user(app: Flask) -> Generator[User, None, None]:
    """Create and return a sample user."""
    with app.app_context():
        user = User(email="test@example.com", username="testuser")
        user.set_password("password123")
        db.session.add(user)
        db.session.commit()
        db.session.refresh(user)
        yield user


@pytest.fixture
def auth_headers(sample_user: User, client: FlaskClient) -> dict[str, str]:
    """Return auth headers for the sample user."""
    # Login to get token
    response = client.post(
        "/api/auth/login",
        json={"email": "test@example.com", "password": "password123"},
    )
    data = response.get_json()
    token = data["token"]

    return {"Authorization": f"Bearer {token}"}


@pytest.fixture
def db_session(app: Flask):
    """Provide db session for tests."""
    with app.app_context():
        yield db.session
