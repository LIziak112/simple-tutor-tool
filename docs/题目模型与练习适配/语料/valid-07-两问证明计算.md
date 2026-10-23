<!-- 验证结构点：题组承载共同条件（组说明含 KaTeX 公式）、(1) 证明用 response（参考答案为含公式的 Markdown、带正式手写并存）、(2) 计算沿用旧题型 solve 且【无参考答案】（manual_only 演示）、旧题型进组作子题 -->

---
kind: practice
unit: 数学解答专项
---

# 数学解答专项

::::group{id=grp-1 title="已知数列 $\{a_n\}$ 满足 $a_1=1$，$a_{n+1}=2a_n+1$（$n\in\mathbb{N}^*$）。回答下列两问。" label="1–2"}
::ref{question=zm-1}
::ref{question=zm-2}
::::

::::question{id=zm-1 type=response difficulty=4 knowledge="数列与数学归纳法"}
（1）证明：数列 $\{a_n+1\}$ 是等比数列，并求 $a_n$ 的通项公式。

:::answer
**证明**：由 $a_{n+1}=2a_n+1$ 得

$$a_{n+1}+1 = 2a_n+2 = 2(a_n+1).$$

又 $a_1+1=2\neq 0$，故 $\{a_n+1\}$ 是以 $2$ 为首项、$2$ 为公比的等比数列。

**通项**：

$$a_n+1 = 2\cdot 2^{n-1} = 2^{n},\qquad a_n = 2^{n}-1.$$

（要点：凑配 $a_{n+1}+1=2(a_n+1)$ 是本题核心；证明等比需同时验证首项非零与公比恒定。）
:::
::::

::::question{id=zm-2 type=solve difficulty=4 knowledge="数列求和"}
（2）设 $b_n = \dfrac{n}{a_n+1}$，求数列 $\{b_n\}$ 的前 $n$ 项和 $T_n$。
::::
