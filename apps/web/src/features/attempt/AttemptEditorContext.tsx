import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

export type AttemptEditor = {
  questionId: string;
  kind: "annotation" | "scratch" | "answerInk";
};
interface EditorContextValue {
  active: AttemptEditor | null;
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
const Context = createContext<EditorContextValue | null>(null);
export const useAttemptEditor = () => useContext(Context);

/** 切换等待原编辑者收笔与本机落盘；失败不卸载原稿。 */
export function AttemptEditorProvider({ children }: { children: ReactNode }) {
  const [active, setActive] = useState<AttemptEditor | null>(null);
  const [error, setError] = useState<string | null>(null);
  const activeRef = useRef(active);
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
          activeRef.current = null;
          setActive(null);
          if (
            !(await prepare(controller.signal)) ||
            generation !== sequence.current
          )
            return false;
        }
        activeRef.current = next;
        setActive(next);
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
    [],
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
    () => ({ active, request, register }),
    [active, request, register],
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
