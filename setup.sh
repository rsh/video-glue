#!/bin/bash
# Quick setup for video-glue (Flask + TypeScript + SQLite)

set -e

echo "================================"
echo "video-glue setup"
echo "================================"
echo ""

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo "Checking prerequisites..."
if ! command -v python3 &> /dev/null; then
    echo -e "${RED}Error: Python 3 is not installed${NC}"
    exit 1
fi
if ! command -v node &> /dev/null; then
    echo -e "${RED}Error: Node.js is not installed${NC}"
    exit 1
fi
if ! command -v ffmpeg &> /dev/null || ! command -v ffprobe &> /dev/null; then
    echo -e "${YELLOW}Warning: ffmpeg/ffprobe not found — video-glue will not work without them.${NC}"
    echo "  Install on Ubuntu: sudo apt install ffmpeg"
fi
echo -e "${GREEN}✓${NC} Prerequisites checked"
echo ""

# Detect a GPU-accelerated H264 encoder. Preference order:
#   NVIDIA NVENC (requires a working nvidia-smi, not just ffmpeg support)
#   macOS VideoToolbox (Darwin only)
#   libx264 (CPU fallback)
H264_ENCODER="libx264"
if command -v ffmpeg &> /dev/null; then
    ENCODERS=$(ffmpeg -hide_banner -encoders 2>/dev/null || true)
    if echo "$ENCODERS" | grep -q " h264_nvenc " \
        && command -v nvidia-smi &> /dev/null \
        && nvidia-smi &> /dev/null; then
        H264_ENCODER="h264_nvenc"
        echo -e "${GREEN}✓${NC} Detected NVIDIA GPU — using h264_nvenc"
    elif [ "$(uname -s)" = "Darwin" ] && echo "$ENCODERS" | grep -q " h264_videotoolbox "; then
        H264_ENCODER="h264_videotoolbox"
        echo -e "${GREEN}✓${NC} Detected macOS VideoToolbox — using h264_videotoolbox"
    else
        echo -e "${GREEN}✓${NC} No GPU encoder detected — using libx264 (CPU)"
    fi
fi
echo ""

# Backend
echo -e "${BLUE}Setting up backend...${NC}"
cd backend
if [ ! -d "venv" ]; then
    python3 -m venv venv
    echo -e "${GREEN}✓${NC} Virtual environment created"
fi
./venv/bin/pip install --upgrade pip -q
./venv/bin/pip install -r requirements-dev.txt -q
echo -e "${GREEN}✓${NC} Python dependencies installed"

if [ ! -f ".env" ]; then
    cat > .env << 'EOF'
# SQLite by default; point VIDEO_LIBRARY_DIR at your video folder.
SECRET_KEY=dev-secret-key-change-in-production
VIDEOGLUE_WORKER=1
EOF
    echo -e "${GREEN}✓${NC} .env file created"
fi

# Refresh the encoder line every run so relocating to a new machine
# (e.g. onto a GPU box) picks up the right encoder without a manual edit.
grep -v "^VIDEOGLUE_H264_ENCODER=" .env > .env.tmp || true
mv .env.tmp .env
echo "VIDEOGLUE_H264_ENCODER=$H264_ENCODER" >> .env

cd ..

# Frontend
echo -e "${BLUE}Setting up frontend...${NC}"
cd frontend
npm install --silent
echo -e "${GREEN}✓${NC} Node dependencies installed"
cd ..

# Git hooks
if [ -d ".git" ] && [ -d "infrastructure/git-hooks" ]; then
    for hook in infrastructure/git-hooks/*; do
        [ -f "$hook" ] || continue
        hook_name=$(basename "$hook")
        chmod +x "$hook"
        ln -sf "../../infrastructure/git-hooks/$hook_name" ".git/hooks/$hook_name"
    done
    echo -e "${GREEN}✓${NC} Git hooks installed"
fi

echo ""
echo "Next steps:"
echo "  1. ./start_backend.sh"
echo "  2. ./start_frontend.sh"
echo "  3. Open http://localhost:3000"
