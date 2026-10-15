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
  request(
    next: AttemptEditor | null,
    prepare?: (signal: AbortSignal) => Promise<boolean>,
  ): Promise<boolean>;
  register(
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
  const request = useCallback(
    async (
      next: AttemptEditor | null,
      prepare?: (signal: AbortSignal) => Promise<boolean>,
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
      )
        return true;
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
        if (generation !== sequence.current) return false;
        if (prepare) {
          publish(null);
          if (
            !(await prepare(controller.signal)) ||
            generation !== sequence.current
          )
            return false;
        }
        if (next && paper?.questionId !== next.questionId)
          paperRef.current = null;
        publish(next);
        setError(null);
        return true;
      } catch (cause) {
        if (generation === sequence.current)
          setError(
            cause instanceof Error ? cause.message : "本机稿未保存，请重试",
          );
        return false;
      }
    },
    [publish],
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
        setError(null);
        return true;
      } catch (cause) {
        if (generation === sequence.current)
          setError(
            cause instanceof Error ? cause.message : "本机稿未保存，请重试",
          );
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
      {error && (
        <div
          role="alert"
          className="sticky top-[var(--attempt-header-height,64px)] z-40 border-b border-destructive bg-card px-3 py-2 text-sm text-destructive"
        >
          {error}
        </div>
      )}
      {children}
    </Context.Provider>
  );
}
