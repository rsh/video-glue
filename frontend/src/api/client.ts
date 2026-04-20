/**
 * Typed HTTP client for the video-glue backend.
 */

import type {
  ApiError,
  AuthResponse,
  ClipInput,
  Composition,
  ExportFormat,
  ExportJob,
  ExportScaleDivisor,
  LoginRequest,
  RegisterRequest,
  ScannerInfo,
  Segment,
  SubtitleHit,
  User,
  Video,
} from "./types";

export class ApiClient {
  private baseUrl: string;
  private token: string | null = null;

  constructor(baseUrl: string = "") {
    this.baseUrl = baseUrl;
    this.loadToken();
  }

  private loadToken(): void {
    if (typeof window !== "undefined") {
      const stored = localStorage.getItem("auth_token");
      if (stored !== null) this.token = stored;
    }
  }

  private saveToken(token: string): void {
    this.token = token;
    if (typeof window !== "undefined") localStorage.setItem("auth_token", token);
  }

  public clearToken(): void {
    this.token = null;
    if (typeof window !== "undefined") localStorage.removeItem("auth_token");
  }

  public getToken(): string | null {
    return this.token;
  }

  public isAuthenticated(): boolean {
    return this.token !== null;
  }

  /** Append ?token=… for resource URLs that <video>/<img> tags can't set headers on. */
  public urlWithToken(path: string): string {
    if (this.token === null) return `${this.baseUrl}${path}`;
    const sep = path.includes("?") ? "&" : "?";
    return `${this.baseUrl}${path}${sep}token=${encodeURIComponent(this.token)}`;
  }

  private async request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (options.headers) Object.assign(headers, options.headers);
    if (this.token !== null) headers["Authorization"] = `Bearer ${this.token}`;

    const response = await fetch(`${this.baseUrl}${endpoint}`, { ...options, headers });
    if (!response.ok) {
      let error: ApiError = { error: "Request failed" };
      try {
        error = (await response.json()) as ApiError;
      } catch {
        /* ignore */
      }
      const msg =
        typeof error.error === "string" ? error.error : JSON.stringify(error.error);
      throw new Error(msg);
    }
    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
  }

  // ---- auth ----

  public async register(data: RegisterRequest): Promise<AuthResponse> {
    const response = await this.request<AuthResponse>("/api/auth/register", {
      method: "POST",
      body: JSON.stringify(data),
    });
    this.saveToken(response.token);
    return response;
  }

  public async login(data: LoginRequest): Promise<AuthResponse> {
    const response = await this.request<AuthResponse>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify(data),
    });
    this.saveToken(response.token);
    return response;
  }

  public logout(): void {
    this.clearToken();
  }

  public async getCurrentUser(): Promise<User> {
    const response = await this.request<{ user: User }>("/api/auth/me");
    return response.user;
  }

  // ---- library / videos / segments ----

  public async rescanLibrary(): Promise<{
    added: number;
    removed: number;
    total: number;
    library_dir: string;
  }> {
    return this.request<{
      added: number;
      removed: number;
      total: number;
      library_dir: string;
    }>("/api/library/rescan", { method: "POST" });
  }

  public async getVideos(): Promise<Video[]> {
    const response = await this.request<{ videos: Video[] }>("/api/videos");
    return response.videos;
  }

  public async getVideoSegments(videoId: number): Promise<Segment[]> {
    const response = await this.request<{ segments: Segment[] }>(
      `/api/videos/${videoId}/segments`
    );
    return response.segments;
  }

  public async rescanVideo(videoId: number): Promise<Video> {
    const response = await this.request<{ video: Video }>(
      `/api/videos/${videoId}/scan`,
      { method: "POST" }
    );
    return response.video;
  }

  public async getScanners(): Promise<ScannerInfo[]> {
    const response = await this.request<{ scanners: ScannerInfo[] }>("/api/scanners");
    return response.scanners;
  }

  public videoStreamUrl(videoId: number): string {
    return this.urlWithToken(`/api/videos/${videoId}/stream`);
  }

  public thumbnailUrl(relativePath: string): string {
    return this.urlWithToken(`/api/thumbnails/${relativePath}`);
  }

  // ---- compositions ----

  public async getCompositions(): Promise<Composition[]> {
    const response = await this.request<{ compositions: Composition[] }>(
      "/api/compositions"
    );
    return response.compositions;
  }

  public async createComposition(
    data: { name?: string; notes?: string } = {}
  ): Promise<Composition> {
    const response = await this.request<{ composition: Composition }>(
      "/api/compositions",
      { method: "POST", body: JSON.stringify(data) }
    );
    return response.composition;
  }

  public async getComposition(id: number): Promise<Composition> {
    const response = await this.request<{ composition: Composition }>(
      `/api/compositions/${id}`
    );
    return response.composition;
  }

  public async updateComposition(
    id: number,
    data: { name?: string; notes?: string }
  ): Promise<Composition> {
    const response = await this.request<{ composition: Composition }>(
      `/api/compositions/${id}`,
      { method: "PATCH", body: JSON.stringify(data) }
    );
    return response.composition;
  }

  public async deleteComposition(id: number): Promise<void> {
    await this.request<{ message: string }>(`/api/compositions/${id}`, {
      method: "DELETE",
    });
  }

  public async replaceClips(
    compositionId: number,
    clips: ClipInput[]
  ): Promise<Composition> {
    const response = await this.request<{ composition: Composition }>(
      `/api/compositions/${compositionId}/clips`,
      { method: "PUT", body: JSON.stringify({ clips }) }
    );
    return response.composition;
  }

  // ---- exports ----

  public async startExport(
    compositionId: number,
    format: ExportFormat,
    scaleDivisor: ExportScaleDivisor = 1,
    includeAudio: boolean = false
  ): Promise<ExportJob> {
    const response = await this.request<{ export: ExportJob }>(
      `/api/compositions/${compositionId}/export`,
      {
        method: "POST",
        body: JSON.stringify({
          format,
          scale_divisor: scaleDivisor,
          include_audio: includeAudio,
        }),
      }
    );
    return response.export;
  }

  public async getExport(id: number): Promise<ExportJob> {
    const response = await this.request<{ export: ExportJob }>(`/api/exports/${id}`);
    return response.export;
  }

  public exportDownloadUrl(id: number): string {
    return this.urlWithToken(`/api/exports/${id}/download`);
  }

  // ---- subtitles ----

  public async searchSubtitles(q: string, limit: number = 200): Promise<SubtitleHit[]> {
    const params = new URLSearchParams({ q, limit: String(limit) });
    const response = await this.request<{ results: SubtitleHit[] }>(
      `/api/subtitles/search?${params.toString()}`
    );
    return response.results;
  }
}

export const apiClient = new ApiClient();
