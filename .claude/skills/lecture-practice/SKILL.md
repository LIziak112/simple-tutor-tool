---
name: lecture-practice
description: simple-tutor-tool 轻量讲练运行手册：把讲义/练习 md 跑成本机练习站并生成同 Wi-Fi 移动端二维码（讲练页作答、草稿、手写、标画，数据全落库）。凡用户说「把讲义跑起来让学生做」「生成练习二维码」「轻量讲练」「手机扫码做题」时使用。核心约束：复用现有 app 与渲染器不重写；落盘只留讲义 md 源文 + 学生做题数据，页面/组件状态不落库，运行时由 md+做题数据重建。
---

# 轻量讲练（lecture-practice）

app 本身就是练习站：不搭新站、不重写渲染器。四步：出 md → 起服务导入 → 二维码进学生端 → 守住数据口径。

## 何时用 / 前置

- 触发语见 description；动手前必读 `dsl-kit/SKILL.md`（材料→md 单源；本 skill 不复制 DSL 语法，语法权威 `dsl-kit/规范.md`，few-shot 范本 `dsl-kit/完整样例.md`）。
- 复用件路径权威清单在 `references/`（蓝小鲸《skill复用盘点》随本 PR 收进本目录）。

## 四步流程

### 1) 出 md

- 三形态 frontmatter `kind`：lecture / practice / mixed（语法权威 `dsl-kit/规范.md`）。
- 题型枚举：唯一来源 `packages/contract/src/content.ts`，七基础题型 judge/choice/multi/fill/solve/apply/find-error 恒可导，response/matching/ordering 受 NEW_CONTENT_ENABLED 发布开关裁决（只裁决新导入；已开卷按冻结快照作答，见坑位 2）。
- `[[答案]]` 标记内禁 `$`：公式定界符会把标记从中间切开导致答案泄露（`dsl-kit/规范.md`「标记内禁止 $」）。

### 2) 跑起来

- 生产模式：仓库根 `启动服务.cmd`（单进程 8787，API+页面同源；产物缺失自动 build）。
- dev：`pnpm dev`（web 5173 `host: true` 局域网可达，/api 代理 8787）。
- 导入：`POST /api/teacher/import/preview`（dry-run，先看 issues）→ `POST /api/teacher/import/commit`；或教师 MCP `import_markdown`（默认 dry-run，confirm:true 才入库）/ `import_zip`（md+图片打包）。
- 入口：`kind: lesson/mixed` → 学生端讲练页（讲义+练习一件事）；`kind: practice` → 建单元后走课程/作业投放。

### 3) 移动端入口（二维码）

- 学生链接即登录：`GET /s/<token>`（apps/server/src/routes/public.ts，写 90 天会话 Cookie）。
- token 从教师端来：`GET /api/teacher/students` 响应带 linkToken；`POST /api/teacher/students/:id/reset-link` 重置（重置即旧链失效）。
- 二维码：`node .claude/skills/lecture-practice/scripts/lecture-qr.mjs --student <姓名|id|登录名片段>`（仓库根运行；缺省 port 8787 / db ./data/tutor.db；--out 出 SVG/PNG；token 不落文件）。

### 4) 数据口径（硬规则）

- 落盘只留：讲义 md 源文 + 学生做题数据（attempts / responses / ink / notes / noteVersions / noteImages / annotations / annotationBases / events 时间轴）。
- 页面/组件状态（挂载、滚动、渲染缓存、布局偏好）一律不落库，运行时由 md + 做题数据重建；skill 禁止新增任何持久化面。

## 坑位清单

1. **防泄露红线（AGENTS.md 规则 3）**：含题块 md 原文（[[答案]]、:::solution、:::hint）恒不下发学生接口——不要把含答案 md 直接丢给学生端，一切走导入 + 冻结公开投影（publicStemMd 剥答案）。
2. NEW_CONTENT_ENABLED 只裁决新导入；已开卷按冻结快照作答，旧卷不回填。
3. 根目录 .cmd 是 GBK+CRLF：编辑用支持 GBK 的工具，别顺手改成 UTF-8。
4. token 即凭据：不进 git、不进日志、不贴公开频道；二维码等于把链接给出去，撤销走 reset-link。
5. 同题修订保持原 id；新题不手写 id（系统派生）。

## 验收（硬性）

- 手机（同 Wi-Fi）扫码直达学生端讲练页。
- 能作答 + 草稿 + 手写 + 标画（草稿/手写/标画三条链路都是现成组件，不重写；见 docs/约定/手写与同步.md）。
- 库中能查到该次 attempts/responses/events。
- 本 skill 写的每条命令在仓库当前头可跑（lecture-qr.mjs 随本 PR 同批落地）。

## 参考

- 蓝小鲸《skill复用盘点》：同目录 `references/`（随本 PR 收编，复用件路径权威清单）。
- docs/约定/手写与同步.md、docs/约定/学生作答与讲练.md（讲练页约定一节）。
