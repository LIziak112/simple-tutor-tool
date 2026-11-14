import type {
  ReviewV2Create,
  ReviewV2Detail,
  ReviewV2RunPublic,
  ReviewV2Scope,
} from "@tutor/contract";
import { useEffect, useId, useReducer, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useStudentMe } from "@/features/auth/student-auth";
import { requestErrorMessage } from "@/lib/api-response";
import { randomUuid } from "@/lib/uuid";
import { ReviewV2Reports } from "./ReviewV2Reports";
import {
  cancelReviewRun,
  createReviewRun,
  listReviewRuns,
  previewReviewRun,
  readReviewRun,
} from "./review-v2-api";

const LABELS = {
  blocked: "等待分片完成",
  created: "等待处理",
  claimed: "处理中",
  replied: "已收到报告",
  paused: "已暂停",
  cancelled: "已取消",
} as const;
export function ReviewV2Panel({
  attemptId,
  released,
  scope = { kind: "attempt" },
  label = "范围复盘",
  units = [],
  profile = "objective",
}: {
  attemptId: string;
  released: boolean;
  scope?: ReviewV2Scope;
  label?: string;
  units?: readonly { id: string; title: string }[];
  profile?: ReviewV2Create["profile"];
}) {
  const { data: student } = useStudentMe();
  return (
    <ReviewV2Session
      key={`${student?.id ?? "none"}:${attemptId}:${JSON.stringify(scope)}:${profile}`}
      attemptId={attemptId}
      released={released}
      initialScope={scope}
      initialProfile={profile}
      label={label}
      units={units}
      accountId={student?.id ?? null}
    />
  );
}
function ReviewV2Session({
  attemptId,
  released,
  initialScope,
  initialProfile,
  label,
  units,
  accountId,
}: {
  attemptId: string;
  released: boolean;
  initialScope: ReviewV2Scope;
  initialProfile: ReviewV2Create["profile"];
  label: string;
  units: readonly { id: string; title: string }[];
  accountId: string | null;
}) {
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false);
  const [scope, setScope] = useState(initialScope),
    [profile, setProfile] = useState<ReviewV2Create["profile"]>(initialProfile);
  const [purpose, setPurpose] = useState("分析本次作答，区分事实和建议"),
    [error, setError] = useState<string | null>(null);
  const [runs, setRuns] = useState<ReviewV2RunPublic[]>([]),
    [detail, setDetail] = useState<ReviewV2Detail | null>(null);
  const pending = useRef<ReviewV2Create | null>(null);
  const purposeId = useId();
  const [, redraw] = useReducer((value) => value + 1, 0);
  const live = useRef(false),
    controller = useRef<AbortController | null>(null);
  useEffect(() => {
    live.current = open && accountId !== null;
    if (!live.current) return;
    const current = new AbortController();
    controller.current = current;
    const refresh = async () => {
      try {
        const next = await listReviewRuns(attemptId, current.signal);
        if (live.current && !current.signal.aborted) {
          setRuns(next);
          setDetail((previous) =>
            previous !== null && !next.some((run) => run.id === previous.run.id)
              ? null
              : previous,
          );
        }
      } catch (err) {
        if (!current.signal.aborted && live.current)
          setError(requestErrorMessage(err, "读取复盘进度失败"));
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => {
      live.current = false;
      current.abort();
      window.clearInterval(timer);
    };
  }, [attemptId, open, accountId]);
  async function create() {
    const signal = controller.current?.signal;
    if (
      busy ||
      !live.current ||
      !signal ||
      signal.aborted ||
      purpose.trim() === ""
    )
      return;
    setBusy(true);
    setError(null);
    try {
      const input = pending.current ?? {
        mutationId: randomUuid(),
        purpose: purpose.trim(),
        profile,
        scope,
      };
      if (pending.current === null) {
        const preview = await previewReviewRun(attemptId, input, signal);
        if (!live.current || signal.aborted) return;
        pending.current = {
          ...input,
          expectedPreviewVersion: preview.previewVersion,
        };
      }
      const next = await createReviewRun(attemptId, pending.current, signal);
      if (!live.current || signal.aborted) return;
      pending.current = null;
      setRuns((previous) => [
        next,
        ...previous.filter((run) => run.id !== next.id),
      ]);
    } catch (err) {
      if (live.current && !signal.aborted)
        setError(requestErrorMessage(err, "创建失败，可使用同一请求重试"));
    } finally {
      if (live.current) setBusy(false);
    }
  }
  async function read(runId: string) {
    const signal = controller.current?.signal;
    if (!signal || signal.aborted || busy) return;
    setBusy(true);
    setError(null);
    try {
      const next = await readReviewRun(runId, signal);
      if (live.current && !signal.aborted) setDetail(next);
    } catch (err) {
      if (live.current && !signal.aborted)
        setError(requestErrorMessage(err, "读取报告失败"));
    } finally {
      if (live.current) setBusy(false);
    }
  }
  async function cancel(runId: string) {
    const signal = controller.current?.signal;
    if (!signal || signal.aborted || busy) return;
    setBusy(true);
    setError(null);
    try {
      await cancelReviewRun(runId, signal);
      const next = await listReviewRuns(attemptId, signal);
      if (live.current && !signal.aborted) setRuns(next);
    } catch (err) {
      if (live.current && !signal.aborted)
        setError(requestErrorMessage(err, "取消失败"));
    } finally {
      if (live.current) setBusy(false);
    }
  }
  const locked = busy || pending.current !== null;
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        disabled={!released || accountId === null}
        onClick={() => setOpen(true)}
      >
        {label}
      </Button>
      <Dialog
        open={open}
        onOpenChange={(value) => {
          setOpen(value);
          if (!value) {
            setDetail(null);
            setBusy(false);
          }
        }}
      >
        <DialogContent className="max-h-[88dvh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>{label}</DialogTitle>
            <DialogDescription>
              复盘仅使用所选的已公布内容。大卷分片处理，分片完成后再汇总；原有报告仍可从原入口查看。
            </DialogDescription>
          </DialogHeader>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          {detail ? (
            <>
              <Button variant="ghost" onClick={() => setDetail(null)}>
                返回复盘列表
              </Button>
              <ReviewV2Reports detail={detail} />
            </>
          ) : (
            <>
              {initialScope.kind === "attempt" && units.length > 0 && (
                <label className="grid gap-1 text-sm">
                  范围
                  <select
                    aria-label="复盘范围"
                    disabled={locked}
                    className="rounded-md border p-2"
                    value={scope.kind === "unit" ? scope.unitId : ""}
                    onChange={(e) =>
                      setScope(
                        e.target.value === ""
                          ? { kind: "attempt" }
                          : { kind: "unit", unitId: e.target.value },
                      )
                    }
                  >
                    <option value="">整卷</option>
                    {units.map((unit) => (
                      <option key={unit.id} value={unit.id}>
                        {unit.title}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label className="grid gap-1 text-sm">
                报告侧重
                <select
                  aria-label="报告侧重"
                  disabled={locked}
                  className="rounded-md border p-2"
                  value={profile}
                  onChange={(e) =>
                    setProfile(
                      e.target.value === "essay" ? "essay" : "objective",
                    )
                  }
                >
                  <option value="objective">客观题与知识点</option>
                  <option value="essay">长文作答</option>
                </select>
              </label>
              <label htmlFor={purposeId} className="grid gap-1 text-sm">
                复盘诉求
                <Input
                  id={purposeId}
                  aria-label="复盘诉求"
                  disabled={locked}
                  maxLength={1000}
                  value={purpose}
                  onChange={(e) => setPurpose(e.target.value)}
                />
              </label>
              <Button
                disabled={busy || purpose.trim() === ""}
                onClick={() => void create()}
              >
                {pending.current === null ? "创建范围复盘" : "重试同一份复盘"}
              </Button>
              {pending.current !== null && (
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    pending.current = null;
                    setError(null);
                    redraw();
                  }}
                >
                  放弃本次重试，重新选择范围
                </Button>
              )}
              <p className="text-xs text-muted-foreground">
                创建后请在已连接的 AI 客户端领取分片并提交报告。
              </p>
              {runs.length === 0 && (
                <p className="text-sm text-muted-foreground">暂无范围复盘</p>
              )}
              {runs.map((run) => (
                <article
                  key={run.id}
                  className="grid gap-2 rounded-lg border p-3 text-sm"
                >
                  <p className="font-medium">
                    {run.purpose} · {run.questionCount} 题
                  </p>
                  <ul className="grid gap-1">
                    {run.tasks.map((task, index) => (
                      <li key={task.id}>
                        {task.kind === "summary"
                          ? "汇总"
                          : `分片 ${index + 1}（${task.questionNos.length} 题）`}
                        ：{LABELS[task.status]}
                      </li>
                    ))}
                  </ul>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={
                        busy || !run.tasks.some((task) => task.hasResult)
                      }
                      onClick={() => void read(run.id)}
                    >
                      查看报告
                    </Button>
                    {run.tasks.some(
                      (task) => !["replied", "cancelled"].includes(task.status),
                    ) && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => void cancel(run.id)}
                      >
                        取消未完成任务
                      </Button>
                    )}
                  </div>
                </article>
              ))}
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
