import { DurableObject } from "cloudflare:workers";
import { defineDurableObject } from "void/durable";
import { eventStream } from "void/sse";
import {
  isUploadFinished,
  preferUploadView,
  shouldStoreStatus,
  toUploadView,
  UPLOAD_COLUMNS,
  uploadRecordFromRow,
  type UploadStatus,
  type UploadView,
} from "../lib/upload";

type Subscriber = {
  done: boolean;
  tail: Promise<void>;
  send: (view: UploadView) => Promise<void>;
  finish: () => Promise<void>;
};

/**
 * One Durable Object per upload id. It is the meeting point for SSE clients and
 * the queue consumer. Native class (not defineDurableState) so an open stream
 * does not serialize, and therefore block, the notify call.
 */
export class UploadStatusObject extends DurableObject<Cloudflare.Env> {
  #subscribers = new Set<Subscriber>();
  #latest: UploadView | null = null;

  async notify(view: UploadView): Promise<void> {
    if (!shouldStoreStatus(this.#latest?.status ?? null, view.status)) return;
    this.#latest = view;
    await Promise.all([...this.#subscribers].map((subscriber) => this.#deliver(subscriber, view)));
  }

  async fetch(request: Request): Promise<Response> {
    const id = new URL(request.url).searchParams.get("id");
    if (!id) return new Response(null, { status: 400 });

    const snapshot = await this.#readOnce(id);
    if (!snapshot) return new Response(null, { status: 404 });

    return eventStream(
      async (stream) => {
        const subscriber: Subscriber = {
          done: false,
          tail: Promise.resolve(),
          send: (view) => stream.send({ event: "status", id: view.id, data: view }),
          finish: async () => {
            if (subscriber.done) return;
            subscriber.done = true;
            this.#subscribers.delete(subscriber);
            await stream.close();
          },
        };
        this.#subscribers.add(subscriber);
        try {
          await this.#deliver(subscriber, preferUploadView(snapshot, this.#latest));
          if (!subscriber.done) await stream.closed;
        } finally {
          subscriber.done = true;
          this.#subscribers.delete(subscriber);
        }
      },
      { keepAlive: { intervalMs: 15_000 }, signal: request.signal },
    );
  }

  async #readOnce(id: string): Promise<UploadView | null> {
    const row = await this.env.DB.prepare(`SELECT ${UPLOAD_COLUMNS} FROM uploads WHERE id = ?`)
      .bind(id)
      .first<{
        id: string;
        name: string;
        status: UploadStatus;
        mime: string | null;
        reason: string | null;
        createdAt: number;
      }>();
    return row ? toUploadView(uploadRecordFromRow(row)) : null;
  }

  #deliver(subscriber: Subscriber, view: UploadView): Promise<void> {
    const finished = isUploadFinished(view.status);
    const run = subscriber.tail.then(async () => {
      if (subscriber.done) return;
      await subscriber.send(view);
      if (finished) await subscriber.finish();
    });
    subscriber.tail = run.then(
      () => undefined,
      async () => {
        await subscriber.finish().catch(() => undefined);
      },
    );
    return subscriber.tail;
  }
}

export const UploadStatus = defineDurableObject({
  name: "upload-status",
  class: UploadStatusObject,
});

export default UploadStatus;
