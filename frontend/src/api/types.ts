/**
 * API types shared with the backend.
 */

export interface User {
  id: number;
  username: string;
  email?: string;
  created_at: string;
}

export type VideoStatus =
  | "discovered"
  | "probing"
  | "probed"
  | "scanning"
  | "thumbnailing"
  | "subtitles_importing"
  | "ready"
  | "error";

export interface Video {
  id: number;
  path: string;
  filename: string;
  size_bytes: number;
  date_modified: string;
  duration_seconds: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  total_frames: number | null;
  container: string | null;
  codec: string | null;
  status: VideoStatus;
  scan_progress_percent: number;
  scan_started_at: string | null;
  preview_proxy_status: PreviewProxyStatus;
  preview_proxy_started_at: string | null;
  preview_proxy_error_message: string | null;
  error_message: string | null;
  discovered_at: string;
  updated_at: string;
  segment_count?: number;
}

export type PreviewProxyStatus = "none" | "building" | "ready" | "error";

export interface Segment {
  id: number;
  video_id: number;
  scanner_name: string;
  start_frame: number;
  end_frame: number;
  frame_count: number;
  start_pts_seconds: number;
  end_pts_seconds: number;
  duration_seconds: number;
  thumbnail_path: string | null;
  meta: Record<string, unknown>;
}

export interface ScannerInfo {
  name: string;
  version: string;
  default_config: Record<string, unknown>;
}

export interface Clip {
  id: number;
  composition_id: number;
  segment_id: number;
  position: number;
  trim_start_frame: number;
  trim_end_frame: number;
  segment: Segment | null;
}

export interface Composition {
  id: number;
  name: string;
  owner_id: number;
  notes: string | null;
  created_at: string;
  updated_at: string;
  clips?: Clip[];
}

export interface ClipInput {
  segment_id: number;
  trim_start_frame: number;
  trim_end_frame: number;
}

export type ExportFormat = "mp4" | "webm" | "gif";
export type ExportStatus = "queued" | "running" | "done" | "error";

export interface ExportJob {
  id: number;
  composition_id: number;
  format: ExportFormat;
  status: ExportStatus;
  progress_percent: number;
  error_message: string | null;
  created_at: string;
  finished_at: string | null;
  download_available: boolean;
}

export interface RegisterRequest {
  email: string;
  username: string;
  password: string;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface AuthResponse {
  token: string;
  user: User;
}

export interface SubtitleHit {
  cue_id: number;
  video_id: number;
  video_filename: string;
  segment_id: number | null;
  thumbnail_path: string | null;
  start_pts_seconds: number;
  end_pts_seconds: number;
  prev_cue_text: string | null;
  cue_snippet_html: string;
  next_cue_text: string | null;
}

export interface ApiError {
  error: string;
  details?: unknown;
}
