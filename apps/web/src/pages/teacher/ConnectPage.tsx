import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useState } from "react";
import { CopyBlock } from "@/components/CopyBlock";
import { Button } from "@/components/ui/button";
import { ApiTokenSection } from "@/features/teacher-settings/ApiTokenSection";
import { useApiToken } from "@/features/teacher-settings/api-token-queries";
import { fetchPublicConfig } from "@/lib/api";
import { buildMcpServersConfig } from "@/lib/mcp-config";

const TOKEN_PLACEHOLDER = "<你的API_TOKEN>";

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
    <section className="teacher-config-page">
      <header className="mb-7">
        <h1 className="teacher-page-title">连接 AI</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          让你熟悉的 AI 客户端参与备课与学情分析，访问范围仅限你的数据。
        </p>
        <p className="mt-5 inline-flex rounded-md bg-accent px-3 py-1 text-xs font-medium text-accent-foreground">
          {tokenQuery.isPending
            ? "正在加载凭据…"
            : tokenQuery.isError
              ? "凭据暂不可用"
              : token === null
                ? "尚未生成凭据"
                : "已生成凭据 · 请在客户端确认连接"}
        </p>
      </header>
      <div className="min-w-0 space-y-7">
        <ApiTokenSection
          title="第一步：生成连接凭据"
          showConnectionLink={false}
        />
        <div className="teacher-config-section">
          <h2 className="text-lg font-semibold">
            第二步：选择客户端并复制配置
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
              label="服务器地址（Streamable HTTP）"
              text={serverUrl}
              ariaLabel="复制 MCP 服务器地址"
            />
          )}

          <fieldset className="flex flex-wrap gap-2">
            <legend className="mb-2 text-sm font-medium">选择客户端</legend>
            {[
              ["generic", "通用客户端"],
              ["claude", "Claude Desktop"],
            ].map(([value, label]) => (
              <label
                key={value}
                className={`flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm ${client === value ? "border-primary bg-accent font-medium text-accent-foreground" : "border-border"}`}
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
            {tokenQuery.isError
              ? "凭据无法加载，配置暂用占位符。请重新加载凭据后再配置客户端。"
              : tokenQuery.isPending
                ? "正在加载凭据，配置暂用占位符。"
                : token === null
                  ? "尚未生成 Token，片段中为占位符，复制的是示例，请先在第一步生成真实凭据。"
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
                ~/Library/Application Support/Claude/claude_desktop_config.json
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
              text={buildMcpServersConfig({
                serverKey: "tutor",
                serverUrl,
                token: token ?? TOKEN_PLACEHOLDER,
              })}
              example={token === null}
              ariaLabel={
                client === "claude"
                  ? "复制 Claude Desktop 配置 JSON"
                  : "复制通用 MCP 配置 JSON"
              }
            />
          )}
        </div>
        <section className="teacher-config-section">
          <h2 className="text-lg font-semibold">第三步：在客户端确认连接</h2>
          <p className="text-sm leading-relaxed text-muted-foreground">
            配置完成后，在客户端查看可用工具。生成凭据不代表已连接成功。
          </p>
          <p className="text-sm leading-relaxed text-muted-foreground">
            可以尝试：“总结这位学生两周的薄弱点，出 8 道针对性练习并导入。”AI
            报告保存在学生画像页。
          </p>
        </section>
        <details className="rounded-xl border border-border bg-card px-5 py-4">
          <summary className="min-h-11 cursor-pointer content-center text-sm font-medium">
            连接排查与凭据保管
          </summary>
          <div className="space-y-3 pb-2 text-sm leading-relaxed text-muted-foreground">
            <p>
              地址无法访问？检查服务器 PUBLIC_URL
              是否与实际访问地址一致，并确认客户端支持 Streamable HTTP。
            </p>
            <p>
              配置中包含
              Token，请保存在自己的客户端。重置后需同步更新客户端配置。
            </p>
          </div>
        </details>
      </div>
    </section>
  );
}

export default ConnectPage;
