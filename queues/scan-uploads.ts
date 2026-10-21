import { defineQueue } from "void";
import { UploadStatus } from "../durable-objects/upload-status";
import { containsEicar, sniffImage, stripExif } from "../lib/file-scan";
import {
  getUploadIdFromKey,
  isUploadFinished,
  MAX_UPLOAD_BYTES,
  QUARANTINE_BUCKET_NAME,
  toUploadView,
  type ImageMime,
  type UploadRecord,
  type UploadStatus as UploadState,
} from "../lib/upload";
import type { R2UploadEvent } from "../lib/upload-event";

type ScanRow = {
  key: string;
  name: string;
  status: UploadState;
  mime: string | null;
  reason: string | null;
  createdAt: number;
};

export default defineQueue<R2UploadEvent>(async (batch, env) => {
  for (const message of batch.messages) {
    const event = message.body;
    const id = getUploadIdFromKey(event.object?.key);
    if (event.bucket !== QUARANTINE_BUCKET_NAME || event.action !== "PutObject" || !id) {
      message.ack();
      continue;
    }

    const row = await env.DB.prepare(
      "SELECT key, name, status, mime, reason, created_at AS createdAt FROM uploads WHERE id = ?",
    )
      .bind(id)
      .first<ScanRow>();
    if (!row || row.key !== event.object.key) {
      message.ack();
      continue;
    }

    // A previous attempt may have saved the result and then crashed before notify or ack.
    if (isUploadFinished(row.status)) {
      await notifyUpload(id, recordFrom(id, row, row.status, imageMime(row.mime), row.reason));
      message.ack();
      continue;
    }

    const retryingScan = row.status === "scanning" && message.attempts > 1;
    if (row.status !== "uploading" && !retryingScan) {
      message.ack();
      continue;
    }
    if (!retryingScan) {
      const claim = await env.DB.prepare(
        "UPDATE uploads SET status = 'scanning' WHERE id = ? AND status = 'uploading'",
      )
        .bind(id)
        .run();
      if (claim.meta.changes !== 1) {
        message.ack();
        continue;
      }
    }

    await notifyUpload(id, recordFrom(id, row, "scanning", null, null));

    let outcome: UploadRecord;
    try {
      const source = await env.QUARANTINE.get(row.key);
      if (!source || source.size > MAX_UPLOAD_BYTES)
        throw new Error("파일이 없거나 5MB 제한을 넘었어요.");
      const bytes = new Uint8Array(await source.arrayBuffer());
      const mime = sniffImage(bytes);
      if (!mime) throw new Error("실제 파일 형식이 JPG 또는 PNG가 아니에요.");
      if (containsEicar(bytes)) throw new Error("EICAR 검사 파일이 발견됐어요.");

      const cleaned = stripExif(bytes, mime);
      await env.PUBLIC_UPLOADS.put(row.key, cleaned, {
        httpMetadata: { contentType: mime },
        customMetadata: { scanned: "demo" },
      });

      await env.DB.prepare(
        "UPDATE uploads SET status = 'ready', mime = ?, reason = NULL WHERE id = ?",
      )
        .bind(mime, id)
        .run();
      await env.QUARANTINE.delete(row.key);
      outcome = recordFrom(id, row, "ready", mime, null);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "검사에 실패했어요.";
      await env.DB.prepare("UPDATE uploads SET status = 'rejected', reason = ? WHERE id = ?")
        .bind(reason, id)
        .run();
      await env.QUARANTINE.delete(row.key);
      outcome = recordFrom(id, row, "rejected", null, reason);
    }

    await notifyUpload(id, outcome);
    message.ack();
  }
});

function recordFrom(
  id: string,
  row: ScanRow,
  status: UploadState,
  mime: ImageMime | null,
  reason: string | null,
): UploadRecord {
  return { id, name: row.name, status, mime, reason, createdAt: row.createdAt };
}

function imageMime(mime: string | null): ImageMime | null {
  return mime === "image/jpeg" || mime === "image/png" ? mime : null;
}

async function notifyUpload(id: string, record: UploadRecord): Promise<void> {
  await UploadStatus.get(id).notify(toUploadView(record));
}
