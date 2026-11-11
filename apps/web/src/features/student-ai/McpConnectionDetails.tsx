import { CopyBlock } from "@/components/CopyBlock";
import { useStudentMe } from "@/features/auth/student-auth";
import { buildMcpServersConfig, learnerMcpEndpoint } from "@/lib/mcp-config";

/**
 * 连接卡直接给出可用配置；历史哈希没有可恢复的 Token，不伪造占位凭据。
 * 端点按账号类型（模块 0）：班级学生 /mcp/student；个人账号 /mcp/personal——
 * 同一枚 token 同时开放内容管线 / 本人学情的教师白名单工具与全部学生工具。
 */
export function McpConnectionDetails({ token }: { token: string | null }) {
  const accountKind = useStudentMe().data?.accountKind ?? "class";
  const personal = accountKind === "personal";
  const { url: endpoint, serverKey } = learnerMcpEndpoint(
    window.location.origin,
    accountKind,
  );
  return (
    <div className="min-w-0 space-y-3">
      {token !== null ? (
        <>
          <CopyBlock
            label="完整 MCP 配置"
            text={buildMcpServersConfig({
              serverKey,
              serverUrl: endpoint,
              token,
            })}
            ariaLabel="复制完整 MCP 配置 JSON"
          />
          <p className="text-sm leading-relaxed text-muted-foreground">
            将上方完整配置粘贴到支持 MCP 的 AI
            客户端。需要分别填写时，使用下方地址和 Token。
          </p>
        </>
      ) : (
        <p className="rounded-xl bg-muted/50 p-4 text-sm leading-relaxed text-muted-foreground">
          此连接尚无可查看的 Token。旧连接仍可使用；如需完整配置，请重新生成一次
          Token，并更新客户端配置。
        </p>
      )}
      {token !== null && (
        <CopyBlock label="MCP Token" text={token} ariaLabel="复制 Token" />
      )}
      <CopyBlock label="MCP 接口地址" text={endpoint} ariaLabel="复制端点" />
      <details className="group rounded-xl border border-border px-4">
        <summary className="cursor-pointer py-3 text-sm font-medium focus-visible:outline-2 focus-visible:outline-ring">
          端点与认证方式
        </summary>
        <div className="space-y-3 pb-4">
          <p className="text-sm text-muted-foreground">
            认证方式 Bearer Token · Streamable HTTP
          </p>
          {personal && (
            <p className="text-sm leading-relaxed text-muted-foreground">
              个人账号只有这一枚 Token：AI
              既能帮你导入与整理资料、查看自己的作答与学习记录，也能做 AI
              伴学任务；不开放班级管理类能力（学生、作业、报告、改答）。
            </p>
          )}
        </div>
      </details>
    </div>
  );
}
