import type {
  AiTaskPublic,
  AttemptQuestionPublic,
  StudentAiDisplayLayout,
} from "@tutor/contract";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AiCompanionPanelBody,
  AiCompanionTrigger,
} from "@/features/student-ai/AiCompanionRail";
import {
  AiCompanionComposer,
  AiCompanionQuickButtons,
  AiCompanionStatusPanel,
  DRAFT_PAPER_LABEL,
  FORMAL_INK_PAPER_LABEL,
} from "@/features/student-ai/AiCompanionSession";
import {
  AiConversationPanel,
  useAiConversationController,
} from "@/features/student-ai/AiConversationPanel";
import type { AiCompanionLayoutController } from "@/features/student-ai/ai-companion-layout";
import {
  AiCompareActiveContext,
  hasAiCompareSpace,
  useAiCompanionLayout,
} from "@/features/student-ai/ai-companion-layout";
import {
  type AiMaterialAvailability,
  type AiSendController,
  DEFAULT_AI_MATERIALS,
  studentModeReasonText,
  useAiSendController,
} from "@/features/student-ai/use-ai-send-controller";
import { fetchStudentAiTaskApi } from "@/lib/api";
import {
  AiReadingMemoryContext,
  useAiReadingMemory,
} from "./AiReadingWorkspace";
import { CHANNEL_LABEL } from "./ai-channel-label";
import { useAiDisplayPreference } from "./ai-display-preference-store";

/**
 * SAI-22 伴学栏共享装配（B12 执行步骤 1）：布局控制器 + 发送控制器 + 会话
 * 面板 + 打开绑定的一次性接线从作答页（AttemptSession）抽出，各来源页面只
 * 传本次身份（attemptId + 题集）与阶段（currentQuestionId / editor /
 * materials）。SAI-19/20/21 的语义（打开前收笔、显式绑定不随滚动重绑、
 * 按题草稿隔离、幂等发送、回信门禁）全部保留在本装配与下游单源内。
 *
 * 页面接线：
 * - trigger：放页面头部动作位（如 AttemptHeader actions / 讲练 HeaderBar）；
 * - inlineForQuestion：将当前工作区放到所属完整题卡之后；
 * - rail(children)：稳定包住主内容，宽屏主动固定时呈现同一工作区；
 * - controller：布局状态（navigatorCollapsed 等）供页面折叠答题卡。
 *
 * 打开绑定：仅在打开瞬间绑定当时 currentQuestionId（SAI-20 显式动作语义；
 * 滚动不重绑）。currentQuestionId 由页面自跟踪——作答页=阅读当前题，
 * 结果页=回看当前题，讲练=当前作答题。
 */

/** 材料可选面重导出（单源在 use-ai-send-controller） */
export type { AiMaterialAvailability };

export interface UseAiCompanionDockHost {
  readonly attemptId: string;
  /** 本卷题集（发送校验 + 材料采集输入；复盘态传 { id } 最小引用即可） */
  readonly questions: readonly (
    | AttemptQuestionPublic
    | { readonly id: string }
  )[];
  /** 手写题（solve/apply/find-error）采集正式手写，其余采集草稿 */
  readonly isHandwritten: (questionId: string) => boolean;
  /** 绑定题的题面元素（材料收起/未挂载时为 null） */
  readonly surfaceOf: (questionId: string) => HTMLElement | null;
  /** 收笔并等本题本机落盘（AttemptEditorContext.flush；无编辑器传空实现） */
  readonly flush: (questionId: string) => Promise<void>;
  /** 采集材料页头（如「第 27 题 · 作业名」） */
  readonly titleOf: (questionId: string) => string;
  /** 绑定题显示名（如「第 3 题」）；不在卷内 → null（面板显示未绑定） */
  readonly labelOf: (questionId: string) => string | null;
  /** 打开瞬间的绑定/收笔目标题（页面自跟踪；null = 无当前题） */
  readonly currentQuestionId: string | null;
  /** 布局控制器的编辑器（打开前收笔；null = 无可收笔对象直接打开） */
  readonly editor: Parameters<typeof useAiCompanionLayout>[0]["editor"];
  /** 材料可选面（缺省圈画+纸面；讲练/结果页按实际能力收窄） */
  readonly materials?: AiMaterialAvailability | undefined;
  /** 入口名（作答态「AI 助教」缺省；结果页完成后按 §7.5 传「AI 复盘」） */
  readonly triggerLabel?: string | undefined;
  /** 作答材料恢复成功后才消费跨页定位；结果页无编辑材料时缺省为就绪。 */
  readonly ready?: boolean | undefined;
  /**
   * 统一切题入口（M4-D2 §12.1：旧任务定位先切题再展开）。单题专注模式
   * 由页面注入 goSingleQuestion（含收笔/落盘/AI 收起保护）；失败返回
   * false，定位流程保留现场不切换。未注入时视为已就位（列表等场景）。
   */
  readonly goToQuestion?:
    | ((questionId: string) => Promise<boolean>)
    | undefined;
}

/**
 * 单题专注模式切题守卫（M4-D2 §12.1）：宿主注入 goToQuestion 时先经统一
 * 切题入口（含收笔/落盘/AI 收起保护）；未注入（列表等场景）视为已就位。
 * 返回是否已在目标题上可继续操作。
 */
const ensureAtQuestion = async (
  host: UseAiCompanionDockHost,
  questionId: string,
): Promise<boolean> => {
  if (host.goToQuestion === undefined) return true;
  return host.goToQuestion(questionId);
};

export function useAiCompanionDock(host: UseAiCompanionDockHost) {
  const { attemptId, questions, currentQuestionId, editor, labelOf } = host;
  const location = useLocation();
  const navigate = useNavigate();
  // 异步定位回写地址时按最新 search 重算（统一切题可能已改写 q）
  const locationRef = useRef(location);
  locationRef.current = location;
  const railRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const returnAnchorRef = useRef<{
    element: HTMLButtonElement;
    top: number;
  } | null>(null);
  const preference = useAiDisplayPreference();
  const readingMemory = useAiReadingMemory(attemptId);
  const [sessionLayout, setSessionLayout] =
    useState<StudentAiDisplayLayout>("inline");
  const [presentation, setPresentation] =
    useState<StudentAiDisplayLayout>("inline");
  const [enlarged, setEnlarged] = useState(false);
  const dialogTitleRef = useRef<HTMLHeadingElement>(null);
  const dialogContentRef = useRef<HTMLDivElement>(null);
  const restoringPresentationRef = useRef(false);
  const [workingQuestions, setWorkingQuestions] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [presentationError, setPresentationError] = useState<string | null>(
    null,
  );
  const transitionRef = useRef(false);
  const controller = useAiCompanionLayout({
    containerRef: railRef,
    editor,
    currentQuestionId,
    dockEnabled: presentation === "side",
  });
  const send = useAiSendController({
    attemptId,
    questions,
    isHandwritten: host.isHandwritten,
    surfaceOf: host.surfaceOf,
    flush: host.flush,
    titleOf: host.titleOf,
    active: controller.open,
    ...(host.materials !== undefined ? { materials: host.materials } : {}),
  });

  // 只在显式打开成功后绑定；不再用阅读位置效应覆盖刚选中的题目。
  const bind = send.bind;
  const entryOf = (questionId: string) =>
    Array.from(
      railRef.current?.querySelectorAll<HTMLButtonElement>(
        "[data-ai-trigger-question]",
      ) ?? [],
    ).find((element) => element.dataset.aiTriggerQuestion === questionId);
  const openForQuestion = async (
    questionId: string,
    trigger?: HTMLButtonElement,
  ) => {
    if (host.ready === false) {
      setPresentationError("作答材料尚未恢复，请完成恢复后重新打开助教");
      return false;
    }
    if (transitionRef.current) return false;
    transitionRef.current = true;
    try {
      // 已开栏切到另一题时也先保存原题；不能绕过 openPanel 的首次保护。
      if (
        controller.open &&
        send.boundQuestionId !== null &&
        send.boundQuestionId !== questionId
      ) {
        try {
          await host.flush(send.boundQuestionId);
          await host.flush(questionId);
        } catch {
          setPresentationError("当前稿件未保存，请重试保存后再切换题目");
          return false;
        }
      }
      if (!controller.open) {
        try {
          await host.flush(questionId);
        } catch {
          setPresentationError("当前稿件未保存，请重试保存后再打开助教");
          return false;
        }
      }
      const opened = await controller.openPanel(questionId);
      if (opened) {
        if (!controller.open) {
          setSessionLayout(preference.layout);
          setPresentation(
            preference.layout === "side" && !hasAiCompareSpace(railRef.current)
              ? "dialog"
              : preference.layout,
          );
          setEnlarged(false);
        }
        if (trigger) {
          triggerRef.current = trigger;
          returnAnchorRef.current = {
            element: trigger,
            top: trigger.getBoundingClientRect().top,
          };
        }
        bind(questionId);
        setPresentationError(null);
      }
      return opened;
    } finally {
      transitionRef.current = false;
    }
  };

  const boundQuestionId = send.boundQuestionId;
  const boundLabel = boundQuestionId !== null ? labelOf(boundQuestionId) : null;
  const paperLabel =
    boundQuestionId !== null && host.isHandwritten(boundQuestionId)
      ? FORMAL_INK_PAPER_LABEL
      : DRAFT_PAPER_LABEL;

  const materials = host.materials ?? DEFAULT_AI_MATERIALS;
  const conversation = useAiConversationController(send, controller.open);
  const returnParams = new URLSearchParams(location.search);
  for (const key of ["aiTask", "aiQuestion", "aiCompose"])
    returnParams.delete(key);
  if (boundQuestionId !== null) {
    if (conversation.expandedId !== null) {
      returnParams.set("aiTask", conversation.expandedId);
      returnParams.set("aiQuestion", boundQuestionId);
    } else returnParams.set("aiCompose", boundQuestionId);
  }
  const settingsHref = `/s/settings/ai?from=${encodeURIComponent(`${location.pathname}${returnParams.size ? `?${returnParams}` : ""}`)}`;
  const openComposeRef = useRef(async (_questionId: string) => false);
  openComposeRef.current = async (questionId: string) => {
    if (!questions.some((question) => question.id === questionId))
      throw new Error("这道题已不在当前练习中，请重新选择题目");
    // 单题专注模式：目标非当前题时先经统一切题入口（含 AI 收起保护），
    // 失败抛错保留现场；列表等场景未注入则视为已就位。
    if (!(await ensureAtQuestion(host, questionId)))
      throw new Error("暂时无法切到本题，请检查材料保存状态后重试");
    if (!(await openForQuestion(questionId, entryOf(questionId)))) return false;
    conversation.startNew(questionId);
    requestAnimationFrame(() =>
      document
        .getElementById(controller.panelId)
        ?.scrollIntoView?.({ block: "start", behavior: "instant" }),
    );
    return true;
  };
  const openTask = async (task: AiTaskPublic) => {
    if (task.attemptId !== attemptId) return false;
    if (!questions.some((question) => question.id === task.questionId)) {
      setPresentationError(
        "这条求助对应的题目已不在当前练习中，请从求助记录选择其他题目",
      );
      return false;
    }
    if (host.ready === false) {
      setPresentationError("正在恢复作答材料，请完成恢复后重新打开这条回复");
      return false;
    }
    // 单题专注模式：先统一切题到任务所属题（收笔/落盘/AI 收起同链），
    // 失败保留现场不展开回复。
    if (!(await ensureAtQuestion(host, task.questionId))) return false;
    const entry = entryOf(task.questionId);
    if (!(await openForQuestion(task.questionId, entry))) return false;
    conversation.openTask(task);
    requestAnimationFrame(() =>
      document
        .getElementById(controller.panelId)
        ?.scrollIntoView?.({ block: "start", behavior: "instant" }),
    );
    return true;
  };
  const openTaskRef = useRef(openTask);
  openTaskRef.current = openTask;
  const locateQuestion = async (questionId: string) => {
    if (!questions.some((question) => question.id === questionId)) {
      setPresentationError("这道题已不在当前练习中，请重新选择题目");
      return false;
    }
    if (host.ready === false || transitionRef.current) return false;
    // 单题专注模式：回题定位同样先统一切题，失败保留当前列表与阅读状态。
    if (!(await ensureAtQuestion(host, questionId))) return false;
    const entry = entryOf(questionId);
    const card = entry?.closest("article");
    if (!entry || !card) {
      setPresentationError("暂时无法定位本题，请重新加载后重试");
      return false;
    }
    transitionRef.current = true;
    try {
      // 回题同样先确认当前稿件落盘，失败保留列表与现有阅读状态。
      for (const editingQuestionId of new Set([
        currentQuestionId,
        boundQuestionId,
      ])) {
        if (editingQuestionId !== null) await host.flush(editingQuestionId);
      }
      controller.closePanel();
      setPresentationError(null);
      triggerRef.current = entry;
      returnAnchorRef.current = null;
      requestAnimationFrame(() => {
        card.scrollIntoView?.({ block: "start", behavior: "instant" });
        entry.focus({ preventScroll: true });
      });
      return true;
    } catch {
      setPresentationError("当前稿件未保存，请重试保存后再回到本题");
      return false;
    } finally {
      transitionRef.current = false;
    }
  };
  const locateQuestionRef = useRef(locateQuestion);
  locateQuestionRef.current = locateQuestion;
  const openQuestion = async (task: AiTaskPublic) =>
    task.attemptId === attemptId && locateQuestion(task.questionId);
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const taskId = params.get("aiTask");
    const questionId = params.get("aiQuestion");
    const composeQuestionId = params.get("aiCompose");
    if (host.ready === false || (!questionId && !composeQuestionId)) return;
    let cancelled = false;
    const action =
      taskId && questionId
        ? fetchStudentAiTaskApi(taskId).then(async ({ task }) => {
            if (cancelled) return;
            if (task.attemptId !== attemptId || task.questionId !== questionId)
              throw new Error("求助定位与当前练习不一致，请重新选择记录");
            if (!(await openTaskRef.current(task)))
              throw new Error("暂时无法打开回复，请检查材料保存状态后重试");
          })
        : Promise.resolve().then(async () => {
            if (cancelled) return;
            const opened = questionId
              ? await locateQuestionRef.current(questionId)
              : composeQuestionId
                ? await openComposeRef.current(composeQuestionId)
                : false;
            if (!opened)
              throw new Error("暂时无法打开本题，请检查材料保存状态后重试");
          });
    void action
      .catch((cause: unknown) => {
        if (!cancelled)
          setPresentationError(
            cause instanceof Error
              ? cause.message
              : "回复定位失败，请从求助记录重试",
          );
      })
      .finally(() => {
        if (cancelled) return;
        // 消费 ai 参数时按最新地址重算：统一切题入口可能已改写 q，不得
        // 用过期 search 回写把切换 undone。
        const latest = new URLSearchParams(locationRef.current.search);
        latest.delete("aiTask");
        latest.delete("aiQuestion");
        latest.delete("aiCompose");
        void navigate(
          { pathname: location.pathname, search: latest.toString() },
          { replace: true, preventScrollReset: true },
        );
      });
    return () => {
      cancelled = true;
    };
  }, [attemptId, host.ready, location.pathname, location.search, navigate]);
  const fixedActive = presentation === "side";
  const dialogActive = controller.open && presentation === "dialog";
  useEffect(() => {
    if (!dialogActive) return;
    const viewport = window.visualViewport;
    const resize = () => {
      const height = viewport?.height ?? window.innerHeight;
      const narrow = window.innerWidth < 640;
      const content = dialogContentRef.current;
      if (!content) return;
      content.style.height = `${narrow ? height : height * 0.9}px`;
      content.style.maxHeight = `${height}px`;
      content.style.top = `${(viewport?.offsetTop ?? 0) + height / 2}px`;
    };
    resize();
    viewport?.addEventListener("resize", resize);
    viewport?.addEventListener("scroll", resize);
    window.addEventListener("resize", resize);
    return () => {
      viewport?.removeEventListener("resize", resize);
      viewport?.removeEventListener("scroll", resize);
      window.removeEventListener("resize", resize);
    };
  }, [dialogActive]);
  // 已打开的侧栏只单向退让；回补空间留到下一次打开，避免键盘与分屏反复搬动正文。
  useEffect(() => {
    if (
      !controller.open ||
      presentation !== "side" ||
      (hasAiCompareSpace(railRef.current) &&
        (!controller.canDock || controller.mode === "dock")) ||
      boundQuestionId === null
    )
      return;
    let cancelled = false;
    void host
      .flush(boundQuestionId)
      .then(() => {
        if (!cancelled) {
          setPresentation("dialog");
          setPresentationError(null);
        }
      })
      .catch(() => {
        if (!cancelled)
          setPresentationError("当前稿件未保存，请重试保存后再调整助教布局");
      });
    return () => {
      cancelled = true;
    };
  }, [
    controller.open,
    controller.canDock,
    controller.mode,
    presentation,
    boundQuestionId,
    host.flush,
  ]);
  const close = async () => {
    if (transitionRef.current) return false;
    transitionRef.current = true;
    try {
      if (boundQuestionId !== null) await host.flush(boundQuestionId);
      controller.closePanel();
      setPresentationError(null);
      triggerRef.current?.focus({ preventScroll: true });
      const anchor = returnAnchorRef.current;
      if (anchor)
        requestAnimationFrame(() => {
          if (returnAnchorRef.current !== anchor || !anchor.element.isConnected)
            return;
          const difference =
            anchor.element.getBoundingClientRect().top - anchor.top;
          if (Math.abs(difference) > 1)
            window.scrollBy({ top: difference, behavior: "instant" });
        });
      return true;
    } catch {
      setPresentationError("当前稿件未保存，请重试保存后再收起助教");
      return false;
    } finally {
      transitionRef.current = false;
    }
  };
  /**
   * 切题导航先收起 AI 阅读（M4-D2 §12.1）：复用既有收起链（flush →
   * closePanel → 焦点/锚点还原），不开第二套收起。未打开时直接放行；
   * 落盘失败返回 false，调用方保留现场不切题。收起后绑定仍在本题并记
   * 入工作集——返回原题时以「再看回复」折叠入口续读（阅读锚点语义）。
   */
  const collapseForNavigation = async () => {
    if (!controller.open) return true;
    const questionId = boundQuestionId;
    if (!(await close())) return false;
    if (questionId !== null)
      setWorkingQuestions((previous) => new Set(previous).add(questionId));
    return true;
  };
  /** 回到作答＝同一收起语义（面板内「回到作答」动作复用） */
  const returnToWork = collapseForNavigation;
  // 不经 ensureAtQuestion 的隐含前提（M4 闸门钉注）：两个入口（阅读结尾
  // 「再检查新步骤」、工作集「再看回复」折叠条）只在目标题为当前题时可见
  // 可点——单题模式非当前题卡是 hidden 不可点，不构成切题路径。若日后单题
  // 模式改为真卸载非当前卡、或折叠入口移到常驻栏，须补 ensureAtQuestion 守卫。
  const checkNewSteps = async (questionId: string) => {
    if (!(await openForQuestion(questionId, entryOf(questionId)))) return;
    conversation.startNew(questionId);
    send.selectPreset(
      "check-current",
      "请检查我新写的步骤，指出需要修改的地方，并给我一个可以自己尝试的下一步。",
      questionId,
    );
  };
  const changePresentation = async () => {
    if (transitionRef.current || boundQuestionId === null) return;
    transitionRef.current = true;
    try {
      await host.flush(boundQuestionId);
      if (enlarged) {
        const next =
          sessionLayout === "side" && !hasAiCompareSpace(railRef.current)
            ? "dialog"
            : sessionLayout;
        restoringPresentationRef.current = next !== "dialog";
        setPresentation(next);
        setEnlarged(false);
      } else {
        setPresentation("dialog");
        setEnlarged(true);
      }
      setPresentationError(null);
    } catch {
      setPresentationError("当前稿件未保存，请重试保存后再调整助教布局");
    } finally {
      transitionRef.current = false;
    }
  };
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!controller.open) return;
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing)
        return;
      // 题下展开不抢焦点；入口仍持有焦点时，Esc也能原路收起。
      if (
        document.activeElement === triggerRef.current ||
        document.activeElement === document.body
      ) {
        event.preventDefault();
        void closeRef.current();
      }
    };
    window.addEventListener("keydown", onEscape);
    return () => window.removeEventListener("keydown", onEscape);
  }, [controller.open]);
  const trigger = (
    <AiCompanionTrigger
      ref={triggerRef}
      controller={controller}
      label={host.triggerLabel}
      onPress={(trigger) => {
        if (controller.open) {
          triggerRef.current = trigger;
          void close();
        } else if (currentQuestionId !== null)
          void openForQuestion(currentQuestionId, trigger);
      }}
    />
  );
  const triggerForQuestion = (questionId: string) => (
    <AiCompanionTrigger
      questionId={questionId}
      controller={controller}
      label="AI 助教"
      expanded={controller.open && send.boundQuestionId === questionId}
      onPress={(trigger) => {
        if (controller.open && send.boundQuestionId === questionId) {
          triggerRef.current = trigger;
          void close();
          return;
        }
        void openForQuestion(questionId, trigger);
      }}
    />
  );
  const workspace = (
    <section
      id={controller.panelId}
      aria-label={`${boundLabel ?? "本题"}的 AI 助教`}
      data-slot="ai-companion-panel"
      className="flex min-w-0 flex-col rounded-lg border border-border bg-card text-card-foreground"
      onKeyDown={(event) => {
        if (
          event.key === "Escape" &&
          !event.defaultPrevented &&
          !event.nativeEvent.isComposing
        ) {
          event.preventDefault();
          void close();
        }
      }}
    >
      <AiCompanionPanelBody
        flow={presentation === "inline"}
        questionLabel={boundLabel}
        settingsHref={settingsHref}
        onDockClose={dialogActive ? undefined : () => void close()}
        heading={
          dialogActive ? (
            <DialogTitle
              ref={dialogTitleRef}
              tabIndex={-1}
              className="min-w-0 flex-1 truncate text-sm leading-6 outline-none"
            >
              {boundLabel ?? "本题"} · AI 助教
            </DialogTitle>
          ) : undefined
        }
        headerNote={
          dialogActive && sessionLayout === "side" && !enlarged ? (
            <p className="px-3 py-2 text-xs text-muted-foreground">
              当前空间不足，已用弹窗打开；你的侧边偏好仍保留。
            </p>
          ) : undefined
        }
        closeLabel="收起 AI 助教"
        onFix={
          presentation !== "dialog" || enlarged
            ? () => void changePresentation()
            : undefined
        }
        fixed={enlarged}
        onDisplaySettings={() => {
          if (boundQuestionId === null || transitionRef.current) return;
          transitionRef.current = true;
          void host
            .flush(boundQuestionId)
            .then(() => {
              void navigate(
                `/s/settings?from=${encodeURIComponent(`${location.pathname}${returnParams.size ? `?${returnParams}` : ""}`)}#ai-display`,
              );
            })
            .catch(() =>
              setPresentationError("当前稿件未保存，请重试保存后再进入设置"),
            )
            .finally(() => {
              transitionRef.current = false;
            });
        }}
        status={
          <AiCompanionStatusPanel send={send} settingsHref={settingsHref} />
        }
        compactStatus={
          send.status && (
            <p className="mt-0.5 text-xs text-muted-foreground">
              {send.effectiveChannel
                ? CHANNEL_LABEL[send.effectiveChannel]
                : "尚未连接"}{" "}
              · {studentModeReasonText(send.status)}
            </p>
          )
        }
        settingsAttention={
          send.needsSetup ||
          send.statusError ||
          send.status?.resolution.usable === false
        }
        quickButtons={null}
        conversation={
          <AiConversationPanel
            send={send}
            controller={conversation}
            onReturnToWork={() => void returnToWork()}
            onCheckNewSteps={() =>
              boundQuestionId !== null && void checkNewSteps(boundQuestionId)
            }
            quickButtons={<AiCompanionQuickButtons send={send} />}
            composer={
              <AiCompanionComposer
                send={send}
                paperLabel={paperLabel}
                questionLabel={boundLabel}
                materials={materials}
              />
            }
          />
        }
      />
    </section>
  );
  const inlineForQuestion = (questionId: string) => (
    <div data-ai-question={questionId} className="min-w-0 [&:not(:empty)]:mt-3">
      {workingQuestions.has(questionId) &&
        (!controller.open || send.boundQuestionId !== questionId) && (
          <fieldset
            className="flex flex-wrap items-center gap-2 rounded-lg bg-primary/5 px-3 py-2"
            aria-label="继续本题学习"
          >
            <span className="mr-auto text-sm text-muted-foreground">
              先试一步，需要时再看看提示。
            </span>
            <Button
              type="button"
              variant="ghost"
              className="min-h-11"
              onClick={() =>
                void openForQuestion(questionId, entryOf(questionId))
              }
            >
              再看回复
            </Button>
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              onClick={() => void checkNewSteps(questionId)}
            >
              检查新步骤
            </Button>
          </fieldset>
        )}
      {send.boundQuestionId === questionId &&
      controller.open &&
      presentation === "inline"
        ? workspace
        : null}
    </div>
  );
  const rail = (children: ReactNode) => (
    <AiReadingMemoryContext value={readingMemory}>
      <AiCompareActiveContext.Provider value={fixedActive && controller.open}>
        <div
          ref={railRef}
          data-slot="ai-companion-rail"
          data-ai-state={
            controller.open ? (fixedActive ? "dock" : presentation) : "closed"
          }
          className="w-full min-w-0"
        >
          {(controller.error || presentationError) && (
            <p
              role="alert"
              className="mb-3 rounded-lg border border-destructive p-3 text-sm text-destructive"
            >
              {presentationError ?? controller.error}
            </p>
          )}
          <div
            className={
              fixedActive && controller.open
                ? "flex min-w-0 items-start gap-4"
                : "min-w-0"
            }
          >
            <section aria-label="作答区" className="min-w-0 flex-1">
              {children}
            </section>
            {fixedActive && controller.open && (
              <aside
                aria-label="AI 对照"
                className="sticky top-[calc(var(--attempt-header-height,64px)+16px)] flex h-[calc(var(--attempt-viewport-height,100dvh)-var(--attempt-header-height,64px)-var(--attempt-footer-height,64px)-32px)] min-h-0 w-[26rem] max-w-full shrink-0 flex-col overflow-hidden [&>[data-slot=ai-companion-panel]]:min-h-0 [&>[data-slot=ai-companion-panel]]:flex-1"
              >
                {workspace}
              </aside>
            )}
          </div>
          {dialogActive && (
            <Dialog
              open
              onOpenChange={(open) => {
                if (!open) void close();
              }}
            >
              <DialogContent
                ref={dialogContentRef}
                className="flex h-dvh max-h-dvh w-full max-w-full flex-col gap-0 overflow-hidden rounded-none p-0 sm:h-[90dvh] sm:max-h-[90dvh] sm:w-[calc(100%-3rem)] sm:max-w-[60rem] sm:rounded-xl"
                onOpenAutoFocus={(event) => {
                  event.preventDefault();
                  dialogTitleRef.current?.focus({ preventScroll: true });
                }}
                onCloseAutoFocus={(event) => {
                  event.preventDefault();
                  if (restoringPresentationRef.current) {
                    restoringPresentationRef.current = false;
                    document
                      .getElementById(controller.panelId)
                      ?.querySelector<HTMLButtonElement>("[data-ai-enlarge]")
                      ?.focus({ preventScroll: true });
                  } else triggerRef.current?.focus({ preventScroll: true });
                }}
                onPointerDownOutside={(event) => event.preventDefault()}
                onEscapeKeyDown={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  void close();
                }}
              >
                <DialogDescription className="sr-only">
                  阅读和追问本题，关闭后回到原题继续作答。
                </DialogDescription>
                <div className="flex min-h-0 flex-1 flex-col [&>[data-slot=ai-companion-panel]]:min-h-0 [&>[data-slot=ai-companion-panel]]:flex-1 [&>[data-slot=ai-companion-panel]]:rounded-none [&>[data-slot=ai-companion-panel]]:border-0">
                  {presentationError && (
                    <p
                      role="alert"
                      className="px-5 py-2 text-sm text-destructive"
                    >
                      {presentationError}
                    </p>
                  )}
                  {workspace}
                </div>
              </DialogContent>
            </Dialog>
          )}
        </div>
      </AiCompareActiveContext.Provider>
    </AiReadingMemoryContext>
  );

  return {
    /** 布局控制器（navigatorCollapsed / open / closePanel 等） */
    controller,
    openTask,
    openQuestion,
    /** 发送控制器（bind 可用于页面显式切绑） */
    send,
    /** 头部动作位的 AI 助教按钮 */
    trigger,
    triggerForQuestion,
    inlineForQuestion,
    /** 主区包裹（传入页面主内容） */
    rail,
    /** 绑定题显示名（null = 未绑定） */
    boundLabel,
    triggerRef,
    /**
     * 切题导航先收起 AI 阅读（M4-D2 §12.1）：统一切题入口在切题前调用，
     * 返回 false 时保留现场不切换。
     */
    collapseForNavigation,
  } as const;
}

export type AiCompanionDock = ReturnType<typeof useAiCompanionDock>;
export type { AiCompanionLayoutController, AiSendController };
