/**
 * 结果页订正区（T6R.15 C，挂 AttemptResultView 每题卡——NoteOriginalView/
 * InkThumbnail 之后，**所有题型**都有订正入口）：
 * - 折叠零请求（结果页 N 张题卡不自动拉头）；展开经 ② evidence 端点
 *   （本人历史权限、软删题可读）拉头投影，并就地播种未封存订正行进本地
 *   correction 记录（seedOpenCorrection）；
 * - 「添加订正」→ Dialog 二选一（默认空白 / 复制原稿——复制项仅该题证据
 *   frozen 可选，否则禁用并说明）→ createCorrectionApi → 清旧封存行残留
 *   （clearCorrectionRecord）→ 播种新行 → 打开 CorrectionPanel；
 * - 已封存订正列表：封存时间 + 反思分栏（「我卡在哪里」/「我的错因」，
 *   无则不显示）；点开 NoteVersionView 查看（笔数显示在查看面板就绪行
 *   ——契约 noteRecordMeta 无 strokeCount，列表行不显示笔数）；未封存行
 *   显示「编辑中」继续编辑入口；
 * - 「找回草稿为补充稿」（D8）：evidence∈{missing,none,legacy_unverified}
 *   且本地 scratch 有未同步内容 → 破坏性次级按钮 + 确认文案 → 本地复制到
 *   phase='supplement' 新记录并触发同步（scratch 本地记录保留不动）；
 * - 「本题历史」链接携 questionId 跳题目笔记本（/s/notebook/:questionId）。
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { NoteHeadData, NoteRecordMeta } from "@tutor/contract";
import {
  ChevronDown,
  ClipboardEdit,
  History,
  Plus,
  TriangleAlert,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { CorrectionPanel } from "@/features/notes/CorrectionPanel";
import {
  correctionHeadKey,
  hasRecoverableScratch,
  openCorrectionOf,
  recoverScratchAsSupplement,
  seedOpenCorrection,
} from "@/features/notes/correction-record";
import { NoteVersionView } from "@/features/notes/NoteVersionView";
import {
  clearCorrectionRecord,
  getNoteRecord,
} from "@/features/notes/note-store";
import { useNoteSessionRef } from "@/features/notes/use-note-head";
import { ApiError, createCorrectionApi } from "@/lib/api";
import { fetchNoteEvidenceApi } from "@/lib/note-endpoints";
import { formatCnTime } from "@/lib/time";

/** 已封存行类型收窄（sealedAt 非空） */
type SealedCorrection = NoteRecordMeta & { sealedAt: string };

/** D8 找回入口的证据状态集合（原稿未固定族） */
const RECOVERABLE_EVIDENCE: ReadonlySet<string> = new Set([
  "missing",
  "none",
  "legacy_unverified",
]);

export interface CorrectionSectionProps {
  attemptId: string;
  questionId: string;
  /** 无障碍标签前缀（如「第 3 题」） */
  ariaPrefix?: string;
}

export function CorrectionSection({
  attemptId,
  questionId,
  ariaPrefix = "本题",
}: CorrectionSectionProps) {
  const session = useNoteSessionRef();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);

  // ---- 头投影（展开才拉；queryFn 内播种未封存行） ----
  const headKey = correctionHeadKey(
    session?.studentId ?? "standby",
    attemptId,
    questionId,
  );
  const headQuery = useQuery({
    queryKey: headKey,
    queryFn: async () => {
      if (session === null) {
        throw new Error("草稿会话未绑定（不应发生：展开守卫已拦）");
      }
      const head = await fetchNoteEvidenceApi("student", attemptId, questionId);
      await seedOpenCorrection(session, attemptId, questionId, head);
      return head;
    },
    enabled: open && session !== null,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    retry: (count, err) => !(err instanceof ApiError) && count < 2,
  });
  const head = headQuery.data ?? null;
  const openRow = head === null ? null : openCorrectionOf(head);
  const sealedRows: SealedCorrection[] =
    head?.corrections.filter(
      (row): row is SealedCorrection => row.sealedAt != null,
    ) ?? [];

  // ---- D8：本地 scratch 是否有未同步内容（展开后异步复核；head 刷新不
  // 改变本地 scratch 记录，无需随其重判） ----
  const [scratchRecoverable, setScratchRecoverable] = useState(false);
  useEffect(() => {
    if (!open || session === null) return;
    let cancelled = false;
    void getNoteRecord(session, {
      attemptId,
      questionId,
      phase: "scratch",
    }).then((record) => {
      if (!cancelled) setScratchRecoverable(hasRecoverableScratch(record));
    });
    return () => {
      cancelled = true;
    };
  }, [open, session, attemptId, questionId]);
  const [recovered, setRecovered] = useState(false);
  const recoverable =
    !recovered &&
    head?.evidence !== null &&
    head?.evidence !== undefined &&
    RECOVERABLE_EVIDENCE.has(head.evidence.state) &&
    scratchRecoverable;

  // ---- 添加订正（Dialog 二选一） ----
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const create = async (copyFromOriginal: boolean) => {
    if (session === null) return;
    setCreating(true);
    setCreateError(null);
    try {
      const newHead = await createCorrectionApi(attemptId, questionId, {
        copyFromOriginal,
      });
      // 新行起步：清旧封存行残留（stale pending/冲突/被拒不灌新行），再按
      // 响应头播种（复制原稿时拉首版本正文；空白行只对齐 noteId/基线 0）
      await clearCorrectionRecord(session, {
        attemptId,
        questionId,
        phase: "correction",
      });
      await seedOpenCorrection(session, attemptId, questionId, newHead);
      queryClient.setQueryData(headKey, newHead);
      setCreateOpen(false);
      setPanelOpen(true);
    } catch (err) {
      setCreateError(
        err instanceof Error ? err.message : "创建订正失败，请稍后重试",
      );
      // 409（OPEN_EXISTS 等）时重拉头：列表形态可能已变为「继续编辑」
      void headQuery.refetch();
    } finally {
      setCreating(false);
    }
  };

  // ---- D8 找回确认 ----
  const [recoverOpen, setRecoverOpen] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [recoverError, setRecoverError] = useState<string | null>(null);
  const recover = async () => {
    if (session === null) return;
    setRecovering(true);
    setRecoverError(null);
    try {
      const outcome = await recoverScratchAsSupplement(
        session,
        attemptId,
        questionId,
      );
      if (outcome === "nothing") {
        setRecoverError("没有找到可找回的草稿内容。");
        return;
      }
      setRecovered(true);
      setRecoverOpen(false);
    } catch (err) {
      setRecoverError(
        err instanceof Error ? err.message : "找回失败，请稍后重试",
      );
    } finally {
      setRecovering(false);
    }
  };

  const onSealed = (sealedHead: NoteHeadData) => {
    queryClient.setQueryData(headKey, sealedHead);
    setPanelOpen(false);
  };

  const canCopyOriginal = head?.evidence?.state === "frozen";

  return (
    <div data-slot="correction-section" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          className="h-11"
          aria-expanded={open}
          aria-label={`${ariaPrefix}订正`}
          onClick={() => setOpen((prev) => !prev)}
        >
          <ClipboardEdit aria-hidden className="size-4" />
          订正
          <ChevronDown
            aria-hidden
            className={`size-4 transition-transform ${open ? "rotate-180" : ""}`}
          />
        </Button>
        <Link
          to={`/s/notebook/${encodeURIComponent(questionId)}`}
          aria-label={`${ariaPrefix}本题历史`}
          className="flex min-h-11 items-center gap-1 rounded-lg px-2 text-sm text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <History aria-hidden className="size-4" />
          本题历史
        </Link>
      </div>

      {open && (
        <div className="flex flex-col gap-2 rounded-lg bg-muted/30 px-3 py-3">
          {headQuery.isPending && (
            <p
              role="status"
              className="text-sm text-muted-foreground"
              aria-label="正在读取订正信息"
            >
              正在读取订正信息…
            </p>
          )}

          {headQuery.isError && (
            <div
              role="alert"
              className="flex flex-col items-start gap-2 text-sm"
            >
              <p>订正信息读取失败：{headQuery.error.message}</p>
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                onClick={() => void headQuery.refetch()}
              >
                重试
              </Button>
            </div>
          )}

          {head !== null && (
            <div className="flex flex-col gap-2">
              {/* 编辑入口：未封存行 → 继续编辑；否则添加（所有题型） */}
              {!panelOpen &&
                (openRow !== null ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="rounded-full bg-amber-100 px-2.5 py-1 text-xs font-medium text-amber-800 dark:bg-amber-500/20 dark:text-amber-300">
                      编辑中
                    </span>
                    <Button
                      type="button"
                      variant="secondary"
                      className="min-h-11"
                      onClick={() => setPanelOpen(true)}
                    >
                      继续编辑订正
                    </Button>
                  </div>
                ) : (
                  <div className="flex flex-col gap-1">
                    <Button
                      type="button"
                      variant="outline"
                      className="min-h-11 w-fit"
                      onClick={() => {
                        setCreateError(null);
                        setCreateOpen(true);
                      }}
                    >
                      <Plus aria-hidden className="size-4" />
                      添加订正
                    </Button>
                    {sealedRows.length === 0 && (
                      <p className="text-xs text-muted-foreground">
                        还没有保存过的订正。写完一稿点「保存订正」，会定格成一次
                        检查点并留下你的反思。
                      </p>
                    )}
                  </div>
                ))}

              {/* 已封存订正列表：封存时间 + 反思分栏 + 查看入口 */}
              {sealedRows.length > 0 && (
                <div className="flex flex-col gap-2">
                  {sealedRows.map((row, index) => (
                    <div
                      key={row.noteId}
                      className="flex flex-col gap-2 rounded-lg border border-border bg-card px-3 py-2.5"
                    >
                      <p className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                        <span className="font-medium text-foreground">
                          订正 {index + 1}
                        </span>
                        <span>封存于 {formatCnTime(row.sealedAt)}</span>
                      </p>
                      {row.stuckAt !== null && row.stuckAt !== "" && (
                        <p className="text-sm">
                          <span className="text-muted-foreground">
                            我卡在哪里：
                          </span>
                          {row.stuckAt}
                        </p>
                      )}
                      {row.errorCause !== null && row.errorCause !== "" && (
                        <p className="text-sm">
                          <span className="text-muted-foreground">
                            我的错因：
                          </span>
                          {row.errorCause}
                        </p>
                      )}
                      <NoteVersionView
                        viewer="student"
                        versionId={row.currentVersionId}
                        title="订正"
                        openLabel="查看订正"
                        savedAtLabel="封存于"
                        savedAt={row.sealedAt}
                        revision={row.revision}
                        ariaPrefix={ariaPrefix}
                        icon={ClipboardEdit}
                      />
                    </div>
                  ))}
                </div>
              )}

              {/* D8：找回草稿为补充稿（明确动作，不自动重传） */}
              {recoverable && (
                <div className="flex flex-col gap-1">
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11 w-fit border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
                    onClick={() => {
                      setRecoverError(null);
                      setRecoverOpen(true);
                    }}
                  >
                    <TriangleAlert aria-hidden className="size-4" />
                    找回草稿为补充稿
                  </Button>
                </div>
              )}
              {recovered && (
                <p role="status" className="text-xs text-muted-foreground">
                  已作为补充稿开始同步，可在「本题历史」查看；它不能证明交卷前
                  已固定。
                </p>
              )}
            </div>
          )}

          {/* 编辑器（订正区展开态内嵌；闸门修复 F2：随区块收起一并卸载——
              收起即收起编辑器，不用 setPanelOpen(false) 方案以免丢视口） */}
          {panelOpen && (
            <CorrectionPanel
              attemptId={attemptId}
              questionId={questionId}
              ariaPrefix={ariaPrefix}
              onClose={() => setPanelOpen(false)}
              onSealed={onSealed}
            />
          )}
        </div>
      )}

      {/* 添加订正：二选一（默认空白；复制原稿仅 frozen 可选） */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>添加订正</DialogTitle>
            <DialogDescription>
              选择这份订正从哪里开始。保存后成为一次检查点，再修改会新开一份。
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Button
              type="button"
              variant="secondary"
              className="min-h-11 justify-start"
              disabled={creating}
              onClick={() => void create(false)}
            >
              <Plus aria-hidden className="size-4" />
              空白订正
            </Button>
            <Button
              type="button"
              variant="secondary"
              className="min-h-11 justify-start"
              disabled={creating || !canCopyOriginal}
              onClick={() => void create(true)}
            >
              <ClipboardEdit aria-hidden className="size-4" />
              复制原稿开始订正
            </Button>
            {!canCopyOriginal && (
              <p className="text-xs text-muted-foreground">
                本次交卷没有可复制的原稿（缺稿或未固定），从空白开始。
              </p>
            )}
            {createError !== null && (
              <p role="alert" className="text-sm text-destructive">
                {createError}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              className="h-11"
              disabled={creating}
              onClick={() => setCreateOpen(false)}
            >
              取消
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* D8 找回确认 */}
      <Dialog open={recoverOpen} onOpenChange={setRecoverOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>找回草稿为补充稿？</DialogTitle>
            <DialogDescription>
              会把这道题在本机的未同步草稿复制成一份补充稿并开始同步；
              找回的内容只能作为补充材料，不能变成交卷时的原稿。原草稿在本机
              保留不动。
            </DialogDescription>
          </DialogHeader>
          {recoverError !== null && (
            <p role="alert" className="text-sm text-destructive">
              {recoverError}
            </p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              className="h-11"
              disabled={recovering}
              onClick={() => setRecoverOpen(false)}
            >
              取消
            </Button>
            <Button
              type="button"
              variant="destructive"
              className="h-11"
              disabled={recovering}
              onClick={() => void recover()}
            >
              {recovering ? "正在找回…" : "确认找回"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
