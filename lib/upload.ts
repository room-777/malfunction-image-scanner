export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
export const MAX_UPLOAD_HISTORY = 20;
export const QUARANTINE_BUCKET_NAME = "upload-quarantine-demo";
export const UPLOAD_KEY_PREFIX = "uploads";
export const UPLOAD_COLUMNS = "id, name, status, mime, reason, created_at AS createdAt";

export const IMAGE_MIME_TYPES = ["image/jpeg", "image/png"] as const;
export const UPLOAD_STATUSES = ["uploading", "scanning", "ready", "rejected"] as const;

export type ImageMime = (typeof IMAGE_MIME_TYPES)[number];
export type UploadStatus = (typeof UPLOAD_STATUSES)[number];

export type UploadRecord = {
  id: string;
  name: string;
  status: UploadStatus;
  mime: ImageMime | null;
  reason: string | null;
  createdAt: number;
};

export type UploadView = UploadRecord & { url: string | null };

export type UploadTicket = {
  id: string;
  key: string;
  url: string;
  method: "PUT";
  headers: Record<string, string>;
};

export function createUploadKey(id: string): string {
  return `${UPLOAD_KEY_PREFIX}/${id}`;
}

export function getUploadIdFromKey(key?: string): string | null {
  if (!key?.startsWith(`${UPLOAD_KEY_PREFIX}/`)) return null;

  const id = key.slice(UPLOAD_KEY_PREFIX.length + 1);
  return /^[0-9a-f-]{36}$/.test(id) ? id : null;
}

export function isUploadFinished(status: UploadStatus): boolean {
  return status === "ready" || status === "rejected";
}

const STATUS_RANK: Record<UploadStatus, number> = {
  uploading: 0,
  scanning: 1,
  ready: 2,
  rejected: 2,
};

export function uploadRecordFromRow(row: {
  id: string;
  name: string;
  status: UploadStatus;
  mime: string | null;
  reason: string | null;
  createdAt: number;
}): UploadRecord {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    mime: row.mime === "image/jpeg" || row.mime === "image/png" ? row.mime : null,
    reason: row.reason,
    createdAt: row.createdAt,
  };
}

/** Keep a newer in-memory notification when it raced ahead of the single D1 read. */
export function preferUploadView(snapshot: UploadView, latest: UploadView | null): UploadView {
  if (!latest || latest.id !== snapshot.id) return snapshot;
  if (isUploadFinished(latest.status)) return latest;
  if (isUploadFinished(snapshot.status)) return snapshot;
  return STATUS_RANK[latest.status] >= STATUS_RANK[snapshot.status] ? latest : snapshot;
}

/** A finished status sticks. A later scanning notice must not overwrite it. */
export function shouldStoreStatus(current: UploadStatus | null, incoming: UploadStatus): boolean {
  return !(current !== null && isUploadFinished(current) && !isUploadFinished(incoming));
}

export function toUploadView(upload: UploadRecord): UploadView {
  const { id, name, status, mime, reason, createdAt } = upload;
  return {
    id,
    name,
    status,
    mime,
    reason,
    createdAt,
    url: status === "ready" ? `/api/public/${id}` : null,
  };
}
