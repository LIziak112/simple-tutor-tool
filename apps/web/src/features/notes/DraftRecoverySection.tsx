/**
 * 草稿找回区（2026-10 订正重构，自 CorrectionSection 迁入草稿组）：
 * - 「找回草稿为补充稿」（D8）：evidence∈{missing,none,legacy_unverified}
 *   且本地 scratch 有未同步内容 → 破坏性次级按钮 + 确认文案 → 本地复制到
 *   phase='supplement' 新记录并触发同步（scratch 本地记录保留不动）；
 * - 「补充稿同步状态」小区块（闸门修复 F3）：仅本地存在 supplement 记录
 *   且非干净态时渲染——conflict 裁决 / denied 重试 / 等待同步的诚实出口，
 *   不再让「已开始同步」在静默停传时成为假话；
 * - 归属草稿组：两者都是「交卷时草稿材料的找回与同步」语义，与订正无关。
 * 挂载即读取（外层草稿面板按需挂载，保证折叠零请求）。
 */

import { useQuery } from "@tanstack/react-query";
import { TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  correctionHeadKey,
  hasRecoverableScratch,
  recoverScratchAsSupplement,
} from "@/features/notes/correction-record";
import { NoteStatusArea } from "@/features/notes/NoteStatusArea";
import { getNoteRecord } from "@/features/notes/note-store";
import { useNoteSessionRef } from "@/features/notes/use-note-head";
import { useNoteRecord } from "@/features/notes/use-note-record";
import { useNoteSyncActions } from "@/features/notes/use-note-sync-actions";
import { ApiError } from "@/lib/api";
import { fetchNoteEvidenceApi } from "@/lib/note-endpoints";

/** D8 找回入口的证据状态集合（原稿未固定族） */
const RECOVERABLE_EVIDENCE: ReadonlySet<string> = new Set([
  "missing",
  "none",
  "legacy_unverified",
]);

export interface DraftRecoverySectionProps {
  attemptId: string;
  questionId: string;
}

export function DraftRecoverySection({
  attemptId,
  questionId,
}: DraftRecoverySectionProps) {
  const session = useNoteSessionRef();
  const headKey = correctionHeadKey(
    session?.studentId ?? "standby",
    attemptId,
    questionId,
  );
  const headQuery = useQuery({
    queryKey: headKey,
    queryFn: () => fetchNoteEvidenceApi("student", attemptId, questionId),
    enabled: session !== null,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    retry: (count, err) => !(err instanceof ApiError) && count < 2,
  });
  const head = headQuery.data ?? null;

  // ---- D8：本地 scratch 是否有未同步内容（挂载后异步复核；head 刷新不
  // 改变本地 scratch 记录，无需随其重判） ----
  const [scratchRecoverable, setScratchRecoverable] = useState(false);
  useEffect(() => {
    if (session === null) return;
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
  }, [session, attemptId, questionId]);
  const [recovered, setRecovered] = useState(false);
  const recoverable =
    !recovered &&
    head?.evidence !== null &&
    head?.evidence !== undefined &&
    RECOVERABLE_EVIDENCE.has(head.evidence.state) &&
    scratchRecoverable;

  // ---- F3：补充稿同步状态（本地存在 supplement 记录且非干净态才渲染） ----
  const supplementView = useNoteRecord(attemptId, questionId, "supplement");
  const supplementActions = useNoteSyncActions(session, {
    attemptId,
    questionId,
    phase: "supplement",
  });
  const supplementNeedsUI =
    supplementView !== null &&
    (supplementView.server !== "synced" || supplementView.local === "failed");

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

  if (!recoverable && !supplementNeedsUI && !recovered) return null;

  return (
    <div
      data-slot="draft-recovery-section"
      className="flex flex-col gap-2 border-t border-border pt-2"
    >
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
          已加入补充稿同步队列（同步异常时在此处处理）；补充稿不能证明
          交卷前已固定，可在「本题历史」查看。
        </p>
      )}

      {/* 补充稿同步状态：conflict 给「保留本机/保留云端」裁决、denied(access)
          给「重试同步」，复用共享 NoteStatusArea（图片维度关——补充稿不在任何
          head 图片投影） */}
      {supplementNeedsUI && (
        <div className="flex flex-col gap-1.5">
          <p className="text-sm font-medium">补充稿同步状态</p>
          <NoteStatusArea
            view={supplementView}
            localLoaded
            label="补充稿"
            images={false}
            resolveError={supplementActions.resolveError}
            onKeepLocal={supplementActions.keepLocal}
            onKeepCloud={supplementActions.keepCloud}
            onRetryDenied={supplementActions.retryDenied}
          />
        </div>
      )}

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
