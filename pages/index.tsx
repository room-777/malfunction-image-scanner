import { useCallback, useEffect, useRef, useState } from "react";
import { connectEventStream, type SseClient } from "void/sse/client";
import {
  IMAGE_MIME_TYPES,
  isUploadFinished,
  MAX_UPLOAD_HISTORY,
  UPLOAD_STATUS_WAIT_MS,
  type UploadTicket,
  type UploadView,
} from "../lib/upload";
import "./index.css";

type UploadStream = SseClient<{ status: UploadView; timeout: UploadView }>;

const statusLabel: Record<UploadView["status"], string> = {
  uploading: "업로드 대기",
  scanning: "검사 중",
  ready: "사용 가능",
  rejected: "거절됨",
};

export default function HomePage() {
  const [uploads, setUploads] = useState<UploadView[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [slowIds, setSlowIds] = useState<string[]>([]);
  const events = useRef<UploadStream | null>(null);

  const remember = useCallback((upload: UploadView) => {
    setUploads((current) => {
      const exists = current.some((item) => item.id === upload.id);
      return exists
        ? current.map((item) => (item.id === upload.id ? upload : item))
        : [upload, ...current].slice(0, MAX_UPLOAD_HISTORY);
    });
    if (isUploadFinished(upload.status)) {
      setSlowIds((current) => current.filter((id) => id !== upload.id));
    }
  }, []);

  const refresh = useCallback(async () => {
    const response = await fetch("/api/uploads");
    if (response.ok) {
      const { uploads: current } = (await response.json()) as {
        uploads: UploadView[];
      };
      setUploads(current);
      setSlowIds((ids) =>
        ids.filter((id) => {
          const row = current.find((item) => item.id === id);
          return row ? !isUploadFinished(row.status) : false;
        }),
      );
    }
  }, []);

  useEffect(() => {
    void refresh();
    return () => {
      events.current?.close();
    };
  }, [refresh]);

  async function upload(file?: File) {
    if (!file) return;
    setBusy(true);
    setError("");
    try {
      // 업로드 URL 발급
      const ticketResponse = await fetch("/api/uploads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: file.name,
          type: file.type,
          size: file.size,
        }),
      });
      if (!ticketResponse.ok)
        throw new Error("업로드 URL 발급에 실패했어요. JPG/PNG, 5MB 이하 파일만 올릴 수 있어요.");

      // 발급받은 업로드 URL로 클라이언트가 저장소에 직접 업로드
      const ticket = (await ticketResponse.json()) as UploadTicket;
      const putResponse = await fetch(ticket.url, {
        method: ticket.method,
        headers: ticket.headers,
        body: file,
      });
      if (!putResponse.ok) throw new Error("파일 전송에 실패했어요. 다시 시도해 주세요.");
      watchUpload(ticket.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "업로드 중 문제가 생겼어요.");
    } finally {
      setBusy(false);
    }
  }

  function watchUpload(id: string) {
    events.current?.close();
    setSlowIds((current) => current.filter((item) => item !== id));
    let stopped = false;
    const stream = connectEventStream<{ status: UploadView; timeout: UploadView }>(
      `/api/uploads?id=${encodeURIComponent(id)}`,
    );
    events.current = stream;
    const stop = () => {
      stopped = true;
      stream.close();
      if (events.current === stream) events.current = null;
    };
    stream.on("status", ({ data: upload }) => {
      remember(upload);
      if (isUploadFinished(upload.status)) stop();
    });
    stream.on("timeout", ({ data: upload }) => {
      // Close before any other work so EventSource cannot schedule a reconnect.
      stop();
      remember(upload);
      setSlowIds((current) => (current.includes(upload.id) ? current : [...current, upload.id]));
    });
    stream.onError(() => {
      if (stopped) stream.close();
    });
  }

  return (
    <main className="shell">
      <header>
        <p className="eyebrow">VOID · CLOUDFLARE R2</p>
        <h1>안전한 파일 업로드</h1>
        <p className="intro">파일은 격리 버킷에서 검사를 받고, 통과한 파일만 공개돼요.</p>
      </header>
      <label className={`dropzone ${busy ? "busy" : ""}`}>
        <input
          type="file"
          accept={IMAGE_MIME_TYPES.join(",")}
          disabled={busy}
          onChange={(event) => {
            void upload(event.currentTarget.files?.[0]);
            event.currentTarget.value = "";
          }}
        />
        <span className="upload-icon">↑</span>
        <strong>{busy ? "업로드 중…" : "JPG 또는 PNG 파일을 선택하세요"}</strong>
        <span>최대 5MB · 검사 전에는 공개되지 않아요</span>
      </label>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <section className="files">
        <div className="section-heading">
          <h2>업로드 기록</h2>
          <button type="button" onClick={() => void refresh()}>
            새로고침
          </button>
        </div>
        {uploads.length === 0 ? (
          <p className="empty">아직 파일이 없어요.</p>
        ) : (
          uploads.map((item) => (
            <article className="file" key={item.id}>
              <div className="file-info">
                <strong>{item.name}</strong>
                <span>
                  {item.mime ?? "형식 확인 전"}
                  {item.reason ? ` · ${item.reason}` : ""}
                </span>
                {slowIds.includes(item.id) && !isUploadFinished(item.status) && (
                  <span className="slow">
                    검사가 {UPLOAD_STATUS_WAIT_MS / 1000}초보다 오래 걸리고 있어요. 자동으로 다시
                    연결하지 않았어요.
                  </span>
                )}
              </div>
              <div className="file-side">
                {slowIds.includes(item.id) && !isUploadFinished(item.status) && (
                  <button
                    type="button"
                    className="check-again"
                    onClick={() => watchUpload(item.id)}
                  >
                    다시 확인
                  </button>
                )}
                {item.status === "ready" && item.url ? (
                  <a href={item.url} target="_blank" rel="noreferrer">
                    보기
                  </a>
                ) : (
                  <span className={`badge ${item.status}`}>{statusLabel[item.status]}</span>
                )}
              </div>
            </article>
          ))
        )}
      </section>
      <footer>
        검사기는 EICAR 시험 문자열과 이미지 머리글을 확인해요. 실제 악성코드 방어 제품은 연결하지
        않은 학습용 데모예요.
      </footer>
    </main>
  );
}
