import type {
  AttemptQuestionPublic,
  InkStroke,
  QuestionProcessStatus,
  StudentAnswer,
} from "@tutor/contract";
import {
  NOTE_PAPER_HEIGHT_DEFAULT,
  questionProcessStatusSchema,
} from "@tutor/contract";
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { peekAnnotationRecord } from "@/features/annotation/annotation-store";
import { currentAnnotationSession } from "@/features/annotation/annotation-sync";
import { peekNoteRecord } from "@/features/notes/note-store";
import { currentNoteSession } from "@/features/notes/note-sync";
import { useNoteSessionRef } from "@/features/notes/use-note-head";
import { questionProcessStatusApi, uploadQuestionProcessApi } from "@/lib/api";
import { idbKVBackend } from "@/lib/kv-backend";
import { QuestionProcessRecorder } from "./recorder";

export const QuestionProcessContext =
  createContext<QuestionProcessRecorder | null>(null);
export const useQuestionProcessContext = () =>
  useContext(QuestionProcessContext);
const MATERIAL_INACTIVE_REASON = "材料正在恢复，暂不可编辑";
const store = idbKVBackend("tutor-question-process", "process");

async function removeProcessQueue(prefix: string) {
  const rows = await store.getAll(`${JSON.stringify([prefix]).slice(0, -1)},`);
  await Promise.all(rows.map(([key]) => store.del(key)));
}

export function processStrokes(strokes: readonly InkStroke[]) {
  return strokes.map((stroke, i) => ({
    ...stroke,
    id: stroke.id ?? `legacy-${i}`,
  }));
}

export function readProcessSurfaces(attemptId: string, questionId: string) {
  const noteSession = currentNoteSession();
  const annotationSession = currentAnnotationSession();
  const scope = { attemptId, questionId, phase: "scratch" as const };
  const note = noteSession
    ? peekNoteRecord(noteSession, scope)?.doc
    : undefined;
  const annotation = annotationSession
    ? peekAnnotationRecord(annotationSession, scope)
    : undefined;
  const doc = annotation?.doc;
  const baseId = annotation?.localBase
    ? annotation.localBase.boundBaseId
    : annotation?.base?.baseId;
  return {
    ...(note
      ? {
          scratch: {
            width: 1000,
            height: note.paperHeightLogical ?? NOTE_PAPER_HEIGHT_DEFAULT,
            background: note.background,
            strokes: processStrokes(note.ink.strokes),
          },
        }
      : {}),
    ...(doc
      ? {
          annotation: {
            width: doc.baseWidth,
            height: doc.baseHeight,
            strokes: processStrokes(doc.strokes),
            ...(baseId ? { baseId } : {}),
            ...(annotation?.localBase ? { png: annotation.localBase.png } : {}),
          },
        }
      : {}),
  };
}

interface Inputs {
  attemptId: string;
  enabled: boolean;
  ready: boolean;
  questions: readonly AttemptQuestionPublic[];
  answers: Record<string, StudentAnswer> | null;
}

export function useQuestionProcess(inputs: Inputs) {
  const { attemptId, enabled, ready } = inputs;
  const scope = useNoteSessionRef();
  const prefix = scope
    ? JSON.stringify([scope.origin, scope.studentId, attemptId])
    : null;
  const [state, setState] = useState<{
    prefix: string;
    data: QuestionProcessStatus;
  } | null>(null);
  const [cacheFailed, setCacheFailed] = useState(false);
  const [operationFailed, setOperationFailed] = useState(false);
  const [working, setWorking] = useState(false);
  const [active, setActive] = useState<QuestionProcessRecorder | null>(null);
  const deleting = useRef(false);
  const changeEpoch = useRef(0);
  const latest = useRef(inputs);
  latest.current = inputs;
  const status = enabled && state?.prefix === prefix ? state?.data : undefined;
  const recordingId =
    status?.state === "active" ? status.recordingId : undefined;
  const expiresAt = status?.state === "active" ? status.expiresAt : undefined;
  const recorder =
    active?.options.prefix === prefix &&
    active?.options.recordingId === recordingId
      ? active
      : null;

  useEffect(() => {
    if (!enabled || !prefix || !scope) return;
    const controller = new AbortController();
    const loadStatus = async () => {
      const epoch = changeEpoch.current;
      const isCurrent = () =>
        !controller.signal.aborted &&
        currentNoteSession() === scope &&
        epoch === changeEpoch.current;
      try {
        const raw = await questionProcessStatusApi(
          attemptId,
          "GET",
          controller.signal,
        );
        if (!isCurrent()) return;
        const data = questionProcessStatusSchema.parse(raw);
        setState({ prefix, data });
        if (data.state === "active") await store.set(prefix, data);
        else {
          await store.del(prefix);
          if (data.state === "closed") await removeProcessQueue(prefix);
        }
      } catch {
        if (!isCurrent()) return;
        if (navigator.onLine) {
          setCacheFailed(true);
          return;
        }
        try {
          const cached = questionProcessStatusSchema.safeParse(
            await store.get(prefix),
          );
          if (
            isCurrent() &&
            cached.success &&
            cached.data.state === "active" &&
            Date.parse(cached.data.expiresAt) > Date.now()
          ) {
            setState({ prefix, data: cached.data });
          }
        } catch {
          if (isCurrent()) setCacheFailed(true);
        }
      }
    };
    const online = () => {
      void loadStatus();
    };
    online();
    window.addEventListener("online", online);
    return () => {
      controller.abort();
      window.removeEventListener("online", online);
    };
  }, [attemptId, enabled, prefix, scope]);

  useEffect(() => {
    if (!prefix || !scope || !recordingId || !expiresAt) return;
    const instance = new QuestionProcessRecorder({
      attemptId,
      recordingId,
      expiresAt,
      prefix,
      store,
      revision: (id) =>
        latest.current.questions.find((question) => question.id === id)
          ?.questionRevisionId,
      snapshot: (id) => ({
        answer: latest.current.answers?.[id] ?? null,
        hints: [],
        layers: readProcessSurfaces(attemptId, id),
      }),
      current: () =>
        currentNoteSession() === scope &&
        !deleting.current &&
        latest.current.ready,
      inactiveReason: () =>
        latest.current.ready ? undefined : MATERIAL_INACTIVE_REASON,
      upload: (batch, signal) =>
        uploadQuestionProcessApi(attemptId, batch, signal).then(
          (data) => data.acceptedThrough,
        ),
    });
    setActive(instance);
    instance.scheduleUpload(0);
    const online = () => {
      instance.boundary("online");
      instance.scheduleUpload(0);
    };
    const offline = () => instance.boundary("offline");
    const visibility = () => {
      instance.boundary(document.hidden ? "hidden" : "visible");
      if (!document.hidden) instance.scheduleUpload(0);
    };
    const pagehide = () => instance.boundary("closed");
    window.addEventListener("online", online);
    window.addEventListener("offline", offline);
    window.addEventListener("pagehide", pagehide);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      void instance.close();
      window.removeEventListener("online", online);
      window.removeEventListener("offline", offline);
      window.removeEventListener("pagehide", pagehide);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [attemptId, expiresAt, prefix, recordingId, scope]);

  useEffect(() => {
    if (!ready && recorder && status?.state === "active" && status.canCapture)
      recorder.invalidate(MATERIAL_INACTIVE_REASON);
    else if (ready) recorder?.resume(MATERIAL_INACTIVE_REASON);
  }, [ready, recorder, status]);

  async function change(method: "POST" | "DELETE") {
    if (!scope || !prefix || currentNoteSession() !== scope) return;
    changeEpoch.current += 1;
    setWorking(true);
    setOperationFailed(false);
    if (method === "DELETE") deleting.current = true;
    try {
      const data = await questionProcessStatusApi(attemptId, method);
      const next: QuestionProcessStatus = data ?? { state: "closed" };
      if (currentNoteSession() === scope) setState({ prefix, data: next });
      if (method === "DELETE") {
        await recorder?.discard();
        await store.del(prefix);
        await removeProcessQueue(prefix);
      } else if (next.state === "active") {
        await store.set(prefix, next);
      }
    } catch {
      if (currentNoteSession() === scope) setOperationFailed(true);
    } finally {
      deleting.current = false;
      setWorking(false);
    }
  }

  return {
    recorder: status?.state === "active" && status.canCapture ? recorder : null,
    inactiveReason:
      status?.state === "active" && status.canCapture
        ? !ready
          ? MATERIAL_INACTIVE_REASON
          : !recorder
            ? "录制器尚未就绪"
            : undefined
        : undefined,
    status,
    storeRecorder: recorder,
    cacheFailed,
    working,
    operationFailed,
    change,
    retry: () => recorder?.scheduleUpload(0),
  };
}

const initialSync = () => "synced" as const;
const noopSubscribe = () => () => {};
const emptyReason = () => "";
function useProcessSync(process: ReturnType<typeof useQuestionProcess>) {
  const sync = useSyncExternalStore(
    process.storeRecorder?.subscribe ?? noopSubscribe,
    process.storeRecorder?.getStatus ?? initialSync,
  );
  const reason = useSyncExternalStore(
    process.storeRecorder?.subscribe ?? noopSubscribe,
    process.storeRecorder?.getInactiveReason ?? emptyReason,
  );
  return { sync, reason: process.inactiveReason ?? reason };
}

export function QuestionProcessSyncNotice({
  process,
}: {
  process: ReturnType<typeof useQuestionProcess>;
}) {
  const { sync, reason } = useProcessSync(process);
  if (process.status?.state !== "active") return null;
  if (reason || sync === "inactive")
    return (
      <p role="status" className="rounded border p-2 text-sm">
        当前操作未被记录（{reason || "录制器不可用"}）
      </p>
    );
  if (sync !== "failed") return null;
  return (
    <p role="status" className="rounded border p-2 text-sm">
      部分做题过程可能缺失或尚未同步。{" "}
      <button type="button" className="underline" onClick={process.retry}>
        重试过程同步
      </button>
    </p>
  );
}

export function QuestionProcessControls({
  process,
}: {
  process: ReturnType<typeof useQuestionProcess>;
}) {
  const [remove, setRemove] = useState(false);
  const { sync, reason } = useProcessSync(process);
  if (!process.status || process.status.state === "unavailable") return null;
  return (
    <section
      aria-label="做题过程记录"
      className="space-y-2 rounded-md border p-3 text-sm"
    >
      {process.status.state === "available" && (
        <>
          <p>
            开启后，老师可以回放本次练习的圈画、草稿、作答和提示。擦掉的笔迹仍可能出现在回放中。过程记录保留
            30 天。
          </p>
          <button
            type="button"
            className="underline"
            disabled={process.working}
            onClick={() => void process.change("POST")}
          >
            开启过程记录
          </button>
        </>
      )}
      {process.status.state === "active" && (
        <>
          <p role="status">
            {reason || sync === "inactive"
              ? `当前操作未被记录（${reason || "录制器不可用"}）`
              : sync === "saving"
                ? "正在保存过程"
                : sync === "pending"
                  ? "过程待同步"
                  : sync === "failed"
                    ? "部分过程可能缺失或尚未同步"
                    : "过程已同步"}
          </p>
          {sync === "failed" && (
            <button
              type="button"
              className="mr-3 underline"
              onClick={process.retry}
            >
              重试同步
            </button>
          )}
          {remove ? (
            <>
              <p>删除本次练习的过程回放。作答和原稿按原规则保存。</p>
              <button
                type="button"
                className="mr-3 underline"
                disabled={process.working}
                onClick={() => void process.change("DELETE")}
              >
                确认删除过程记录
              </button>
              <button
                type="button"
                className="underline"
                disabled={process.working}
                onClick={() => setRemove(false)}
              >
                取消
              </button>
            </>
          ) : (
            <button
              type="button"
              className="underline"
              onClick={() => setRemove(true)}
            >
              删除过程记录
            </button>
          )}
        </>
      )}
      {process.status.state === "closed" && <p>本次过程记录已关闭。</p>}
      {process.cacheFailed && <p role="alert">过程记录的本机状态未能保存。</p>}
      {process.operationFailed && (
        <p role="alert">操作未完成，请联网后重试。</p>
      )}
    </section>
  );
}
