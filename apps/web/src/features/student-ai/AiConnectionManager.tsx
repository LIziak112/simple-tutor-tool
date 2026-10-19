import { useQueryClient } from "@tanstack/react-query";
import type {
  AiChannel,
  AiConnectionCreateRequest,
  AiConnectionPatchRequest,
  AiConnectionPublic,
  AiImageCapability,
} from "@tutor/contract";
import { AI_SHARE_MAX_VALID_HOURS } from "@tutor/contract";
import { CircleAlert, Loader2, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ApiError } from "@/lib/api";
import { AiConnectionCard } from "./AiConnectionCard";
import { CHANNEL_LABEL } from "./ai-channel-label";
import {
  studentAiConnectionDraftKey,
  useCreateStudentAiConnection,
  useDeleteStudentAiConnection,
  usePatchStudentAiConnection,
  useStudentAiConnections,
  useTestStudentAiConnection,
} from "./ai-connection-queries";
import { InappConnectionFields } from "./InappConnectionFields";

/** 学生连接管理：凭据、通道与编辑草稿各自保持明确状态，设置页不自动发送求助。 */

/** 表单草稿(新建/编辑共用;channel 决定可见字段) */
interface ConnectionDraft {
  /** 正在修改的连接 id(null = 新建);随草稿缓存,重挂不丢编辑对象 */
  readonly editingId: string | null;
  readonly channel: AiChannel;
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKey: string;
  readonly imageCapability?: AiImageCapability | undefined;
  readonly defaultValidHours: number;
  readonly isDefault: boolean;
  /** 首次知情确认(本会话记忆;已有连接时由 hasConnection 接管门槛) */
  readonly consentAcknowledged: boolean;
  /** 用户是否动过表单(dirty 口径:导航/刷新拦截与放弃确认依据) */
  readonly touched: boolean;
}

const EMPTY_DRAFT: ConnectionDraft = {
  editingId: null,
  channel: "inapp",
  baseUrl: "",
  model: "",
  apiKey: "",
  imageCapability: "unknown",
  defaultValidHours: 24,
  isDefault: false,
  consentAcknowledged: false,
  touched: false,
};

/** 单槽操作提示:一次只显示最近一次操作的结果,避免多 alert 并存 */
interface Notice {
  readonly tone: "error" | "ok" | "info";
  readonly text: string;
}

/** ApiError 之外的异常收敛为通用网络文案(不透传堆栈) */
function errorTextOf(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error && error.message.length > 0) return error.message;
  return fallback;
}

/**
 * 来源题回跳地址(B11 发送控制器跳入携带):只接受本学生域内部路径,
 * 过滤外站、协议相对地址与跨角色页面(同题卡历史页 returnTo 纪律)。
 */
function safeFromOf(source: string | null): string | null {
  if (
    source === null ||
    !source.startsWith("/s/") ||
    source.startsWith("//") ||
    source.includes("\\")
  ) {
    return null;
  }
  return source;
}

export function AiConnectionManager() {
  const connectionsQuery = useStudentAiConnections();
  const createMutation = useCreateStudentAiConnection();
  const patchMutation = usePatchStudentAiConnection();
  const deleteMutation = useDeleteStudentAiConnection();
  const testMutation = useTestStudentAiConnection();

  const [searchParams] = useSearchParams();
  /** 来源题路径(B11 发送控制器跳入时携带;保存成功后提供回跳入口) */
  const from = safeFromOf(searchParams.get("from"));
  const queryClient = useQueryClient();

  // 草稿经 queryClient 缓存读回(gcTime Infinity):切页/卸载重挂不丢,
  // 登出 removeQueries(["student"]) 随账号缓存隔离归零(同快捷按钮纪律)
  const [draft, setDraft] = useState<ConnectionDraft>(
    () =>
      queryClient.getQueryData<ConnectionDraft>(studentAiConnectionDraftKey) ??
      EMPTY_DRAFT,
  );
  const [view, setView] = useState<"overview" | "form" | "detail">(() =>
    draft.touched || draft.editingId !== null ? "form" : "overview",
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const viewHeading = useRef<HTMLHeadingElement>(null);
  const previousView = useRef(view);
  useEffect(() => {
    if (previousView.current !== view) {
      viewHeading.current?.focus();
      previousView.current = view;
    }
  }, [view]);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [resetTokenConnection, setResetTokenConnection] =
    useState<AiConnectionPublic | null>(null);
  /** 保存成功且带来源题时的回跳提示 */
  const [savedFrom, setSavedFrom] = useState(false);

  const connections = connectionsQuery.data?.connections ?? [];
  const editingConnection = connections.find(
    (item) => item.id === draft.editingId,
  );
  const hasConnection = connections.length > 0;
  const editingMissing =
    draft.editingId !== null &&
    connectionsQuery.isSuccess &&
    editingConnection === undefined;
  const selectedConnection = connections.find((item) => item.id === selectedId);
  const availableChannels = (Object.keys(CHANNEL_LABEL) as AiChannel[]).filter(
    (channel) => !connections.some((item) => item.channel === channel),
  );
  /** 知情门槛:已有连接(已知情)或本次已勾选确认 */
  const consentOk = hasConnection || draft.consentAcknowledged;

  // 草稿写回缓存:gcTime Infinity,切页/卸载重挂不丢;登出清 ["student"] 一并带走
  useEffect(() => {
    queryClient.setQueryDefaults(studentAiConnectionDraftKey, {
      gcTime: Infinity,
    });
  }, [queryClient]);
  useEffect(() => {
    queryClient.setQueryData(studentAiConnectionDraftKey, draft);
  }, [queryClient, draft]);
  useEffect(() => {
    if (!draft.touched) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [draft.touched]);

  /** 就地改草稿(任何编辑都标记 touched) */
  function updateDraft(patch: Partial<ConnectionDraft>): void {
    setDraft((prev) => ({ ...prev, ...patch, touched: true }));
  }

  /** 普通导航离开的放弃确认:有未保存编辑时拦截,取消留在页面 */
  function guardNavigate(event: React.MouseEvent): void {
    if (draft.touched && !window.confirm("连接设置尚未保存,放弃更改并离开?")) {
      event.preventDefault();
    }
  }

  /** 表单本地有效性(服务端仍会完整校验;无效时保存按钮禁用) */
  const formValid =
    draft.channel !== "inapp" ||
    (draft.baseUrl.trim().length > 0 &&
      draft.model.trim().length > 0 &&
      ((draft.editingId !== null &&
        editingConnection?.channel === "inapp" &&
        draft.baseUrl.trim().replace(/\/+$/, "") ===
          editingConnection.baseUrl.replace(/\/+$/, "")) ||
        draft.apiKey.length > 0));
  const saving = createMutation.isPending || patchMutation.isPending;

  function buildCreateRequest(): AiConnectionCreateRequest {
    switch (draft.channel) {
      case "inapp":
        return {
          channel: "inapp",
          baseUrl: draft.baseUrl.trim(),
          model: draft.model.trim(),
          apiKey: draft.apiKey,
          ...(draft.imageCapability !== undefined &&
            draft.imageCapability !== "unknown" && {
              imageCapability: draft.imageCapability,
            }),
          isDefault: draft.isDefault,
        };
      case "mcp":
        return { channel: "mcp", isDefault: draft.isDefault };
      default:
        return {
          channel: "link",
          defaultValidHours: draft.defaultValidHours,
          isDefault: draft.isDefault,
        };
    }
  }

  function buildPatchRequest(
    target: AiConnectionPublic,
  ): AiConnectionPatchRequest {
    switch (target.channel) {
      case "inapp":
        return {
          channel: "inapp",
          baseUrl: draft.baseUrl.trim(),
          model: draft.model.trim(),
          // 编辑留空 = 保持原 Key(不回显旧明文;重填即轮换)
          ...(draft.apiKey.length > 0 && { apiKey: draft.apiKey }),
          ...(draft.imageCapability !== undefined &&
            draft.imageCapability !== target.imageCapability && {
              imageCapability: draft.imageCapability,
            }),
          isDefault: draft.isDefault,
        };
      case "mcp":
        return { channel: "mcp", isDefault: draft.isDefault };
      default:
        return {
          channel: target.channel,
          defaultValidHours: draft.defaultValidHours,
          isDefault: draft.isDefault,
        };
    }
  }

  /** 重置为空白新建态(知情确认记忆保留:本会话不再重复勾选) */
  function resetDraft(): void {
    setDraft((prev) => ({
      ...EMPTY_DRAFT,
      consentAcknowledged: prev.consentAcknowledged,
    }));
  }

  function leaveForm(): void {
    if (saving) return;
    if (draft.touched && !window.confirm("连接设置尚未保存，放弃更改？"))
      return;
    resetDraft();
    setNotice(null);
    setView("overview");
  }

  function startCreate(): void {
    const channel = availableChannels[0];
    if (!channel) return;
    resetDraft();
    setDraft((prev) => ({ ...prev, channel, isDefault: false }));
    setNotice(null);
    setView("form");
  }

  function handleSave(): void {
    setNotice(null);
    const editing =
      draft.editingId === null
        ? null
        : (connections.find((item) => item.id === draft.editingId) ?? null);
    if (draft.editingId !== null && editing === null) {
      setNotice({
        tone: "error",
        text: "此连接已不存在，请取消修改并返回总览重新加载。输入仍保留。",
      });
      return;
    }
    if (draft.editingId !== null && editing !== null) {
      patchMutation.mutate(
        { id: draft.editingId, request: buildPatchRequest(editing) },
        {
          onSuccess: () => {
            resetDraft();
            setView("overview");
            setNotice({ tone: "ok", text: "连接已更新。" });
            if (from !== null) setSavedFrom(true);
          },
          onError: (error) =>
            setNotice({
              tone: "error",
              text: `${errorTextOf(error, "网络异常")}。更改仍保留,请重试保存。`,
            }),
        },
      );
      return;
    }
    createMutation.mutate(buildCreateRequest(), {
      onSuccess: () => {
        resetDraft();
        setView("overview");
        setNotice({ tone: "ok", text: "连接已保存。" });
        if (from !== null) setSavedFrom(true);
      },
      onError: (error) =>
        setNotice({
          tone: "error",
          text: `${errorTextOf(error, "网络异常")}。填写的内容仍保留,请调整后重试。`,
        }),
    });
  }

  /** 进入编辑态:行值载入草稿(Key 恒空 = 不改;不回显旧明文) */
  function startEdit(connection: AiConnectionPublic): void {
    setView("form");
    setNotice(null);
    setDraft({
      editingId: connection.id,
      channel: connection.channel,
      baseUrl: connection.channel === "inapp" ? connection.baseUrl : "",
      model: connection.channel === "inapp" ? connection.model : "",
      apiKey: "",
      imageCapability:
        connection.channel === "inapp" ? connection.imageCapability : "unknown",
      defaultValidHours:
        connection.channel === "link" ? connection.defaultValidHours : 24,
      isDefault: connection.isDefault,
      consentAcknowledged: true,
      touched: false,
    });
  }

  /** 测试连接(仅 inapp;结果就地展示,不自动改写其他输入) */
  function handleTest(connection: AiConnectionPublic): void {
    if (connection.channel !== "inapp") return;
    setNotice({ tone: "info", text: "正在测试连接…" });
    testMutation.mutate(connection.id, {
      onSuccess: (data) => {
        if (data.verifyStatus === "verified") {
          setNotice({ tone: "ok", text: `连接测试成功:${data.message ?? ""}` });
        } else {
          setNotice({
            tone: "error",
            text: `连接测试未通过:${data.message ?? "请检查配置后重试"}`,
          });
        }
      },
      onError: (error) =>
        setNotice({
          tone: "error",
          text: `连接测试失败:${errorTextOf(error, "网络异常")}。配置未被修改。`,
        }),
    });
  }

  /** 主动重新生成凭证；旧 Token 立即失效，连接卡同步刷新。 */
  function handleResetToken(connection: AiConnectionPublic): void {
    if (connection.channel !== "mcp") return;
    setNotice(null);
    patchMutation.mutate(
      { id: connection.id, request: { channel: "mcp", resetToken: true } },
      {
        onSuccess: () =>
          setNotice({
            tone: "ok",
            text: "Token 已重新生成，请更新 AI 客户端配置。",
          }),
        onError: (error) =>
          setNotice({
            tone: "error",
            text: `重置 Token 失败:${errorTextOf(error, "网络异常")}`,
          }),
      },
    );
  }

  const deletingRow =
    confirmDeleteId === null
      ? null
      : (connections.find((item) => item.id === confirmDeleteId) ?? null);

  const consentPanel = (
    <details
      open={!hasConnection}
      aria-labelledby="ai-consent-title"
      className="space-y-3 rounded-xl border border-border bg-card p-5"
    >
      <summary
        id="ai-consent-title"
        className="cursor-pointer text-sm font-medium focus-visible:outline-2 focus-visible:outline-ring"
      >
        数据外发说明
      </summary>
      <ul className="list-disc space-y-1.5 pl-5 text-sm leading-relaxed text-muted-foreground">
        <li>
          求助内容将发送到你配置的 AI 服务(发送目的地由你在此页选择并保存)。
        </li>
        <li>默认包含本题已有答案解析(实际尺度服从教师设置的教学模式)。</li>
        <li>所选书写材料(圈画、草稿、手写)可能包含你的姓名。</li>
        <li>调用外部 AI 可能产生 API 费用,按你的连接服务方计费。</li>
      </ul>
      {!hasConnection && (
        <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm">
          <input
            type="checkbox"
            aria-label="我已了解数据外发说明"
            className="size-4 accent-primary"
            checked={draft.consentAcknowledged}
            onChange={(event) =>
              setDraft((prev) => ({
                ...prev,
                consentAcknowledged: event.target.checked,
                touched: true,
              }))
            }
          />
          我已了解数据外发说明,同意在主动求助时按上述方式发送。
        </label>
      )}
      {hasConnection && (
        <p className="text-xs text-muted-foreground">
          已确认外发说明。之后求助不需逐题重复确认,但每次发送仍由你主动操作。
        </p>
      )}
    </details>
  );

  function renderConnection(connection: AiConnectionPublic, detail = false) {
    return (
      <AiConnectionCard
        connection={connection}
        detail={detail}
        busy={saving || testMutation.isPending || deleteMutation.isPending}
        onView={() => {
          setSelectedId(connection.id);
          setNotice(null);
          setView("detail");
        }}
        onEdit={() => startEdit(connection)}
        onTest={() => handleTest(connection)}
        onResetToken={() => setResetTokenConnection(connection)}
        onDelete={() => setConfirmDeleteId(connection.id)}
        onDefault={() => {
          setNotice(null);
          patchMutation.mutate(
            {
              id: connection.id,
              request: { channel: connection.channel, isDefault: true },
            },
            {
              onSuccess: () =>
                setNotice({ tone: "ok", text: "默认连接已更新。" }),
              onError: (error) =>
                setNotice({
                  tone: "error",
                  text: `设置默认连接失败：${errorTextOf(error, "网络异常")}，请重试。`,
                }),
            },
          );
        }}
      />
    );
  }

  const connectionList = (
    <section
      aria-labelledby="ai-connection-list-title"
      className="min-w-0 space-y-5"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-1">
          <h2
            ref={viewHeading}
            tabIndex={-1}
            id="ai-connection-list-title"
            className="text-lg font-semibold focus-visible:outline-2 focus-visible:outline-ring"
          >
            我的连接
          </h2>
          <p className="text-sm text-muted-foreground">
            管理已保存的连接，选择求助时优先使用的方式。
          </p>
        </div>
        {connectionsQuery.isSuccess && availableChannels.length > 0 && (
          <Button className="min-h-11" onClick={startCreate}>
            新增连接
          </Button>
        )}
      </div>
      {connectionsQuery.isPending && (
        <p role="status" className="py-8 text-sm text-muted-foreground">
          正在加载连接…
        </p>
      )}
      {connectionsQuery.isError && (
        <div className="rounded-xl border border-border bg-card p-5">
          <p role="alert" className="text-sm text-destructive">
            无法加载连接，请重试。
          </p>
          <Button
            variant="outline"
            className="mt-3 min-h-11"
            onClick={() => void connectionsQuery.refetch()}
          >
            重新加载
          </Button>
        </div>
      )}
      {connectionsQuery.isSuccess && !hasConnection && (
        <div className="rounded-xl border border-dashed border-border bg-card px-5 py-10 text-center">
          <p className="font-medium">尚未配置 AI 连接</p>
          <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">
            添加一种使用方式，即可在题目旁主动求助。已有 AI 客户端可选
            MCP，也可以使用 API 在本站提问。
          </p>
        </div>
      )}
      {hasConnection && (
        <ul className="space-y-3">
          {connections.map((connection) => (
            <li key={connection.id}>{renderConnection(connection)}</li>
          ))}
        </ul>
      )}
      {connectionsQuery.isSuccess && availableChannels.length === 0 && (
        <p className="text-sm text-muted-foreground">
          三种使用方式均已添加，可在对应连接中查看或修改配置。
        </p>
      )}
    </section>
  );

  return (
    <div className="min-w-0 space-y-6">
      {/* 普通导航返回设置入口(dirty 时先确认,取消留在页面) */}
      <Link
        to="/s/settings"
        aria-label="返回设置"
        onClick={guardNavigate}
        className="inline-flex min-h-11 items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        ← 返回设置
      </Link>

      {/* —— 操作提示(单槽:成功 / 进行中 / 错误)—— */}
      {notice !== null && (
        <p
          role={notice.tone === "error" ? "alert" : "status"}
          className={
            notice.tone === "error"
              ? "flex items-start gap-2 text-sm text-destructive"
              : "flex items-start gap-2 text-sm text-muted-foreground"
          }
        >
          {notice.tone === "error" && (
            <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
          )}
          {notice.text}
        </p>
      )}

      {view === "overview" && connectionList}
      {view === "detail" && (
        <section
          className="min-w-0 space-y-5"
          aria-labelledby="ai-detail-title"
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2
              ref={viewHeading}
              tabIndex={-1}
              id="ai-detail-title"
              className="text-lg font-semibold focus-visible:outline-2 focus-visible:outline-ring"
            >
              {selectedConnection
                ? `${CHANNEL_LABEL[selectedConnection.channel]} 配置`
                : "连接已移除"}
            </h2>
            <Button
              variant="outline"
              className="min-h-11"
              onClick={() => {
                setNotice(null);
                setView("overview");
              }}
            >
              返回我的连接
            </Button>
          </div>
          {selectedConnection ? (
            renderConnection(selectedConnection, true)
          ) : (
            <p className="text-sm text-muted-foreground">
              此连接已不存在，请返回查看其他连接。
            </p>
          )}
        </section>
      )}
      {from !== null && !draft.touched && view === "overview" && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card p-4 text-sm">
          <p className="text-muted-foreground">
            {savedFrom
              ? "连接已保存，回到原题即可主动发起求助。"
              : "回到原题继续学习，尚未发送的问题会保留。"}
          </p>
          <Link
            to={from}
            onClick={guardNavigate}
            className="inline-flex min-h-11 items-center rounded-lg bg-primary px-4 font-medium text-primary-foreground"
          >
            返回原题
          </Link>
        </div>
      )}
      {view === "form" && (
        <div className="min-w-0 space-y-6">
          {/* —— 新建 / 编辑表单 —— */}
          <section
            aria-labelledby="ai-connection-form-title"
            className="min-w-0 space-y-5 rounded-2xl border border-border bg-card p-4 shadow-sm sm:p-6"
          >
            <h2
              ref={viewHeading}
              tabIndex={-1}
              id="ai-connection-form-title"
              className="text-lg font-semibold focus-visible:outline-2 focus-visible:outline-ring"
            >
              {draft.editingId === null ? "新增连接" : "修改连接"}
            </h2>
            {editingMissing && (
              <p role="alert" className="text-sm text-destructive">
                此连接已不存在，请取消修改并返回总览重新加载。输入仍保留。
              </p>
            )}
            {draft.editingId === null ? (
              <fieldset className="space-y-2">
                <legend className="mb-2 text-sm font-medium">
                  选择使用方式
                </legend>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  {(Object.keys(CHANNEL_LABEL) as AiChannel[]).map(
                    (channel) => (
                      <label
                        key={channel}
                        className={`flex min-h-24 cursor-pointer items-start gap-3 rounded-xl border p-4 text-sm has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring ${draft.channel === channel ? "border-primary bg-primary/5" : "border-border hover:bg-muted/50"}`}
                      >
                        <input
                          type="radio"
                          disabled={connections.some(
                            (item) => item.channel === channel,
                          )}
                          name="ai-connection-channel"
                          aria-label={CHANNEL_LABEL[channel]}
                          className="mt-0.5 size-4 shrink-0 accent-primary"
                          checked={draft.channel === channel}
                          onChange={() => {
                            setNotice(null);
                            updateDraft({ channel });
                          }}
                        />
                        <span className="space-y-1">
                          <span className="block font-medium">
                            {CHANNEL_LABEL[channel]}
                            {connections.some(
                              (item) => item.channel === channel,
                            ) && (
                              <span className="ms-2 text-xs text-muted-foreground">
                                已添加
                              </span>
                            )}
                          </span>
                          <span className="block text-xs leading-relaxed text-muted-foreground">
                            {channel === "inapp"
                              ? "在题目旁提问，回复直接显示在本站"
                              : channel === "mcp"
                                ? "让支持 MCP 的 AI 客户端领取题目并回传回复"
                                : "把本题链接发给能够打开网页的 AI"}
                          </span>
                        </span>
                      </label>
                    ),
                  )}
                </div>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {draft.channel === "inapp"
                    ? "在题目旁直接提问和查看回复，支持 OpenAI 兼容接口。"
                    : draft.channel === "mcp"
                      ? "连接你常用的 AI 客户端，领取求助并将回复带回题目。"
                      : "复制本题上下文链接，交给外部 AI 读取；回复在外部查看。"}
                </p>
              </fieldset>
            ) : (
              <p className="text-sm text-muted-foreground">
                正在修改{CHANNEL_LABEL[draft.channel]}
                。保存后生效，其他连接不受影响。
              </p>
            )}

            {draft.channel === "inapp" && (
              <InappConnectionFields
                key={draft.editingId ?? "new"}
                values={{
                  baseUrl: draft.baseUrl,
                  model: draft.model,
                  apiKey: draft.apiKey,
                  imageCapability: draft.imageCapability ?? "unknown",
                }}
                connectionId={draft.editingId}
                savedBaseUrl={
                  editingConnection?.channel === "inapp"
                    ? editingConnection.baseUrl
                    : null
                }
                onChange={updateDraft}
              />
            )}

            {draft.channel === "mcp" && (
              <div className="flex flex-col gap-1.5 text-sm leading-relaxed text-muted-foreground">
                <p className="flex items-start gap-2">
                  <CircleAlert
                    aria-hidden
                    className="mt-0.5 size-4 shrink-0 text-primary"
                  />
                  MCP Token 由系统生成，保存后可随时查看和复制。
                </p>
                <p>
                  保存后复制完整配置并粘贴到 AI 客户端。客户端需要支持 Bearer
                  Token 认证与 Streamable HTTP 传输。
                </p>
              </div>
            )}

            {draft.channel === "link" && (
              <div className="grid gap-6 lg:grid-cols-2">
                <div className="space-y-4 text-sm leading-relaxed">
                  <h3 className="font-medium">把一道题交给外部 AI</h3>
                  <ol className="list-decimal space-y-2 pl-5 text-muted-foreground">
                    <li>保存此方式后，在题目旁选择「上下文链接」并生成。</li>
                    <li>复制带读取说明的内容，粘贴到支持联网读网页的 AI。</li>
                    <li>先让 AI 确认本次读取的题号，再继续提问。</li>
                  </ol>
                  <p className="rounded-lg bg-muted/60 p-3 text-muted-foreground">
                    每条链接只含一道题。可生成多条独立链接；同时发送时，请要求
                    AI 逐条打开并核对，不能默认它已读完全部题目。
                  </p>
                  <p className="text-xs text-muted-foreground">
                    每次读取都会重新检查有效期和访问权限，本站不缓存分享响应。链接保存的是生成时的题目快照；修改作答后需更新求助内容并重新生成。第三方
                    AI
                    可能无法联网或沿用自己的缓存，无法读取时请使用「复制文字与下载材料」。
                  </p>
                  <p className="text-xs text-muted-foreground">
                    外部 AI
                    需要能访问本站地址。若本站只在本机或局域网开放，请改用复制文字，或在本站使用页内
                    AI。
                  </p>
                </div>
                <label className="flex flex-col gap-1.5 self-start rounded-xl bg-muted/50 p-5 text-sm">
                  <span>
                    新链接默认有效期(小时,1–{AI_SHARE_MAX_VALID_HOURS})
                  </span>
                  <input
                    type="number"
                    aria-label="新链接默认有效期(小时)"
                    min={1}
                    max={AI_SHARE_MAX_VALID_HOURS}
                    className="w-full min-h-11 max-w-48 rounded-lg border border-input bg-background px-3 py-2 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
                    value={draft.defaultValidHours}
                    onChange={(event) =>
                      updateDraft({
                        defaultValidHours: Number(event.target.value) || 1,
                      })
                    }
                  />
                  <span className="mt-2 text-xs leading-relaxed text-muted-foreground">
                    过期后外部 AI
                    无法再打开。获得链接的人也能读取本题资料，请只发给你信任的
                    AI；可在题目旁撤销链接。
                  </span>
                </label>
              </div>
            )}

            {consentPanel}

            <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm">
              <input
                type="checkbox"
                aria-label="设为默认连接"
                className="size-4 accent-primary"
                checked={draft.isDefault}
                onChange={(event) =>
                  updateDraft({ isDefault: event.target.checked })
                }
              />
              设为默认连接(求助时优先使用;同时间只有一条默认)
            </label>

            {!consentOk && (
              <p className="text-sm text-muted-foreground">
                请先勾选上方「我已了解数据外发说明」再保存连接。
              </p>
            )}

            <div className="flex flex-wrap items-center gap-3">
              <Button
                type="button"
                className="min-h-11 px-5"
                disabled={!consentOk || !formValid || saving || editingMissing}
                onClick={handleSave}
              >
                {saving && (
                  <Loader2 aria-hidden className="motion-safe:animate-spin" />
                )}
                保存连接
              </Button>
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                disabled={saving}
                onClick={leaveForm}
              >
                {draft.editingId === null ? "取消新增" : "取消修改"}
              </Button>
              <p role="status" className="text-xs text-muted-foreground">
                {draft.touched ? "有未保存的更改" : "表单无未保存更改"}
              </p>
            </div>
          </section>
        </div>
      )}

      {/* 删除确认:软删停发该通道 created 任务,列明后果 */}
      <Dialog
        open={resetTokenConnection !== null}
        onOpenChange={(open) => {
          if (!open) setResetTokenConnection(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>重新生成 MCP Token？</DialogTitle>
            <DialogDescription>
              旧 Token 将立即失效，已连接的 AI
              客户端需要粘贴新配置才能继续使用。历史求助记录会保留。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              className="min-h-11"
              onClick={() => setResetTokenConnection(null)}
            >
              取消
            </Button>
            <Button
              className="min-h-11"
              onClick={() => {
                const connection = resetTokenConnection;
                setResetTokenConnection(null);
                if (connection !== null) handleResetToken(connection);
              }}
            >
              重新生成 Token
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={confirmDeleteId !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmDeleteId(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>删除连接</DialogTitle>
            <DialogDescription asChild>
              <div className="space-y-2">
                <p>
                  将删除「
                  {deletingRow === null
                    ? ""
                    : CHANNEL_LABEL[deletingRow.channel]}
                  」连接
                  {deletingRow?.isDefault === true ? "(默认连接)" : ""}。
                  未发出的求助将停止发送;历史求助记录保留,不受影响。
                </p>
                <p>删除后需要时可重新配置。</p>
              </div>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              className="min-h-11"
              onClick={() => setConfirmDeleteId(null)}
            >
              取消
            </Button>
            <Button
              variant="destructive"
              className="min-h-11"
              disabled={deleteMutation.isPending}
              onClick={() => {
                if (confirmDeleteId === null) return;
                deleteMutation.mutate(confirmDeleteId, {
                  onSuccess: () => {
                    setConfirmDeleteId(null);
                    setNotice({ tone: "ok", text: "连接已删除。" });
                    setView("overview");
                    if (draft.editingId === confirmDeleteId) resetDraft();
                  },
                  onError: (error) =>
                    setNotice({
                      tone: "error",
                      text: `删除失败:${errorTextOf(error, "网络异常")}`,
                    }),
                });
              }}
            >
              删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
