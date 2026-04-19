#!/bin/bash
# Teardown — stops Flask + webpack dev server, optionally wipes local data.
#
# Usage:
#   ./teardown.sh              # just stop services
#   ./teardown.sh --reset-db   # also wipe data/video-glue.db*, thumbnails, and exports
#                              # (library/ is left alone; re-scan to repopulate)

set -e

RESET_DB=false
for arg in "$@"; do
    case "$arg" in
        --reset-db) RESET_DB=true ;;
        -h|--help)
            sed -n '2,6p' "$0"
            exit 0
            ;;
        *)
            echo "Unknown argument: $arg" >&2
            echo "Usage: $0 [--reset-db]" >&2
            exit 2
            ;;
    esac
done

REPO_ROOT=$(cd "$(dirname "$0")" && pwd)

echo "================================"
echo "Teardown Services"
echo "================================"
echo ""

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Kill processes that match `pattern` AND whose cwd is under this repo.
# Filtering on cwd keeps us from touching other users' `python app.py`
# or unrelated `webpack` processes on a shared machine.
kill_repo_processes() {
    local label="$1"
    local pattern="$2"
    local pids=()
    local pid cwd
    for pid in $(pgrep -f "$pattern" 2>/dev/null || true); do
        cwd=$(readlink "/proc/$pid/cwd" 2>/dev/null || true)
        if [[ -n "$cwd" && "$cwd" == "$REPO_ROOT"* ]]; then
            pids+=("$pid")
        fi
    done
    if [ "${#pids[@]}" -eq 0 ]; then
        echo -e "${YELLOW}⚠${NC} No $label process found"
        return
    fi
    echo "Found $label processes: ${pids[*]}"
    kill "${pids[@]}" 2>/dev/null || true
    sleep 1
    kill -9 "${pids[@]}" 2>/dev/null || true
    echo -e "${GREEN}✓${NC} $label stopped"
}

echo -e "${BLUE}Stopping Flask backend...${NC}"
kill_repo_processes "Flask backend" "python.*app\.py"

echo -e "${BLUE}Stopping webpack dev server...${NC}"
kill_repo_processes "webpack dev server" "webpack.*serve|webpack-dev-server"

if [ "$RESET_DB" = true ]; then
    echo ""
    echo -e "${BLUE}Resetting local data...${NC}"

    # Load .env so we honour overrides (VIDEOGLUE_DATA_DIR, DATABASE_URL, …).
    if [ -f "$REPO_ROOT/backend/.env" ]; then
        set -a
        # shellcheck disable=SC1091
        source "$REPO_ROOT/backend/.env"
        set +a
    fi

    DATA_DIR="${VIDEOGLUE_DATA_DIR:-$REPO_ROOT/data}"

    # SQLite DB + WAL artifacts.
    if [[ "${DATABASE_URL:-}" == sqlite:///* ]]; then
        DB_PATH="${DATABASE_URL#sqlite:///}"
    else
        DB_PATH="$DATA_DIR/video-glue.db"
    fi
    for suffix in "" "-shm" "-wal"; do
        target="${DB_PATH}${suffix}"
        if [ -f "$target" ]; then
            rm -f "$target"
            echo -e "${GREEN}✓${NC} removed $target"
        fi
    done

    THUMB_DIR="${VIDEOGLUE_THUMBNAIL_DIR:-$DATA_DIR/thumbnails}"
    EXPORT_DIR="${VIDEOGLUE_EXPORT_DIR:-$DATA_DIR/exports}"
    for d in "$THUMB_DIR" "$EXPORT_DIR"; do
        if [ -d "$d" ]; then
            rm -rf "$d"
            mkdir -p "$d"
            echo -e "${GREEN}✓${NC} cleared $d"
        fi
    done
    echo -e "${YELLOW}Note:${NC} library/ left intact; re-run your library rescan to repopulate."
fi

echo ""
echo -e "${GREEN}================================${NC}"
echo -e "${GREEN}Teardown complete${NC}"
echo -e "${GREEN}================================${NC}"
