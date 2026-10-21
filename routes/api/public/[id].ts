import { defineHandler } from "void";
import type { UploadStatus } from "../../../lib/upload";

// 업로드한 이미지 가져오는 핸들러
export const GET = defineHandler(async (c) => {
  const id = c.req.param("id");
  const row = await c.env.DB.prepare("SELECT key, mime, status FROM uploads WHERE id = ?")
    .bind(id)
    .first<{ key: string; mime: string | null; status: UploadStatus }>();
  if (!row || row.status !== "ready" || !row.mime) return c.notFound();
  const object = await c.env.PUBLIC_UPLOADS.get(row.key);
  if (!object) return c.notFound();
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("Content-Type", row.mime);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  return new Response(object.body, { headers });
});
