import { CopyBlock } from "@/components/CopyBlock";
import { buildMcpServersConfig } from "@/lib/mcp-config";

/** 连接卡直接给出可用配置；历史哈希没有可恢复的 Token，不伪造占位凭据。 */
export function McpConnectionDetails({ token }: { token: string | null }) {
  const endpoint = `${window.location.origin}/mcp/student`;
  return (
    <div className="min-w-0 space-y-3">
      {token !== null ? (
        <>
          <CopyBlock label="MCP Token" text={token} ariaLabel="复制 Token" />
          <CopyBlock
            label="完整 MCP 配置"
            text={buildMcpServersConfig({
              serverKey: "tutor-student",
              serverUrl: endpoint,
              token,
            })}
            ariaLabel="复制完整 MCP 配置 JSON"
          />
          <p className="text-sm leading-relaxed text-muted-foreground">
            将完整配置粘贴到 AI 客户端即可。Token 随时可在这里查看和复制。
          </p>
        </>
      ) : (
        <p className="rounded-xl bg-muted/50 p-4 text-sm leading-relaxed text-muted-foreground">
          此连接尚无可查看的 Token。旧连接仍可使用；如需完整配置，请重新生成一次
          Token，并更新客户端配置。
        </p>
      )}
      <details className="group rounded-xl border border-border px-4">
        <summary className="cursor-pointer py-3 text-sm font-medium focus-visible:outline-2 focus-visible:outline-ring">
          端点与认证方式
        </summary>
        <div className="space-y-3 pb-4">
          <p className="text-sm text-muted-foreground">
            认证方式 Bearer Token · Streamable HTTP
          </p>
          <CopyBlock label="MCP 端点" text={endpoint} ariaLabel="复制端点" />
        </div>
      </details>
    </div>
  );
}
