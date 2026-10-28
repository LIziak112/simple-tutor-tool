import type { ReactNode } from "react";
import type { ReferenceMaterial } from "../types";

/**
 * 对照呈现的共用壳（UA-03 从 ResultAnswerComparison 抽取，DOM 逐字不变）：
 * 两栏网格 + 「你的答案：」「参考答案：」标签。公布三态（锁定/无参考/有参考）
 * 由 ReferenceMaterial 携带，referenceColumnOf 是三态的唯一分支处（§6 授权
 * 判断在宿主，展示分支单源于此）。
 */

/** 两栏对照壳：左列本人答案、右列参考答案（发布态由调用方组装右列内容） */
export function AnswerComparisonShell({
  ownColumn,
  referenceColumn,
}: {
  ownColumn: ReactNode;
  referenceColumn: ReactNode;
}) {
  return (
    <div className="grid min-w-0 gap-3 border-t border-border pt-3 text-sm sm:grid-cols-2 sm:gap-6">
      <div className="min-w-0">
        <p className="mb-1 text-muted-foreground">你的答案：</p>
        {ownColumn}
      </div>
      <div className="min-w-0">
        <p className="mb-1 text-muted-foreground">参考答案：</p>
        {referenceColumn}
      </div>
    </div>
  );
}

/**
 * 参考材料三态 → 右列内容（锁定提示 / 原有空态 / 各 kind 的 Reference 呈现）。
 * unavailable 分支类型上不携带参考内容（I09：未公布内容不进模型与 DOM）。
 */
export function referenceColumnOf<Rf>(
  material: ReferenceMaterial<Rf>,
  renderAvailable: (reference: Rf) => ReactNode,
): ReactNode {
  if (material.status === "unavailable") {
    return (
      <p className="text-muted-foreground">参考答案与详解将在截止后公布 🔒</p>
    );
  }
  if (material.status === "no-reference") {
    return <p className="font-medium">暂无参考答案</p>;
  }
  return renderAvailable(material.reference);
}
