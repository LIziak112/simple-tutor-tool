import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Button } from "@/components/ui/button";
import { localPersistenceErrorMessage } from "@/lib/local-persistence-error";

export type AttemptEditor = {
  questionId: string;
  kind: "annotation" | "scratch" | "answerInk";
};
interface EditorContextValue {
  active: AttemptEditor | null;
  paper: AttemptEditor | null;
  getActive(): AttemptEditor | null;
  getPaper(): AttemptEditor | null;
  requestPaper(next: AttemptEditor | null): Promise<boolean>;
  /**
   * 切换活动编辑者：先收笔落盘原编辑者（失败进「上次操作未完成」横幅并
   * 保留原编辑者，可重试）；带 prepare 时，prepare 抛错属「打开失败」
   * （前置条件不满足），不进横幅、不提供全局重试，错误原样抛回调用方
   * 就地呈现（不带 prepare 的调用永不 reject）。
   */
  request(
    next: AttemptEditor | null,
    prepare?: (signal: AbortSignal) => Promise<boolean>,
  ): Promise<boolean>;  register(
    questionId: string,
    finish: () => Promise<void>,
    kind?: AttemptEditor["kind"],
  ): () => void;
  /**
   * 仅对选定题收笔并等待该题本机落盘（AI 材料采集，B05 SAI-10）：
   * 不改变 active/paper、不卸载控制器、不清撤销历史；落盘失败向前抛出。
   */
  flush(
    questionId: string,
    kinds?: readonly AttemptEditor["kind"][],
  ): Promise<void>;
}
interface EditorStore extends Omit<EditorContextValue, "active" | "paper"> {
  subscribe(listener: () => void): () => void;
}
const Context = createContext<EditorStore | null>(null);
const NoticeContext = createContext<{
  message: string | null;
  retrying: boolean;
  retry(): Promise<void>;
} | null>(null);

/** 放进标题的正常布局，随标题一同测量，不能另设悬浮层遮住题目。 */
export function AttemptEditorNotice() {
  const notice = useContext(NoticeContext);
  if (!notice?.message) return null;
  return (
    <div
      role="alert"
      className="col-span-full flex flex-wrap items-center gap-2 rounded-lg border border-destructive/30 bg-card px-3 py-2 text-sm text-destructive"
    >
      <span className="min-w-0 flex-1 break-words">
        上次操作未完成：{notice.message}
      </span>
      <Button
        type="button"
        variant="outline"
        className="min-h-11"
        disabled={notice.retrying}
        onClick={() => void notice.retry()}
      >
        {notice.retrying ? "正在重试…" : "重试操作"}
      </Button>
    </div>
  );
}
const noSubscribe = () => () => {};
/** undefined订阅全局，题号只订阅本题，null只取稳定操作而不订阅模式。 */
export function useAttemptEditor(
  questionId?: string | null,
): EditorContextValue | null {
  const store = useContext(Context);
  const read = useCallback(() => {
    const active = store?.getActive() ?? null;
    return questionId === null
      ? null
      : questionId === undefined || active?.questionId === questionId
        ? active
        : null;
  }, [store, questionId]);
  const active = useSyncExternalStore(
    store?.subscribe ?? noSubscribe,
    read,
    read,
  );
  const readPaper = useCallback(() => {
    const paper = store?.getPaper() ?? null;
    return questionId === null
      ? null
      : questionId === undefined || paper?.questionId === questionId
        ? paper
        : null;
  }, [store, questionId]);
  const paper = useSyncExternalStore(
    store?.subscribe ?? noSubscribe,
    readPaper,
    readPaper,
  );
  return useMemo(
    () =>
      store
        ? {
            active,
            paper,
            getActive: store.getActive,
            getPaper: store.getPaper,
            requestPaper: store.requestPaper,
            request: store.request,
            register: store.register,
            flush: store.flush,
          }
        : null,
    [store, active, paper],
  );
}

/** 切换等待原编辑者收笔与本机落盘；失败不卸载原稿。 */
export function AttemptEditorProvider({ children }: { children: ReactNode }) {
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const retryLock = useRef(false);
  const failedOperation = useRef<{
    kind: "active" | "paper";
    next: AttemptEditor | null;
    prepare?: (signal: AbortSignal) => Promise<boolean>;
  } | null>(null);
  const activeRef = useRef<AttemptEditor | null>(null);
  // 纸面展开与标画模式独立；同题两个区域可直接落笔。
  const paperRef = useRef<AttemptEditor | null>(null);
  const listeners = useRef(new Set<() => void>());
  const publish = useCallback((next: AttemptEditor | null) => {
    activeRef.current = next;
    for (const listener of listeners.current) listener();
  }, []);
  const controllers = useRef(new Map<string, () => Promise<void>>());
  const sequence = useRef(0);
  const preparation = useRef<AbortController | null>(null);
  // 语义分流（annotation/scratch/answerInk 共用）：阶段一「收笔落盘」失败是
  // 数据未保存，保留原编辑者并进全局横幅（可重试）；阶段二「打开前置」失败是
  // 前置条件不满足（v1 底图/已封存/布局不匹配等确定性错误），重试无意义，
  // 不进横幅、错误抛回调用方就地呈现。replay 供 retry() 重放历史失败操作，
  // 其阶段二失败沿用横幅语义（与既有行为一致，不向调用方抛出）。
  const runRequest = useCallback(
    async (
      next: AttemptEditor | null,
      prepare?: (signal: AbortSignal) => Promise<boolean>,
      replay = false,
    ) => {
      const generation = ++sequence.current;
      preparation.current?.abort();
      const controller = new AbortController();
      preparation.current = controller;
      const previous = activeRef.current;
      if (
        !paperRef.current &&
        previous?.questionId === next?.questionId &&
        previous?.kind === next?.kind
      ) {
        failedOperation.current = null;
        setError(null);
        return true;
      }
      // 阶段一：原编辑者与纸面收笔并本机落盘（失败=保存未完成）。
      try {
        if (previous)
          await controllers.current.get(
            `${previous.kind}:${previous.questionId}`,
          )?.();
        const paper = paperRef.current;
        if (paper)
          await controllers.current.get(
            `${paper.kind}:${paper.questionId}`,
          )?.();
      } catch (cause) {
        if (generation === sequence.current) {
          failedOperation.current = {
            kind: "active",
            next,
            ...(prepare ? { prepare } : {}),
          };
          setError(localPersistenceErrorMessage(cause));
        }
        return false;
      }
      if (generation !== sequence.current) return false;
      // 阶段二：新编辑者的打开前置（失败=打开失败，就地呈现）。
      if (prepare) {
        publish(null);
        try {
          if (!(await prepare(controller.signal))) return false;
          if (generation !== sequence.current) return false;
        } catch (cause) {
          if (generation !== sequence.current) return false;
          if (replay) {
            failedOperation.current = { kind: "active", next, prepare };
            setError(localPersistenceErrorMessage(cause));
            return false;
          }
          // 挂起的旧失败已随本次收笔成功一并了结，不再保留过期重试目标。
          failedOperation.current = null;
          setError(null);
          throw cause;
        }
      }
      if (next && paperRef.current?.questionId !== next.questionId)
        paperRef.current = null;
      publish(next);
      failedOperation.current = null;
      setError(null);
      return true;
    },
    [publish],
  );
  const request = useCallback(
    async (
      next: AttemptEditor | null,
      prepare?: (signal: AbortSignal) => Promise<boolean>,
    ) => runRequest(next, prepare, false),
    [runRequest],
  );
  const requestPaper = useCallback(
    async (next: AttemptEditor | null) => {
      const generation = ++sequence.current;
      preparation.current?.abort();
      const previous = paperRef.current;
      const active = activeRef.current;
      try {
        if (previous)
          await controllers.current.get(
            `${previous.kind}:${previous.questionId}`,
          )?.();
        const closeActive =
          active && next && active.questionId !== next.questionId;
        if (closeActive)
          await controllers.current.get(
            `${active.kind}:${active.questionId}`,
          )?.();
        if (generation !== sequence.current) return false;
        paperRef.current = next;
        publish(closeActive ? null : active);
        failedOperation.current = null;
        setError(null);
        return true;
      } catch (cause) {
        if (generation === sequence.current) {
          failedOperation.current = { kind: "paper", next };
          setError(localPersistenceErrorMessage(cause));
        }
        return false;
      }
    },
    [publish],
  );
  const register = useCallback(
    (
      questionId: string,
      finish: () => Promise<void>,
      kind: AttemptEditor["kind"] = "annotation",
    ) => {
      const key = `${kind}:${questionId}`;
      controllers.current.set(key, finish);
      return () => {
        if (controllers.current.get(key) === finish)
          controllers.current.delete(key);
      };
    },
    [],
  );
  const retry = useCallback(async () => {
    const operation = failedOperation.current;
    if (!operation || retryLock.current) return;
    retryLock.current = true;
    setRetrying(true);
    try {
      if (operation.kind === "paper") await requestPaper(operation.next);
      else await runRequest(operation.next, operation.prepare, true);
    } finally {
      retryLock.current = false;
      setRetrying(false);
    }
  }, [runRequest, requestPaper]);
  // 固定顺序收笔（标画 → 草稿 → 正式手写）；只碰本题注册的控制器。
  const flush = useCallback(
    async (questionId: string, kinds?: readonly AttemptEditor["kind"][]) => {
      for (const kind of kinds ?? ["annotation", "scratch", "answerInk"]) {
        await controllers.current.get(`${kind}:${questionId}`)?.();
      }
    },
    [],
  );
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.key !== "Escape" ||
        event.isComposing ||
        event.keyCode === 229 ||
        (!activeRef.current && !paperRef.current)
      )
        return;
      if (document.querySelector('[role="dialog"][data-state="open"]')) return;
      event.preventDefault();
      if (activeRef.current) void request(null);
      else void requestPaper(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      sequence.current++;
      preparation.current?.abort();
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [request, requestPaper]);
  const value = useMemo(
    () => ({
      getActive: () => activeRef.current,
      getPaper: () => paperRef.current,
      subscribe: (listener: () => void) => {
        listeners.current.add(listener);
        return () => {
          listeners.current.delete(listener);
        };
      },
      request,
      requestPaper,
      register,
      flush,
    }),
    [request, requestPaper, register, flush],
  );
  return (
    <Context.Provider value={value}>
      <NoticeContext.Provider value={{ message: error, retrying, retry }}>
        {children}
      </NoticeContext.Provider>
    </Context.Provider>
  );
}
