---
kind: practice
unit: 引用错误示例
---

# 引用错误示例

<!-- 验证结构点：组与题目 ::ref 引用了未在本文档声明且不可解析的材料 id（mat-404）→ lint error UNKNOWN_MATERIAL_REF；引用解析（两遍解析第二遍）必须报错而非静默忽略 -->

::::group{id=grp-1 title="根据以下资料回答第 1 题"}
::ref{material=mat-404}
::ref{question=ew-1}
::::

::::question{id=ew-1 type=choice difficulty=2}
材料中提到的年份是（　）。

- [ ] 2023 年
- [x] 2024 年
- [ ] 2025 年
- [ ] 2026 年
::::
