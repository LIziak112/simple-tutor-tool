# 012 状态呈现使用既有图标集

状态：本地验收通过，待CI及合并；执行提交：`0b3f1a69571409143e64ec00f484f7719aa6f12f`。无 `REQUIRES-APPROVAL`、无 `TOUCHES-DS`，复用 Lucide。

UI-13；P3；canon `ST-11`（hard / slop / judgement，source UNSLOP）；版本 `public-2026.11.06-1`；索引 SHA-256 `2ff9cedd3abd8868acb8ea7c4fffa3b32cd6ed6971788ad3aca4a1a8d19ab78f`。

## 问题与范围

`apps/web/src/features/attempt/PendingReleaseBanner.tsx:55` 为 `🎉 作业已成功交卷！`，156 行为 `待公布 🔒（截止后自动判分）`；`features/answering/views/comparison.tsx:43` 为 `参考答案与详解将在截止后公布 🔒`。这是界面状态图标，不是用户消息内容。

截图 `pending-release-emoji.png`，原代码可直接核对。截图来自已提交演示卷的页面响应拦截，仅为呈现分支夹具；不是服务器公布权限的安全验收，不据此宣称未公布投影测试通过。

## 目标与步骤

1. 交卷标题移除 🎉，保留中文文字；左侧已有 CheckCircle2，无需再补一个庆祝图标。
2. 两处锁定提示改为同一 Lucide `LockKeyhole`，aria-hidden、size-3.5/shrink-0；文字继续完整承载“待公布/截止后公布”语义。使用 inline-flex items-center gap-1.5；长句允许自然换行。
3. 搜索生产 TSX 中 emoji 的真实渲染点，确认这三个位置均处理；不改注释、教学 Markdown、学生/AI 回复正文或消息里的 emoji。难度五角星是题目难度约定，不是本次 emoji 替换范围。
4. 保留公布 gate、倒计时和所有原状态文字，不修改 API。原测试如依赖 emoji，应改为按中文语义查询，不通过删测试放行。

## 验证

未公布/到期/已公布各态截图；emoji 消失、锁定图标来自同一图标集，读屏不重复朗读图标，参考答案的许可条件不变。390/768/1440 下长提示仍完整，旧圈画与题面内容没有变化。纯呈现可豁免新增单测，现有公布/对照测试必须保持，并在真实未公布夹具补截图复核。
