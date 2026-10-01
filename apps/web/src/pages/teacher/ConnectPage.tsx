import { useQuery } from "@tanstack/react-query";
import {
  Bot,
  Check,
  Copy,
  KeyRound,
  Link2,
  Loader2,
  PlugZap,
  Settings,
  TriangleAlert,
} from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import {
  useApiToken,
  useResetApiToken,
} from "@/features/teacher-settings/api-token-queries";
import { fetchPublicConfig } from "@/lib/api";
import { copyText } from "@/lib/copy";

/**
 * /t/connect「连接 AI」页（T4.7，D26）：把本工具接入 Claude Desktop 等
 * 支持 MCP 的客户端所需的全部信息与配置示例：
 * - MCP 服务器地址 = PUBLIC_URL + /mcp（经 /api/public/config 下发，部署
 *   配置单一来源，前端不猜协议与主机）；
 * - API Token：复用设置页 apiToken 接口（D22 每教师一份、可随时查看）；
 *   未生成时可就地生成（首次生成无失效影响，不走重置确认）；
 * - 通用 MCP 配置 JSON 片段（mcpServers + Streamable HTTP URL + Authorization
 *   header）与 Claude Desktop 专属示例（claude_desktop_config.json 写法 +
 *   配置文件位置），均一键复制（复制内容已代入真实地址与 token）。
 * 三态齐全、触控目标 ≥44px（min-h-11）。
 */

/** token 未生成时配置片段里的占位符（先生成再复制可用真实值） */
const TOKEN_PLACEHOLDER = "<你的API_TOKEN>";

/**
 * mcpServers 配置片段（通用客户端与 Claude Desktop 同一格式：Streamable HTTP
 * + Bearer header；代入真实地址与 token）。两处展示共用一份生成逻辑，
 * 差异只在页面说明文字（Claude Desktop 需指明配置文件位置）。
 */
function buildMcpServersConfig(serverUrl: string, token: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        tutor: {
          type: "http",
          url: serverUrl,
          headers: { Authorization: `Bearer ${token}` },
        },
      },
    },
    null,
    2,
  );
}

/** 一键复制行：等宽代码块 + 复制按钮（成功 2 秒内显示「已复制」） */
function CopyBlock({
  label,
  text,
  ariaLabel,
}: {
  label: string;
  text: string;
  ariaLabel: string;
}) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    if (await copyText(text)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium">{label}</p>
        <Button
          type="button"
          variant="outline"
          className="min-h-11 px-4"
          aria-label={ariaLabel}
          onClick={() => void handleCopy()}
        >
          {copied ? (
            <>
              <Check aria-hidden />
              已复制
            </>
          ) : (
            <>
              <Copy aria-hidden />
              复制
            </>
          )}
        </Button>
      </div>
      <pre className="overflow-x-auto rounded-lg border border-border bg-muted/50 p-3 font-mono text-xs leading-5 break-all whitespace-pre-wrap">
        {text}
      </pre>
    </div>
  );
}

export function ConnectPage() {
  // PUBLIC_URL（部署配置）：MCP 地址 = publicUrl + /mcp
  const configQuery = useQuery({
    queryKey: ["public-config"],
    queryFn: fetchPublicConfig,
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
  const tokenQuery = useApiToken();
  const resetMutation = useResetApiToken();

  const serverUrl =
    configQuery.data !== undefined ? `${configQuery.data.publicUrl}/mcp` : null;
  const token = tokenQuery.data?.token ?? null;
  const tokenForConfig = token ?? TOKEN_PLACEHOLDER;

  const errorText =
    tokenQuery.isError && tokenQuery.error instanceof Error
      ? tokenQuery.error.message
      : tokenQuery.isError
        ? "加载失败，请刷新重试"
        : null;

  return (
    <section className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-6 py-8">
      <header>
        <h1 className="flex items-center gap-2 text-xl font-semibold">
          <PlugZap aria-hidden className="size-5 text-primary" />
          连接 AI
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          把本工具接入 Claude Desktop 等支持 MCP 的 AI 客户端：AI 可以读取
          学情数据、按内容规范出题、校验并导入练习、把学情报告存回系统 （共 11
          个工具），全部操作只限你自己的数据域。
        </p>
      </header>

      {/* 第①步：Token */}
      <div className="flex flex-col gap-3 rounded-xl border border-border bg-card p-5 text-card-foreground">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <KeyRound aria-hidden className="size-4" />
          第一步：你的 API Token
        </h2>
        <p className="text-sm text-muted-foreground">
          每位教师一份，长期有效；可随时在设置页重置（重置后旧 Token 立即失效，
          已配置的客户端需要更新）。
        </p>

        {tokenQuery.isPending && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 aria-hidden className="size-4 animate-spin" />
            正在加载…
          </p>
        )}

        {errorText && (
          <p
            role="alert"
            className="flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
            {errorText}
          </p>
        )}

        {tokenQuery.data && (
          <div className="flex flex-col gap-3">
            {token === null ? (
              <div className="flex flex-col items-start gap-2">
                <p className="text-sm text-muted-foreground">
                  还没有 Token，生成一份即可开始连接。
                </p>
                <Button
                  className="min-h-11 px-5"
                  disabled={resetMutation.isPending}
                  onClick={() => resetMutation.mutate(undefined)}
                >
                  {resetMutation.isPending ? (
                    <>
                      <Loader2 aria-hidden className="animate-spin" />
                      正在生成…
                    </>
                  ) : (
                    "生成 Token"
                  )}
                </Button>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <code className="min-h-11 flex-1 overflow-x-auto rounded-lg border border-border bg-muted/50 px-3 py-3 font-mono text-sm break-all">
                  {token}
                </code>
                <TokenCopyButton token={token} />
              </div>
            )}
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Settings aria-hidden className="size-3.5 shrink-0" />
              Token 的查看与重置也在
              <Link
                to="/t/settings"
                className="rounded font-medium text-primary outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                设置页
              </Link>
              。
            </p>
          </div>
        )}
      </div>

      {/* 第②步：服务器地址 */}
      <div className="flex flex-col gap-3 rounded-xl border border-border bg-card p-5 text-card-foreground">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <Link2 aria-hidden className="size-4" />
          第二步：MCP 服务器地址
        </h2>
        <p className="text-sm text-muted-foreground">
          按部署配置（PUBLIC_URL）生成；若地址打不开，请先检查服务器 PUBLIC_URL
          环境变量与实际访问地址是否一致。
        </p>
        {serverUrl === null ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 aria-hidden className="size-4 animate-spin" />
            正在获取部署地址…
          </p>
        ) : (
          <CopyBlock
            label="MCP 端点（Streamable HTTP）"
            text={serverUrl}
            ariaLabel="复制 MCP 服务器地址"
          />
        )}
      </div>

      {/* 第③步：配置示例 */}
      <div className="flex flex-col gap-4 rounded-xl border border-border bg-card p-5 text-card-foreground">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <Bot aria-hidden className="size-4" />
          第三步：客户端配置示例
        </h2>
        <p className="text-sm text-muted-foreground">
          以下片段已代入你的服务器地址与 Token，复制后粘贴进客户端配置即可。
          {token === null &&
            "（尚未生成 Token，片段中为占位符，请先在第一步生成。）"}
        </p>

        {serverUrl !== null && (
          <>
            <CopyBlock
              label="通用 MCP 配置（mcpServers 片段，适用于支持 Streamable HTTP 的客户端）"
              text={buildMcpServersConfig(serverUrl, tokenForConfig)}
              ariaLabel="复制通用 MCP 配置 JSON"
            />
            <div className="flex flex-col gap-1.5">
              <p className="text-sm text-muted-foreground">
                Claude Desktop：打开配置文件（macOS：
                <code className="rounded bg-muted px-1 font-mono text-xs">
                  ~/Library/Application
                  Support/Claude/claude_desktop_config.json
                </code>
                ；Windows：
                <code className="rounded bg-muted px-1 font-mono text-xs">
                  %APPDATA%\Claude\claude_desktop_config.json
                </code>
                ），把下面的 mcpServers 段合并进去并保存，重启 Claude Desktop
                后工具列表会出现本工具。
              </p>
              <CopyBlock
                label="Claude Desktop 配置（claude_desktop_config.json）"
                text={buildMcpServersConfig(serverUrl, tokenForConfig)}
                ariaLabel="复制 Claude Desktop 配置 JSON"
              />
            </div>
          </>
        )}
      </div>

      <p className="text-xs text-muted-foreground">
        连接后可对 AI 说：「看看某某这两周的作业，总结薄弱点，出 8 道针对性
        练习并导入成新作业」。AI 生成的报告会保存在该学生的画像页「AI 报告」区。
      </p>
    </section>
  );
}

/** Token 一键复制（独立小组件：独立 copied 态，与配置片段的复制互不影响） */
function TokenCopyButton({ token }: { token: string }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    if (await copyText(token)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }

  return (
    <Button
      type="button"
      variant="outline"
      className="min-h-11 px-4"
      onClick={() => void handleCopy()}
    >
      {copied ? (
        <>
          <Check aria-hidden />
          已复制
        </>
      ) : (
        <>
          <Copy aria-hidden />
          复制
        </>
      )}
    </Button>
  );
}

// 供 App.tsx 路由级懒加载
export default ConnectPage;
