import { defineQueue } from "void";
import { containsEicar, sniffImage, stripExif } from "../lib/file-scan";
import {
  getUploadIdFromKey,
  MAX_UPLOAD_BYTES,
  QUARANTINE_BUCKET_NAME,
  type UploadStatus,
} from "../lib/upload";
import type { R2UploadEvent } from "../lib/upload-event";

export default defineQueue<R2UploadEvent>(async (batch, env) => {
  for (const message of batch.messages) {
    const event = message.body;
    const id = getUploadIdFromKey(event.object?.key);
    if (event.bucket !== QUARANTINE_BUCKET_NAME || event.action !== "PutObject" || !id) {
      message.ack();
      continue;
    }

    const row = await env.DB.prepare("SELECT key, status FROM uploads WHERE id = ?")
      .bind(id)
      .first<{ key: string; status: UploadStatus }>();
    const retryingScan = row?.status === "scanning" && message.attempts > 1;
    if (!row || row.key !== event.object.key || (row.status !== "uploading" && !retryingScan)) {
      message.ack(); // queue에서 메시지 제거
      continue;
    }
    if (!retryingScan) {
      const claim = await env.DB.prepare(
        "UPDATE uploads SET status = 'scanning' WHERE id = ? AND status = 'uploading'",
      )
        .bind(id)
        .run();
      if (claim.meta.changes !== 1) {
        message.ack(); // queue에서 메시지 제거
        continue;
      }
    }

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

      // 검사 완료 : 파일의 status가 'scanning' -> 'ready'로 변경됨
      await env.DB.prepare(
        "UPDATE uploads SET status = 'ready', mime = ?, reason = NULL WHERE id = ?",
      )
        .bind(mime, id)
        .run();
      await env.QUARANTINE.delete(row.key);
    } catch (error) {
      await env.DB.prepare("UPDATE uploads SET status = 'rejected', reason = ? WHERE id = ?")
        .bind(error instanceof Error ? error.message : "검사에 실패했어요.", id)
        .run();
      await env.QUARANTINE.delete(row.key);
    }
    message.ack();
  }
});
