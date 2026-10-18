import type { AiConnectionPublic } from "@tutor/contract";
import { Bot, Link2, Terminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CHANNEL_LABEL } from "./ai-channel-label";
import { McpConnectionDetails } from "./McpConnectionDetails";

/** 总览只呈现摘要；完整凭据与维护操作仅出现在详情中。 */
export function AiConnectionCard({
  connection,
  detail = false,
  busy,
  onView,
  onEdit,
  onDefault,
  onTest,
  onResetToken,
  onDelete,
}: {
  connection: AiConnectionPublic;
  detail?: boolean;
  busy: boolean;
  onView: () => void;
  onEdit: () => void;
  onDefault: () => void;
  onTest: () => void;
  onResetToken: () => void;
  onDelete: () => void;
}) {
  const Icon =
    connection.channel === "inapp"
      ? Bot
      : connection.channel === "mcp"
        ? Terminal
        : Link2;
  const status =
    connection.channel !== "inapp"
      ? "配置已保存"
      : connection.verifyStatus === "verified"
        ? "验证成功"
        : connection.verifyStatus === "failed"
          ? "测试未通过,暂不可用"
          : connection.verifyStatus === "needs_rekey"
            ? "需重新填写 Key"
            : "已保存,未测试";
  const description =
    connection.channel === "inapp"
      ? connection.model
      : connection.channel === "mcp"
        ? "在外部 AI 客户端领取求助，回复带回题目"
        : `新链接默认有效期 ${connection.defaultValidHours} 小时`;
  return (
    <article className="min-w-0 rounded-xl border border-border bg-card">
      <div className="flex flex-col gap-5 p-5 sm:p-6">
        <div className="flex min-w-0 items-start gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Icon aria-hidden className="size-5" />
          </span>
          <div className="min-w-0 flex-1 space-y-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="font-semibold">
                {CHANNEL_LABEL[connection.channel]}
              </h3>
              {connection.isDefault && (
                <span className="rounded-md bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                  默认连接
                </span>
              )}
            </div>
            <p className="break-words text-sm text-muted-foreground">
              {description}
            </p>
            {connection.channel === "inapp" && (
              <p className="break-all text-xs leading-relaxed text-muted-foreground">
                {connection.baseUrl}
              </p>
            )}
          </div>
          <span className="max-w-28 shrink-0 text-end text-xs leading-relaxed text-muted-foreground">
            {status}
          </span>
        </div>
        {detail && connection.channel === "inapp" && (
          <dl className="grid gap-4 rounded-lg bg-muted/40 p-4 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-muted-foreground">使用模型</dt>
              <dd className="mt-1 break-all">{connection.model}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">密钥状态</dt>
              <dd className="mt-1 break-all">
                已保存 · 指纹 {connection.keyFingerprint}
              </dd>
            </div>
          </dl>
        )}
        {detail && connection.channel === "mcp" && (
          <McpConnectionDetails token={connection.token ?? null} />
        )}
        {detail && connection.channel === "link" && (
          <p className="text-sm leading-relaxed text-muted-foreground">
            在题目旁生成上下文链接，复制给能够联网读网页的
            AI。回复在外部查看；每条链接只包含一道题，可随时在题目旁撤销。
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          {!detail && (
            <Button variant="outline" className="min-h-11" onClick={onView}>
              查看配置
            </Button>
          )}
          <Button
            variant={detail ? "default" : "ghost"}
            className="min-h-11"
            onClick={onEdit}
          >
            修改配置
          </Button>
          {detail && connection.channel === "inapp" && (
            <Button
              variant="outline"
              className="min-h-11"
              disabled={busy}
              onClick={onTest}
            >
              测试连接
            </Button>
          )}
          {!connection.isDefault && (
            <Button
              variant="ghost"
              className="min-h-11"
              disabled={busy}
              onClick={onDefault}
            >
              设为默认
            </Button>
          )}
        </div>
      </div>
      {detail && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-5 py-3 sm:px-6">
          <p className="text-xs text-muted-foreground">
            删除连接不会清除历史求助记录。
          </p>
          <div className="flex flex-wrap gap-2">
            {connection.channel === "mcp" && (
              <Button
                variant="outline"
                className="min-h-11"
                disabled={busy}
                onClick={onResetToken}
              >
                重置 Token
              </Button>
            )}
            <Button
              variant="ghost"
              className="min-h-11 text-destructive hover:text-destructive"
              disabled={busy}
              onClick={onDelete}
            >
              删除连接
            </Button>
          </div>
        </div>
      )}
    </article>
  );
}
