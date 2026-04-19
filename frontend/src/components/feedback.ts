/**
 * Toast-style error/success notifications + small shared helpers.
 */

export function escapeHtml(text: string): string {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function toast(message: string, variant: "danger" | "success"): void {
  const div = document.createElement("div");
  div.className = `alert alert-${variant} alert-dismissible fade show vg-toast`;
  div.innerHTML = `
    ${escapeHtml(message)}
    <button type="button" class="btn-close" data-bs-dismiss="alert"></button>
  `;
  const container = document.getElementById("app");
  if (container) {
    container.insertBefore(div, container.firstChild);
    setTimeout(() => div.remove(), variant === "danger" ? 6000 : 3000);
  }
}

export function showError(message: string): void {
  toast(message, "danger");
}

export function showSuccess(message: string): void {
  toast(message, "success");
}

export function formatDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return "—";
  const s = Math.max(0, seconds);
  const mm = Math.floor(s / 60);
  const ss = Math.floor(s % 60);
  const ms = Math.floor((s - Math.floor(s)) * 1000);
  if (mm > 0) return `${mm}:${ss.toString().padStart(2, "0")}`;
  return `${ss}.${ms.toString().padStart(3, "0")}s`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}
