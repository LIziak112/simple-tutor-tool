import { useQuery } from "@tanstack/react-query";
import { Bot, Check, Copy, Link2, Loader2, PlugZap } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ApiTokenSection } from "@/features/teacher-settings/ApiTokenSection";
import { useApiToken } from "@/features/teacher-settings/api-token-queries";
import { fetchPublicConfig } from "@/lib/api";
import { copyText } from "@/lib/copy";

const TOKEN_PLACEHOLDER = "<你的API_TOKEN>";

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

/** 复制反馈关联被复制内容，凭据更新后不会沿用旧配置的成功状态。 */
function CopyBlock({
  label,
  text,
  ariaLabel,
}: {
  label: string;
  text: string;
  ariaLabel: string;
}) {
  const [result, setResult] = useState<{ text: string; ok: boolean } | null>(
    null,
  );
  const copied = result?.text === text && result.ok;
  const failed = result?.text === text && !result.ok;

  async function handleCopy() {
    setResult({ text, ok: await copyText(text) });
  }

  return (
    <div className="min-w-0 space-y-2">
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
      <pre className="overflow-x-auto rounded-lg border border-border bg-muted/50 p-4 font-mono text-xs leading-relaxed break-all whitespace-pre-wrap">
        {text}
      </pre>
      <p role="status" className="sr-only">
        {copied ? "已复制" : ""}
      </p>
      {failed && (
        <p role="alert" className="text-sm text-destructive">
          复制失败，请选中内容手动复制。
        </p>
      )}
    </div>
  );
}

/** 凭据、地址、客户端配置三个步骤；两类客户端共用一份配置。 */
export function ConnectPage() {
  const configQuery = useQuery({
    queryKey: ["public-config"],
    queryFn: fetchPublicConfig,
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
  const tokenQuery = useApiToken();
  const [client, setClient] = useState("generic");
  const serverUrl = configQuery.data
    ? `${configQuery.data.publicUrl}/mcp`
    : null;
  const token = tokenQuery.data?.token ?? null;

  return (
    <section className="mx-auto w-full max-w-5xl px-4 py-6 lg:px-8 lg:py-8">
      <header className="mb-7">
        <p className="mb-2 text-xs font-medium text-muted-foreground">
          AI 与教学协作
        </p>
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <PlugZap aria-hidden className="size-6" />
          连接 AI
        </h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
          让支持 MCP 的 AI
          客户端读取学情、出题并导入练习。访问范围仅限你的数据。
        </p>
        <ol
          aria-label="连接步骤"
          className="mt-5 flex flex-wrap gap-x-6 gap-y-2 text-sm text-muted-foreground"
        >
          {["生成凭据", "复制地址", "配置客户端"].map((step, index) => (
            <li key={step} className="flex items-center gap-2">
              <span
                aria-hidden
                className="flex size-6 items-center justify-center rounded-full border border-border bg-card text-xs font-medium text-foreground"
              >
                {index + 1}
              </span>
              {step}
            </li>
          ))}
        </ol>
      </header>
      <div className="grid min-w-0 items-start gap-6 xl:grid-cols-[minmax(0,1fr)_220px]">
        <div className="min-w-0 space-y-5">
          <ApiTokenSection
            title="第一步：你的 API Token"
            showConnectionLink={false}
          />
          <div className="space-y-4 rounded-xl border border-border bg-card p-5">
            <h2 className="flex items-center gap-2 text-base font-semibold">
              <Link2 aria-hidden className="size-4" />
              第二步：MCP 服务器地址
            </h2>
            <p className="text-sm leading-relaxed text-muted-foreground">
              在客户端中填写下方地址。地址由服务器部署配置生成。
            </p>
            {configQuery.isError ? (
              <div className="space-y-3">
                <p role="alert" className="text-sm text-destructive">
                  获取地址失败，请重试；仍无法获取时检查服务器部署配置。
                </p>
                <Button
                  variant="outline"
                  className="min-h-11"
                  onClick={() => void configQuery.refetch()}
                >
                  重新获取地址
                </Button>
              </div>
            ) : serverUrl === null ? (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2
                  aria-hidden
                  className="size-4 motion-safe:animate-spin"
                />
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
          <div className="space-y-4 rounded-xl border border-border bg-card p-5">
            <h2 className="flex items-center gap-2 text-base font-semibold">
              <Bot aria-hidden className="size-4" />
              第三步：客户端配置示例
            </h2>
            <fieldset className="flex flex-wrap gap-2">
              <legend className="mb-2 text-sm font-medium">选择客户端</legend>
              {[
                ["generic", "通用客户端"],
                ["claude", "Claude Desktop"],
              ].map(([value, label]) => (
                <label
                  key={value}
                  className={`flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm ${client === value ? "border-primary bg-muted font-medium" : "border-border"}`}
                >
                  <input
                    type="radio"
                    name="mcp-client"
                    value={value}
                    checked={client === value}
                    onChange={() => setClient(value ?? "generic")}
                    className="size-4 accent-primary"
                  />
                  {label}
                </label>
              ))}
            </fieldset>
            <p className="text-sm leading-relaxed text-muted-foreground">
              {token === null
                ? "尚未生成 Token，片段中为占位符，请先在第一步生成。"
                : "配置已代入服务器地址与 Token，复制后粘贴到客户端。"}
            </p>
            {client === "claude" && (
              <p className="text-sm leading-relaxed break-words text-muted-foreground">
                打开客户端支持的 MCP
                配置入口并合并配置。使用本地配置文件时，Windows 路径为{" "}
                <code className="font-mono text-xs break-all">
                  %APPDATA%\Claude\claude_desktop_config.json
                </code>
                ；macOS 路径为{" "}
                <code className="font-mono text-xs break-all">
                  ~/Library/Application
                  Support/Claude/claude_desktop_config.json
                </code>
                。不同版本的接入能力可能不同，以客户端支持的连接方式为准。
              </p>
            )}
            {serverUrl !== null && !configQuery.isError && (
              <CopyBlock
                label={
                  client === "claude"
                    ? "Claude Desktop 配置（claude_desktop_config.json）"
                    : "通用 MCP 配置"
                }
                text={buildMcpServersConfig(
                  serverUrl,
                  token ?? TOKEN_PLACEHOLDER,
                )}
                ariaLabel={
                  client === "claude"
                    ? "复制 Claude Desktop 配置 JSON"
                    : "复制通用 MCP 配置 JSON"
                }
              />
            )}
          </div>
        </div>
        <aside
          aria-label="连接帮助"
          className="space-y-5 rounded-xl border border-border bg-card p-5"
        >
          <div>
            <h2 className="text-base font-semibold">连接后可以做什么</h2>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              “总结这位学生两周的薄弱点，出 8 道针对性练习并导入。”
            </p>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              AI 报告保存在学生画像页，便于回看与安排下一次教学。
            </p>
          </div>
          <div>
            <h2 className="text-base font-semibold">地址无法访问？</h2>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              检查服务器 PUBLIC_URL 是否与实际访问地址一致，并确认客户端支持
              Streamable HTTP。
            </p>
          </div>
          <div>
            <h2 className="text-base font-semibold">保管连接凭据</h2>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              配置中包含
              Token，请保存在自己的客户端。重置后需同步更新客户端配置。
            </p>
          </div>
        </aside>
      </div>
    </section>
  );
}

export default ConnectPage;
