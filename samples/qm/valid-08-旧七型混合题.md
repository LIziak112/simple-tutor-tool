---
kind: practice
unit: 有理数与整式
---

# 有理数与整式混合练习

<!-- 验证结构点：现有 DSL 语法对照回归——旧七题型（judge/choice/multi/fill/solve/apply/find-error）混排、KaTeX 公式、::image 本站图片引用、题块全部位于 H1 之后；本文件必须通过 pnpm tutor-lint（退出码 0），作为新语料的旧行为基准（注：本文件不含无参考答案题，无参考场景由语料⑦的 solve 演示） -->

::::question{type=judge difficulty=1 knowledge="有理数"}
任何一个负数的绝对值都大于它本身。[[正确]]

:::solution
设 $a<0$，则 $|a|=-a>0>a$，故命题成立。
:::
::::

::::question{type=choice difficulty=2 knowledge="绝对值"}
若 $|x-2|+|y+3|=0$，则 $x+y$ 的值为（　）。

- [ ] $-5$
- [x] $-1$
- [ ] $1$
- [ ] $5$

:::solution
绝对值均为非负数，故 $x-2=0$、$y+3=0$，得 $x=2$、$y=-3$，$x+y=-1$。
:::
::::

::::question{type=multi difficulty=2 knowledge="整式"}
下列各式中，属于整式的有（　）。

- [x] $3x^2y$
- [ ] $\dfrac{5}{x+1}$
- [x] $-7$
- [ ] $\sqrt{2a}$

:::solution
分母含字母（$\dfrac{5}{x+1}$）与根号下含字母（$\sqrt{2a}$）都不是整式；$3x^2y$ 是单项式，$-7$ 是常数单项式。
:::
::::

::::question{type=fill difficulty=2 knowledge="有理数运算"}
计算：$(-2)^3=$ [[-8]]；$-3^2=$ [[-9]]；$|-4|+(-1)^{10}=$ [[5]]。

:::solution
$(-2)^3=-8$；$-3^2=-(3^2)=-9$（先乘方再取负）；$|-4|+(-1)^{10}=4+1=5$。
:::
::::

::::question{type=solve difficulty=3 knowledge="整式化简"}
先化简，再求值：$2(a^2-3a+1)-3(a^2-2a)$，其中 $a=-2$。

:::answer
$-a^2+2$，值为 $-2$
:::

:::solution
原式 $=2a^2-6a+2-3a^2+6a=-a^2+2$。当 $a=-2$ 时，原式 $=-(-2)^2+2=-2$。
:::
::::

::::question{type=apply difficulty=3 knowledge="列方程解应用题"}
某商店把一件商品按进价提高 $40\%$ 后标价，又以标价的 $8$ 折售出，仍盈利 $12$ 元。求这件商品的进价。

:::answer
100 元
:::

:::solution
设进价为 $x$ 元。售价 $=x(1+40\%)\times 0.8=1.12x$，盈利 $1.12x-x=12$，解得 $x=100$。
:::
::::

::::question{type=find-error difficulty=4 knowledge="一元一次方程"}
下面是某同学解方程 $\dfrac{x-1}{3}-\dfrac{x+2}{6}=1$ 的过程，指出其中错误的一步并说明理由。

> 第一步：去分母，得 $2(x-1)-(x+2)=1$；
> 第二步：去括号，得 $2x-2-x-2=1$；
> 第三步：移项合并，得 $x=5$。

::image{src="blobs/media/c4e8d1f2a3b54c6978e5f6a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c.png" alt="去分母常见错误示意" width="50%"}

:::answer
第一步错误：去分母时等号右边的 1 漏乘 6，应为 2(x-1)-(x+2)=6
:::

:::solution
去分母依据等式性质二，两边同乘 6，右边 $1\times 6=6$，漏乘后方程的解被改变。
:::
::::
