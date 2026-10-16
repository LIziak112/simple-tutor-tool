import type { AttemptQuestionPublic } from "@tutor/contract";
import { type ReactNode, useEffect, useRef } from "react";
import { useLocation } from "react-router";
import {
  AiCompanionRail,
  AiCompanionTrigger,
} from "@/features/student-ai/AiCompanionRail";
import {
  AiCompanionComposer,
  AiCompanionQuickButtons,
  AiCompanionStatusPanel,
  DRAFT_PAPER_LABEL,
  FORMAL_INK_PAPER_LABEL,
} from "@/features/student-ai/AiCompanionSession";
import { AiConversationPanel } from "@/features/student-ai/AiConversationPanel";
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
 * 页面接线三件套：
 * - trigger：放页面头部动作位（如 AttemptHeader actions / 讲练 HeaderBar）；
 * - rail(children)：包住主内容（题卡列表/回看列表）——控制器身份稳定由
 *   Rail 的 dock/panel 结构保证；
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
  /** 本卷题集（发送校验 + 材料采集输入；结果页传 { id } 最小引用即可） */
  readonly questions: readonly AttemptQuestionPublic[];
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
}

export function useAiCompanionDock(host: UseAiCompanionDockHost) {
  const { attemptId, questions, currentQuestionId, editor, labelOf } = host;
  const location = useLocation();
  const railRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const controller = useAiCompanionLayout({
    containerRef: railRef,
    editor,
    currentQuestionId,
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

  // 打开瞬间绑定当时所在题（SAI-20：显式动作才切题，滚动不重绑；
  // 重开面板恢复绑定题）。打开时无当前题则保持未绑定，由页面显式 bind。
  const openedRef = useRef(false);
  const bind = send.bind;
  useEffect(() => {
    if (controller.open && !openedRef.current && currentQuestionId !== null) {
      bind(currentQuestionId);
    }
    openedRef.current = controller.open;
  }, [controller.open, currentQuestionId, bind]);

  const boundQuestionId = send.boundQuestionId;
  const boundLabel = boundQuestionId !== null ? labelOf(boundQuestionId) : null;
  const paperLabel =
    boundQuestionId !== null && host.isHandwritten(boundQuestionId)
      ? FORMAL_INK_PAPER_LABEL
      : DRAFT_PAPER_LABEL;

  const materials = host.materials ?? DEFAULT_AI_MATERIALS;
  const trigger = (
    <AiCompanionTrigger ref={triggerRef} controller={controller} />
  );
  const rail = (children: ReactNode) => (
    <AiCompanionRail
      containerRef={railRef}
      controller={controller}
      triggerRef={triggerRef}
      questionLabel={boundLabel}
      settingsHref={settingsHref}
      status={
        <AiCompanionStatusPanel
          send={send}
          settingsHref={settingsHref}
          questionLabel={boundLabel}
        />
      }
      quickButtons={<AiCompanionQuickButtons send={send} />}
      composer={
        <AiCompanionComposer
          send={send}
          paperLabel={paperLabel}
          materials={materials}
        />
      }
      conversation={<AiConversationPanel send={send} />}
    >
      {children}
    </AiCompanionRail>
  );

  return {
    /** 布局控制器（navigatorCollapsed / open / closePanel 等） */
    controller,
    /** 发送控制器（bind 可用于页面显式切绑） */
    send,
    /** 头部动作位的 AI 助教按钮 */
    trigger,
    /** 主区包裹（传入页面主内容） */
    rail,
    /** 绑定题显示名（null = 未绑定） */
    boundLabel,
    triggerRef,
  } as const;
}

export type AiCompanionDock = ReturnType<typeof useAiCompanionDock>;
export type { AiCompanionLayoutController, AiSendController };
