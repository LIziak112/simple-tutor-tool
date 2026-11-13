import { NotebookPen } from "lucide-react";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import {
  type HostLease,
  LearningHostContext,
  type LearningSource,
  learningContextStore,
} from "@/features/learning-context/learning-context-store";
import { MemoQuickCaptureDialog } from "./MemoQuickCapture";

type OpenCapture = (
  lease: HostLease,
  source: LearningSource,
  trigger: HTMLElement | null,
) => void;
const CaptureContext = createContext<OpenCapture | null>(null);
/** 每个学习布局一份记录端；来源是本条记录快照，不参与实时焦点选择。 */
export function QuestionMemoCaptureProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [capture, setCapture] = useState<{
    source: LearningSource;
    principal: string | null;
  } | null>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const unpin = useRef<(() => void) | null>(null);
  const close = () => {
    unpin.current?.();
    unpin.current = null;
    setCapture(null);
  };
  const principal = useSyncExternalStore(
    learningContextStore.subscribe,
    () => learningContextStore.getSnapshot().principal,
    () => null,
  );
  useEffect(() => {
    setCapture((current) =>
      current !== null && current.principal !== principal ? null : current,
    );
  }, [principal]);
  const openCapture = useCallback<OpenCapture>((lease, source, element) => {
    const snapshot = learningContextStore.getSnapshot();
    if (snapshot.host !== lease || source.principal !== snapshot.principal)
      return;
    trigger.current = element;
    setCapture({
      source: structuredClone(source),
      principal: snapshot.principal,
    });
    learningContextStore.explicit(lease, source);
    learningContextStore.pin(lease, true);
    unpin.current = () => learningContextStore.pin(lease, false);
  }, []);
  return (
    <CaptureContext value={openCapture}>
      {children}
      <MemoQuickCaptureDialog
        open={capture !== null && capture.principal === principal}
        onOpenChange={(open) => {
          if (!open) close();
        }}
        source={capture?.source}
        onReturnFocus={() => {
          trigger.current?.focus();
        }}
      />
    </CaptureContext>
  );
}
/** 菜单来源直接由这张题卡的qid定位，禁止读取滚动猜出的当前题。 */
export function QuestionMemoAction({
  attemptId,
  questionId,
  surface,
  questionRevisionId,
  standalone = false,
}: {
  attemptId?: string | undefined;
  questionId: string;
  surface: "attempt" | "result" | "lesson";
  questionRevisionId?: string | undefined;
  standalone?: boolean;
}) {
  const open = useContext(CaptureContext);
  const lease = useContext(LearningHostContext);
  const trigger = useRef<HTMLButtonElement | null>(null);
  if (!open || !attemptId) return null;
  const capture = () => {
    const source = learningContextStore.captureQuestion(lease, {
      attemptId,
      questionId,
      surface,
      questionRevisionId,
    });
    if (!source || !lease) return;
    const active = document.activeElement;
    const card = [
      ...document.querySelectorAll<HTMLElement>(
        "[data-question-id],[data-review-question]",
      ),
    ].find(
      (el) =>
        (el.dataset.questionId === questionId ||
          el.dataset.reviewQuestion === questionId) &&
        el.dataset.learningAttempt === attemptId &&
        el.dataset.learningView === lease.viewId &&
        el.dataset.learningSurface === surface &&
        (questionRevisionId === undefined ||
          el.dataset.learningRevision === questionRevisionId),
    );
    const element =
      trigger.current ??
      card?.querySelector<HTMLElement>('button[aria-label$="更多"]') ??
      (active instanceof HTMLElement ? active : null);
    open(lease, source, element);
  };
  return standalone ? (
    <Button
      ref={trigger}
      variant="ghost"
      className="min-h-11"
      onClick={capture}
    >
      <NotebookPen aria-hidden className="size-4" />
      记随笔
    </Button>
  ) : (
    <DropdownMenuItem onSelect={capture}>
      <NotebookPen aria-hidden className="size-4" />
      记随笔
    </DropdownMenuItem>
  );
}
