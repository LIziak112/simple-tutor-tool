---
kind: practice
unit: 引用错误示例
---

# 引用错误示例

<!-- 验证结构点：两处组结构错误——① 子题 ew-1 同时被 grp-1 与 grp-2 引用 → lint error GROUP_MEMBER_DUPLICATED（同一题在同一 attempt 只能出现一次）；② grp-1 内 ::ref{question=grp-2} 指向另一个组 → lint error GROUP_NESTED_OR_CYCLIC（首版仅一层题组，组引用组拒绝，天然无环）。文件名以主码 GROUP_MEMBER_DUPLICATED 为 expected，本文件同时断言 GROUP_NESTED_OR_CYCLIC -->

::::group{id=grp-1 title="第一组：根据材料回答"}
::ref{question=ew-1}
::ref{question=grp-2}
::::

::::group{id=grp-2 title="第二组：根据材料回答"}
::ref{question=ew-1}
::ref{question=ew-2}
::::

::::question{id=ew-1 type=choice difficulty=2}
第一题。下列说法正确的是（　）。

- [x] 甲
- [ ] 乙
- [ ] 丙
- [ ] 丁
::::

::::question{id=ew-2 type=choice difficulty=2}
第二题。下列说法错误的是（　）。

- [ ] 甲
- [x] 乙
- [ ] 丙
- [ ] 丁
::::
