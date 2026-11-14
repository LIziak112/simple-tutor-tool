import type { AttemptDraftData, PracticeLayout } from "@tutor/contract";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { consumeAttemptStartLayoutIntent } from "./attempt-start-intent";
import { focusWhenReachable } from "./focus-when-reachable";
import {
  currentLayout,
  usePracticePreference,
} from "./practice-preference-store";
import {
  firstUnsubmittedQuestionId,
  practiceProtocolOfDraft,
} from "./practice-protocol";

/** 布局与单题题位：只在显式选择、URL 或首次账号绑定时更新。 */
export function useAttemptQuestionLocation({
  data,
  questionIds,
  currentQuestionId,
}: {
  data: AttemptDraftData;
  questionIds: string[];
  currentQuestionId: string | null;
}) {
  // ---------- 做题方式（M3-D1）：v1 新协议卷的列表/单题呈现 ----------
  // 协议形态只信服务端投影：legacy/lesson（无 practiceWorkflow）恒列表，
  // 现有行为零变化（计划 §6.1、§11 纪律 1 与退化边界）。
  const [searchParams, setSearchParams] = useSearchParams();
  const practiceProtocol = practiceProtocolOfDraft(data);
  const practiceWorkflow =
    practiceProtocol === "v1" ? data.practiceWorkflow : undefined;
  // data 基线进度：单题当前题解析锚定它（提交后不因 overlay 变化自动跳题，
  // 切题只随显式动作——§7.2）；回执 overlay 的进度（practiceProgress）用于
  // 导航四态、进度行与题卡只读的即时更新。
  const questionProgress =
    practiceProtocol === "v1" ? (data.questionProgress ?? []) : [];
  // 布局本次作答内自决：进入时按「开始页一次性 transient 预选 → 默认偏好」
  // 取一次（M5-D3 裁决⑨：预选不经服务端，消费即清除；legacy/lesson 也消费
  // 防同会话残留），之后只随显式切换变化，不被偏好变更或后台重取中途拉扯；
  // 不写回默认偏好（§7.1）
  const [practiceLayout, setPracticeLayout] = useState<PracticeLayout>(() => {
    const startIntent = consumeAttemptStartLayoutIntent();
    if (practiceProtocol !== "v1") return "list";
    return startIntent ?? currentLayout();
  });
  // M3-D1.5：硬刷新直达作答页时，布局层的账号绑定 effect 晚于本组件首渲染，
  // 已保存默认布局会在初值时被错过——store 从未绑定变已绑定的那一刻按已
  // 保存默认布局对齐一次；用户显式切换过布局之后，绑定变化与跨标签偏好
  // 变更都不得再拉扯当前选择（§7.1「进入时取一次」语义的补全）
  const explicitLayoutRef = useRef(false);
  const setPracticeLayoutExplicit = useCallback((layout: PracticeLayout) => {
    explicitLayoutRef.current = true;
    setPracticeLayout(layout);
  }, []);
  const { accountId: boundAccountId, keyboardShortcuts } =
    usePracticePreference();
  const prevBoundAccountRef = useRef(boundAccountId);
  useEffect(() => {
    const previous = prevBoundAccountRef.current;
    prevBoundAccountRef.current = boundAccountId;
    if (practiceProtocol !== "v1" || explicitLayoutRef.current) return;
    // 只在「未绑定 → 已绑定」迁移时对齐一次；换绑与解绑不拉扯
    if (previous !== null || boundAccountId === null) return;
    setPracticeLayout(currentLayout());
  }, [boundAccountId, practiceProtocol]);
  const singleMode = practiceProtocol === "v1" && practiceLayout === "single";
  // 单题当前题：显式跳转 > URL q（须属本卷）> 滚动当前题 > 首道未提交 > 第一题
  const [singleQuestionId, setSingleQuestionId] = useState<string | null>(null);
  const resolvedSingleQuestionId = useMemo(() => {
    if (!singleMode) return null;
    if (singleQuestionId !== null && questionIds.includes(singleQuestionId))
      return singleQuestionId;
    const urlQ = searchParams.get("q");
    if (urlQ !== null && questionIds.includes(urlQ)) return urlQ;
    if (currentQuestionId !== null && questionIds.includes(currentQuestionId))
      return currentQuestionId;
    return (
      firstUnsubmittedQuestionId(questionIds, questionProgress) ??
      questionIds[0] ??
      null
    );
  }, [
    singleMode,
    singleQuestionId,
    questionIds,
    searchParams,
    currentQuestionId,
    questionProgress,
  ]);
  const singleIndex =
    resolvedSingleQuestionId === null
      ? -1
      : questionIds.indexOf(resolvedSingleQuestionId);
  // 单题专注工作区容器（M3-D3 §9.2）：tabIndex=-1 可聚焦，←/→ 的判定域。
  const singleWorkspaceRef = useRef<HTMLDivElement | null>(null);
  // §11-5 焦点纪律：进入单题（含菜单切换）与每次切题后焦点落回容器——
  // 方向键域与连续键盘导航的锚点；focusWhenReachable 代数守卫下与
  // jumpToQuestion 落焦链后到者胜（goSingleQuestion 显式传容器，目标一致）。
  useEffect(() => {
    if (!singleMode || resolvedSingleQuestionId === null) return;
    focusWhenReachable(singleWorkspaceRef.current);
  }, [singleMode, resolvedSingleQuestionId]);

  // §11 纪律 7：单题切题 replace 更新 q、回列表清除 q——不加历史条目；
  // 其他查询参数（returnTo/aiFrom）原样保留
  useEffect(() => {
    if (practiceProtocol !== "v1") return;
    const q = searchParams.get("q");
    if (singleMode && resolvedSingleQuestionId !== null) {
      if (q !== resolvedSingleQuestionId) {
        setSearchParams(
          (prev) => {
            const next = new URLSearchParams(prev);
            next.set("q", resolvedSingleQuestionId);
            return next;
          },
          { replace: true },
        );
      }
    } else if (!singleMode && q !== null) {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.delete("q");
          return next;
        },
        { replace: true },
      );
    }
  }, [
    practiceProtocol,
    singleMode,
    resolvedSingleQuestionId,
    searchParams,
    setSearchParams,
  ]);

  return {
    practiceProtocol,
    practiceWorkflow,
    practiceLayout,
    setPracticeLayoutExplicit,
    keyboardShortcuts,
    singleMode,
    resolvedSingleQuestionId,
    setSingleQuestionId,
    singleIndex,
    singleWorkspaceRef,
  };
}
