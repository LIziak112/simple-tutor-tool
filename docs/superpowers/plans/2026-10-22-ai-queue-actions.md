# 求助记录按钮语义修复

用户已确认方案并授权开分支修复、合并推送 v2。

## 文件与步骤

1. `AiQueuePanel.tsx`：分开题目定位与任务阅读；同卷调用独立回调，跨卷仅查看回复携带 aiTask。
2. `AiCompanionDock.tsx`：复用题卡入口定位，定位前等待材料恢复与收笔落盘；回题收起助教，不读取回复、不改变已读状态。
3. `AttemptSession.tsx`、`AttemptResultView.tsx`、`StudentLessonPage.tsx`：接入同卷回题回调。
4. 先补 `ai-queue.test.tsx`、`AiCompanionDock.test.tsx` 失败用例，再实现；覆盖三种显示偏好、同卷与跨卷、保存失败、恢复等待与题目归属。
5. 简化审查、正确性审查；运行测试、lint、类型检查、构建及相关真实浏览器回归，再合并推送 v2。

## 手动验证

在作答、结果与讲练页打开求助记录，分别使用题下阅读、侧边对照、弹窗偏好：回到本题关闭记录并定位题卡，不展开回复；查看回复展示选定任务。切全部来源选择另一卷，仍应定位原卷原题；保存失败应保留现场。

## 验证结果

已执行 TDD：最初新增四个回题用例均失败（回题 URL 错携 aiTask、仅题目参数不被消费）；分离路径后通过。审查时补测助教绑定题与当前编辑题不同时的落盘保护，先失败再修复。

简化审查：复用 `entryOf`、`host.flush` 与 `controller.closePanel`；同卷/跨卷共用题目定位函数，不新增持久化状态或接口契约。正确性审查：确认同卷/跨卷、材料恢复、归属校验、保存失败保留现场、三种布局、已读副作用与记录主体原有打开行为；发现的两题落盘问题已修复，无遗留阻断项。此次仅修改前端导航与呈现，不修改学生端载荷、答案投影或受控 AI 出口。

真实命令输出：

```text
pnpm test <队列、助教、作答/结果/讲练接线测试> --maxWorkers=2
Test Files 4 passed (4)
Tests 54 passed (54)

pnpm e2e e2e/student-ai.spec.ts --grep '求助记录回题只定位' --workers=2
2 passed (45.4s)  # Chromium / WebKit，三布局、同卷回题、跨页回题、查看回复

pnpm lint
Checked 1166 files. No fixes applied.
Found 2 warnings. Found 1 info.  # 既有 b20-verify 脚本告警，无错误

pnpm typecheck
contract / grading / md-dsl / server / web: Done，包含 E2E 类型检查

pnpm build
server 打包及迁移/规范复制成功；web built in 3.43s，PWA precache 385 entries
```

首轮全量运行时新增落盘测试赶在实现修复前执行，另有一项路由联调初始化超过 10 秒；最终以较低并发复跑全量成功：

```text
pnpm test --maxWorkers=4
Test Files 453 passed (453)
Tests 5321 passed (5321)
Duration 335.38s
```

其他会话中途为工作区创建了 `1295b960` WIP 备份（保留于 `backup/ai-queue-fix-wip-20261022`）。正式分支 `codex/fix-ai-queue-actions-verified` 从同一 v2 基线提取完全相同的代码、测试与文档，不包含临时日志。合并范围仅为本次修复，按用户要求只推送 v2。
