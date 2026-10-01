import {
  Check,
  Copy,
  KeyRound,
  Loader2,
  RotateCcw,
  TriangleAlert,
} from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  useApiToken,
  useResetApiToken,
} from "@/features/teacher-settings/api-token-queries";
import { copyText } from "@/lib/copy";

/**
 * 设置页「AI 连接（API Token）」区（T4.6，D22）：
 * - 查看：token 明文随时可看（D22 定稿：不做「只显示一次」）+ 一键复制；
 *   未生成时提示可生成；
 * - 生成 / 重置：同一动作（无则生成、有则覆盖列值）；重置走二次确认弹层，
 *   明确「重置后旧 token 立即失效，已配置的客户端（如 Claude Desktop）需要
 *   更新 token」；
 * - 连接说明页（/t/connect，含配置 JSON 片段）在 T4.7：本区底部「连接说明
 *   与配置示例」链接直达。
 * 三态齐全（加载/错误/数据）、触控目标 ≥44px（min-h-11）。
 */
export function ApiTokenSection() {
  const tokenQuery = useApiToken();
  const resetMutation = useResetApiToken();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  async function handleCopy(token: string) {
    const ok = await copyText(token);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }

  /** 生成（首次）与重置（已有）共用后端动作；已有 token 时必须先过确认弹层 */
  function handleGenerateClick() {
    if (tokenQuery.data?.token != null) {
      setConfirmOpen(true);
      return;
    }
    resetMutation.mutate(undefined);
  }

  function handleResetConfirm() {
    setConfirmOpen(false);
    resetMutation.mutate(undefined);
  }

  const errorText =
    tokenQuery.isError && tokenQuery.error instanceof Error
      ? tokenQuery.error.message
      : tokenQuery.isError
        ? "加载失败，请刷新重试"
        : null;
  const actionError =
    resetMutation.isError && resetMutation.error instanceof Error
      ? resetMutation.error.message
      : resetMutation.isError
        ? "操作失败，请稍后重试"
        : null;

  return (
    <div className="flex flex-col gap-4 rounded-xl border border-border bg-card p-5 text-card-foreground">
      <div>
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <KeyRound aria-hidden className="size-4" />
          AI 连接（API Token）
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          供 Claude Desktop 等 AI 客户端经 MCP 连接本工具使用（地址 /mcp）。
          每位教师一份，可随时查看、可重置；重置后旧 token 立即失效。
        </p>
      </div>

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

      {/* T4.7：连接说明页入口（MCP 地址与配置示例在 /t/connect） */}
      <Button variant="outline" className="min-h-11 self-start px-4" asChild>
        <Link to="/t/connect">连接说明与配置示例 →</Link>
      </Button>

      {tokenQuery.data && (
        <div className="flex flex-col gap-3">
          {tokenQuery.data.token === null ? (
            <p className="text-sm text-muted-foreground">
              尚未生成 Token。生成后即可在 AI 客户端中配置连接。
            </p>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <code className="min-h-11 flex-1 overflow-x-auto rounded-lg border border-border bg-muted/50 px-3 py-3 font-mono text-sm break-all">
                {tokenQuery.data.token}
              </code>
              <Button
                variant="outline"
                className="min-h-11 px-4"
                onClick={() => void handleCopy(tokenQuery.data?.token ?? "")}
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
          )}

          {actionError && (
            <p
              role="alert"
              className="flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
              {actionError}
            </p>
          )}

          <div>
            <Button
              variant="outline"
              className="min-h-11 px-5"
              disabled={resetMutation.isPending}
              onClick={handleGenerateClick}
            >
              {resetMutation.isPending ? (
                <>
                  <Loader2 aria-hidden className="animate-spin" />
                  正在{tokenQuery.data.token === null ? "生成" : "重置"}…
                </>
              ) : (
                <>
                  <RotateCcw aria-hidden />
                  {tokenQuery.data.token === null ? "生成 Token" : "重置 Token"}
                </>
              )}
            </Button>
          </div>
        </div>
      )}

      {/* 重置二次确认（D22：重置后旧 token 立即失效；列表性内容放 Dialog 正文而非 DialogDescription） */}
      <Dialog open={confirmOpen} onOpenChange={(open) => setConfirmOpen(open)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>重置 API Token？</DialogTitle>
            <DialogDescription>
              重置会生成新 Token，旧 Token 立即失效。
            </DialogDescription>
          </DialogHeader>
          <div className="text-sm text-muted-foreground">
            <p>重置后：</p>
            <ul className="mt-1 list-disc pl-5">
              <li>
                已配置的客户端（如 Claude Desktop）需要更新为新 Token
                才能继续连接；
              </li>
              <li>正在使用旧 Token 的 AI 会话会立即失去访问权限。</li>
            </ul>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              className="min-h-11"
              onClick={() => setConfirmOpen(false)}
            >
              取消
            </Button>
            <Button className="min-h-11" onClick={handleResetConfirm}>
              确认重置
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
