---
kind: practice
unit: 引用错误示例
---

# 引用错误示例

<!-- 验证结构点：::ref{segs=seg-1..seg-9} 的区间终点超出材料实际锚点范围（材料仅有 seg-1～seg-3）→ lint error SEG_RANGE_OUT_OF_BOUNDS（引用范围超过材料边界）；对照 ::ref{segs=seg-2} 单点引用应零告警 -->

::::material{id=mat-1 title="给定资料"}
:::seg{id=seg-1}
第一段：本段用于验证锚点解析。
:::

:::seg{id=seg-2}
第二段：材料共三段，锚点到 seg-3 为止。
:::

:::seg{id=seg-3}
第三段：任何超出 seg-3 的区间引用都属于越界。
:::
::::

::::group{id=grp-1 title="根据给定资料回答"}
::ref{material=mat-1 segs=seg-1..seg-9}
::ref{question=ew-1}
::::

::::question{id=ew-1 type=response difficulty=3}
::ref{material=mat-1 segs=seg-2}
概括资料主要内容。

:::answer
三段文字分别验证锚点解析、锚点数量与越界判定。
:::
::::
