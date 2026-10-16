import { useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  AiChannel,
  AiStatusData,
  AiTaskPublic,
  AiTeachingMode,
  AttemptQuestionPublic,
  StudentQuickButton,
} from "@tutor/contract";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type AiCaptureSnapshot,
  type AiMaterialSelection,
  captureAiQuestionMaterials,
} from "@/features/export/ai-material-capture";
import {
  createStudentAiTaskApi,
  fetchStudentAiStatusApi,
  listStudentAiTasksApi,
  uploadStudentAiTaskMaterialsApi,
} from "@/lib/api";
import { randomUuid } from "@/lib/uuid";
import { errorMessageOf } from "./error-text";

/**
 * SAI-20 单题发送控制器（B11）：伴学栏的会话输入与幂等发送编排。
 *
 * 顺序实施 8 条（批次文件为权威）的控制器侧：
 * 1. 打开只绑定题目（bind 为显式动作）并载入状态/历史/默认通道，不发送；
 *    滚动不重绑——本控制器不接收「当前滚动题」，绑定只在 bind 时变化。
 * 2. 按题保存未发送正文/附件选择/选中 preset（输入隔离键 =
 *    attemptId + questionId），切题（bind 别题）互不覆盖。
 * 3. 通道为本地会话选择（channelOverride，null=用服务端默认）——换通道
 *    不重发、零出站；在途任务保持创建时的通道（服务端按任务行冻结）。
 * 4. 快捷按钮用其 prompt/附件偏好即发，不回写草稿选择（单次语义）。
 * 5. 发送前检查模式可用性、连接与首次知情；需要设置时如实拦截并保留
 *    全部输入（needsSetup 由 UI 引导去设置页，回题不自动出站）。
 * 6. 一次动作一个幂等键（mutationId）：在途重复点击直接复用；失败重试
 *    （正文/选择/通道未变）沿用同一键，服务端幂等去重不重复计费；材料
 *    采集失败保留全部状态；采集成功后的重试经 previous 原样复用快照。
 * 7. 模式不可用给原因并刷新状态（教师刚改设置立即生效）。
 * 8. 来源/账号（attempt）变化即取消本地回调：在途结果迟到不写状态、
 *    不清新作答缓存（epoch 守卫），新作答输入从干净状态开始。
 *
 * 成功清理策略：任务进入待处理后清空该题未发送正文（已随任务发出），
 * 附件选择与选中 preset 保留（下次发送沿用）；任何失败三者全保留。
 */

/** 空草稿（选择全关——首次发送仅文字，学生再按需勾选） */
export const EMPTY_AI_SELECTION: AiMaterialSelection = {
  annotation: false,
  draft: false,
  formalInk: false,
};

export interface AiQuestionDraft {
  readonly text: string;
  readonly selection: AiMaterialSelection;
  readonly presetId: string | null;
}

export type AiSendPhase = "idle" | "sending" | "sent" | "failed";

export interface AiSendState {
  readonly phase: AiSendPhase;
  readonly message: string | null;
  readonly questionId: string | null;
}

/** 材料可选面：来源页面的实际采集能力（SAI-22 讲练题卡无圈画层、结果页
 * 复盘无作答会话，均按 false 收窄；缺省两者皆可） */
export interface AiMaterialAvailability {
  /** 圈画材料（题面标注层截图） */
  readonly annotation: boolean;
  /** 纸面材料（草稿或正式手写） */
  readonly paper: boolean;
}

export const DEFAULT_AI_MATERIALS: AiMaterialAvailability = {
  annotation: true,
  paper: true,
};

export interface UseAiSendControllerConfig {
  readonly attemptId: string;
  readonly questions: readonly AttemptQuestionPublic[];
  /** 手写题（solve/apply/find-error）采集正式手写，其余题型采集草稿 */
  readonly isHandwritten: (questionId: string) => boolean;
  /** 绑定题的题面元素（材料收起/未挂载时为 null，由采集入口按需判定） */
  readonly surfaceOf: (questionId: string) => HTMLElement | null;
  /** 收笔并等本题本机落盘（AttemptEditorContext.flush） */
  readonly flush: (questionId: string) => Promise<void>;
  /** 采集材料页头（如「第 27 题 · 作业名」） */
  readonly titleOf: (questionId: string) => string;
  /** AI 面板是否打开（关闭时不查状态/历史；重开按绑定题恢复） */
  readonly active: boolean;
  /** 材料可选面（缺省全开）：不可选种类在发送/采集/任务登记处一律过滤为关 */
  readonly materials?: AiMaterialAvailability | undefined;
}

/** 教学模式显示名（状态区句子与会话面板「当时模式」共用单源） */
export const AI_MODE_LABEL: Record<AiTeachingMode, string> = {
  open_study: "开放伴学",
  guided_only: "仅启发",
  post_submit_only: "完成后可用",
};

/** 学生侧裁决原因文案（教师侧见 ai-policy-text，措辞按学生视角；伴学栏
 *  状态区与失败提示共用单源，不各写一份） */
export function studentModeReasonText(status: AiStatusData): string {
  if (!status.resolution.usable) {
    switch (status.resolution.reason) {
      case "student_closed":
        return "当前模式为完成后可用，完成本题后可复盘提问";
      case "assignment_closed":
        return "这份作业设置为完成后可用，完成本题后可复盘提问";
      case "teacher_default_closed":
        return "老师设置的当前模式为完成后可用，完成本题后可复盘提问";
      default:
        return "当前教学模式下本题暂不能使用 AI 求助";
    }
  }
  // 契约保证 usable=true 时 mode 必填（superRefine），类型上仍需显式回落
  const mode = status.resolution.mode;
  const label =
    mode === undefined ? AI_MODE_LABEL.open_study : AI_MODE_LABEL[mode];
  const source =
    status.resolution.reason === "assignment_override"
      ? "（来自作业设置）"
      : status.resolution.reason === "student_override"
        ? "（来自你的设置）"
        : "";
  return `当前：${label}${source}`;
}

/** 在途/待重试的一次动作（幂等键生命周期挂在动作上，不挂在点击上） */
interface PendingAction {
  readonly token: number;
  readonly mutationId: string;
  readonly questionId: string;
  readonly text: string;
  readonly selection: AiMaterialSelection;
  readonly channel: AiChannel;
  readonly quickButtonId: string | null;
  /** 采集成功后的快照（失败重试原样复用，不重抓最新稿） */
  snapshot: AiCaptureSnapshot | null;
}

const IDLE_STATE: AiSendState = {
  phase: "idle",
  message: null,
  questionId: null,
};

export function useAiSendController(config: UseAiSendControllerConfig) {
  const { attemptId, questions, active } = config;
  const queryClient = useQueryClient();
  const [boundQuestionId, setBoundQuestionId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<ReadonlyMap<string, AiQuestionDraft>>(
    new Map(),
  );
  const [channelOverride, setChannelOverride] = useState<AiChannel | null>(
    null,
  );
  const [sendState, setSendState] = useState<AiSendState>(IDLE_STATE);
  /** 一次动作（在途或失败待重试）；成功即清空 */
  const pendingRef = useRef<PendingAction | null>(null);
  /**
   * 在途守卫（ref 而非 state）：同一渲染周期内的连击闭包读到的 state 相同，
   * 只有 ref 能同步可见地挡住第二次点击；finally 复位，任何离开路径都放行
   * 下一次发送（含 epoch 失效后的新会话）。
   */
  const sendingRef = useRef(false);
  /** 来源/账号守卫：attempt 变化或卸载即递增，在途回调全部失效 */
  const epochRef = useRef(0);
  const attemptRef = useRef(attemptId);

  // 来源/账号变化：取消当前本地采集回调（在途结果不进入新题），
  // 输入按新作答隔离（新 attempt 从干净草稿开始）。
  useEffect(() => {
    if (attemptRef.current === attemptId) return;
    attemptRef.current = attemptId;
    epochRef.current += 1;
    pendingRef.current = null;
    setBoundQuestionId(null);
    setDrafts(new Map());
    setChannelOverride(null);
    setSendState(IDLE_STATE);
  }, [attemptId]);
  // 卸载同样令在途回调失效（迟到结果不得写进任何新会话）
  useEffect(
    () => () => {
      epochRef.current += 1;
    },
    [],
  );

  const statusKey = useMemo(
    () =>
      boundQuestionId === null
        ? null
        : (["student", "ai-status", attemptId, boundQuestionId] as const),
    [attemptId, boundQuestionId],
  );
  const statusQuery = useQuery({
    queryKey: statusKey ?? ["student", "ai-status", "none"],
    queryFn: () => fetchStudentAiStatusApi(attemptId, boundQuestionId ?? ""),
    enabled: statusKey !== null && active,
    refetchOnWindowFocus: false,
  });
  const historyQuery = useQuery({
    queryKey:
      boundQuestionId === null
        ? ["student", "ai-tasks", "none"]
        : (["student", "ai-tasks", attemptId, boundQuestionId] as const),
    queryFn: () =>
      listStudentAiTasksApi({
        attemptId,
        questionId: boundQuestionId ?? "",
      }),
    enabled: boundQuestionId !== null && active,
    refetchOnWindowFocus: false,
  });

  const status = statusQuery.data;
  const needsSetup =
    status === undefined
      ? false
      : status.channelDefault === null ||
        status.firstUseRequired ||
        !status.connectionReady;

  const refreshStatus = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: ["student", "ai-status", attemptId],
    });
  }, [queryClient, attemptId]);

  const bind = useCallback((questionId: string) => {
    // 显式动作才切题；同题重复 bind 幂等（重开面板恢复绑定）
    setBoundQuestionId((previous) =>
      previous === questionId ? previous : questionId,
    );
  }, []);

  const draftOf = useCallback(
    (questionId: string): AiQuestionDraft =>
      drafts.get(questionId) ?? {
        text: "",
        selection: EMPTY_AI_SELECTION,
        presetId: null,
      },
    [drafts],
  );

  const patchDraft = useCallback(
    (
      questionId: string,
      patch: (draft: AiQuestionDraft) => AiQuestionDraft,
    ) => {
      setDrafts((previous) => {
        const current = previous.get(questionId) ?? {
          text: "",
          selection: EMPTY_AI_SELECTION,
          presetId: null,
        };
        return new Map(previous).set(questionId, patch(current));
      });
    },
    [],
  );

  const setText = useCallback(
    (text: string) => {
      if (boundQuestionId !== null)
        patchDraft(boundQuestionId, (draft) => ({ ...draft, text }));
    },
    [boundQuestionId, patchDraft],
  );
  const toggleMaterial = useCallback(
    (kind: keyof AiMaterialSelection) => {
      // 来源页面不可选的种类是无操作（结果页复盘不采集材料；讲练无圈画层）
      const availability = config.materials ?? DEFAULT_AI_MATERIALS;
      if (kind === "annotation" && !availability.annotation) return;
      if (kind !== "annotation" && !availability.paper) return;
      if (boundQuestionId !== null)
        patchDraft(boundQuestionId, (draft) => ({
          ...draft,
          selection: {
            ...draft.selection,
            [kind]: !draft.selection[kind],
          },
        }));
    },
    [boundQuestionId, config, patchDraft],
  );
  const selectPreset = useCallback(
    (presetId: string | null) => {
      if (boundQuestionId !== null)
        patchDraft(boundQuestionId, (draft) => ({ ...draft, presetId }));
    },
    [boundQuestionId, patchDraft],
  );

  const effectiveChannel: AiChannel | null =
    channelOverride ?? status?.channelDefault ?? null;

  const send = useCallback(
    async (input: { quick?: StudentQuickButton } = {}) => {
      const questionId = boundQuestionId;
      if (questionId === null) return;
      const question = questions.find((item) => item.id === questionId);
      if (question === undefined) return;
      if (sendingRef.current) return; // 在途重复点击：一次动作（ref 同步可见）
      const draft = draftOf(questionId);
      const quick = input.quick;
      const text = quick ? quick.prompt : draft.text.trim();
      // 材料可选面过滤（SAI-22）：来源页面不可采集的种类一律为关——快捷按钮
      // 的附件偏好同样被过滤（结果页复盘恒空材料；讲练不采集圈画）
      const availability = config.materials ?? DEFAULT_AI_MATERIALS;
      const wanted = quick ? quick.attachmentPref : draft.selection;
      const selection: AiMaterialSelection = {
        annotation: wanted.annotation && availability.annotation,
        draft: wanted.draft && availability.paper,
        formalInk: wanted.formalInk && availability.paper,
      };
      const quickButtonId = quick?.id ?? null;
      if (!quick && text === "") {
        setSendState({
          phase: "failed",
          message: "先写一下你的问题，再点发送",
          questionId,
        });
        return;
      }
      // 状态未就绪/读取失败：如实拦下（不白发半成品）
      if (status === undefined) {
        setSendState({
          phase: "failed",
          message: statusQuery.isError
            ? "AI 状态读取失败，请稍后重试"
            : "正在确认 AI 状态，请稍候再发送",
          questionId,
        });
        return;
      }
      if (!status.resolution.usable) {
        refreshStatus();
        setSendState({
          phase: "failed",
          message: `${studentModeReasonText(status)}，已为你刷新最新设置`,
          questionId,
        });
        return;
      }
      const channel = channelOverride ?? status.channelDefault;
      if (
        channel === null ||
        status.firstUseRequired ||
        !status.connectionReady
      ) {
        refreshStatus();
        setSendState({
          phase: "failed",
          message:
            status.firstUseRequired || status.channelDefault === null
              ? "还没有可用的 AI 连接，请先完成连接设置"
              : "默认连接需要重新验证，请到设置中更新",
          questionId,
        });
        return;
      }
      if (channel === "link") {
        // 链接通道票据归 SAI-28（B15）：如实拦截，不出站不虚报
        setSendState({
          phase: "failed",
          message: "链接通道建设中，可先在设置中选择页内 AI 或 MCP 通道",
          questionId,
        });
        return;
      }

      // 幂等键生命周期：同动作（同题/同文/同选择/同通道）复用，变化即新动作
      const reuse =
        pendingRef.current !== null &&
        pendingRef.current.questionId === questionId &&
        pendingRef.current.text === text &&
        pendingRef.current.selection.annotation === selection.annotation &&
        pendingRef.current.selection.draft === selection.draft &&
        pendingRef.current.selection.formalInk === selection.formalInk &&
        pendingRef.current.channel === channel &&
        pendingRef.current.quickButtonId === quickButtonId;
      const pending: PendingAction =
        reuse && pendingRef.current !== null
          ? pendingRef.current
          : {
              token: epochRef.current,
              mutationId: randomUuid(),
              questionId,
              text,
              selection,
              channel,
              quickButtonId,
              snapshot: null,
            };
      pendingRef.current = pending;
      const token = pending.token;
      const alive = () => epochRef.current === token;
      sendingRef.current = true;
      setSendState({ phase: "sending", message: null, questionId });
      try {
        // 材料采集（SAI-10 固定入口；仅文字时零页也合法）
        let snapshot: AiCaptureSnapshot | null = null;
        if (selection.annotation || selection.draft || selection.formalInk) {
          try {
            // ?? null：真实入口恒返回快照；被测试替身留空（undefined）时按
            // 「无材料页」处理，不把非快照值带进后续上传分支
            snapshot =
              (await captureAiQuestionMaterials({
                attemptId,
                question,
                isHandwritten: config.isHandwritten(questionId),
                selection,
                title: config.titleOf(questionId),
                surface: config.surfaceOf(questionId),
                flush: config.flush,
                ...(pending.snapshot !== null
                  ? { previous: pending.snapshot }
                  : {}),
              })) ?? null;
          } catch (cause) {
            if (!alive()) return;
            pending.snapshot = null;
            setSendState({
              phase: "failed",
              message: errorMessageOf(cause, "材料读取失败，请重试"),
              questionId,
            });
            return;
          }
          if (!alive()) return;
          pending.snapshot = snapshot;
        }

        // 创建任务（SAI-13；同 mutationId 重放返回原任务）
        let task: AiTaskPublic;
        try {
          task = await createStudentAiTaskApi({
            attemptId,
            questionId,
            question: text,
            channel,
            materials: selection,
            mutationId: pending.mutationId,
            ...(quickButtonId !== null ? { quickButtonId } : {}),
          });
        } catch (cause) {
          if (!alive()) return;
          setSendState({
            phase: "failed",
            message: errorMessageOf(cause, "发送失败，请检查网络后重试"),
            questionId,
          });
          return;
        }
        if (!alive()) return;

        // 材料登记（回执不虚报；失败时任务已建——重试同幂等键回到上传）
        if (snapshot !== null && snapshot.pages.length > 0) {
          try {
            await uploadStudentAiTaskMaterialsApi(
              task.id,
              snapshot.pages.map((page) => ({
                kind: page.kind,
                pageIndex: page.pageIndex,
                pixelWidth: page.width,
                pixelHeight: page.height,
                png: page.blob,
              })),
            );
          } catch (cause) {
            if (!alive()) return;
            setSendState({
              phase: "failed",
              message: `任务已创建，但材料上传失败：${errorMessageOf(
                cause,
                "请重试发送以补传材料",
              )}（不会重复计费）`,
              questionId,
            });
            return;
          }
          if (!alive()) return;
        }

        // 成功：清空正文（已随任务发出），附件选择与 preset 保留
        patchDraft(questionId, (draft) => ({ ...draft, text: "" }));
        pendingRef.current = null;
        setSendState({
          phase: "sent",
          message: channel === "mcp" ? "已加入求助队列" : "已发送",
          questionId,
        });
        void queryClient.invalidateQueries({
          queryKey: ["student", "ai-status", attemptId],
        });
        void queryClient.invalidateQueries({
          queryKey: ["student", "ai-tasks", attemptId],
        });
      } finally {
        sendingRef.current = false;
      }
    },
    [
      attemptId,
      boundQuestionId,
      channelOverride,
      config,
      draftOf,
      patchDraft,
      queryClient,
      questions,
      refreshStatus,
      status,
      statusQuery.isError,
    ],
  );

  return {
    /** 作答定位（会话面板在同 key 上挂轮询观察者时构造缓存键用） */
    attemptId,
    boundQuestionId,
    bind,
    draftOf,
    setText,
    toggleMaterial,
    selectPreset,
    channelOverride,
    setChannelOverride,
    effectiveChannel,
    send,
    sendState,
    needsSetup,
    status,
    statusLoading: statusQuery.isPending,
    statusError: statusQuery.isError,
    history: historyQuery.data,
    historyLoading: historyQuery.isPending,
    historyError: historyQuery.isError,
    refreshStatus,
  };
}

export type AiSendController = ReturnType<typeof useAiSendController>;
