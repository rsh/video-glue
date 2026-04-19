# Important Context

This entire repository was created using AI, except this section and anything in brackets [rsh: like this]. As of the initial date of publication, 2025-10-03, no human being has ever directly edited this code.

Proceed at your own risk!


# video-glue

Local webapp that scans a directory of video files, detects hard-cut scene transitions (frame-accurate), and lets you assemble short clips on a single-track drag-and-drop timeline. Export to mp4, webm, or gif via ffmpeg.

The scanner model is pluggable: today there's `hard_cut`; adding e.g. `funny_scene` later is a one-file drop-in under `backend/scanners/`.

See `docs/planning/architectural-design.md` for the full design.

## Prerequisites

- **Python 3** (tested on 3.12)
- **Node.js** (for the frontend bundler)
- **ffmpeg + ffprobe** on `PATH` — video-glue shells out to both for probing, thumbnails, and export. On Ubuntu: `sudo apt install ffmpeg`.

No Docker, no Postgres, no Redis required. Data lives in SQLite.

## Setup

```bash
./setup.sh
```

Creates `backend/venv/`, installs Python + npm deps, and writes `backend/.env` with a dev secret and `VIDEOGLUE_WORKER=1`.

## Configuration

All config is env-driven (see `backend/config.py`). Defaults:

| Variable | Default | Purpose |
|---|---|---|
| `VIDEO_LIBRARY_DIR` | `./data/library/` | Where you drop videos for video-glue to discover. |
| `VIDEOGLUE_DATA_DIR` | `./data/` | Root for everything else (db, thumbnails, exports). Override to move it all at once. |
| `VIDEOGLUE_THUMBNAIL_DIR` | `<data>/thumbnails/` | Per-segment first-frame JPEGs. |
| `VIDEOGLUE_EXPORT_DIR` | `<data>/exports/` | Rendered composition output files. |
| `DATABASE_URL` | `sqlite:///<data>/video-glue.db` | Any SQLAlchemy URL. |
| `VIDEOGLUE_WORKER` | unset → off | Must be `1` for background probing/scanning/exports to run. `setup.sh` enables it. |
| `VIDEOGLUE_WORKER_POLL_SECONDS` | `2.0` | How often the worker thread checks for pending work. |
| `SECRET_KEY` | `dev-secret-key` | JWT signing key. Set a real one in production. |
| `FFMPEG_BIN` / `FFPROBE_BIN` | `ffmpeg` / `ffprobe` | Override if they're not on `PATH`. |

Point `VIDEO_LIBRARY_DIR` at a folder of your own videos, or drop files into the default. Extensions picked up: `.mp4 .mov .mkv .webm .avi .m4v`.

## Running

Two terminals:

```bash
# Terminal 1: backend (Flask on :5000)
./start_backend.sh

# Terminal 2: frontend (webpack dev server on :3000, proxies /api to :5000)
./start_frontend.sh
```

Then open <http://localhost:3000>.

## Usage flow

1. Register an account (first visit).
2. Drop some video files into `VIDEO_LIBRARY_DIR`.
3. Click **Rescan library**. Videos appear immediately with status `discovered`.
4. The background worker probes each file (`ffprobe`) → runs the `hard_cut` scanner (PySceneDetect) → extracts a first-frame JPEG thumbnail per segment. The UI polls every 2 s and updates each video's status (`probing` → `scanning` → `ready`).
5. Expand a video to see its segment tiles. Drag tiles down to the timeline.
6. Click a clip to select it; drag its edge handles or use the numeric `trim_start_frame`/`trim_end_frame` inputs for frame-exact trimming. Re-order by dragging clips within the track.
7. Name your composition in the side panel and **Save**.
8. Click **MP4**, **WebM**, or **GIF** to export. Progress polls at 1.5 s; when it's done, a Download button appears.

Preview is approximate (browser `<video>` seek is not frame-exact). Exports are frame-exact (`ffmpeg trim=start_frame=…:end_frame=…`). Audio is stripped in v1.

## Dev cycle

```bash
# Backend
cd backend
source venv/bin/activate
pytest                              # tests (add your own under tests/)
flake8 --max-line-length=120 .      # lint
mypy .                              # type-check
python reset_db.py                  # nuke + recreate schema (WIPES DATA)

# Frontend
cd frontend
npm run type-check                  # tsc --noEmit
npm run lint                        # eslint
npm run lint:fix                    # eslint --fix (runs prettier too)
npm run build                       # production bundle
npm test                            # jest

# Both
./check.sh                          # runs everything in sequence
```

### Database migrations (Alembic)

Schema lives in `backend/models.py`. For quick iteration, `reset_db.py` (or `db.create_all()` on first boot) is enough. Once you have real saved compositions, generate migrations instead:

```bash
cd backend
source venv/bin/activate
alembic revision --autogenerate -m "describe change"
alembic upgrade head
```

### Adding a new scanner

1. Create `backend/scanners/your_scanner.py`. Implement a class with `name`, `version`, `default_config`, and `scan(video, config) -> Iterable[ScannerSegment]`.
2. Register it in `backend/scanners/__init__.py` alongside `HardCutScanner`.
3. It shows up under `GET /api/scanners` automatically; segments it produces coexist with `hard_cut`'s.

## Project structure

```
backend/
  app.py                     # entry point — db.create_all, start worker, Flask dev server
  api.py                     # auth endpoints + WAL/FK SQLite pragmas + blueprint registration
  auth.py                    # JWT (accepts both Authorization header and ?token= query)
  config.py                  # env-driven config + ensure_dirs()
  models.py                  # User, Video, Scanner, ScanRun, Segment, Composition,
                             #   CompositionClip, ExportJob
  schemas.py                 # Pydantic request schemas
  probe.py                   # ffprobe wrapper → metadata (rational fps, total_frames)
  thumbnails.py              # ffmpeg first-frame extraction per segment
  export.py                  # filter_complex builder + subprocess runner + -progress parser
  naming.py                  # adjective-noun-NN composition name generator
  worker.py                  # background thread: probe → scan → thumbnails → exports
  scanners/
    base.py                  # Scanner protocol + dataclasses
    __init__.py              # registry
    hard_cut.py              # PySceneDetect-backed ContentDetector
  routes/                    # Flask blueprints
    library.py  videos.py  segments.py  scanners.py  compositions.py  exports.py
  migrations/                # Alembic
  reset_db.py                # drop_all + create_all

frontend/src/
  index.html, index.ts       # main entry — auth gate + editor view
  styles.css                 # editor layout + timeline/clip styles
  auth.ts                    # current-user state
  api/
    client.ts                # ApiClient: auth, library, videos, segments, compositions, exports
    types.ts                 # shared types
  components/
    auth-forms.ts            # login / register forms
    feedback.ts              # toasts + formatters + escapeHtml
    drag.ts                  # HTML5 DnD MIME types + helpers
    video-grid.ts            # top pane: videos + segment thumbnail tiles
    timeline.ts              # bottom pane: single-track timeline + trim handles
    preview.ts               # composition preview (HTML5 <video>, clip-to-clip seeking)
    composition-panel.ts     # side panel: name, load/save, export

docs/
  ARCHITECTURE.md            # original template architecture (kept for reference)
  planning/
    architectural-design.md  # video-glue-specific design
```

## Troubleshooting

- **Nothing happens after Rescan** — the worker is gated by `VIDEOGLUE_WORKER=1`. Confirm it's set (`./start_backend.sh` loads `.env` automatically; manual `python app.py` invocations don't).
- **Video stuck on `error` with a probe message** — usually means ffmpeg/ffprobe aren't on `PATH`. Check with `which ffmpeg ffprobe`.
- **Scan finishes but there are no segments** — the scanner ran but the probe data was bogus (often variable-frame-rate video). Re-encode to CFR, or flag it as an issue to file (see the VFR note in `docs/planning/architectural-design.md`).
- **Preview skips at clip boundaries** — expected; `<video>` seek is not frame-exact. The export is.
- **Export fails with "ffmpeg exited…"** — check the full `error_message` on the export job; most often a codec that isn't installed with your ffmpeg build (e.g. libvpx-vp9 for webm).

## API at a glance

Everything under `/api/*` except `/api/auth/*` requires a JWT (Authorization header or `?token=` query).

- `POST /api/auth/register` · `POST /api/auth/login` · `GET /api/auth/me`
- `POST /api/library/rescan`
- `GET /api/videos` · `GET /api/videos/:id` · `GET /api/videos/:id/segments` · `GET /api/videos/:id/stream` · `POST /api/videos/:id/scan`
- `GET /api/thumbnails/<video_id>/<segment_id>.jpg`
- `GET /api/scanners`
- `GET /api/compositions` · `POST /api/compositions` · `GET|PATCH|DELETE /api/compositions/:id` · `PUT /api/compositions/:id/clips`
- `POST /api/compositions/:id/export` · `GET /api/exports/:id` · `GET /api/exports/:id/download`

## License

ISC
