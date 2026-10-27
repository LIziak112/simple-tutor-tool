/**
 * 结果页订正入口（2026-10 订正重构，替代旧「展开订正区 → 添加订正弹窗
 * 二选一 → 编辑面板」的三步流程）：
 * - 「订正」是操作行上的直达按钮：点击 → 懒取证据头（折叠零请求不变）
 *   → 已有未封存行则继续、否则自动创建空白行（createCorrectionApi
 *   copyFromOriginal=false——不复制原稿，按最初做题那样重做）→ 打开
 *   CorrectionWorkspace 全屏工作台（题面 + 圈画 + 草稿纸 + 一层保存）；
 * - 命名自动：订正序号 = 已封存数 + 进行中这一份（第 N 次订正），轮次由
 *   roundLabel 标注（第 X 轮练习 · 第 N 次订正），用户不命名；
 * - 按钮态：未封存行存在 → 「继续订正」；已封存 N 份 → 计数徽标；
 * - 历史订正查看走操作行「本题历史」（题目笔记本页含全部轮次与订正列表）；
 * - D8「找回草稿为补充稿」与补充稿同步状态迁至草稿组
 *   （DraftRecoverySection）——那是交卷草稿材料的找回语义，与订正无关。
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { AttemptResultQuestion, NoteHeadData } from "@tutor/contract";
import { ClipboardEdit } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { CorrectionWorkspace } from "@/features/notes/CorrectionWorkspace";
import { sealedCorrectionsOf } from "@/features/notes/correction-display";
import {
  correctionHeadKey,
  openCorrectionOf,
  seedOpenCorrection,
} from "@/features/notes/correction-record";
import { clearCorrectionRecord } from "@/features/notes/note-store";
import { useNoteSessionRef } from "@/features/notes/use-note-head";
import { ApiError, createCorrectionApi } from "@/lib/api";
import { fetchNoteEvidenceApi } from "@/lib/note-endpoints";

export interface CorrectionSectionProps {
  attemptId: string;
  questionId: string;
  /** 卷内题号（1 起，工作台标题用） */
  questionNo: number;
  /** 无障碍标签前缀（如「第 3 题」） */
  ariaPrefix?: string;
  /** 轮次标注（attemptRoundLabel 产物；工作台自动命名的一部分） */
  roundLabel?: string | null;
  /** 结果页题目快照（公开投影——工作台题面呈现；不读答案与判定字段） */
  question: AttemptResultQuestion;
}

export function CorrectionSection({
  attemptId,
  questionId,
  questionNo,
  ariaPrefix = "本题",
  roundLabel = null,
  question,
}: CorrectionSectionProps) {
  const session = useNoteSessionRef();
  const queryClient = useQueryClient();
  const [workspace, setWorkspace] = useState<{
    open: boolean;
    /** 打开工作台时的自动命名序号（已封存数 + 进行中这份） */
    correctionNo: number;
  }>({ open: false, correctionNo: 1 });
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  // ---- 头投影（点击「订正」才拉——结果页 N 张题卡折叠零请求；查询恒不
  //      自动触发（enabled:false），由 start() 内 refetch 驱动；queryFn 内
  //      播种未封存订正行进本地 correction 记录） ----
  const headKey = correctionHeadKey(
    session?.studentId ?? "standby",
    attemptId,
    questionId,
  );
  const headQuery = useQuery({
    queryKey: headKey,
    queryFn: async () => {
      if (session === null) {
        throw new Error("草稿会话未绑定（不应发生：点击守卫已拦）");
      }
      const head = await fetchNoteEvidenceApi("student", attemptId, questionId);
      await seedOpenCorrection(session, attemptId, questionId, head);
      return head;
    },
    enabled: false,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    retry: (count, err) => !(err instanceof ApiError) && count < 2,
  });
  const head = headQuery.data ?? null;
  const openRow = head === null ? null : openCorrectionOf(head);
  const sealedCount = sealedCorrectionsOf(head?.corrections ?? []).length;

  // ---- 直达订正：懒取头 →（无未封存行则建空白行）→ 打开工作台 ----
  const start = async () => {
    if (session === null || starting) return;
    setStartError(null);
    setStarting(true);
    try {
      let current = headQuery.data ?? null;
      if (current === null) {
        const fetched = await headQuery.refetch();
        current = fetched.data ?? null;
        if (current === null) {
          const detail =
            fetched.error instanceof Error ? `：${fetched.error.message}` : "";
          throw new Error(
            detail !== ""
              ? `订正信息读取失败${detail}`
              : "订正信息读取失败，请重试",
          );
        }
      }
      if (openCorrectionOf(current) === null) {
        try {
          current = await createCorrectionApi(attemptId, questionId, {
            copyFromOriginal: false,
          });
          // 新行起步：清旧封存行残留（stale pending/冲突/被拒不灌新行）
          await clearCorrectionRecord(session, {
            attemptId,
            questionId,
            phase: "correction",
          });
        } catch (err) {
          // 409 OPEN_EXISTS（如另一标签页已建行）：重拉头，有未封存行则继续
          const fetched = await headQuery.refetch();
          const refreshed = fetched.data ?? null;
          if (refreshed === null || openCorrectionOf(refreshed) === null) {
            throw err;
          }
          current = refreshed;
        }
      }
      await seedOpenCorrection(session, attemptId, questionId, current);
      queryClient.setQueryData(headKey, current);
      setWorkspace({
        open: true,
        correctionNo: sealedCorrectionsOf(current.corrections).length + 1,
      });
    } catch (err) {
      setStartError(
        err instanceof Error ? err.message : "打开订正失败，请稍后重试",
      );
    } finally {
      setStarting(false);
    }
  };

  const buttonLabel =
    openRow !== null ? `${ariaPrefix}继续订正` : `${ariaPrefix}订正`;

  return (
    <div
      data-slot="correction-section"
      className="flex shrink-0 flex-col items-start gap-1"
    >
      <Button
        type="button"
        variant="outline"
        className="min-h-11 shrink-0 whitespace-nowrap"
        disabled={starting}
        aria-label={
          sealedCount > 0
            ? `${buttonLabel}（已订正 ${sealedCount} 次）`
            : buttonLabel
        }
        title={sealedCount > 0 ? `已订正 ${sealedCount} 次` : undefined}
        onClick={() => void start()}
      >
        <ClipboardEdit aria-hidden className="size-4" />
        {openRow !== null ? "继续订正" : "订正"}
        {sealedCount > 0 && (
          <span className="font-normal text-muted-foreground">
            · {sealedCount}
          </span>
        )}
      </Button>
      {startError !== null && (
        <p
          role="alert"
          className="max-w-64 text-left text-xs text-destructive [overflow-wrap:anywhere]"
        >
          {startError}
        </p>
      )}

      {workspace.open && (
        <CorrectionWorkspace
          attemptId={attemptId}
          questionId={questionId}
          questionNo={questionNo}
          ariaPrefix={ariaPrefix}
          roundLabel={roundLabel}
          correctionNo={workspace.correctionNo}
          question={question}
          onClose={() => setWorkspace((prev) => ({ ...prev, open: false }))}
          onSealed={(sealedHead: NoteHeadData) => {
            queryClient.setQueryData(headKey, sealedHead);
            setWorkspace((prev) => ({ ...prev, open: false }));
          }}
        />
      )}
    </div>
  );
}
