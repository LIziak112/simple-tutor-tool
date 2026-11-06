# 013 AI 相关入口改用表示用途的图标

状态：本地验收通过，待CI及合并；执行提交：`0b3f1a69571409143e64ec00f484f7719aa6f12f`。`TOUCHES-DS`：共享 AiCompanionTrigger 的图标；无 `REQUIRES-APPROVAL`，保留已定稿入口名称。

UI-14；P3；canon `ST-2`（hard / slop / judgement，source UNSLOP），遵守 `US-001`；`ST-1` 仅为修复约束，不是第二项违规。版本 `public-2026.11.06-1`；索引 SHA-256 `2ff9cedd3abd8868acb8ea7c4fffa3b32cd6ed6971788ad3aca4a1a8d19ab78f`。

## 问题与证据

`apps/web/src/features/student-ai/AiCompanionRail.tsx:75` 的 AI 入口使用 `<Sparkles aria-hidden className="size-5" />`；同样的泛化星芒在批量复盘、出题提示词、报告标题与导出入口出现。`more-presets-closed.png`、`ai-prompt-panel.png` 和源代码支持该判断。

需求规格 §7.1 明确保留“AI 助教”，结果态沿用“AI 复盘”；不能为服从通用规则而擅自改掉定稿名称。本计划仅让图标提示用途，动作文字仍按现有产品词表。

## 完整位置与目标

| 文件（从 apps/web/src 起） | 用途 | 目标 Lucide 图标 |
| --- | --- | --- |
| `features/student-ai/AiCompanionRail.tsx` | 共享提问入口 | MessageCircleQuestion |
| `features/student-ai/AiBatchReviewPanel.tsx` | 批量复盘 | ListChecks |
| `features/content/AiPromptPanel.tsx` | 生成出题提示词 | FilePenLine |
| `features/insights/StudentReportsSection.tsx` | 学情报告 | FileText |
| `pages/teacher/StudentHomePage.tsx` | 导出数据包 | FileDown |

以上图标来自当前已安装的 Lucide；实现前核查导出名，不新增依赖。`StudentHomePage` 学生问候及 `StudentLessonPage`/Landing 的讲练类型星芒不是“AI 标志”角色，不在这次替换范围，避免 UR-1/US-008 的越界。

## 步骤与验收

1. 先记录五组实际入口与原 aria-label、title、焦点/展开状态；源码枚举与真实截图分别保存。当前补审只对提问和出题入口做了实际呈现，其余三组实施时必须补齐，不能把静态枚举叫全消费者视觉通过。
2. 仅替换 import 与对应 SVG，保留原 size、stroke 家族、颜色、点击回调和 data/aria 属性。图标继续 aria-hidden；不改AI教学模式、连接或请求参数。
3. 在普通练习、讲练、结果三处验证共享 Trigger；批量复盘、教师导出/报告和出题提示词分别检查。打开、切换或选择问法仍不出站，只有原发送/确认动作出站。
4. 若出现文案必须调整的产品取舍，停止该文案变更并单独提出，不把它藏在图标替换里。

纯图标替换可免新增单测，沿用现有 AI 行为测试与可访问名称断言；仍需 390/1440 视觉对比。对用户看到的名称、授权边界及“单一活动输入”约定零改动。
