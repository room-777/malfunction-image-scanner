import { DurableObject } from "cloudflare:workers";
import { defineDurableObject } from "void/durable";
import { eventStream } from "void/sse";
import {
  isUploadFinished,
  preferUploadView,
  shouldStoreStatus,
  toUploadView,
  UPLOAD_COLUMNS,
  UPLOAD_STATUS_WAIT_MS,
  uploadRecordFromRow,
  type UploadStatus,
  type UploadView,
} from "../lib/upload";

type StatusEvent = "status" | "timeout";

type Subscriber = {
  done: boolean;
  tail: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
  send: (event: StatusEvent, view: UploadView) => Promise<void>;
  finish: () => Promise<void>;
  cancelTimer: () => void;
};

/**
 * One Durable Object per upload id. It is the meeting point for SSE clients and
 * the queue consumer. Native class (not defineDurableState) so an open stream
 * does not serialize, and therefore block, the notify call.
 * Each connection waits at most UPLOAD_STATUS_WAIT_MS. SSE cannot hibernate,
 * so the timer and subscriber are cleared on every close path.
 */
export class UploadStatusObject extends DurableObject<Cloudflare.Env> {
  #subscribers = new Set<Subscriber>();
  #latest: UploadView | null = null;

  async notify(view: UploadView): Promise<void> {
    if (!shouldStoreStatus(this.#latest?.status ?? null, view.status)) return;
    this.#latest = view;
    await Promise.all(
      [...this.#subscribers].map((subscriber) => this.#deliverStatus(subscriber, view)),
    );
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
          send: (event, view) =>
            stream.send({
              event,
              id: view.id,
              data: view,
              // If the page misses its close() call, the browser waits a day instead of
              // reconnecting every few seconds and pinning this object again.
              ...(event === "timeout" ? { retry: 86_400_000 } : {}),
            }),
          cancelTimer() {
            if (subscriber.timer === undefined) return;
            clearTimeout(subscriber.timer);
            subscriber.timer = undefined;
          },
          finish: async () => {
            if (subscriber.done) return;
            subscriber.done = true;
            subscriber.cancelTimer();
            this.#subscribers.delete(subscriber);
            await stream.close();
          },
        };
        this.#subscribers.add(subscriber);
        try {
          await this.#deliverStatus(subscriber, preferUploadView(snapshot, this.#latest));
          if (subscriber.done) return;
          subscriber.timer = setTimeout(() => {
            void this.#deliverTimeout(subscriber, preferUploadView(snapshot, this.#latest)).catch(
              () => {
                subscriber.cancelTimer();
                subscriber.done = true;
                this.#subscribers.delete(subscriber);
              },
            );
          }, UPLOAD_STATUS_WAIT_MS);
          await stream.closed;
        } finally {
          subscriber.cancelTimer();
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

  #deliverStatus(subscriber: Subscriber, view: UploadView): Promise<void> {
    return this.#enqueue(subscriber, async () => {
      await subscriber.send("status", view);
      if (isUploadFinished(view.status)) await subscriber.finish();
    });
  }

  #deliverTimeout(subscriber: Subscriber, view: UploadView): Promise<void> {
    return this.#enqueue(subscriber, async () => {
      await subscriber.send("timeout", view);
      await subscriber.finish();
    });
  }

  #enqueue(subscriber: Subscriber, task: () => Promise<void>): Promise<void> {
    const run = subscriber.tail.then(async () => {
      if (subscriber.done) return;
      await task();
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
