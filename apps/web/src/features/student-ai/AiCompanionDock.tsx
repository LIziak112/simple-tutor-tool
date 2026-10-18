import type { AttemptQuestionPublic } from "@tutor/contract";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useLocation } from "react-router";
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
import { useAiCompanionLayout } from "@/features/student-ai/ai-companion-layout";
import {
  type AiMaterialAvailability,
  type AiSendController,
  DEFAULT_AI_MATERIALS,
  useAiSendController,
} from "@/features/student-ai/use-ai-send-controller";

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
}

export function useAiCompanionDock(host: UseAiCompanionDockHost) {
  const { attemptId, questions, currentQuestionId, editor, labelOf } = host;
  const location = useLocation();
  const railRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const returnAnchorRef = useRef<{
    element: HTMLButtonElement;
    top: number;
  } | null>(null);
  const [fixed, setFixed] = useState(false);
  const [presentationError, setPresentationError] = useState<string | null>(
    null,
  );
  const transitionRef = useRef(false);
  const controller = useAiCompanionLayout({
    containerRef: railRef,
    editor,
    currentQuestionId,
    dockEnabled: fixed,
  });
  const settingsHref = `/s/settings/ai?from=${encodeURIComponent(
    location.pathname + location.search,
  )}`;
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
  const openForQuestion = async (
    questionId: string,
    trigger?: HTMLButtonElement,
  ) => {
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
      const opened = await controller.openPanel(questionId);
      if (opened) {
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
  const fixedActive = fixed && controller.canDock;
  const close = async () => {
    if (transitionRef.current) return;
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
    } catch {
      setPresentationError("当前稿件未保存，请重试保存后再收起助教");
    } finally {
      transitionRef.current = false;
    }
  };
  const changePresentation = async () => {
    if (transitionRef.current || boundQuestionId === null) return;
    transitionRef.current = true;
    try {
      await host.flush(boundQuestionId);
      setFixed((previous) => !previous);
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
  // setVisible 本身是稳定引用（布局控制器内 useCallback([])）；若依赖整个
  // controller（每次渲染都是新对象），消费方的「绑定题可见性」效应会每次
  // 重跑并立即测量，而面板开合又会重排题卡 → 面板反复卸载/挂载闪动。
  const setVisible = controller.setVisible;
  const setQuestionVisible = useCallback(
    (questionId: string, visible: boolean) => {
      if (fixedActive && send.boundQuestionId === questionId)
        setVisible(visible);
    },
    [setVisible, send.boundQuestionId, fixedActive],
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
        flow
        questionLabel={boundLabel}
        settingsHref={settingsHref}
        onDockClose={() => void close()}
        closeLabel="收起 AI 助教"
        onFix={controller.canDock ? () => void changePresentation() : undefined}
        fixed={fixedActive}
        status={
          <AiCompanionStatusPanel send={send} settingsHref={settingsHref} />
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
      {send.boundQuestionId === questionId && controller.open && !fixedActive
        ? workspace
        : null}
    </div>
  );
  const rail = (children: ReactNode) => (
    <div
      ref={railRef}
      data-slot="ai-companion-rail"
      data-ai-state={
        controller.open ? (fixedActive ? "dock" : "inline") : "closed"
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
            style={controller.suspended ? { visibility: "hidden" } : undefined}
            className="sticky top-[calc(var(--attempt-header-height,64px)+16px)] max-h-[calc(var(--attempt-viewport-height,100dvh)-var(--attempt-header-height,64px)-var(--attempt-footer-height,64px)-32px)] w-[26rem] shrink-0 overflow-y-auto overscroll-contain"
          >
            {workspace}
          </aside>
        )}
      </div>
    </div>
  );

  return {
    /** 布局控制器（navigatorCollapsed / open / closePanel 等） */
    controller,
    /** 发送控制器（bind 可用于页面显式切绑） */
    send,
    /** 头部动作位的 AI 助教按钮 */
    trigger,
    triggerForQuestion,
    inlineForQuestion,
    setQuestionVisible,
    /** 主区包裹（传入页面主内容） */
    rail,
    /** 绑定题显示名（null = 未绑定） */
    boundLabel,
    triggerRef,
  } as const;
}

export type AiCompanionDock = ReturnType<typeof useAiCompanionDock>;
export type { AiCompanionLayoutController, AiSendController };
