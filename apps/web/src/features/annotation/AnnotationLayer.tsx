/**
 * 题卡级标注层（T6R.20）：「圈画题干」入口 + 两阶段底图流 + 编辑工作区。
 *
 * 形态（NoteLayer 同构，方案 §10「原始作答控件在标注模式外操作」）：
 * - **收起**：「圈画题干」按钮（有笔迹含笔数；同步异常提示点开处理）；
 * - **展开**：先走底图两阶段流（GET 视图 → 无底图则 POST base → 客户端
 *   栅格化 → POST base/image）——ready 才挂 AnnotationWorkspace（底图 img＋
 *   画布同 scale 变换）；**base 非 ready 不挂画布**，只显示状态：
 *   - disabled（超高题/EXPORT_ASSEMBLY_BROKEN/403）：「该题禁用标注，
 *     草稿照用」类文案——入口保留禁用态（重新打开可重试装配失败类）；
 *   - error（网络/栅格化瞬时失败）：原因 + 重试按钮；
 *   - sealed（审查修复 3①）：该 phase 已封存——只读固定态（AnnotationView
 *     回看：底图＋静态笔迹层＋「已随交卷/订正保存固定」），不挂编辑器；
 * - phase=correction 的编辑形态带「保存订正标注」检查点（对齐笔记订正
 *   CorrectionPanel 的 seal 模式：catchUpAnnotations → record 检查 →
 *   sealAttemptAnnotationsApi(attemptId, 'correction')；保存后定格，再修改
 *   会新开一份）；
 * - 标注模式外保留原作答控件（本层是题干区的附加折叠区，不替换作答区）。
 */
import {
  ChevronDown,
  CircleAlert,
  LoaderCircle,
  Lock,
  PenLine,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { sealAttemptAnnotationsApi } from "@/lib/api";
import { AnnotationView } from "./AnnotationView";
import { AnnotationWorkspace } from "./AnnotationWorkspace";
import { getAnnotationRecord } from "./annotation-store";
import { catchUpAnnotations, retryAnnotationUpload } from "./annotation-sync";
import { useAnnotationBase } from "./use-annotation-base";
import {
  useAnnotationRecord,
  useAnnotationSessionRef,
} from "./use-annotation-record";

export interface AnnotationLayerProps {
  attemptId: string;
  questionId: string;
  /** 阶段（答题期 scratch；订正期 correction——结果视图挂载） */
  phase?: "scratch" | "correction";
  /** 无障碍标签前缀（如「第 3 题」） */
  ariaPrefix?: string;
}

export function AnnotationLayer({
  attemptId,
  questionId,
  phase = "scratch",
  ariaPrefix = "本题",
}: AnnotationLayerProps) {
  const session = useAnnotationSessionRef();
  const record = useAnnotationRecord(attemptId, questionId, phase);
  const { flow, ensureBase } = useAnnotationBase({
    session,
    attemptId,
    questionId,
    phase,
  });
  const [open, setOpen] = useState(false);
  const label = `${ariaPrefix}题干标注`;

  // ---- 保存订正标注检查点（审查修复 3①；对齐 CorrectionPanel 的 seal 模式） ----
  const [sealOpen, setSealOpen] = useState(false);
  const [sealing, setSealing] = useState(false);
  const [sealError, setSealError] = useState<string | null>(null);
  /** 本地已封存（seal 成功后即时切固定态；重开页面由 flow=sealed 恢复） */
  const [sealedLocal, setSealedLocal] = useState(false);
  const sealed = flow.kind === "sealed" || sealedLocal;

  const sealCorrection = useCallback(async (): Promise<void> => {
    if (session === null || phase !== "correction") return;
    setSealing(true);
    setSealError(null);
    try {
      // 先追平：本地落盘 → 上传队列 → 回执落地（seal 的判定以追平后 record 为准）
      await catchUpAnnotations(attemptId);
      const current = await getAnnotationRecord(session, {
        attemptId,
        questionId,
        phase,
      });
      if (current === null || current.baseRevision === 0) {
        setSealError("还没有订正标注内容，请先圈画。");
        return;
      }
      if (current.conflict !== null) {
        setSealError(
          "订正标注有同步冲突待处理，请先点开标注层选择保留哪一份。",
        );
        return;
      }
      if (current.denied !== null) {
        setSealError(`订正标注同步被拒：${current.denied.reason}`);
        return;
      }
      if (current.pending !== null) {
        setSealError("订正标注的最新修改还没同步完成，请稍候再试。");
        return;
      }
      await sealAttemptAnnotationsApi(attemptId, "correction");
      setSealOpen(false);
      setSealedLocal(true);
    } catch (err) {
      setSealError(
        err instanceof Error ? err.message : "保存订正标注失败，请稍后重试",
      );
    } finally {
      setSealing(false);
    }
  }, [session, attemptId, questionId, phase]);

  // 展开即触发两阶段流（收起再展开：ready/disabled/sealed 幂等不重跑）
  useEffect(() => {
    if (open) void ensureBase();
  }, [open, ensureBase]);

  const strokeCount = record?.doc?.strokes.length ?? 0;

  const onRetryDenied = useCallback(() => {
    if (session !== null) {
      void retryAnnotationUpload(session, { attemptId, questionId, phase });
    }
  }, [session, attemptId, questionId, phase]);

  return (
    <div data-slot="annotation-layer" className="flex min-w-0 flex-col gap-2">
      {/* 收起形态：入口按钮（标注模式切换明确——显式开/收） */}
      {!open && (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            className="h-11 gap-1.5"
            onClick={() => setOpen(true)}
          >
            <PenLine aria-hidden className="size-4" />
            圈画题干
            {strokeCount > 0 && (
              <span className="text-muted-foreground">· {strokeCount} 笔</span>
            )}
            <ChevronDown aria-hidden className="size-4" />
          </Button>
          {(record?.conflict != null ||
            record?.denied != null ||
            record?.local === "failed") && (
            <span
              role="status"
              className="flex items-center gap-1 text-xs text-amber-600"
            >
              <CircleAlert aria-hidden className="size-3.5" />
              标注同步需处理
              {record?.denied?.kind === "access" && (
                <Button
                  variant="outline"
                  className="ml-1 h-9 px-2.5 text-xs"
                  onClick={onRetryDenied}
                >
                  重试同步
                </Button>
              )}
            </span>
          )}
        </div>
      )}

      {/* 展开形态：标题行 + 收起按钮 */}
      {open && (
        <div className="flex items-center justify-between gap-2">
          <p className="flex items-center gap-1.5 text-sm font-medium">
            <PenLine aria-hidden className="size-4" />
            圈画题干
            {strokeCount > 0 && (
              <span className="font-normal text-muted-foreground">
                {strokeCount} 笔
              </span>
            )}
            {phase === "correction" && (
              <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-800 dark:bg-amber-500/15 dark:text-amber-300">
                订正标注
              </span>
            )}
          </p>
          <Button
            type="button"
            variant="ghost"
            className="h-11 gap-1 px-2.5"
            onClick={() => setOpen(false)}
            aria-label={`收起${label}`}
          >
            <ChevronDown aria-hidden className="size-4" />
            收起
          </Button>
        </div>
      )}

      {/* 展开体：base 生命周期 gate——ready 才挂画布（没有可靠底图不能落墨） */}
      {open && (
        <>
          {flow.kind === "loading" && (
            <div
              role="status"
              className="flex min-h-20 items-center justify-center gap-2 rounded-xl border border-dashed border-border text-sm text-muted-foreground"
            >
              <LoaderCircle aria-hidden className="size-4 animate-spin" />
              正在生成题干底图…
            </div>
          )}
          {flow.kind === "ready" && !sealed && (
            <>
              <AnnotationWorkspace
                attemptId={attemptId}
                questionId={questionId}
                phase={phase}
                base={flow.base}
                ariaPrefix={ariaPrefix}
              />
              {/* 保存订正标注检查点（审查修复 3①）：只有订正期编辑形态提供 */}
              {phase === "correction" && (
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    className="min-h-11"
                    disabled={sealing}
                    onClick={() => {
                      setSealError(null);
                      setSealOpen(true);
                    }}
                  >
                    保存订正标注
                  </Button>
                  <p className="text-xs text-muted-foreground">
                    保存后这份订正标注定格，再修改会新开一份
                  </p>
                </div>
              )}
            </>
          )}
          {/* 已封存固定态（审查修复 3①）：只读回看视图（底图＋静态笔迹层），
              不挂编辑器——scratch=已随交卷固定；correction=已随订正保存固定 */}
          {sealed && (
            <div className="flex flex-col gap-2">
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Lock aria-hidden className="size-3.5" />
                {phase === "correction"
                  ? "已随订正保存固定（再修改会新开一份）"
                  : "已随交卷固定（订正期另开新标注）"}
              </p>
              <AnnotationView
                viewer="student"
                attemptId={attemptId}
                questionId={questionId}
                phase={phase}
                ariaPrefix={ariaPrefix}
              />
            </div>
          )}
          {flow.kind === "disabled" && (
            <div
              role="note"
              className="flex items-start gap-2 rounded-xl border border-amber-300/60 bg-amber-50 px-3 py-2.5 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300"
            >
              <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
              <span>{flow.reason}</span>
            </div>
          )}
          {flow.kind === "error" && (
            <div
              role="alert"
              className="flex flex-col items-start gap-2 rounded-xl border border-destructive/40 bg-destructive/5 px-3 py-2.5 text-sm"
            >
              <p className="text-destructive">底图生成失败：{flow.message}</p>
              <Button
                variant="outline"
                className="h-10 px-3 text-xs"
                onClick={() => void ensureBase()}
              >
                重试
              </Button>
            </div>
          )}
          {flow.kind === "idle" && (
            <div
              role="status"
              className="flex min-h-20 items-center justify-center gap-2 rounded-xl border border-dashed border-border text-sm text-muted-foreground"
            >
              <LoaderCircle aria-hidden className="size-4 animate-spin" />
              正在准备题干标注…
            </div>
          )}
        </>
      )}

      {/* 保存订正标注 = seal 检查点（确认弹层；对齐笔记订正的定格确认） */}
      <Dialog open={sealOpen} onOpenChange={setSealOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>保存订正标注</DialogTitle>
            <DialogDescription>
              保存后这份订正标注定格，再修改会新开一份；老师导出学情材料时会
              收到这份订正时的圈画。
            </DialogDescription>
          </DialogHeader>
          {sealError !== null && (
            <p role="alert" className="text-sm text-destructive">
              {sealError}
            </p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              className="h-11"
              disabled={sealing}
              onClick={() => setSealOpen(false)}
            >
              取消
            </Button>
            <Button
              type="button"
              className="h-11"
              disabled={sealing}
              onClick={() => void sealCorrection()}
            >
              {sealing ? "正在保存…" : "确认保存"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
