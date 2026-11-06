# 004 补上学生首页的页面标题语义

状态：已实现并完成本地验收；CI及合并以对应PR为准；执行提交：`0b3f1a69571409143e64ec00f484f7719aa6f12f`。无 `REQUIRES-APPROVAL`；无 `TOUCHES-DS`。

对应 UI-05；P3；judgement；本轮 canon 已经 MCP 获取并校验。检测器 1.0.3 / `12a35cc5f003ec08dcb6dd828ed0d059904902cd`，本问题来自 DOM 大纲检查。

## 问题与目标

`apps/web/src/pages/student/StudentHomePage.tsx:100` 原文：

```tsx
<p className="text-lg font-semibold">{name}，你好</p>
```

1440、768、390 下首页 h1 数均为 0，只有“我的作业 / 错题本 / 我的课程”三个 h2。把现有问候改为 h1，保留 `text-lg font-semibold`、姓名插值和显示位置，不额外增加一行“首页”。现有 `StudentPageHeader` 用 h1 的方式可作为语义参考；无需为此套入第二套页头或改首页结构。

## 步骤与验证

1. 在 `StudentHomePage.test.tsx` 先加会失败的可访问标题查询：存在唯一 level=1 的当前姓名问候；分区仍为 level=2，且原统计与入口保持。
2. 仅 p→h1；如补 id/aria-labelledby，使用 `student-home-title`，不要重复保留互相冲突的区域命名。
3. 比较 390、768、1440 原截图，标题位置、字号、横幅尺寸应保持；检查页面 h1 恰为一个。

这是语义调整，不涉及 API、数据、首页渐变去留、图标、两列布局或文案改写。无需为一次标签修改增加新的封装。无需修改产品专题；若现有测试已覆盖唯一 h1，直接扩展该测试，不另建镜像测试文件。

## 2026-11-07 MCP 补审元信息

固定 canon `public-2026.11.06-1`；索引 SHA-256 `2ff9cedd3abd8868acb8ea7c4fffa3b32cd6ed6971788ad3aca4a1a8d19ab78f`，source UNSLOP；取得与校验详情见 `evidence/canon/retrieval.json`。本项仍为项目附加检查，不强行编造远程 canon 对应规则；完整规则获取不会使已确认的项目问题失效。

本地检测器实际 detectorVersion 为 `sha256:210d57f5901ed2b4f3316bbeea467b2f6bfe45f659e9ad1753067132a815cc88`；文中 1.0.3 是插件版本。当前 canon 全部为 judgement，未建立或伪造自动绑定。
