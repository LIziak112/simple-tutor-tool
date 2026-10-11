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
  getActive(): AttemptEditor | null;
  request(
    next: AttemptEditor | null,
    prepare?: (signal: AbortSignal) => Promise<boolean>,
  ): Promise<boolean>;
  register(
    questionId: string,
    finish: () => Promise<void>,
    kind?: AttemptEditor["kind"],
  ): () => void;
}
interface EditorStore extends Omit<EditorContextValue, "active"> {
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
  return useMemo(
    () =>
      store
        ? {
            active,
            getActive: store.getActive,
            request: store.request,
            register: store.register,
          }
        : null,
    [store, active],
  );
}

/** 切换等待原编辑者收笔与本机落盘；失败不卸载原稿。 */
export function AttemptEditorProvider({ children }: { children: ReactNode }) {
  const [error, setError] = useState<string | null>(null);
  const activeRef = useRef<AttemptEditor | null>(null);
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
        previous?.questionId === next?.questionId &&
        previous?.kind === next?.kind
      )
        return true;
      try {
        if (previous)
          await controllers.current.get(
            `${previous.kind}:${previous.questionId}`,
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
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.key !== "Escape" ||
        event.isComposing ||
        event.keyCode === 229 ||
        !activeRef.current
      )
        return;
      if (document.querySelector('[role="dialog"][data-state="open"]')) return;
      event.preventDefault();
      void request(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      sequence.current++;
      preparation.current?.abort();
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [request]);
  const value = useMemo(
    () => ({
      getActive: () => activeRef.current,
      subscribe: (listener: () => void) => {
        listeners.current.add(listener);
        return () => {
          listeners.current.delete(listener);
        };
      },
      request,
      register,
    }),
    [request, register],
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
