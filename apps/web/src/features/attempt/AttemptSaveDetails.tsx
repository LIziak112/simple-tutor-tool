import { ListChecks, RotateCw } from "lucide-react";
import {
  type RefObject,
  useCallback,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  type AttemptSaveDetail,
  readAttemptSaveDetails,
  subscribeAttemptSaveChanges,
} from "./use-attempt-save-status";
import type { InkUploadController } from "./use-ink-upload";

interface DetailsProps {
  attemptId: string;
  questionIds: readonly string[];
  controllers: RefObject<Map<string, InkUploadController>>;
  onJump(questionId: string): Promise<void>;
  onRetry(): Promise<void>;
}

function SaveRows({
  attemptId,
  questionIds,
  controllers,
  onJump,
}: Omit<DetailsProps, "onRetry">) {
  const read = useCallback(
    () =>
      JSON.stringify(
        readAttemptSaveDetails(attemptId, questionIds, controllers.current),
      ),
    [attemptId, questionIds, controllers],
  );
  const snapshot = useSyncExternalStore(
    subscribeAttemptSaveChanges,
    read,
    read,
  );
  const rows = useMemo(
    () => JSON.parse(snapshot) as AttemptSaveDetail[],
    [snapshot],
  );
  return (
    <div className="min-h-0 overflow-y-auto">
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">尚无作答或辅助稿件</p>
      ) : (
        <ul className="divide-y divide-border">
          {rows.map((row) => (
            <li key={row.questionId} className="py-3">
              <Button
                variant="ghost"
                className="min-h-11 px-2"
                aria-label={`定位第 ${row.questionNo} 题`}
                onClick={() => void onJump(row.questionId)}
              >
                第 {row.questionNo} 题
              </Button>
              <dl className="grid grid-cols-1 gap-1 px-2 text-sm sm:grid-cols-2">
                {[
                  ["答案", row.answer],
                  ["正式手写", row.ink],
                  ["草稿", row.scratch],
                  ["标画", row.annotation],
                ].map(([name, status]) => (
                  <div key={name} className="break-words">
                    <dt className="inline">{name}：</dt>
                    <dd className="inline">{status}</dd>
                  </div>
                ))}
              </dl>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function AttemptSaveDetails(props: DetailsProps) {
  const [open, setOpen] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const jumping = useRef(false);
  const generation = useRef(0);
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        generation.current++;
        setOpen(value);
        setError(null);
        setRetrying(false);
      }}
    >
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          className="size-11 shrink-0 p-0"
          title="保存详情"
          aria-label="保存详情"
        >
          <ListChecks aria-hidden className="size-4" />
        </Button>
      </DialogTrigger>
      <DialogContent
        className="flex max-h-[70dvh] w-[calc(100%-24px)] flex-col rounded-lg"
        onCloseAutoFocus={(event) => {
          if (jumping.current) {
            event.preventDefault();
            jumping.current = false;
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>保存详情</DialogTitle>
          <DialogDescription>本机保存与服务器同步</DialogDescription>
        </DialogHeader>
        {open && (
          <SaveRows
            {...props}
            onJump={async (id) => {
              jumping.current = true;
              generation.current++;
              setOpen(false);
              await props.onJump(id);
            }}
          />
        )}
        {error && (
          <p role="alert" className="text-sm break-words text-destructive">
            {error}
          </p>
        )}
        <Button
          variant="outline"
          className="min-h-11"
          disabled={retrying}
          onClick={async () => {
            const current = ++generation.current;
            setRetrying(true);
            setError(null);
            try {
              await props.onRetry();
            } catch (cause) {
              if (current !== generation.current) return;
              setError(
                cause instanceof Error
                  ? cause.message
                  : "重试失败，请保持页面打开",
              );
            } finally {
              if (current === generation.current) setRetrying(false);
            }
          }}
        >
          <RotateCw aria-hidden className="size-4" />
          重试保存与同步
        </Button>
      </DialogContent>
    </Dialog>
  );
}
