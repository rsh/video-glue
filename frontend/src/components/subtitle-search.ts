/**
 * Subtitle search view: one input, a list of result rows.
 *
 * Each row: thumbnail left, three text lines right (prev cue · matched cue
 * with FTS5 <b>…</b> highlights · next cue). Missing prev/next are omitted.
 *
 * Rows are HTML5-draggable with the same MIME as segment tiles — dropping on
 * the timeline adds the full overlapping hard-cut segment, unchanged.
 */

import { apiClient, type SubtitleHit } from "../api";
import { escapeHtml } from "./feedback";
import { setSegmentDragData } from "./drag";

const SEARCH_DEBOUNCE_MS = 200;

export interface SubtitleSearchProps {
  initialQuery: string;
  initialResults: SubtitleHit[];
  onSearch: (q: string, results: SubtitleHit[]) => void;
  onError: (message: string) => void;
}

export function createSubtitleSearch(props: SubtitleSearchProps): HTMLElement {
  const el = document.createElement("div");
  el.className = "vg-subtitle-search";

  el.innerHTML = `
    <div class="vg-sub-search-bar input-group mb-2">
      <span class="input-group-text">Search</span>
      <input type="text" class="form-control" id="vg-sub-q"
             placeholder="Search dialog across library…" autocomplete="off"
             value="${escapeHtml(props.initialQuery)}"/>
      <span class="input-group-text vg-sub-count text-muted small">
        ${props.initialResults.length} ${props.initialResults.length === 1 ? "hit" : "hits"}
      </span>
    </div>
    <div class="vg-sub-results"></div>
  `;

  const input = el.querySelector("#vg-sub-q") as HTMLInputElement;
  const count = el.querySelector(".vg-sub-count") as HTMLElement;
  const list = el.querySelector(".vg-sub-results") as HTMLElement;

  renderResults(list, props.initialResults);

  let debounce: number | null = null;
  let lastQuery = props.initialQuery;
  input.addEventListener("input", () => {
    if (debounce !== null) window.clearTimeout(debounce);
    debounce = window.setTimeout(async () => {
      const q = input.value.trim();
      if (q === lastQuery) return;
      lastQuery = q;
      if (q === "") {
        count.textContent = "0 hits";
        list.innerHTML = "";
        props.onSearch("", []);
        return;
      }
      try {
        const results = await apiClient.searchSubtitles(q);
        count.textContent = `${results.length} ${results.length === 1 ? "hit" : "hits"}`;
        renderResults(list, results);
        props.onSearch(q, results);
      } catch (err) {
        props.onError(err instanceof Error ? err.message : String(err));
      }
    }, SEARCH_DEBOUNCE_MS);
  });

  // Autofocus so the user can just start typing when they switch views.
  setTimeout(() => input.focus(), 0);

  return el;
}

function renderResults(host: HTMLElement, results: SubtitleHit[]): void {
  host.innerHTML = "";
  if (results.length === 0) {
    const empty = document.createElement("p");
    empty.className = "text-muted small mb-0";
    empty.textContent =
      "No results yet — type a phrase above. Results appear as you type.";
    host.appendChild(empty);
    return;
  }
  for (const hit of results) {
    host.appendChild(renderRow(hit));
  }
}

function renderRow(hit: SubtitleHit): HTMLElement {
  const row = document.createElement("div");
  row.className = "vg-sub-row";
  if (hit.segment_id !== null) {
    row.draggable = true;
    row.dataset["segmentId"] = String(hit.segment_id);
  }

  const thumb = document.createElement("div");
  thumb.className = "vg-sub-thumb";
  if (hit.thumbnail_path) {
    const img = document.createElement("img");
    img.src = apiClient.thumbnailUrl(hit.thumbnail_path);
    img.alt = `segment ${hit.segment_id ?? ""}`;
    thumb.appendChild(img);
  } else {
    thumb.classList.add("vg-sub-thumb-missing");
    thumb.textContent = "no thumbnail";
  }

  const text = document.createElement("div");
  text.className = "vg-sub-text";

  if (hit.prev_cue_text) {
    const prev = document.createElement("div");
    prev.className = "vg-sub-line vg-sub-context";
    prev.textContent = hit.prev_cue_text;
    text.appendChild(prev);
  }

  const match = document.createElement("div");
  match.className = "vg-sub-line vg-sub-match";
  match.innerHTML = sanitizeSnippet(hit.cue_snippet_html);
  text.appendChild(match);

  if (hit.next_cue_text) {
    const next = document.createElement("div");
    next.className = "vg-sub-line vg-sub-context";
    next.textContent = hit.next_cue_text;
    text.appendChild(next);
  }

  const meta = document.createElement("div");
  meta.className = "vg-sub-meta small text-muted mt-1";
  meta.textContent = `${hit.video_filename} · ${formatTime(hit.start_pts_seconds)}`;
  text.appendChild(meta);

  row.appendChild(thumb);
  row.appendChild(text);

  if (hit.segment_id !== null) {
    const segId = hit.segment_id;
    row.addEventListener("dragstart", (e) => setSegmentDragData(e, segId));
  }

  return row;
}

/**
 * FTS5 snippet() returns safely-escaped text interleaved with the literal
 * markers we supplied (`<b>`, `</b>`, `…`). Allowlist just those tags; any
 * other angle-bracket content is neutralised back to escaped text.
 */
function sanitizeSnippet(html: string): string {
  // Escape everything, then un-escape only the exact allowed markers.
  const escaped = escapeHtml(html);
  return escaped.replace(/&lt;b&gt;/g, "<b>").replace(/&lt;\/b&gt;/g, "</b>");
}

function formatTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number): string => n.toString().padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}
