# 008 保存过程保持按钮尺寸稳定

状态：已实现并完成本地验收；CI及合并以对应PR为准；执行提交：`0b3f1a69571409143e64ec00f484f7719aa6f12f`。`TOUCHES-DS`：在现有 Button 变体中增加可选的忙碌呈现能力；无 `REQUIRES-APPROVAL`。

UI-09；P2；canon `ST-4`（hard / slop / judgement，source UNSLOP），关联 `US-004`。版本 `public-2026.11.06-1`，索引 SHA-256 `2ff9cedd3abd8868acb8ea7c4fffa3b32cd6ed6971788ad3aca4a1a8d19ab78f`。完整规则及主题校验和见 `evidence/canon/`；没有机器检测绑定。

## 问题与文件

`apps/web/src/features/teacher-settings/CapabilityProfileSection.tsx:160` 的按钮为 `className="min-h-11 px-5"`，173 行仅在 `saveMutation.isPending` 时插入 `<Loader2 ... />`。隔离浏览器拦截 PUT、保持 pending 后，同一按钮宽度由 **98→120px**，左边由 **1186→1164px**。文字未变，新增图标和间距造成跳变。证据：`save-idle.png`、`save-pending.png`、`canon-ui-probes.json`。

## 目标与步骤

1. 在浏览器先加入失败检查：拦截保存响应，连续测量闲置/pending/成功/失败四态，按钮宽高不变（容许浏览器像素取整 ≤1px）；失败仍保留草稿并可重试。
2. 阅读 `components/ui/button.tsx`，采用可选 `busy` 图标位：忙碌图标绝对定位于原按钮内容中心，正文和布局中的内嵌图标保留原尺寸、仅在 busy 时 opacity=0；不要给所有按钮空出 22px。Loader 与原内容不可同时占文档流。不引入动画库。
3. `busy` 只管呈现与 `aria-busy`，保留调用方 disabled、提交和取消语义；未传 busy 的 Button DOM/交互保持。忙碌文字可由独立 role=status 宣布，不替换固定按钮标签。
4. 先迁移 `CapabilityProfileSection.tsx` 与 `PracticeFeedbackSection.tsx` 的“保存更改”；再搜索实际使用相同 pending 插入 Loader 的保存调用，逐一列出并迁移。不要改正在手写/提交的业务锁，也不把任意 Loader 机械替换为按钮 busy。
5. 更新 `docs/约定/界面与账号.md` 的共享忙碌反馈约定，记录实际迁移消费者。

## 验证与边界

390/768/1440、长中文标签、200% 文字、reduce/no-preference；图标可见但不抢焦点，按钮尺寸稳定，状态信息仍可访问。实际消费者分别验证，不能仅证明 Button 有新属性。请求拦截取证没有写入真实设置；实施测试仍需真实成功/失败路径。源码变更按根 AGENTS.md 先失败测试、选测及 diff 审查。
