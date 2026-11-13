import type { PracticeWorkflow } from "@tutor/contract";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
  useRef,
  useState,
} from "react";
import { specOf } from "@/features/keyboard/key-spec";
import type { useKeyboardBindings } from "@/features/keyboard/keyboard-binding-store";
import { isKeyboardDevice } from "@/features/keyboard/keyboard-device";
import type { AnswerCardFilter } from "./AttemptAnswerCard";
import type { useAttemptEditor } from "./AttemptEditorContext";
import { draftStore } from "./draft-store";
import { focusWhenReachable } from "./focus-when-reachable";
import {
  isActivatingTarget,
  isOverlayOpen,
  isSuppressedKeyEvent,
  isTextEditingEvent,
} from "./practice-keyboard";
import type { usePracticeQuestionSubmit } from "./use-practice-question-submit";

/** 显式切题统一收笔、落盘与 AI 收起，滚动推断不发材料回顶信号。 */
export function useAttemptQuestionNavigation({
  editor,
  cardElements,
  forceMountQuestion,
  preserveReadingPosition,
  resolvedSingleQuestionId,
  setSingleQuestionId,
  setCurrentQuestionId,
  singleWorkspaceRef,
  singleMode,
  practiceSubmit,
  flushQuestionLocal,
  collapseForNavigation,
}: {
  editor: ReturnType<typeof useAttemptEditor>;
  cardElements: RefObject<Map<string, HTMLLIElement>>;
  forceMountQuestion: (id: string) => void;
  preserveReadingPosition: (id: string) => void;
  resolvedSingleQuestionId: string | null;
  setSingleQuestionId: (id: string) => void;
  setCurrentQuestionId: (id: string) => void;
  singleWorkspaceRef: RefObject<HTMLDivElement | null>;
  singleMode: boolean;
  practiceSubmit: Pick<
    ReturnType<typeof usePracticeQuestionSubmit>,
    "submittingId"
  >;
  flushQuestionLocal: (id: string) => Promise<boolean>;
  collapseForNavigation: () => Promise<boolean>;
}) {
  const [navigatorOpen, setNavigatorOpen] = useState(false);
  const [navigatorFilter, setNavigatorFilter] =
    useState<AnswerCardFilter>("all");
  const navigatorTrigger = useRef<HTMLButtonElement>(null);
  const navigatorJumping = useRef(false);
  const openNavigator = (trigger: HTMLButtonElement) => {
    navigatorTrigger.current = trigger;
    navigatorJumping.current = false;
    setNavigatorOpen(true);
  };
  // 显式跳题信号（C 口径）：材料列回顶只认显式跳题——题号导航/上一题/
  // 下一题/键盘切题统一走 jumpToQuestion 入口；滚动侦测
  // （useReadingPosition）改写的 currentQuestionId 不发信号。seq 单调递增
  // 供锚点去重，questionId 供锚点判断目标是否属于自己
  const [jumpSignal, setJumpSignal] = useState<{
    questionId: string;
    seq: number;
  } | null>(null);
  const jumpSeqRef = useRef(0);
  // 单题切题保护（M3-D3 §11-5）：本机落盘失败时记下被拦下的目标题（仍停留
  // 本题），就地提示 + 重试；成功切题即清除
  const [singleSwitchBlocked, setSingleSwitchBlocked] = useState<string | null>(
    null,
  );
  const [localSaveRetrying, setLocalSaveRetrying] = useState(false);
  const jumpToQuestion = async (
    id: string,
    focusAnswer = false,
    focusElement?: HTMLElement | null,
  ) => {
    if (editor && !(await editor.request(null))) return;
    if (navigatorOpen) navigatorJumping.current = true;
    setNavigatorOpen(false);
    setCurrentQuestionId(id);
    // 显式跳题信号（C 口径）：只有这条入口发材料回顶信号；seq 单调递增
    // 供锚点去重
    jumpSeqRef.current += 1;
    setJumpSignal({ questionId: id, seq: jumpSeqRef.current });
    // 懒挂载：目标题通常不在视口附近、题卡还没挂载。li 常驻，先滚到占位，
    // 强制挂载后等 `<article>` 出现再对齐滚动与落焦（上限 3 秒，超时退回
    // 原有兜底焦点；跳跃过程中占位会先到视口，观察器本身也会触发挂载）。
    forceMountQuestion(id);
    requestAnimationFrame(() => {
      const deadline = performance.now() + 3000;
      const align = () => {
        const card = cardElements.current.get(id);
        const article = card?.querySelector<HTMLElement>("article");
        if (article === null || article === undefined) {
          card?.scrollIntoView?.({ block: "start", behavior: "auto" });
          if (performance.now() < deadline) {
            requestAnimationFrame(align);
            return;
          }
          focusWhenReachable(focusElement ?? card ?? null);
          return;
        }
        article.scrollIntoView?.({ block: "start", behavior: "auto" });
        // 跳题先登记已对齐的位置；邻题占位随后换成真实题卡时沿用挂载补偿。
        preserveReadingPosition(id);
        const fields = card?.querySelectorAll<HTMLInputElement>(
          'input:not([type="radio"]):not([type="checkbox"])',
        );
        const target = focusAnswer
          ? (Array.from(fields ?? []).find(
              (field) => field.value.trim() === "",
            ) ?? fields?.[0])
          : null;
        const answerControl = card?.querySelector<HTMLElement>(
          'math-field, [data-slot="question-surface"] input[type="radio"], [data-slot="question-surface"] input[type="checkbox"], [data-slot="question-surface"] button',
        );
        // 作答保护（inert——reload 后材料核对未完成）下 focus 静默失败，
        // focusWhenReachable 按帧重试，保护解除后落焦（webkit E2E 回归）。
        // focusElement：调用方指定的落焦点（单题模式=工作区容器），优先于题卡。
        focusWhenReachable(
          target ??
            (focusAnswer ? answerControl : null) ??
            focusElement ??
            article,
        );
      };
      align();
    });
  };
  // 单题跳题（M3-D1）：与列表跳题同一收笔/滚动/聚焦链，另更新单题态与
  // 当前题标记（AI 伴学/导航跟随显式选择，§11 纪律 1 不重建题卡）。
  // M3-D3 切题纪律（§11-5）：切题前只要求当前题**本机**落盘成功（不要求
  // 服务器确认，离线可继续已核对题面）；失败不切题，就地提示与重试，不清
  // 空原稿、不跳页。列表模式自由浏览不设保护；上一题/下一题/导航跳题/键盘
  // 切题统一走本入口。
  // jumpToQuestion 本身非 memo（每渲染重建），此处同法不包 useCallback。
  // M4-D2 §12.1：返回是否切题成功，供 AI 旧任务定位判断是否保留现场。
  const goSingleQuestion = async (
    id: string,
    focusAnswer = false,
  ): Promise<boolean> => {
    // 提交在途禁切题（§7.2 busy）：上一题/下一题/导航均已禁用，此处兜底直调
    if (practiceSubmit.submittingId !== null) return false;
    // 先收笔再切题（闸门修复：原序先切态后收笔，收笔失败=用户选择继续书写
    // 时已切走，错误横幅与键盘守门会指向看不见的旧题——与列表模式同序）
    if (editor && !(await editor.request(null))) return false;
    const from = resolvedSingleQuestionId;
    if (from !== null && from !== id) {
      if (!(await flushQuestionLocal(from))) {
        setSingleSwitchBlocked(id);
        return false;
      }
      // 切题先收起 AI 阅读（M4-D2 §12.1）：在本机落盘保护之后、真正切换
      // 之前，复用 dock 既有收起链（落盘失败不切题）；收起失败时 dock 已
      // 就地提示重试，不再叠加切题保护横幅，保留现场不切换。
      if (!(await collapseForNavigation())) return false;
    }
    setSingleSwitchBlocked(null);
    setSingleQuestionId(id);
    setCurrentQuestionId(id);
    // 单题切题落焦工作区容器（§9.2 ←/→ 判定域；不落题面避免软键盘）；
    // focusAnswer（交卷确认「去补全」）：显式补答意图优先落答案控件
    await jumpToQuestion(id, focusAnswer, singleWorkspaceRef.current);
    return true;
  };
  /** 切题保护的重试入口：本机落盘成功后继续被拦下的那次切题 */
  const retryBlockedSwitch = async (): Promise<void> => {
    const target = singleSwitchBlocked;
    if (target === null || localSaveRetrying) return;
    setLocalSaveRetrying(true);
    try {
      const from = resolvedSingleQuestionId;
      if (from === null || (await flushQuestionLocal(from)))
        await goSingleQuestion(target);
    } finally {
      setLocalSaveRetrying(false);
    }
  };
  const jumpForMode = singleMode ? goSingleQuestion : jumpToQuestion;

  const closeNavigatorFocus = () => {
    if (navigatorJumping.current) return;
    if (singleWorkspaceRef.current?.contains(document.activeElement)) return;
    navigatorTrigger.current?.focus();
  };

  return {
    navigatorOpen,
    setNavigatorOpen,
    navigatorFilter,
    setNavigatorFilter,
    openNavigator,
    closeNavigatorFocus,
    jumpSignal,
    singleSwitchBlocked,
    localSaveRetrying,
    retryBlockedSwitch,
    goSingleQuestion,
    jumpForMode,
  };
}

/** 单题键盘命令与按钮复用同一导航和提交入口。 */
export function useAttemptWorkspaceKeyboard({
  singleMode,
  keyboardShortcuts,
  resolvedSingleQuestionId,
  practiceSubmit,
  singleSwitchBlocked,
  editor,
  attemptId,
  questionIds,
  progressById,
  keyBindings,
  cardElements,
  singleWorkspaceRef,
  timeUp,
  practiceWorkflow,
  goSingleQuestion,
  online,
  denied,
  openSubmitDialog,
  singleAutoSubmit,
  runPracticeSubmit,
  setKeyboardHelpOpen,
}: {
  singleMode: boolean;
  keyboardShortcuts: boolean;
  resolvedSingleQuestionId: string | null;
  practiceSubmit: Pick<
    ReturnType<typeof usePracticeQuestionSubmit>,
    "submittingId" | "finished" | "firstUnsubmittedId"
  >;
  singleSwitchBlocked: string | null;
  editor: ReturnType<typeof useAttemptEditor>;
  attemptId: string;
  questionIds: string[];
  progressById: ReadonlyMap<string, { submittedAt: string | null }>;
  keyBindings: ReturnType<typeof useKeyboardBindings>;
  cardElements: RefObject<Map<string, HTMLLIElement>>;
  singleWorkspaceRef: RefObject<HTMLDivElement | null>;
  timeUp: boolean;
  practiceWorkflow: PracticeWorkflow | undefined;
  goSingleQuestion: (id: string, focusAnswer?: boolean) => Promise<boolean>;
  online: boolean;
  denied: boolean;
  openSubmitDialog: () => Promise<void>;
  singleAutoSubmit: boolean;
  runPracticeSubmit: (id: string) => Promise<void>;
  setKeyboardHelpOpen: (open: boolean) => void;
}) {
  // ---------- 单题专注键盘（M3-D3 §9.2 → 2026-10-28 快捷键体系） ----------
  // 仅 v1 新协议 + 单题模式 + 键盘设备挂载（legacy/lesson 零变化，纯触屏
  // 设备整体静默）；偏好开关关闭全失效。键位来自注册表 + 设置页自定义
  // （keyBindings），固定命令（1–9 选选项）先匹配——改键抢不走选项数字。
  // 守门链：默认抑制态（合成/repeat/修饰键/已被处理）→ 任一弹层打开 → busy →
  // 书写中/纸面展开 → 答案冲突 → 切题保护拦截。一次 keydown 至多一个动作；
  // 键盘发起的提交持同步锁（submit 串行守卫在收笔 await 之后才置位，微任务
  // 窗口内的第二次 Enter 靠此锁挡住）。文本编辑区判定走 composedPath（含
  // MathLive/AI 输入宿主），按钮/链接保留自身 Enter，查看结果永不入键。
  const practiceKeyActionRef = useRef(false);
  const onWorkspaceKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!singleMode || !keyboardShortcuts || !isKeyboardDevice()) return;
    const native = event.nativeEvent;
    if (isSuppressedKeyEvent(native) || isOverlayOpen()) return;
    const currentId = resolvedSingleQuestionId;
    if (currentId === null) return;
    if (
      practiceSubmit.submittingId !== null ||
      singleSwitchBlocked !== null ||
      (editor !== null &&
        (editor.getActive() !== null || editor.getPaper() !== null)) ||
      draftStore.peekAnswerConflicts(attemptId)[currentId] !== undefined
    ) {
      return;
    }
    const currentIndex = questionIds.indexOf(currentId);
    const submitted =
      (progressById.get(currentId)?.submittedAt ?? null) !== null;
    const spec = specOf(native);
    if (spec === null) return;
    if (keyBindings["practice.select-option"].includes(spec)) {
      // 已提交只读题不响应；文本编辑区内数字保持输入语义
      if (submitted || isTextEditingEvent(native)) return;
      const card = cardElements.current.get(currentId);
      const options = card?.querySelectorAll<HTMLInputElement>(
        '[data-slot="question-surface"] input[type="radio"], [data-slot="question-surface"] input[type="checkbox"]',
      );
      const option = options?.[Number(spec) - 1];
      if (option === undefined || option.disabled) return;
      event.preventDefault();
      // 复用既有选项控件链（React onChange → setAnswer → 草稿防丢），不另写
      // 一套答案拼装；原生 click 会把焦点移到选项上，连续键盘导航要求焦点
      // 留在工作区容器
      option.click();
      singleWorkspaceRef.current?.focus();
      return;
    }
    if (keyBindings["practice.submit-or-next"].includes(spec)) {
      if (isTextEditingEvent(native) || isActivatingTarget(native)) return;
      event.preventDefault();
      if (practiceKeyActionRef.current) return;
      practiceKeyActionRef.current = true;
      void (async () => {
        try {
          if (!submitted) {
            // 工作流收紧时 Enter 退为切题/交卷（与主操作位同链）；题目级
            // 参考答案门控已随 v2 自评实现移除（QM 判分框架下逐题提交恒可用）
            if (timeUp || !practiceWorkflow?.canSubmitQuestion) {
              const next = questionIds[currentIndex + 1];
              if (next !== undefined) await goSingleQuestion(next);
              else if (online && !denied) await openSubmitDialog();
              return;
            }
            if (singleAutoSubmit) {
              const next = questionIds[currentIndex + 1];
              if (next !== undefined) await goSingleQuestion(next);
              return;
            }
            // 与主操作按钮同链，空白也可提交。
            await runPracticeSubmit(currentId);
            return;
          }
          // 已提交只导航：查看本次结果永不入键（§9.2）
          if (practiceSubmit.finished) return;
          const next = questionIds[currentIndex + 1];
          if (next !== undefined) {
            await goSingleQuestion(next);
            return;
          }
          const resume = practiceSubmit.firstUnsubmittedId;
          if (resume !== null && resume !== currentId) {
            await goSingleQuestion(resume);
          }
        } finally {
          practiceKeyActionRef.current = false;
        }
      })();
      return;
    }
    // ←→ 切题（可分别改键）：仅工作区容器自身持有焦点时生效，题面/输入/
    // 按钮内的按键保持原生；prev 命中优先于 next（冲突检测拦住同时改同键）
    const step = keyBindings["practice.prev-question"].includes(spec)
      ? -1
      : keyBindings["practice.next-question"].includes(spec)
        ? 1
        : 0;
    if (step !== 0) {
      if (document.activeElement !== event.currentTarget) return;
      event.preventDefault();
      const target = questionIds[currentIndex + step];
      if (target !== undefined) void goSingleQuestion(target);
      return;
    }
    if (keyBindings["practice.open-help"].includes(spec)) {
      if (isTextEditingEvent(native)) return;
      event.preventDefault();
      setKeyboardHelpOpen(true);
    }
  };

  return onWorkspaceKeyDown;
}
