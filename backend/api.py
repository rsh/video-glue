"""Flask application: auth endpoints + blueprint registration."""
from flask import Flask, request
from flask_cors import CORS
from pydantic import ValidationError
from sqlalchemy import event
from sqlalchemy.engine import Engine

import config
from auth import generate_token, login_required, validate_request_json
from models import User, db
from routes import ALL_BLUEPRINTS
from schemas import LoginRequest, RegisterRequest

app = Flask(__name__)
CORS(app)

config.ensure_dirs()
app.config["SQLALCHEMY_DATABASE_URI"] = config.DATABASE_URL
app.config["SQLALCHEMY_TRACK_MODIFICATIONS"] = False

db.init_app(app)


@event.listens_for(Engine, "connect")
def _sqlite_pragmas(dbapi_conn, _):  # type: ignore[no-untyped-def]
    """Enable WAL + foreign keys for SQLite connections.

    Fires for every connection; no-ops on non-SQLite engines since the PRAGMAs
    would fail harmlessly, so we check the module name.
    """
    module = type(dbapi_conn).__module__
    if "sqlite" not in module:
        return
    cur = dbapi_conn.cursor()
    try:
        cur.execute("PRAGMA journal_mode=WAL")
        cur.execute("PRAGMA foreign_keys=ON")
    finally:
        cur.close()


for bp in ALL_BLUEPRINTS:
    app.register_blueprint(bp)


# ============================================================================
# Authentication Endpoints (kept from template)
# ============================================================================


@app.route("/api/auth/register", methods=["POST"])
@validate_request_json(["email", "username", "password"])
def register() -> tuple[dict, int]:
    try:
        data = RegisterRequest(**request.get_json())
    except ValidationError as e:
        return {"error": e.errors()}, 400

    if User.query.filter_by(email=data.email).first():
        return {"error": "Email already registered"}, 400
    if User.query.filter_by(username=data.username).first():
        return {"error": "Username already taken"}, 400

    user = User(email=data.email, username=data.username)
    user.set_password(data.password)
    db.session.add(user)
    db.session.commit()

    token = generate_token(user.id)
    return {
        "message": "User registered successfully",
        "token": token,
        "user": user.to_dict(include_email=True),
    }, 201


@app.route("/api/auth/login", methods=["POST"])
@validate_request_json(["email", "password"])
def login() -> tuple[dict, int]:
    try:
        data = LoginRequest(**request.get_json())
    except ValidationError as e:
        return {"error": e.errors()}, 400

    user = User.query.filter_by(email=data.email).first()
    if not user or not user.check_password(data.password):
        return {"error": "Invalid email or password"}, 401

    token = generate_token(user.id)
    return {
        "message": "Login successful",
        "token": token,
        "user": user.to_dict(include_email=True),
    }, 200


@app.route("/api/auth/me", methods=["GET"])
@login_required
def get_current_user_info(current_user: User) -> tuple[dict, int]:
    return {"user": current_user.to_dict(include_email=True)}, 200


@app.route("/health", methods=["GET"])
def health() -> tuple[dict, int]:
    return {"status": "healthy"}, 200
