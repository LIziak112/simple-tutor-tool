import {
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useState,
} from "react";
import { errorMessageOf } from "./error-text";

/**
 * SAI-19 伴学栏布局控制器（B10）：
 * - 布局状态区分宽屏 dock、窄屏独立面板（panel）与关闭，基于容器实测
 *   可用宽度判定，不固定全设备比例（需求规格 §7.3）；
 * - 打开 AI 栏前对当前题收笔并等本机落盘（复用 SAI-10 的 editor.flush），
 *   失败不重排、保留原题与当前纸面（§7.2）；
 * - dock 空间不足时收起左侧答题卡并记录原状态；关闭 AI 栏或空间回补时，
 *   仅在用户未另行操作的前提下恢复（§7.2，不与用户抢控制）；
 * - 宽度变化（旋转/分屏/缩放）重新判定模式，不可用宽度退为面板模式，
 *   主区与 AI 面板不互相挤爆。
 * 视图壳见 AiCompanionRail.tsx；本文件只做状态与测量。
 */

/** dock 模式所需的最小容器宽度（低于则退为独立面板） */
export const AI_COMPANION_DOCK_MIN_WIDTH = 960;
/** dock 模式下保持答题卡展开所需的最小容器宽度（低于则自动收起让位） */
export const AI_COMPANION_NAV_EXPAND_MIN_WIDTH = 1280;
/** 416px 对照栏 + 16px间距 + 44px折叠导航 + 24px间距 + 560px题列。 */
export const AI_COMPANION_COMPARE_MIN_WIDTH = 1060;

/** 打开时同步读取当前容器，避免路由首帧测量尚未发布而误判为空间不足。 */
export function hasAiCompareSpace(element: HTMLElement | null): boolean {
  if (!element) return false;
  const rect = element.getBoundingClientRect();
  const scale =
    element.offsetWidth > 0 && rect.width > 0
      ? rect.width / element.offsetWidth
      : 1;
  return rect.width / scale >= AI_COMPANION_COMPARE_MIN_WIDTH;
}

/** 布局控制器对编辑器上下文的最小结构性依赖（AttemptEditorContext 满足） */
export interface AiCompanionLayoutEditor {
  flush(
    questionId: string,
    kinds?: readonly ("annotation" | "scratch" | "answerInk")[],
  ): Promise<void>;
}

export interface AiCompanionLayoutController {
  /** AI 栏是否打开 */
  open: boolean;
  /** 打开时的呈现模式：宽屏 dock / 窄屏独立面板（关闭时无意义） */
  mode: "dock" | "panel";
  /** 现有答题卡折叠按钮应呈现的实效状态（用户选择 ∨ AI 覆盖） */
  navigatorCollapsed: boolean;
  /** 打开失败（本机落盘失败）时的如实提示；成功打开后清除 */
  error: string | null;
  /** 面板元素 id（触发按钮 aria-controls 指向） */
  panelId: string;
  /** 保证题面可用时才允许学生主动固定对照。 */
  canDock: boolean;
  /** 打开 AI 栏：先收笔等本机落盘，失败返回 false 且布局不变 */
  openPanel(questionId?: string): Promise<boolean>;
  /** 关闭 AI 栏；按恢复承诺还原答题卡 */
  closePanel(): void;
  /** 用户手动切换答题卡折叠（覆盖期间操作＝另行操作，取消恢复承诺） */
  toggleNavigator(): void;
}

export function useAiCompanionLayout({
  containerRef,
  editor,
  currentQuestionId,
  dockEnabled = true,
}: {
  /** 主区 + AI 面板共同所在的容器（实测可用宽度的测量对象） */
  containerRef: RefObject<HTMLElement | null>;
  editor: AiCompanionLayoutEditor | null;
  currentQuestionId: string | null;
  dockEnabled?: boolean;
}): AiCompanionLayoutController {
  const [open, setOpen] = useState(false);
  const [width, setWidth] = useState<number | null>(null);
  const [userCollapsed, setUserCollapsed] = useState(false);
  /**
   * dock 空间不足时的答题卡覆盖（true=代为收起）。覆盖存在本身即
   * 「关闭/空间回补时恢复」的承诺（用户另行操作会连覆盖带承诺一起取消），
   * 不需要单独的 restorePromise 状态。
   */
  const [navOverride, setNavOverride] = useState(false);
  /**
   * 互斥让位（§7.2）：用户在 dock 空间不足时主动展开答题卡，AI 面板
   * 让位为独立面板，不把题目和纸面挤到不可用宽度；空间回补或用户重新
   * 收起答题卡时解除。
   */
  const [yieldDock, setYieldDock] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const panelId = useId();

  // 实测可用宽度：ResizeObserver + resize/visualViewport 兜底；CSS 缩放
  // 须还原为布局单位（同 AttemptWorkspace 测量纪律）。1px 抖动内不重判。
  useLayoutEffect(() => {
    const element = containerRef.current;
    if (element === null) return;
    const measure = () => {
      const rect = element.getBoundingClientRect();
      const scale =
        element.offsetWidth > 0 && rect.width > 0
          ? rect.width / element.offsetWidth
          : 1;
      const next = rect.width / scale;
      setWidth((previous) =>
        previous === null || Math.abs(previous - next) >= 1 ? next : previous,
      );
    };
    measure();
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(measure);
    observer?.observe(element);
    window.addEventListener("resize", measure);
    window.visualViewport?.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
      window.visualViewport?.removeEventListener("resize", measure);
    };
  }, [containerRef]);

  const mode =
    width === null || width < AI_COMPANION_DOCK_MIN_WIDTH || yieldDock
      ? "panel"
      : "dock";
  const navFitsAlongDock =
    width !== null && width >= AI_COMPANION_NAV_EXPAND_MIN_WIDTH;

  // dock 下空间不足以同时容纳题面、答题卡与 AI 面板时收起答题卡让位；
  // 空间回补（分屏拖宽、旋转回横屏等）时在用户未另行操作的前提下恢复。
  const needsCollapse =
    open &&
    dockEnabled &&
    mode === "dock" &&
    !navFitsAlongDock &&
    !userCollapsed;
  useEffect(() => {
    if (needsCollapse && !navOverride) setNavOverride(true);
    else if (!needsCollapse && navOverride) setNavOverride(false);
  }, [needsCollapse, navOverride]);
  // 互斥让位在空间回补后解除（AI 回 dock，答题卡保持用户展开的选择）
  useEffect(() => {
    if (yieldDock && navFitsAlongDock) setYieldDock(false);
  }, [yieldDock, navFitsAlongDock]);

  const openPanel = useCallback(
    async (questionId?: string) => {
      if (open) return true;
      // 先收笔并等本机落盘（SAI-10 flush：不改 active/paper、不卸载控制器、
      // 不清撤销历史）；失败向前抛出——布局保持原状，不重排。
      const flushQuestionId = questionId ?? currentQuestionId;
      if (editor !== null && flushQuestionId !== null) {
        try {
          await editor.flush(flushQuestionId);
        } catch (cause) {
          setError(errorMessageOf(cause, "本机稿未保存，AI 助教未打开"));
          return false;
        }
      }
      setError(null);
      setOpen(true);
      return true;
    },
    [open, editor, currentQuestionId],
  );

  const closePanel = useCallback(() => {
    setOpen(false);
    // 仅在用户未另行操作时恢复答题卡原状态（toggleNavigator 已取消覆盖）
    if (navOverride) setNavOverride(false);
    setYieldDock(false);
  }, [navOverride]);

  const toggleNavigator = useCallback(() => {
    if (navOverride) {
      // 覆盖期间的主动操作：尊重用户新选择（展开），覆盖连同恢复承诺
      // 一起取消；窄空间互斥——AI 面板让位为独立面板，不与用户抢控制。
      setNavOverride(false);
      setUserCollapsed(false);
      setYieldDock(true);
    } else if (userCollapsed) {
      setUserCollapsed(false);
      // 用户主动展开（此前是自己收的）：dock 下空间仍不足时同样让位
      if (open && !navFitsAlongDock) setYieldDock(true);
    } else {
      setUserCollapsed(true);
      // 用户收起答题卡：空间让出，AI 不再需要让位
      setYieldDock(false);
    }
  }, [navOverride, userCollapsed, open, navFitsAlongDock]);

  return {
    open,
    mode,
    navigatorCollapsed: userCollapsed || navOverride,
    error,
    panelId,
    canDock: width !== null && width >= AI_COMPANION_COMPARE_MIN_WIDTH,
    openPanel,
    closePanel,
    toggleNavigator,
  };
}
