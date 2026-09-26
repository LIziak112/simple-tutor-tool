import { Construction } from "lucide-react";

/**
 * 教师端占位页：除「设置」外的四个分区（内容 / 学生与作业 / 数据 / 学情）
 * 由后续任务实现，本任务（T1.9）只搭骨架。
 * 空态文案说明现状并给出预期（UI 约定：空态要有解释性文案）。
 */
export function PlaceholderPage({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <section className="flex flex-col items-center justify-center gap-3 px-6 py-24 text-center">
      <Construction aria-hidden className="size-10 text-muted-foreground" />
      <h1 className="text-lg font-semibold">{title}</h1>
      <p className="max-w-sm text-sm text-muted-foreground">{description}</p>
      <p className="text-xs text-muted-foreground/70">建设中 · 敬请期待</p>
    </section>
  );
}

export default PlaceholderPage;
