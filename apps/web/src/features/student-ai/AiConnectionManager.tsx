import { useQueryClient } from "@tanstack/react-query";
import type {
  AiChannel,
  AiConnectionCreateRequest,
  AiConnectionFirstCredential,
  AiConnectionPatchRequest,
  AiConnectionPublic,
} from "@tutor/contract";
import { AI_SHARE_MAX_VALID_HOURS } from "@tutor/contract";
import {
  BadgeCheck,
  Bot,
  CircleAlert,
  Info,
  Link2,
  Loader2,
  Terminal,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { CopyBlock } from "@/components/CopyBlock";
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
import { copyText } from "@/lib/copy";
import { buildMcpServersConfig } from "@/lib/mcp-config";
import { CHANNEL_LABEL } from "./ai-channel-label";
import {
  studentAiConnectionDraftKey,
  useCreateStudentAiConnection,
  useDeleteStudentAiConnection,
  usePatchStudentAiConnection,
  useStudentAiConnections,
  useTestStudentAiConnection,
} from "./ai-connection-queries";

/**
 * SAI-18 学生「连接 AI」管理区(/s/settings/ai,需求 §4.3/§5.6/§6.2):
 * - 首次知情:发送目的地、默认已有答案解析、材料可能含姓名、费用四要素
 *   常驻可随时查看;无任何连接时必须显式勾选确认才能保存(不默认同意向
 *   任何目的地发送),已有连接即视为已知情、不逐题重复确认;
 * - 页内(inapp)连接完整管理:选择批准端点/模型、录入 Key、测试(无题面
 *   探针)、修改、删除、默认通道;Key 只显示安全状态——输入 password、
 *   列表只回指纹,编辑留空 = 保持原 Key,永不回显旧明文;
 * - mcp 一次性 token:创建/重置响应的明文只展示一次,复制成功/失败都有
 *   真实反馈,失败可手动复制(HTTP 剪贴板降级见 lib/copy);同区域给出已
 *   代入本次 Token 的完整 mcpServers 配置(教师 /t/connect 同款结构,
 *   lib/mcp-config 共用生成),可整段复制;
 * - mcp 通道(SAI-27):连接行常驻展示端点(/mcp/student)与认证方式
 *   Bearer Token,可一键复制端点,并常驻完整配置示例(Token 为占位符、
 *   按钮明示「复制示例」,替换指引与重置入口就近给出);「配置已保存」徽章只表示已配置,
 *   无可靠在线信号不标在线/已连接;不能附 Bearer 或仅支持 OAuth 的
 *   客户端如实标注当前不兼容,不用长效密钥链接绕过;
 * - link 通道功能建设中:如实说明进度,不显示「已连接」;
 * - 表单草稿存 queryClient(gcTime Infinity)切页不丢,后台 refetch 不
 *   覆盖;保存/测试失败保留输入并显示可操作错误(409 不吞改动);
 * - 带来源题(?from=)进入时保存成功提供「返回原题」入口,返回后由学生
 *   再次主动发(B11 发送控制器),本页绝不自动创建求助任务;
 * - 有未保存编辑时普通导航离开先确认(取消留在页面),刷新/关闭走
 *   beforeunload。
 */

/** 表单草稿(新建/编辑共用;channel 决定可见字段) */
interface ConnectionDraft {
  /** 正在修改的连接 id(null = 新建);随草稿缓存,重挂不丢编辑对象 */
  readonly editingId: string | null;
  readonly channel: AiChannel;
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKey: string;
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

/**
 * 学生 MCP 端点(SAI-25 独立端点,同源部署):随当前部署地址推导,
 * 展示与复制共用一份;认证方式为 Bearer Token(一次性明文 Token)。
 */
function studentMcpEndpointUrl(): string {
  return `${window.location.origin}/mcp/student`;
}

/** 行内配置示例的 Token 占位符(明文只出现一次,行内不虚构可用凭据) */
const STUDENT_MCP_TOKEN_PLACEHOLDER = "<你的MCP_TOKEN>";

/**
 * 学生侧完整 mcpServers 配置(教师 /t/connect 同款结构,一键复制到客户端):
 * 键名用 tutor-student,与教师端 tutor 区分,同一客户端同时配置两端不覆盖。
 */
function studentMcpServersConfig(token: string): string {
  return buildMcpServersConfig({
    serverKey: "tutor-student",
    serverUrl: studentMcpEndpointUrl(),
    token,
  });
}

/** verifyStatus 徽章文案:已配置 / 验证成功 / 暂不可用分开显示 */
function verifyBadgeOf(connection: AiConnectionPublic): {
  text: string;
  tone: "ok" | "warn" | "muted";
} {
  // mcp/link 无测试语义(SAI-16:verifyStatus 恒 unverified),只如实说明
  // 配置已保存——在线判断归后续领取链路,不显示「已连接」
  if (connection.channel !== "inapp") {
    return { text: "配置已保存", tone: "muted" };
  }
  switch (connection.verifyStatus) {
    case "verified":
      return { text: "验证成功", tone: "ok" };
    case "failed":
      return { text: "测试未通过,暂不可用", tone: "warn" };
    case "needs_rekey":
      return { text: "需重新填写 Key", tone: "warn" };
    default:
      return { text: "已保存,未测试", tone: "muted" };
  }
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
  /** mcp 创建/重置的一次性 token 展示(明文只出现在本组件内存) */
  const [tokenOnce, setTokenOnce] =
    useState<AiConnectionFirstCredential | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
    "idle",
  );
  /** mcp 端点复制反馈(与 token 复制分开,一次只对一个对象给反馈) */
  const [endpointCopyState, setEndpointCopyState] = useState<
    "idle" | "copied" | "failed"
  >("idle");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  /** 保存成功且带来源题时的回跳提示 */
  const [savedFrom, setSavedFrom] = useState(false);

  const connections = connectionsQuery.data?.connections ?? [];
  const hasConnection = connections.length > 0;
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
      (draft.editingId !== null || draft.apiKey.length > 0));
  const saving = createMutation.isPending || patchMutation.isPending;

  function buildCreateRequest(): AiConnectionCreateRequest {
    switch (draft.channel) {
      case "inapp":
        return {
          channel: "inapp",
          baseUrl: draft.baseUrl.trim(),
          model: draft.model.trim(),
          apiKey: draft.apiKey,
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
          isDefault: draft.isDefault,
        };
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

  function handleSave(): void {
    setNotice(null);
    const editing =
      draft.editingId === null
        ? null
        : (connections.find((item) => item.id === draft.editingId) ?? null);
    if (draft.editingId !== null && editing !== null) {
      patchMutation.mutate(
        { id: draft.editingId, request: buildPatchRequest(editing) },
        {
          onSuccess: (data) => {
            resetDraft();
            setNotice({ tone: "ok", text: "连接已更新。" });
            if (data.credential !== null) setTokenOnce(data.credential);
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
      onSuccess: (data) => {
        resetDraft();
        setNotice({ tone: "ok", text: "连接已保存。" });
        if (data.credential !== null) setTokenOnce(data.credential);
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
    setNotice(null);
    setDraft({
      editingId: connection.id,
      channel: connection.channel,
      baseUrl: connection.channel === "inapp" ? connection.baseUrl : "",
      model: connection.channel === "inapp" ? connection.model : "",
      apiKey: "",
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

  /** mcp 重置 token(旧 token 立即失效;新明文只在响应出现一次) */
  function handleResetToken(connection: AiConnectionPublic): void {
    if (connection.channel !== "mcp") return;
    setNotice(null);
    patchMutation.mutate(
      { id: connection.id, request: { channel: "mcp", resetToken: true } },
      {
        onSuccess: (data) => {
          if (data.credential !== null) {
            setTokenOnce(data.credential);
            setCopyState("idle");
          }
        },
        onError: (error) =>
          setNotice({
            tone: "error",
            text: `重置 Token 失败:${errorTextOf(error, "网络异常")}`,
          }),
      },
    );
  }

  async function handleCopyToken(): Promise<void> {
    if (tokenOnce === null) return;
    const ok = await copyText(tokenOnce.token);
    setCopyState(ok ? "copied" : "failed");
  }

  /** 复制学生 MCP 端点(SAI-27:端点常驻展示,配置外部客户端时直接复制) */
  async function handleCopyEndpoint(): Promise<void> {
    const ok = await copyText(studentMcpEndpointUrl());
    setEndpointCopyState(ok ? "copied" : "failed");
  }

  const deletingRow =
    confirmDeleteId === null
      ? null
      : (connections.find((item) => item.id === confirmDeleteId) ?? null);

  return (
    <div className="space-y-6">
      {/* 普通导航返回设置入口(dirty 时先确认,取消留在页面) */}
      <Link
        to="/s/settings"
        aria-label="返回设置"
        onClick={guardNavigate}
        className="inline-flex min-h-11 items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        ← 返回设置
      </Link>

      {/* —— 首次知情说明(四要素常驻,可随时查看)—— */}
      <section
        aria-labelledby="ai-consent-title"
        className="space-y-3 rounded-xl border border-border bg-card p-5"
      >
        <h2
          id="ai-consent-title"
          className="flex items-center gap-2 font-semibold"
        >
          <Info aria-hidden className="size-4 text-primary" />
          数据外发说明
        </h2>
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
      </section>

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

      {/* —— mcp 一次性 token 展示(明文只出现一次,复制有真实反馈)—— */}
      {tokenOnce !== null && (
        <section
          aria-label="MCP Token 一次性展示"
          className="space-y-3 rounded-xl border border-primary/40 bg-primary/5 p-5"
        >
          <h3 className="flex items-center gap-2 font-semibold">
            <BadgeCheck aria-hidden className="size-4 text-primary" />
            MCP Token(只显示这一次)
          </h3>
          <p className="text-sm leading-relaxed text-muted-foreground">
            以下 Token 是访问 MCP 工具的唯一凭证,关闭本区域后无法再次查看;
            遗失只能重置(Token 重置后旧 Token 立即失效)。
          </p>
          <code className="block break-all rounded-lg bg-muted px-3 py-2 font-mono text-sm">
            {tokenOnce.token}
          </code>
          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="button"
              className="min-h-11"
              onClick={() => void handleCopyToken()}
            >
              复制 Token
            </Button>
            {copyState === "copied" && (
              <span role="status" className="text-sm text-primary">
                已复制
              </span>
            )}
            {copyState === "failed" && (
              <span role="alert" className="text-sm text-destructive">
                复制失败,请手动复制上方内容
              </span>
            )}
          </div>
          <p className="text-sm leading-relaxed text-muted-foreground">
            把下方配置整段复制到你的 AI 客户端即可,已代入本次
            Token,无需再手动替换。
          </p>
          <CopyBlock
            label="完整 MCP 配置(已代入本次 Token)"
            text={studentMcpServersConfig(tokenOnce.token)}
            ariaLabel="复制完整 MCP 配置 JSON"
          />
        </section>
      )}

      {/* —— 已配置连接列表 —— */}
      <section aria-labelledby="ai-connection-list-title" className="space-y-3">
        <h2 id="ai-connection-list-title" className="font-semibold">
          我的连接
        </h2>
        {connectionsQuery.isPending && (
          <p className="text-sm text-muted-foreground">正在加载连接…</p>
        )}
        {connectionsQuery.isError && (
          <div>
            <p role="alert" className="text-sm text-destructive">
              无法加载连接,请重试。
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
        {connectionsQuery.isSuccess && connections.length === 0 && (
          <p className="rounded-xl border border-border bg-card p-4 text-sm leading-relaxed text-muted-foreground">
            尚未配置 AI 连接。在下方选择通道并保存后,即可在求助时使用。
          </p>
        )}
        {connections.length > 0 && (
          <ul className="flex flex-col gap-3">
            {connections.map((connection) => {
              const badge = verifyBadgeOf(connection);
              return (
                <li
                  key={connection.id}
                  className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4 sm:p-5"
                >
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm">
                    <span className="flex items-center gap-1.5 font-medium">
                      {connection.channel === "inapp" && (
                        <Bot aria-hidden className="size-4 text-primary" />
                      )}
                      {connection.channel === "mcp" && (
                        <Terminal aria-hidden className="size-4 text-primary" />
                      )}
                      {connection.channel === "link" && (
                        <Link2 aria-hidden className="size-4 text-primary" />
                      )}
                      {CHANNEL_LABEL[connection.channel]}
                    </span>
                    <span
                      className={
                        badge.tone === "ok"
                          ? "rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary"
                          : badge.tone === "warn"
                            ? "rounded-full bg-destructive/10 px-2 py-0.5 text-xs text-destructive"
                            : "rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground"
                      }
                    >
                      {badge.text}
                    </span>
                    {connection.isDefault && (
                      <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                        默认通道
                      </span>
                    )}
                    {connection.channel === "link" && (
                      <span className="text-xs text-muted-foreground">
                        功能建设中,可先保存偏好
                      </span>
                    )}
                  </div>
                  <p className="break-all text-sm text-muted-foreground">
                    {connection.channel === "inapp" &&
                      `${connection.baseUrl} · 模型 ${connection.model} · Key 指纹 ${connection.keyFingerprint}`}
                    {connection.channel === "mcp" &&
                      `Token 指纹 ${connection.tokenFingerprint} · 在题目里发起的求助由外部 AI 客户端领取处理,未写回前保持等待`}
                    {connection.channel === "link" &&
                      `新链接默认有效期 ${connection.defaultValidHours} 小时`}
                  </p>
                  {connection.channel === "mcp" && (
                    <div className="space-y-2">
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                        <p className="break-all text-sm text-muted-foreground">
                          端点 <code>{studentMcpEndpointUrl()}</code> · 认证方式
                          Bearer Token(即一次性展示的 MCP Token)
                        </p>
                        <Button
                          type="button"
                          variant="outline"
                          className="min-h-11"
                          onClick={() => void handleCopyEndpoint()}
                        >
                          复制端点
                        </Button>
                        {endpointCopyState === "copied" && (
                          <span
                            role="status"
                            className="text-sm text-primary"
                          >
                            已复制
                          </span>
                        )}
                        {endpointCopyState === "failed" && (
                          <span
                            role="alert"
                            className="text-sm text-destructive"
                          >
                            复制失败,请手动复制上方内容
                          </span>
                        )}
                      </div>
                      <CopyBlock
                        label="完整 MCP 配置(Token 为占位符)"
                        text={studentMcpServersConfig(
                          STUDENT_MCP_TOKEN_PLACEHOLDER,
                        )}
                        example
                        ariaLabel="复制完整 MCP 配置示例 JSON"
                      />
                      <p className="text-xs leading-relaxed text-muted-foreground">
                        把配置中的占位符替换为你保存的
                        Token;Token 只在生成或重置时展示一次,遗失请先重置再复制。
                      </p>
                    </div>
                  )}
                  <div className="flex flex-wrap items-center gap-3">
                    {connection.channel === "inapp" && (
                      <Button
                        type="button"
                        variant="outline"
                        className="min-h-11"
                        disabled={testMutation.isPending}
                        onClick={() => handleTest(connection)}
                      >
                        {testMutation.isPending && (
                          <Loader2
                            aria-hidden
                            className="motion-safe:animate-spin"
                          />
                        )}
                        测试连接
                      </Button>
                    )}
                    {connection.channel === "mcp" && (
                      <Button
                        type="button"
                        variant="outline"
                        className="min-h-11"
                        disabled={patchMutation.isPending}
                        onClick={() => handleResetToken(connection)}
                      >
                        重置 Token
                      </Button>
                    )}
                    {connection.channel === "inapp" && (
                      <Button
                        type="button"
                        variant="outline"
                        className="min-h-11"
                        onClick={() => startEdit(connection)}
                      >
                        修改配置
                      </Button>
                    )}
                    {!connection.isDefault && (
                      <Button
                        type="button"
                        variant="outline"
                        className="min-h-11"
                        disabled={patchMutation.isPending}
                        onClick={() => {
                          setNotice(null);
                          patchMutation.mutate(
                            {
                              id: connection.id,
                              request: {
                                channel: connection.channel,
                                isDefault: true,
                              },
                            },
                            {
                              onError: (error) =>
                                setNotice({
                                  tone: "error",
                                  text: `设置默认通道失败:${errorTextOf(error, "网络异常")}`,
                                }),
                            },
                          );
                        }}
                      >
                        设为默认
                      </Button>
                    )}
                    <Button
                      type="button"
                      variant="outline"
                      aria-label="删除连接"
                      className="ml-auto size-11 p-0 text-destructive hover:text-destructive"
                      onClick={() => setConfirmDeleteId(connection.id)}
                    >
                      <Trash2 aria-hidden className="size-4" />
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* —— 新建 / 编辑表单 —— */}
      <section
        aria-labelledby="ai-connection-form-title"
        className="space-y-4 rounded-xl border border-border bg-card p-5"
      >
        <h2 id="ai-connection-form-title" className="font-semibold">
          {draft.editingId === null ? "新增连接" : "修改连接"}
        </h2>
        <fieldset className="space-y-2">
          <legend className="text-sm text-muted-foreground">通道</legend>
          <div className="flex flex-wrap gap-x-6 gap-y-2">
            {(Object.keys(CHANNEL_LABEL) as AiChannel[]).map((channel) => (
              <label
                key={channel}
                className="flex min-h-11 cursor-pointer items-center gap-2 text-sm"
              >
                <input
                  type="radio"
                  name="ai-connection-channel"
                  aria-label={CHANNEL_LABEL[channel]}
                  className="size-4 accent-primary"
                  checked={draft.channel === channel}
                  onChange={() => {
                    setNotice(null);
                    updateDraft({ channel });
                  }}
                />
                {CHANNEL_LABEL[channel]}
              </label>
            ))}
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">
            页内 AI 在作答页内直接对话;MCP 工具供外部 AI
            客户端领取处理你的求助(端点与认证方式见 mcp
            说明);上下文链接功能建设中,可先保存配置。
          </p>
        </fieldset>

        {draft.channel === "inapp" && (
          <div className="flex flex-col gap-4">
            <label className="flex flex-col gap-1.5 text-sm">
              <span>接口地址(OpenAI 兼容 baseUrl)</span>
              <input
                type="url"
                aria-label="接口地址"
                placeholder="https://api.example.com/v1"
                className="w-full rounded-lg border border-input bg-transparent px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
                value={draft.baseUrl}
                onChange={(event) =>
                  updateDraft({ baseUrl: event.target.value })
                }
              />
            </label>
            <label className="flex flex-col gap-1.5 text-sm">
              <span>模型名称</span>
              <input
                type="text"
                aria-label="模型名称"
                className="w-full rounded-lg border border-input bg-transparent px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
                value={draft.model}
                onChange={(event) => updateDraft({ model: event.target.value })}
              />
            </label>
            <label className="flex flex-col gap-1.5 text-sm">
              <span>
                API Key(只写入不回显;
                {draft.editingId === null ? "必填" : "留空 = 保持原 Key"})
              </span>
              <input
                type="password"
                aria-label="API Key"
                autoComplete="new-password"
                className="w-full rounded-lg border border-input bg-transparent px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
                value={draft.apiKey}
                onChange={(event) =>
                  updateDraft({ apiKey: event.target.value })
                }
              />
            </label>
          </div>
        )}

        {draft.channel === "mcp" && (
          <div className="flex flex-col gap-1.5 text-sm leading-relaxed text-muted-foreground">
            <p className="flex items-start gap-2">
              <CircleAlert
                aria-hidden
                className="mt-0.5 size-4 shrink-0 text-primary"
              />
              MCP Token 由系统生成,保存后只显示一次;旧 Token 可随时在此重置。
            </p>
            <p>
              外部客户端须支持 Bearer Token 认证与 Streamable HTTP 传输;不能附加
              Bearer Token 或仅支持 OAuth
              发现的客户端当前不兼容(不提供把密钥拼进链接的替代方式)。
              保存后会一次性展示已代入 Token 的完整配置,可直接整段复制到客户端。
            </p>
          </div>
        )}

        {draft.channel === "link" && (
          <label className="flex flex-col gap-1.5 text-sm">
            <span>新链接默认有效期(小时,1–{AI_SHARE_MAX_VALID_HOURS})</span>
            <input
              type="number"
              aria-label="新链接默认有效期(小时)"
              min={1}
              max={AI_SHARE_MAX_VALID_HOURS}
              className="w-full max-w-48 rounded-lg border border-input bg-transparent px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
              value={draft.defaultValidHours}
              onChange={(event) =>
                updateDraft({
                  defaultValidHours: Number(event.target.value) || 1,
                })
              }
            />
          </label>
        )}

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
          <p role="alert" className="text-sm text-destructive">
            请先勾选上方「我已了解数据外发说明」再保存连接。
          </p>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            className="min-h-11 px-5"
            disabled={!consentOk || !formValid || saving}
            onClick={handleSave}
          >
            {saving && (
              <Loader2 aria-hidden className="motion-safe:animate-spin" />
            )}
            保存连接
          </Button>
          {draft.editingId !== null && (
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              onClick={() => {
                resetDraft();
                setNotice(null);
              }}
            >
              取消修改
            </Button>
          )}
          <p role="status" className="text-xs text-muted-foreground">
            {draft.touched ? "有未保存的更改" : "表单无未保存更改"}
          </p>
        </div>

        {/* 保存成功且带来源题:提供回跳入口(返回后由学生再次主动发) */}
        {savedFrom && from !== null && !draft.touched && (
          <div className="flex flex-col gap-2 rounded-lg bg-muted p-4 text-sm sm:flex-row sm:items-center sm:justify-between">
            <p className="text-muted-foreground">
              连接已保存。回到原题后,发送仍需你再次主动确认。
            </p>
            <Link
              to={from}
              onClick={guardNavigate}
              className="flex min-h-11 items-center justify-center rounded-lg bg-primary px-4 font-medium text-primary-foreground hover:bg-primary/90"
            >
              返回原题
            </Link>
          </div>
        )}
      </section>

      {/* 删除确认:软删停发该通道 created 任务,列明后果 */}
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
                  {deletingRow?.isDefault === true ? "(当前默认通道)" : ""}。
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
