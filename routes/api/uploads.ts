import { AwsClient } from "aws4fetch";
import * as v from "valibot";
import { defineHandler } from "void";
import { queues } from "void/queues";
import { eventStream } from "void/sse";
import {
  createUploadKey,
  IMAGE_MIME_TYPES,
  type ImageMime,
  isUploadFinished,
  MAX_UPLOAD_BYTES,
  MAX_UPLOAD_HISTORY,
  QUARANTINE_BUCKET_NAME,
  toUploadView,
  type UploadRecord,
  type UploadStatus,
  type UploadTicket,
} from "../../lib/upload";
import type { R2UploadEvent } from "../../lib/upload-event";

const UPLOAD_COLUMNS = "id, name, status, mime, reason, created_at AS createdAt";

const requestSchema = v.object({
  name: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(120)),
  type: v.picklist(IMAGE_MIME_TYPES),
  size: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(MAX_UPLOAD_BYTES)),
});

export const GET = defineHandler(async (c) => {
  const id = c.req.query("id");
  if (id) {
    const upload = await c.env.DB.prepare(`SELECT ${UPLOAD_COLUMNS} FROM uploads WHERE id = ?`)
      .bind(id)
      .first<UploadRecord>();
    if (!upload) return c.notFound();

    return eventStream(
      async (stream) => {
        let lastStatus = "";
        while (!stream.signal.aborted) {
          const current = await c.env.DB.prepare(
            `SELECT ${UPLOAD_COLUMNS} FROM uploads WHERE id = ?`,
          )
            .bind(id)
            .first<UploadRecord>();
          if (!current) return;

          if (current.status !== lastStatus) {
            await stream.send({
              event: "status",
              id: current.id,
              data: toUploadView(current),
            });
            lastStatus = current.status;
          }
          if (isUploadFinished(current.status)) return;

          await new Promise((resolve) => setTimeout(resolve, 1_000));
        }
      },
      { keepAlive: { intervalMs: 15_000 } },
    );
  }

  const { results } = await c.env.DB.prepare(
    `SELECT ${UPLOAD_COLUMNS} FROM uploads ORDER BY created_at DESC LIMIT ${MAX_UPLOAD_HISTORY}`,
  ).all<UploadRecord>();
  return c.json({
    uploads: results.map(toUploadView),
  });
});

export const POST = defineHandler.withValidator({ body: requestSchema })(async (c, { body }) => {
  const env = c.env;
  const id = crypto.randomUUID();
  const upload = { id, key: createUploadKey(id) };
  const url = await createUploadUrl(env, upload, body.type);
  if (!url) return c.json({ error: "R2 서명 키를 설정해 주세요." }, 503);

  await env.DB.prepare(
    "INSERT INTO uploads (id, key, name, status, created_at) VALUES (?, ?, ?, 'uploading', ?)",
  )
    .bind(id, upload.key, body.name, Date.now())
    .run();
  const ticket: UploadTicket = {
    ...upload,
    url,
    method: "PUT",
    headers: { "Content-Type": body.type },
  };
  return c.json(ticket, 201);
});

async function createUploadUrl(
  env: Pick<
    VoidGeneratedEnvBindings,
    "R2_ACCOUNT_ID" | "R2_ACCESS_KEY_ID" | "R2_SECRET_ACCESS_KEY"
  >,
  upload: Pick<UploadTicket, "id" | "key">,
  type: ImageMime,
): Promise<string | null> {
  if (import.meta.env.DEV) return `/api/uploads?uploadId=${upload.id}`;
  if (!env.R2_ACCOUNT_ID || !env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY) return null;

  const client = new AwsClient({
    service: "s3",
    region: "auto",
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
  });
  const request = new Request(
    `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${QUARANTINE_BUCKET_NAME}/${upload.key}?X-Amz-Expires=300`,
    { method: "PUT", headers: { "Content-Type": type } },
  );
  return (
    await client.sign(request, { aws: { signQuery: true, allHeaders: true } })
  ).url.toString();
}

export const PUT = defineHandler(async (c) => {
  if (!import.meta.env.DEV) return c.notFound();

  const id = c.req.query("uploadId");
  if (!id) return c.json({ error: "업로드 정보를 찾을 수 없어요." }, 400);

  const env = c.env;
  const row = await env.DB.prepare("SELECT key, status FROM uploads WHERE id = ?")
    .bind(id)
    .first<{ key: string; status: UploadStatus }>();
  if (!row || row.status !== "uploading") return c.notFound();

  const body = c.req.raw.body;
  if (!body) return c.json({ error: "파일이 비어 있어요." }, 400);
  const declaredSize = Number(c.req.header("Content-Length"));
  if (Number.isFinite(declaredSize) && declaredSize > MAX_UPLOAD_BYTES) {
    return c.json({ error: "파일은 5MB 이하여야 해요." }, 413);
  }
  const bytes = await readLimitedBody(body, MAX_UPLOAD_BYTES);
  if (!bytes) return c.json({ error: "파일은 5MB 이하여야 해요." }, 413);

  // 임시 버킷(저장소)에 파일 업로드
  await env.QUARANTINE.put(row.key, bytes, {
    httpMetadata: { contentType: c.req.header("Content-Type") ?? "application/octet-stream" },
  });
  const event: R2UploadEvent = {
    action: "PutObject",
    bucket: QUARANTINE_BUCKET_NAME,
    object: { key: row.key, size: bytes.byteLength },
  };

  // 검사기에 저장 알림
  await queues["scan-uploads"].send(event);
  return c.body(null, 202);
});

async function readLimitedBody(
  body: ReadableStream<Uint8Array>,
  limit: number,
): Promise<Uint8Array | null> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }

  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}
