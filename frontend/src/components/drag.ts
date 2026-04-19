/**
 * Shared HTML5 drag-and-drop helpers and MIME types.
 */

export const MIME_SEGMENT = "application/x-video-glue-segment";
export const MIME_CLIP = "application/x-video-glue-clip";

export function setSegmentDragData(e: DragEvent, segmentId: number): void {
  if (!e.dataTransfer) return;
  e.dataTransfer.effectAllowed = "copy";
  e.dataTransfer.setData(MIME_SEGMENT, String(segmentId));
}

export function readSegmentDragData(e: DragEvent): number | null {
  if (!e.dataTransfer) return null;
  const raw = e.dataTransfer.getData(MIME_SEGMENT);
  if (!raw) return null;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

export function setClipDragData(e: DragEvent, clipIndex: number): void {
  if (!e.dataTransfer) return;
  e.dataTransfer.effectAllowed = "move";
  e.dataTransfer.setData(MIME_CLIP, String(clipIndex));
}

export function readClipDragData(e: DragEvent): number | null {
  if (!e.dataTransfer) return null;
  const raw = e.dataTransfer.getData(MIME_CLIP);
  if (!raw) return null;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}
