---
kind: practice
unit: 七选五专项
---

# 七选五专项

<!-- 验证结构点：matching 题型 + 题内 ::ref{material slots=区间} 槽位集合声明、::::options 选项池与 :::option 选项、7 项含 2 干扰项、answer 行式 slotId = optionId 参考映射、allow-repeat 缺省 false -->

::::material{id=mat-1 title="Why We Sleep — Excerpt"}
Sleep is not the absence of activity but a distinct biological state with its own architecture. Each night the brain cycles through stages, consolidating memories and clearing metabolic waste. {{slot-1}} That cleaning cycle, visible only in the last decade of research, may explain why chronic short sleep correlates with dementia risk.

The economics of sleep are equally misunderstood. {{slot-2}} The snooze button, in other words, purchases fragmented minutes at the price of the deeper stages it interrupts.

Cultural attitudes compound the problem. In some workplaces, visible exhaustion functions as a badge of commitment. {{slot-3}} Longitudinal studies of such workplaces report higher error rates, not higher output.

What, then, works? Consistency outperforms duration hacks: a fixed wake time anchors the entire rhythm. {{slot-4}} Caffeine has a half-life of five to six hours, so an afternoon espresso is still negotiating with your neurons at midnight.

Finally, treat sleep as infrastructure rather than indulgence. {{slot-5}} The bed, like the desk, is a tool; using it for everything from meals to meetings eventually teaches the brain that it is a place for everything except sleep.
::::

::::group{id=grp-1 title="根据短文内容，从短文后的选项中选出能填入空白处的最佳选项。选项中有两项为多余选项。" label="1–5"}
::ref{material=mat-1}
::ref{question=qx-1}
::::

::::question{id=qx-1 type=matching difficulty=4 knowledge="七选五"}
从下方 7 个选项中为文中 5 个空白处选择最合适的内容（每空限选一项，不可重复）。

::ref{material=mat-1 slots=slot-1..slot-5}

::::options
:::option{id=opt-1}
During deep sleep, the brain's glymphatic system flushes waste proteins that accumulate during waking hours.
:::
:::option{id=opt-2}
A ten-minute nap after lunch, by contrast, improves afternoon alertness without disturbing the night.
:::
:::option{id=opt-3}
Pride in sleeplessness is, from the data's point of view, pride in degraded performance.
:::
:::option{id=opt-4}
Waking at the same time daily — even after a late night — rebuilds the rhythm faster than sleeping in.
:::
:::option{id=opt-5}
Historians note that the eight-hour norm is itself an artefact of industrial shift scheduling.
:::
:::option{id=opt-6}
Respecting that tool means giving it a job description: sleep, and little else.
:::
:::option{id=opt-7}
A morning espresso therefore has largely left the bloodstream before the next cycle begins.
:::
::::

:::answer
slot-1 = opt-1
slot-2 = opt-5
slot-3 = opt-3
slot-4 = opt-4
slot-5 = opt-6
:::

:::solution
干扰项分析：opt-2（午睡话题未出现）、opt-7（早晨咖啡与原文「下午咖啡影响午夜」方向相反）。五个空位分别承接「清洁循环→glymphatic」「经济学误解→八小时是工业产物」「疲惫徽章→骄傲于劣化表现」「固定起床时间→同频锚定」「基础设施→工具职责」。
:::
::::
