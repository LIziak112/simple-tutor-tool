---
kind: practice
unit: 引用错误示例
---

# 引用错误示例

<!-- 验证结构点：::ref 引用材料 mat-lib-1——该 id 不在本文档声明，仅存在于导入库中且属【另一教师域】。静态 lint 对「文档内不可解析」报 UNKNOWN_MATERIAL_REF；导入/发布层按教师域查询后命中他人材料，报 MATERIAL_REF_OUT_OF_DOMAIN（本文件为导入层断言样例：TT-05/06 测试需预置他域同名材料） -->

::::group{id=grp-1 title="根据以下资料回答第 1 题"}
::ref{material=mat-lib-1}
::ref{question=ew-1}
::::

::::question{id=ew-1 type=choice difficulty=2}
材料作者的观点是（　）。

- [ ] 支持取消考试
- [x] 支持改进考试形式
- [ ] 未表达观点
- [ ] 反对一切评价
::::
