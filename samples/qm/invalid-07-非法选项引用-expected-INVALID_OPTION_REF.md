---
kind: practice
unit: 引用错误示例
---

# 引用错误示例

<!-- 验证结构点：matching 参考答案（:::answer 行式映射）引用了选项池中不存在的 opt-9（池仅声明 opt-1～opt-3）→ lint error INVALID_OPTION_REF；对照行 slot-2 = opt-1 引用合法应零告警，确保「非法引用」与「合法映射」可区分。发布层的「参考答案全覆盖槽位」校验（5.3.3 规则 5）另由 TT-05/06 测试补足，不在本文件断言 -->

::::material{id=mat-1 title="人名与观点"}
{{slot-1}}认为批评的锋芒应指向作品本身；{{slot-2}}则主张批评首先是历史的批评。
::::

:::::question{id=ew-1 type=matching difficulty=3}
将人名与其观点配对。

::ref{material=mat-1 slots=slot-1..slot-2}

::::options
:::option{id=opt-1}
别林斯基
:::
:::option{id=opt-2}
车尔尼雪夫斯基
:::
:::option{id=opt-3}
杜勃罗留波夫
:::
:::::

:::answer
slot-1 = opt-9
slot-2 = opt-1
:::
::::
