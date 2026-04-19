#!/bin/bash
set -e

echo "Starting backend server..."

if [ ! -d "backend/venv" ]; then
    echo "Error: Virtual environment not found at backend/venv"
    echo "Please run ./setup.sh first"
    exit 1
fi

cd backend
source venv/bin/activate

if [ -f ".env" ]; then
    echo "Loading environment from .env file..."
    set -a
    # shellcheck disable=SC1091
    source .env
    set +a
else
    export SECRET_KEY=$(python3 -c "import secrets; print(secrets.token_hex(32))")
    export VIDEOGLUE_WORKER=1
    echo "Generated new SECRET_KEY for this session"
fi

echo "Starting Flask on http://localhost:5000"
# app.py handles db.create_all() and worker startup in __main__.
python app.py
