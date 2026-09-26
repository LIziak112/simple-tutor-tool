import type { ReactNode } from "react";

/**
 * 未知指令降级组件（§5.1.1(3) 兼容规则，AGENTS.md 第 11 条）：
 * 显示其内部文字内容 + 不显眼的灰色虚线边框 + 小字标注指令名，
 * 页面不报错、不崩溃——新版文档导入旧版系统时内容不丢失。
 */
export function UnknownDirective({
  name,
  inline = false,
  children,
}: {
  /** 原始指令名（用于标注） */
  name: string;
  /** 行内指令用行内形态降级 */
  inline?: boolean;
  children?: ReactNode;
}) {
  if (inline) {
    return (
      <span className="mx-1 rounded border border-dashed border-muted-foreground/50 bg-muted/40 px-1 text-muted-foreground">
        {children}
        <span className="ml-1 text-xs opacity-70">（未支持指令：{name}）</span>
      </span>
    );
  }
  return (
    <div className="my-3 rounded-xl border border-dashed border-muted-foreground/50 bg-muted/30 p-3 text-sm text-muted-foreground">
      {children}
      <span className="mt-1 block text-xs opacity-70">未支持指令：{name}</span>
    </div>
  );
}
