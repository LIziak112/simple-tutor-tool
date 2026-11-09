import type { PracticeQuestionProgress } from "@tutor/contract";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
  useEffect,
  useRef,
} from "react";
import type { ResolvedKeyBindings } from "@/features/keyboard/command-registry";
import { matchesKeyBinding } from "@/features/keyboard/command-registry";
import { specOf } from "@/features/keyboard/key-spec";
import { isKeyboardDevice } from "@/features/keyboard/keyboard-device";
import { draftStore } from "./draft-store";
import {
  isActivatingTarget,
  isOverlayOpen,
  isSuppressedKeyEvent,
  isTextEditingEvent,
} from "./practice-keyboard";

/** 题卡内选项控件（判断/单选/多选）选择器：复用既有控件链，不另拼答案 */
const OPTION_SELECTOR =
  '[data-slot="question-surface"] input[type="radio"], [data-slot="question-surface"] input[type="checkbox"]';

/** 字母键：不带控件原生语义（方向键在单选组内会移动选中），守门更宽 */
function isLetterSpec(spec: string): boolean {
  return spec.length === 1 && /[A-Za-z]/.test(spec);
}

/**
 * 作答页键盘派发 hook（阶段 B 做题工作区改版，2026-11；由 AttemptSession 的
 * onWorkspaceKeyDown 抽出并扩到列表模式）。
 *
 * 单题专注（M3-D3 §9.2 → 2026-10-28 快捷键体系）：仅 v1 新协议 + 单题模式 +
 * 键盘设备挂载（legacy/lesson 零变化，纯触屏设备整体静默）；偏好开关关闭全
 * 失效。键位来自注册表 + 设置页自定义（keyBindings），固定命令（1–9 选选项）
 * 先匹配——改键抢不走选项数字。守门链：默认抑制态（合成/repeat/修饰键/已被
 * 处理）→ 任一弹层打开 → busy → 书写中/纸面展开 → 答案冲突 → 切题保护拦截。
 * 一次 keydown 至多一个动作；键盘发起的提交持同步锁（submit 串行守卫在收笔
 * await 之后才置位，微任务窗口内的第二次 Enter 靠此锁挡住）。文本编辑区判定
 * 走 composedPath（含 MathLive/AI 输入宿主），按钮/链接保留自身 Enter，查看
 * 结果永不入键。方向键切题仍要求工作区容器自身持有焦点；J/K 字母键在输入区
 * 外随处可按（字母不带控件原生语义）。
 *
 * 列表模式（阶段 B 新增，scope=practice 的命令）：文档级监听，只派发切题
 * （J/K 等字母键——方向键在列表里保留原生滚动语义，不劫持）与选选项（1–9
 * 作用于「焦点所在题卡 ∥ 滚动当前题」）；守门链同口径（抑制态/弹层/文本
 * 编辑区/已提交只读/答案冲突）。Enter 主动作、? 帮助不进列表模式。
 */
export interface AttemptKeyboardInput {
  attemptId: string;
  singleMode: boolean;
  /** 偏好总开关（设置页「键盘快捷键」） */
  keyboardShortcuts: boolean;
  keyBindings: ResolvedKeyBindings;
  questionIds: readonly string[];
  /** 单题模式解析后的当前题；列表模式为 null */
  resolvedSingleQuestionId: string | null;
  /** 列表模式的滚动当前题（useReadingPosition 跟踪） */
  currentQuestionId: string | null;
  progressById: ReadonlyMap<string, PracticeQuestionProgress>;
  /** v1 卷：逐题提交在途题 / 全部收尾 / 首道未提交 */
  practiceSubmit: {
    submittingId: string | null;
    finished: boolean;
    firstUnsubmittedId: string | null;
  };
  singleSwitchBlocked: string | null;
  editor: {
    getActive(): unknown;
    getPaper(): unknown;
  } | null;
  cardElements: RefObject<Map<string, HTMLLIElement>>;
  singleWorkspaceRef: RefObject<HTMLDivElement | null>;
  canSubmitQuestion: boolean;
  singleAutoSubmit: boolean;
  online: boolean;
  denied: boolean;
  goSingleQuestion: (id: string, focusAnswer?: boolean) => Promise<boolean>;
  jumpToQuestion: (id: string) => Promise<void>;
  openSubmitDialog: () => Promise<void>;
  runPracticeSubmit: (questionId: string) => Promise<void>;
  openKeyboardHelp: () => void;
}

/** 焦点所在题卡的题号（列表模式选选项的首选目标；焦点不在任何题卡时为 null） */
function focusedQuestionId(
  cards: ReadonlyMap<string, HTMLLIElement>,
): string | null {
  const active = document.activeElement;
  if (active === null || active === document.body) return null;
  for (const [questionId, element] of cards) {
    if (element.contains(active)) return questionId;
  }
  return null;
}

/** 在题卡内按序号点选选项（复用 React onChange → setAnswer → 草稿防丢链） */
function clickOption(card: HTMLLIElement | undefined, spec: string): boolean {
  const options = card?.querySelectorAll<HTMLInputElement>(OPTION_SELECTOR);
  const option = options?.[Number(spec) - 1];
  if (option === undefined || option.disabled) return false;
  option.click();
  return true;
}

export function useAttemptKeyboard(input: AttemptKeyboardInput): {
  /** 单题工作区容器的 onKeyDown（列表模式不挂） */
  onWorkspaceKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
} {
  // 最新输入放 ref：文档级监听只随模式/开关重挂，不随每次渲染重订阅
  const latest = useRef(input);
  latest.current = input;
  const practiceKeyActionRef = useRef(false);

  const onWorkspaceKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const state = latest.current;
    if (!state.singleMode || !state.keyboardShortcuts || !isKeyboardDevice())
      return;
    const native = event.nativeEvent;
    if (isSuppressedKeyEvent(native) || isOverlayOpen()) return;
    const currentId = state.resolvedSingleQuestionId;
    if (currentId === null) return;
    if (
      state.practiceSubmit.submittingId !== null ||
      state.singleSwitchBlocked !== null ||
      (state.editor !== null &&
        (state.editor.getActive() !== null ||
          state.editor.getPaper() !== null)) ||
      draftStore.peekAnswerConflicts(state.attemptId)[currentId] !== undefined
    ) {
      return;
    }
    const currentIndex = state.questionIds.indexOf(currentId);
    const submitted =
      (state.progressById.get(currentId)?.submittedAt ?? null) !== null;
    const spec = specOf(native);
    if (spec === null) return;
    const keys = state.keyBindings;
    if (matchesKeyBinding(keys["practice.select-option"], spec)) {
      // 已提交只读题不响应；文本编辑区内数字保持输入语义
      if (submitted || isTextEditingEvent(native)) return;
      const card = state.cardElements.current.get(currentId);
      const options = card?.querySelectorAll<HTMLInputElement>(OPTION_SELECTOR);
      const option = options?.[Number(spec) - 1];
      if (option === undefined || option.disabled) return;
      event.preventDefault();
      // 复用既有选项控件链（React onChange → setAnswer → 草稿防丢），不另写
      // 一套答案拼装；原生 click 会把焦点移到选项上，连续键盘导航要求焦点
      // 留在工作区容器
      option.click();
      state.singleWorkspaceRef.current?.focus();
      return;
    }
    if (matchesKeyBinding(keys["practice.submit-or-next"], spec)) {
      if (isTextEditingEvent(native) || isActivatingTarget(native)) return;
      event.preventDefault();
      if (practiceKeyActionRef.current) return;
      practiceKeyActionRef.current = true;
      void (async () => {
        try {
          if (!submitted) {
            // 工作流收紧时 Enter 退为切题/交卷（与主操作位同链）；题目级
            // 参考答案门控已随 v2 自评实现移除（QM 判分框架下逐题提交恒可用）
            if (!state.canSubmitQuestion) {
              const next = state.questionIds[currentIndex + 1];
              if (next !== undefined) await state.goSingleQuestion(next);
              else if (state.online && !state.denied)
                await state.openSubmitDialog();
              return;
            }
            if (state.singleAutoSubmit) {
              const next = state.questionIds[currentIndex + 1];
              if (next !== undefined) await state.goSingleQuestion(next);
              return;
            }
            // 与主操作按钮同链，空白也可提交。
            await state.runPracticeSubmit(currentId);
            return;
          }
          // 已提交只导航：查看本次结果永不入键（§9.2）
          if (state.practiceSubmit.finished) return;
          const next = state.questionIds[currentIndex + 1];
          if (next !== undefined) {
            await state.goSingleQuestion(next);
            return;
          }
          const resume = state.practiceSubmit.firstUnsubmittedId;
          if (resume !== null && resume !== currentId) {
            await state.goSingleQuestion(resume);
          }
        } finally {
          practiceKeyActionRef.current = false;
        }
      })();
      return;
    }
    // 切题（可分别改键）：方向键仅工作区容器自身持有焦点时生效，题面/输入/
    // 按钮内的按键保持原生；J/K 字母键在文本编辑区外随处可按（字母不带控件
    // 原生语义）。prev 命中优先于 next（冲突检测拦住同时改同键）
    const step = matchesKeyBinding(keys["practice.prev-question"], spec)
      ? -1
      : matchesKeyBinding(keys["practice.next-question"], spec)
        ? 1
        : 0;
    if (step !== 0) {
      if (isLetterSpec(spec)) {
        if (isTextEditingEvent(native)) return;
      } else if (document.activeElement !== event.currentTarget) return;
      event.preventDefault();
      const target = state.questionIds[currentIndex + step];
      if (target !== undefined) void state.goSingleQuestion(target);
      return;
    }
    if (matchesKeyBinding(keys["practice.open-help"], spec)) {
      if (isTextEditingEvent(native)) return;
      event.preventDefault();
      state.openKeyboardHelp();
    }
  };

  // 列表模式：文档级监听（J/K 切题 + 1–9 选选项）
  const { singleMode, keyboardShortcuts } = input;
  useEffect(() => {
    if (singleMode || !keyboardShortcuts) return;
    const handler = (event: KeyboardEvent) => {
      const state = latest.current;
      if (state.singleMode || !state.keyboardShortcuts || !isKeyboardDevice())
        return;
      if (isSuppressedKeyEvent(event) || isOverlayOpen()) return;
      if (isTextEditingEvent(event)) return;
      const spec = specOf(event);
      if (spec === null) return;
      const keys = state.keyBindings;
      const cards = state.cardElements.current;
      if (matchesKeyBinding(keys["practice.select-option"], spec)) {
        const targetId = focusedQuestionId(cards) ?? state.currentQuestionId;
        if (targetId === null) return;
        // v1 卷已提交只读行不响应；答案冲突待裁决不改写
        if (
          (state.progressById.get(targetId)?.submittedAt ?? null) !== null ||
          draftStore.peekAnswerConflicts(state.attemptId)[targetId] !==
            undefined
        )
          return;
        if (clickOption(cards.get(targetId), spec)) event.preventDefault();
        return;
      }
      // 列表模式只认字母键切题：方向键保留页面原生滚动语义
      if (!isLetterSpec(spec)) return;
      const step = matchesKeyBinding(keys["practice.prev-question"], spec)
        ? -1
        : matchesKeyBinding(keys["practice.next-question"], spec)
          ? 1
          : 0;
      if (step === 0) return;
      const currentIndex =
        state.currentQuestionId === null
          ? -1
          : state.questionIds.indexOf(state.currentQuestionId);
      // 尚无当前题（刚打开、未滚动）：J 到第一题，K 不动
      const target =
        currentIndex === -1
          ? step > 0
            ? state.questionIds[0]
            : undefined
          : state.questionIds[currentIndex + step];
      if (target === undefined) return;
      event.preventDefault();
      void state.jumpToQuestion(target);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [singleMode, keyboardShortcuts]);

  return { onWorkspaceKeyDown };
}
