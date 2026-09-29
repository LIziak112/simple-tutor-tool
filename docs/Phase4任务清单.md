# Phase 4 任务清单（学情 + AI 数据包 + MCP）

> 从《`docs/开发任务清单.md`》分离而来；全局约定（API 前缀、响应格式、主键、时间等）见该文档 §0.3，任务分支与 🧑 规则见其 §0.2，**均继续适用**。
> 配套文档：`docs/技术架构与实施方案.md`（下称"架构文档"，引用写作 §x.x）。本文只写**做什么、按什么顺序、怎么验收**，设计细节以架构文档为准。
> 执行对象：GLM 5.3。每次只下达**一个任务（Txx）**。
> **顺序前提**：`docs/Phase3任务清单.md` 全部完成（T4.1 依赖 T3.2；T4.4 依赖 T1.10）；`docs/Phase2A改进任务清单.md` / `docs/Phase2B改进任务清单.md` 对本文条目的修订（见 T2A.9 / T2B.8 的文档同步说明）**以改进清单为准**。任务完成后在 [`docs/进度表.md`](进度表.md) 打勾。

### 下达提示词

```
阅读 AGENTS.md、docs/技术架构与实施方案.md、docs/开发任务清单.md（§0 全局约定）、docs/Phase4任务清单.md。
执行任务 <Txx>，只做该任务范围内的事。
1. 先列出：要新建/修改的文件、实现步骤、要写的测试。等我回复"确认"。
2. 确认后实施。完成后运行 pnpm lint && pnpm typecheck && pnpm test（涉及 E2E 时加 pnpm e2e），贴出结果。
3. 逐条对照该任务的「验收」自查，说明每条如何验证。
4. 文档未覆盖的设计决策，停下来问我，不要自行假设。
```

---

### T4.1 学情聚合服务
- 依赖：T3.2
- 产出：`AnalyticsService`（纯 SQL + TS，全部以 `finalCorrect` 为准）：完成矩阵、学生总正确率周趋势、学生×考点正确率、题目正确率/平均用时/高频错误答案、用时异常题（> 该题用时中位数 2 倍或提示数 ≥2）、"下节课重点"（周期内错误最多的 3 个考点 + 代表错题）。对应 `GET /api/teacher/analytics/*` 接口。
- 验收：用固定种子数据（`scripts/seed-demo.ts`，3 名学生、4 份作业）写测试，断言每个指标数值。

### T4.2 学情页面
- 依赖：T4.1
- 产出：ECharts 按需加载；学情总览（完成矩阵 + 下节课重点卡片）、学生画像页（趋势、考点、错题、异常题）、题目视角页。
- 验收：🧑 种子数据下各图表显示合理，点击错题可跳转到作答详情。

### T4.3 AI 学情数据包
- 依赖：T4.1
- 产出：contract 新增 `LearningPack` schema（导出 JSON Schema）；`GET /api/teacher/export/learning-pack?studentId&from&to&includeInk` → zip（结构见架构文档 §5.9）；`prompt.md` 模板放 `docs/dsl/学情分析提示词.md`；学生画像页"导出给 AI"按钮。
- 验收：测试：pack.json 通过 schema 校验；🧑 将 zip 交给大模型，得到合理诊断与符合 DSL 的变式练习，练习可直接导入。

### T4.4 备份与恢复
- 依赖：T1.10
- 产出：每日 `VACUUM INTO` 快照保留 14 份（启动时 + 每 24h）；`GET /api/teacher/backup/download`（zip：db 快照 + blobs）；`POST /api/teacher/backup/restore`（上传 zip，校验后替换并重启数据连接，操作前自动再做一次快照）；设置页入口。
- 验收：测试：备份 → 修改数据 → 恢复 → 数据回到备份时状态。

### T4.5 MCP Server
- 依赖：T4.3、T1.13
- 产出：`apps/server/src/mcp/`，`@modelcontextprotocol/sdk` Streamable HTTP，挂载 `/mcp`，`Authorization: Bearer <教师 API Token>`；tools 见架构文档 §5.9 表格（`import_markdown` 默认 dry-run，`confirm:true` 才写入）；`reports` 表 + `save_report`；教师设置页：生成/重置 API Token。
- 验收：测试：无 token 401；用 SDK 客户端调用每个 tool 返回正确结构；🧑 在 Claude Desktop（或其他 MCP 客户端）配置后完成"读学情 → 出题 → lint → 导入"。

### T4.6 AI 连接说明页与报告查看
- 依赖：T4.5
- 产出：教师端"连接 AI"页（MCP 地址、Token、Claude Desktop 等客户端配置片段一键复制）；学生画像页显示 AI 存回的报告列表（Markdown 渲染）。
- 验收：🧑 按页面说明从零配置成功。

**Phase 4 完成标志**：架构文档 Phase 4 验收通过。
