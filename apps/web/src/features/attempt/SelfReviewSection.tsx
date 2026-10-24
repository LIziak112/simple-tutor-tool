import { useQueryClient } from "@tanstack/react-query";
import type {
  AttemptResultQuestion,
  SelfReviewRecord,
  SelfReviewRequest,
} from "@tutor/contract";
import {
  type SelfReviewVerdict,
  selfReviewConflictCurrentSchema,
} from "@tutor/contract";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ApiError, saveSelfReviewApi } from "@/lib/api";
import { randomUuid } from "@/lib/uuid";

/**
 * 学生对照自评交互件（QM-11，TT-09b）：reference_self 行在答案公布后的
 * 「对了／错了／暂不判断」动作与完成状态呈现。既有 UI 协议沿 v2
 * 「学生对照自评」（2026-10-24）；本组件消费 QM 支线 TT-09a 后端
 * （POST /attempts/:id/questions/:questionId/self-review，verdict 三值 +
 * baseRevision CAS + mutationId 幂等）。
 *
 * 纪律：
 * - 只消费服务端已公布投影（question.selfReview/gradingPolicy 不可伪造，
 *   客户端不推断未公布答案）；教师已判（teacherMark 非空）整块不渲染——
 *   教师判定显示优先（§5.5.2 三层回落），不可被客户端覆盖；
 * - 不自动替学生选、不抢焦点、不自动跳题；动作全为原生按钮（键盘可达），
 *   状态经 role=status、错误经 role=alert 供屏幕阅读器识别；
 * - 失败保留现场（状态/选择不变），同一意图重试复用同一 mutationId
 *   （网络重试同键不重复写）；CAS 409 附 _current 时采纳为最新基线；
 * - 成功后刷新本题与聚合缓存（attempt 前缀 + 讲练/记录/错题/教师）。
 */

/** 本地采用的最新自评事实（成功回执或 409 _current；refetch 落库后由投影接管） */
interface SelfReviewOverride {
  readonly record: SelfReviewRecord | null;
  readonly revision: number;
}

/** 投影键缺省（旧载荷/公布前 null 投影）与 override 的合并读取 */
function currentSelfReviewOf(
  question: AttemptResultQuestion,
  override: SelfReviewOverride | null,
): { record: SelfReviewRecord | null; revision: number } | null {
  const projected = question.selfReview ?? null;
  if (override !== null && override.revision > (projected?.revision ?? -1)) {
    return override;
  }
  return projected;
}

export function SelfReviewSection({
  attemptId,
  question,
}: {
  attemptId: string;
  question: AttemptResultQuestion;
}) {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [override, setOverride] = useState<SelfReviewOverride | null>(null);
  /** 教师竞争 409 后收起动作入口（显示以教师判定为准，等 refetch 落地） */
  const [supersededByTeacher, setSupersededByTeacher] = useState(false);
  /** 同一意图（verdict+基线）重试复用同一 mutationId（§5.5.1 幂等回执） */
  const intentRef = useRef<SelfReviewRequest | null>(null);
  const scope = `${attemptId}:${question.questionId}`;

  // 换题/换卷重置本地状态（宿主按题挂载，此处兜底同位复用）
  useEffect(() => {
    intentRef.current = null;
    setError(null);
    setOverride(null);
    setSupersededByTeacher(false);
    setBusy(false);
  }, [scope]);

  const gradingPolicy = question.gradingPolicy ?? null;
  // 旧行（null）与 auto 行不开放自评；教师已判（或仅评语清除判定后回落自评
  // 的窗口之外）显示走既有批改块/徽章——本组件不重复渲染
  if (
    (gradingPolicy !== "reference_self" && gradingPolicy !== "manual_only") ||
    question.teacherMark !== null
  ) {
    return null;
  }

  const current = currentSelfReviewOf(question, override);
  const record = current?.record ?? null;

  const save = useCallback(
    async (verdict: SelfReviewVerdict) => {
      if (busy) return;
      const baseRevision = current?.revision ?? 0;
      const previous = intentRef.current;
      const request: SelfReviewRequest =
        previous !== null &&
        previous.verdict === verdict &&
        previous.baseRevision === baseRevision
          ? previous
          : { verdict, baseRevision, mutationId: randomUuid() };
      intentRef.current = request;
      setBusy(true);
      setError(null);
      try {
        const data = await saveSelfReviewApi(
          attemptId,
          question.questionId,
          request,
        );
        // 成功采纳：record 来自回执；undecided 清除后 record=null、revision=base+1
        setOverride({ record: data.selfReview, revision: baseRevision + 1 });
        intentRef.current = null;
        // 刷新本题与聚合缓存（结果/草稿经 attempt 前缀；讲练页/记录/错题/
        // 教师面消费同一服务端事实；context 冻结投影幂等重取无副作用）
        void client.invalidateQueries({
          queryKey: ["student", "attempt", attemptId],
        });
        void client.invalidateQueries({ queryKey: ["student", "lesson"] });
        void client.invalidateQueries({ queryKey: ["student", "records"] });
        void client.invalidateQueries({
          queryKey: ["student", "wrong-questions"],
        });
        void client.invalidateQueries({ queryKey: ["teacher"] });
      } catch (cause) {
        if (cause instanceof ApiError) {
          setError(cause.message);
          if (cause.code === "SELF_REVIEW_REVISION_CONFLICT") {
            // CAS 冲突：采纳 _current 为最新基线（下次提交直接用新 revision）
            const parsed = selfReviewConflictCurrentSchema.safeParse(
              cause.extra?._current,
            );
            if (parsed.success) {
              setOverride({
                record: parsed.data.selfReview,
                revision: parsed.data.revision,
              });
            }
          } else if (cause.code === "SELF_REVIEW_TEACHER_MARKED") {
            // 教师竞争：动作入口收起（显示以教师判定为准），刷新投影
            setSupersededByTeacher(true);
            void client.invalidateQueries({
              queryKey: ["student", "attempt", attemptId],
            });
          } else if (
            cause.code === "SELF_REVIEW_NOT_RELEASED" ||
            cause.code === "SELF_REVIEW_NOT_ALLOWED"
          ) {
            // UI 状态过期（教师改设置/策略不符）：刷新本题投影，按钮待新投影
            void client.invalidateQueries({
              queryKey: ["student", "attempt", attemptId],
            });
          }
        } else {
          setError(
            cause instanceof Error ? cause.message : "自评保存失败，请重试",
          );
        }
      } finally {
        setBusy(false);
      }
    },
    [attemptId, busy, client, current, question.questionId],
  );

  // manual_only：无参考答案，不假装可自动判断——只提示待老师批改
  if (gradingPolicy === "manual_only") {
    return (
      <section
        aria-label="本题自评"
        className="flex flex-col gap-1 text-sm text-muted-foreground"
      >
        <p role="status">暂无参考答案，不能自动判断——待老师批改后显示判定。</p>
      </section>
    );
  }

  const status =
    record === null
      ? "已完成，待自评"
      : record.verdict === "correct"
        ? "自评正确"
        : "自评错误";

  return (
    <section
      aria-label="本题自评"
      className="flex flex-col gap-2 text-sm"
      data-slot="self-review"
    >
      <p role="status" className="font-medium">
        {status}
      </p>
      {!supersededByTeacher && (
        <>
          <p className="text-xs text-muted-foreground">
            对照参考答案和解析判断，无需老师再次确认；可随时修正。
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              className="min-h-11"
              variant={record?.verdict === "correct" ? "default" : "outline"}
              aria-pressed={record?.verdict === "correct"}
              disabled={busy}
              onClick={() => void save("correct")}
            >
              对了
            </Button>
            <Button
              size="sm"
              className="min-h-11"
              variant={record?.verdict === "wrong" ? "default" : "outline"}
              aria-pressed={record?.verdict === "wrong"}
              disabled={busy}
              onClick={() => void save("wrong")}
            >
              错了
            </Button>
            <Button
              size="sm"
              className="min-h-11"
              variant="ghost"
              disabled={busy || record === null}
              onClick={() => void save("undecided")}
            >
              暂不判断
            </Button>
          </div>
        </>
      )}
      {busy && <p className="text-xs text-muted-foreground">正在保存自评…</p>}
      {error !== null && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}
