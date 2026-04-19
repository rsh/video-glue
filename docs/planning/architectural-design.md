# video-glue — Architectural Design

## Context

The repo ships a Flask + SQLAlchemy + Pydantic backend and a plain-TypeScript + Webpack + Bootstrap frontend — currently a priority-based todo app with JWT auth. `design.md` pivots it to **video-glue**: a local webapp that scans a directory for video files, detects hard-cut scene transitions, and lets the user assemble clips on a single-track drag-and-drop timeline, exporting to webm/gif/mp4 via ffmpeg. The scanner model must be extensible (a future "funny scene" scanner should coexist with "hard_cut").

Decisions taken up-front: **audio stripped in v1**, **auth kept** (compositions are user-owned), **Alembic from day one**, **packages kept minimal** — each addition is justified below.

## 1. Data model (SQLite + Alembic)

Six new tables. Frame indices are the source of truth; timestamps are derived for display and ffmpeg convenience.

- **`videos`** — one row per discovered file. `path` UNIQUE, `filename`, `size_bytes`, `date_modified`, `duration_seconds`, `width`, `height`, `fps_num`/`fps_den` (rational, to handle 29.97 = 30000/1001), `total_frames`, `container`, `status` (`discovered|probing|probed|scanning|ready|error`), `error_message`, timestamps.
- **`scanners`** — registry. `(name, version)` UNIQUE; `config_json` snapshot of thresholds. Re-scans with a tuned algo coexist with old results.
- **`scan_runs`** — one row per (video × scanner) execution. `status`, timing, error. A partial-unique index enforces one completed result per (video, scanner).
- **`segments`** — `scan_run_id`, `video_id` + `scanner_name` (denormalized, indexed for grid queries), `start_frame` (inclusive), `end_frame` (exclusive), `start_pts_seconds`, `end_pts_seconds`, `thumbnail_path`, `meta_json` (scanner-specific blob: `{"confidence": 0.87}` for hard_cut). Half-open `[start, end)` intervals make "every frame accounted for" a one-line invariant: `segments[i].end == segments[i+1].start` and `MAX(end_frame) == video.total_frames`.
- **`compositions`** — `name` (randomly generated default, see §6), `user_id` FK, `notes`, timestamps.
- **`composition_clips`** — junction with ordering & trimming. `composition_id`, `segment_id`, `position` (0-indexed on the single track), `trim_start_frame`, `trim_end_frame`. UNIQUE(`composition_id`, `position`). Effective playback range = `[segment.start + trim_start, segment.end - trim_end)`. Reorder = full renumber in one transaction (dozens-of-clips scale — fractional indexing is unneeded complexity).

Existing `users` table is kept. `Todo` is gutted.

## 2. Discovery & processing pipeline

- **Discovery**: manual `POST /api/library/rescan` + a sweep on app startup. Walks `VIDEO_LIBRARY_DIR`, upserts into `videos` dedup'd by `path`. No `watchdog` dep — users know when they dropped files in, and partial-write detection during copy is a real footgun.
- **Worker**: a single background thread (stdlib `threading`; not Celery/RQ/Redis). The `videos.status` column _is_ the queue. Loop: pick oldest `discovered` → probe (ffprobe subprocess → JSON) → pick oldest `probed` → scan → write segments → extract thumbnails → `status='ready'`. Started in `app.py` behind a `VIDEOGLUE_WORKER=1` env gate so Flask's debug reloader doesn't double-start it. All DB work runs inside `with app.app_context()`. SQLite WAL mode on startup so reads don't block the worker's writes.
- **Scene detection**: PySceneDetect's `ContentDetector`. Returns frame-exact `(start, end)` pairs (see §7 for why not raw ffmpeg).
- **Result writing**: per scan, one transaction — INSERT `scan_runs`, bulk INSERT `segments`, UPDATE `videos.status='ready'`. Thumbnails (file I/O) are extracted after the transaction and their paths UPDATE'd. Contiguity invariant (`[0, total_frames)`, no gaps, no overlaps) asserted before COMMIT.
- **Frontend notification**: polling. `GET /api/videos` returns each video's `status` and `segment_count`. UI polls every 2 s while any video is in a non-terminal state, then stops. No WebSockets/SSE.

## 3. Scanner extensibility

A `backend/scanners/` package with a `Scanner` protocol (`name`, `version`, `default_config`, `scan(video) -> Iterable[ScannerSegment]`) and a module-level registry (`register()`, `get()`, `all_scanners()`). `hard_cut.py` self-registers on import. Adding `funny_scene.py` later = drop one file in, import it from `__init__.py`, one new row in `scanners`. API: `POST /api/videos/:id/scan?scanner=hard_cut|all`. Segments from multiple scanners coexist in `segments`, partitioned by `scanner_name`; the grid has a scanner-filter dropdown sourced from `GET /api/scanners`.

## 4. Frontend architecture

Plain TS + Bootstrap — no framework added. Components stay as functions returning `HTMLElement`, matching `frontend/src/components.ts`. The `ApiClient` singleton in `frontend/src/api/client.ts` is kept; methods gutted + replaced.

Layout (after login):

- **Top pane**: segment grid, grouped by video, scanner-filterable. Each tile = pre-extracted first-frame JPEG + duration badge. Tiles are HTML5-draggable.
- **Bottom pane**: single-track timeline with clips in order, a playhead, and trim handles. Each clip's `<div>` width ∝ effective duration at a pixel-per-second zoom.
- **Preview**: one `<video>` element fed by `GET /api/videos/:id/stream` (Flask `send_file(conditional=True)` gives HTTP range support — required for `<video>` seek). Composition playback is a state machine that seeks clip→clip on `timeupdate`. `<video>` seek is not frame-exact; the UI surfaces this ("preview is approximate; export is frame-exact").
- **Trim**: two drag handles per clip + authoritative numeric `trim_start_frame` / `trim_end_frame` inputs in a side panel — handles update the inputs, inputs are the truth.
- **DnD**: HTML5 native. Two MIME types: `application/x-video-glue-segment` (grid → timeline, append/insert) and `application/x-video-glue-clip` (timeline reorder). Sortable.js considered and deferred — it's polish (animated placeholders, keyboard a11y), not core behavior.

## 5. Export

ffmpeg via `subprocess.run` with argv lists (not `ffmpeg-python` — a wrapper around the same CLI that adds a dep and debugging surface). Single-pass filter graph:

```
[i:v]trim=start_frame=S_i:end_frame=E_i,setpts=PTS-STARTPTS[v_i];
...
[v_0][v_1]...[v_N-1]concat=n=N:v=1:a=0[out]
```

Frame-exact because `trim` with frame indices avoids timestamp rounding. Input-side `-ss` is **not** used (rounds to keyframe).

Per-format tail:

- **mp4**: `-c:v libx264 -crf 18 -preset medium -pix_fmt yuv420p -movflags +faststart`
- **webm**: `-c:v libvpx-vp9 -crf 32 -b:v 0 -pix_fmt yuv420p`
- **gif**: two-pass — `palettegen` → `paletteuse`, default 20 fps, scale 480w.

All exports are `-an` (audio stripped) in v1.

Export runs on the same worker thread (or a second one); tracked in an `export_jobs` table (`composition_id`, `format`, `status`, `output_path`, `progress_percent`, `error_message`, timestamps). `ffmpeg -progress pipe:1` is parsed for progress. Frontend polls `GET /api/exports/:id`; downloads via `GET /api/exports/:id/download`.

Random composition name: hand-rolled `adjective-noun-NN` (80 × 80 × 100 = 640k combos, zero deps). Renameable.

## 6. New packages (with pitches)

Added deliberately — each earns its weight:

- **`scenedetect`** (pulls `opencv-python`, `numpy`). Purpose-built hard-cut detection; returns frame-exact intervals with tunable thresholds and a clean Python API. Alternatives are (a) ffmpeg's `select='gt(scene,...)'` filter — stderr-scraping, timestamp-only output, different threshold semantics; or (b) hand-rolled OpenCV diffs — reinventing this library. **Strongly worth adding.**
- **`alembic`**. Per decision — one dep + a `migrations/` dir; avoids a data-loss moment once users have saved compositions.

Considered and rejected:

- `ffmpeg-python` — subprocess is clearer for a handful of commands.
- `watchdog` — manual rescan is sufficient; avoids partial-write edge cases.
- `celery` / `rq` / `redis` — single-user workload does not justify another daemon.
- `Sortable.js` (frontend) — HTML5 DnD is enough for v1; keep in pocket as a polish upgrade.

Removed from template: `psycopg2-binary` (SQLite only), `boto3` (unused).

## 7. Keep / gut from template

**Keep**: auth stack (User model, `/api/auth/*`, `auth.py` JWT decorators, login/register forms, `ApiClient` token handling), Pydantic schema pattern, functional TS component pattern, `showError` / `showSuccess` helpers, webpack dev-server proxy, `check.sh`, test directory structure.

**Gut**: `Todo` model, `/api/todos/*` routes, todo schemas, `createTodoForm` / `createTodosTable` / `createQuickAddTask`, "Todo Calendar" branding, `reset_db.py`'s PostgreSQL-specific `CASCADE` SQL (Alembic owns schema now), `boto3`, `psycopg2-binary`, `brite-theme.css` (optional — nuke if the template look isn't wanted).

## 8. File layout (additions / changes)

```
backend/
  app.py                     # edit: start worker thread behind env gate, WAL pragma
  api.py                     # gut todos; register new route blueprints
  models.py                  # gut Todo; add Video, Scanner, ScanRun, Segment,
                             #   Composition, CompositionClip, ExportJob
  schemas.py                 # gut todo schemas; add new Pydantic schemas
  config.py                  # NEW: VIDEO_LIBRARY_DIR, THUMBNAIL_DIR, EXPORT_DIR,
                             #   worker poll interval
  worker.py                  # NEW: background loop, probe + scan + thumbnail dispatch
  probe.py                   # NEW: ffprobe wrapper
  thumbnails.py              # NEW: per-segment first-frame JPEG extraction
  export.py                  # NEW: filter_complex builder, subprocess, progress parser
  naming.py                  # NEW: adjective-noun-NN generator (wordlist constant)
  scanners/
    __init__.py              # NEW: registry (register/get/all_scanners)
    base.py                  # NEW: Scanner protocol, ScannerSegment dataclass
    hard_cut.py              # NEW: PySceneDetect scanner
  routes/                    # NEW: split api.py by resource
    videos.py  segments.py  scanners.py  compositions.py  exports.py
  migrations/                # NEW: Alembic
  requirements.txt           # - psycopg2-binary, boto3; + scenedetect, alembic
  tests/                     # add tests per new module

frontend/src/
  index.html                 # rebrand
  index.ts                   # replace main view render path
  api/client.ts, types.ts    # gut todo methods/types; add video/segment/composition/export
  components/                # NEW: split components.ts
    video-grid.ts  timeline.ts  preview.ts  composition-panel.ts
    drag.ts        feedback.ts
  styles.css                 # grow
```

## 9. Risks & open questions

1. **Variable-frame-rate (VFR) video.** PySceneDetect and ffmpeg `trim` assume CFR; phone-recorded MP4s are often VFR. Mitigation: detect at probe time; if VFR, transcode once to CFR at average fps into `<library>/.video-glue/cache/<id>.mp4` and use that for both scanning and export. Without this, frame counts silently drift. Highest-impact footgun.
2. **SQLite write contention** between worker thread + HTTP reads — mitigated by WAL mode.
3. **Large compositions** (100+ clips) may hit `filter_complex` arg limits. Fallback: per-clip intermediates + concat demuxer. Unlikely in typical use.
4. **Thumbnail storage**: hidden dir inside library (`<LIBRARY>/.video-glue/thumbnails/`) vs. OS app-data dir. Leaning library-relative for portability; env override.
5. **ffmpeg/ffprobe presence** is a system prerequisite. Check at startup; surface a clear UI error if absent; document in README.
6. **Preview vs. export asymmetry**: `<video>` seek is not frame-exact. Flag in UI.

## 10. Verification

- **Unit tests** (`backend/tests/`): scanner contiguity invariant; composition-clip reorder transaction; export filter-graph builder produces expected argv for a known composition; `probe` parses a known ffprobe JSON fixture.
- **Integration**: check in a tiny `.mp4` fixture; hit `POST /api/library/rescan`, poll until `status='ready'`, assert `segment_count > 0` and `SUM(end_frame - start_frame) == total_frames`.
- **End-to-end (manual)**: start backend + frontend, add one real video, wait for scan, drag 2–3 segments to the timeline, trim one, export as gif and mp4, compare frame counts against `trim_start/end` math using `ffprobe -count_frames`.
- **Lint + tests**: `check.sh` runs flake8, mypy, eslint, pytest, and jest.
