---
kind: practice
unit: 引用错误示例
---

# 引用错误示例

<!-- 验证结构点：子题 ::ref{slot=slot-99} 绑定的槽位在目标材料中不存在（材料仅声明 slot-1，且 slot-1 已由 ew-2 合法绑定）→ lint error UNKNOWN_SLOT_REF；对照组 ew-2 的合法绑定（slot-1）应零告警，确保「未知槽位」与「正常绑定」可区分 -->

::::material{id=mat-1 title="短文"}
文中有{{slot-1}}一个空位，本应只对应一道子题。
::::

::::group{id=grp-1 title="完形演示"}
::ref{material=mat-1}
::ref{question=ew-1}
::ref{question=ew-2}
::::

::::question{id=ew-1 type=choice difficulty=2}
第 1 空。::ref{material=mat-1 slot=slot-99}

- [ ] however
- [x] therefore
- [ ] moreover
- [ ] otherwise
::::

::::question{id=ew-2 type=choice difficulty=2}
第 2 空。::ref{material=mat-1 slot=slot-1}

- [x] only
- [ ] also
- [ ] never
- [ ] still
::::
