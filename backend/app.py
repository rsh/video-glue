"""Flask application entry point."""
import config
import worker
from api import app
from models import db

if __name__ == "__main__":
    with app.app_context():
        db.create_all()

    if config.WORKER_ENABLED:
        worker.start(app)

    app.run(host="0.0.0.0", port=5000, debug=True)
