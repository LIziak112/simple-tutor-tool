import type { ReactNode } from "react";
/** 已结算题默认收起；导航显式定位仍可展开同一题卡。 */
export function QuestionSettlementFold({
  seq,
  forceOpen,
  children,
}: {
  seq: number | undefined;
  forceOpen: boolean;
  children: ReactNode;
}) {
  if (seq === undefined) return children;
  return (
    <details open={forceOpen || undefined} className="rounded-lg border p-3">
      <summary className="min-h-11 cursor-pointer content-center text-sm font-medium">
        第 {seq} 批已提交 · 展开查看
      </summary>
      {children}
    </details>
  );
}
