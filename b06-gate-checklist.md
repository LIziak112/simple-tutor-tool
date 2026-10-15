# B06 闸门审查清单（独立审查会话，2026-10-16，收尾删除本文件）

范围：`git diff v2...codex/student-ai-b06`——新增 student-ai-materials.ts(782)/student-ai-queue.ts(1571)+两测试(1290/1529)+content-service.test 4 行+验收记录。

## 第一遍 /simplify（4 并行代理：复用/简化/效率/抽象层级）——代理已全部回报，处置中
- [x] 与 SAI-05 sqlite 层/SAI-09 context/SAI-10 采集的重复：blob-io/pngIntact/attemptTeacherId/备份引用/策略裁决均已复用；仅 nowSpecOf vs export-service.resolveNowDate（context 已在用）+ taskOf/requireOwnTask 两文件各一份 → 修
- [x] 两新服务互相之间的重复：invalid()/taskOf/nowIso 内联/首条消息查询/回信插入四份 → 选低风险修；invalid/conflict 本地构造器按仓惯例跳过
- [x] 单调用方过度抽象：aiTaskMaterialsInternalOf 单调用内联；beginInappDispatch 事务后重读行 → 修
- [ ] 测试大段 setup 复制该抽 fixture：两新测试 ~190 行重复（insertResponse/expectHttpError/setupWorld/openFileDb）→ 建 ai-companion 夹具模块，仅迁两个新测试文件

## 第二遍 /code-review（最严口径，逐项核）——亲读两实现全文+定向抽查测试，处置中
- [x] contextVersion 双口径：输入全为服务端落库字段（快照实质体去 capturedAt/版本锚/promptHash/材料 hash 清单），客户端无预构碰撞面；与 SAI-09 HMAC 平行已在注释声明——无缺陷
- [x] 迟到回执/paused 独立事务（决策①）：代码 late 分支主事务只读提交后另事务落 late_reply 再抛 409；T2 paused 随事务提交后抛 403；测试 811-830 断言 409 后事实存活/正文零入库——已证
- [x] lease/代次 CAS：openDualWorld 真临时文件库双连接；1451-1484 真实 BEGIN IMMEDIATE 持锁 + busy_timeout=300 快速失败 + 释放后重试——非串行模拟
- [ ] 配额三计数：🔴 **C2 已确认**——技术方案 §限额表「待处理任务/学生 10 = pending+dispatching+claimed+uncertain」，实现只数 pending 桶([created])，claimed/dispatching/uncertain 不占额可无限堆 → TDD 修；cancelled 释放（当日量除外）与超额不建半成品已核
- [x] uncertain→replied 偏离（遗留②）：判接受——§6「回写按 (taskId,generation) CAS」文字语义 + §312「超时待确认显式重试」不排除迟到交付，测试②已覆盖；验收记录保留记录
- [x] SAI-11 五项：写序先文件后单事务+失败只清新写文件、resolveWithinRoot 越界 500 AI_MATERIAL_BROKEN 带材料标识、GC keep=全行+备份引用+不可读保守放弃+只扫本命名空间、publicOfRow 无 pngPath/错误消息无路径、三通道门禁齐——均与申报一致
- [ ] 状态转换集中性：🔴 applyTransition 自称唯一写入口但 claim/begin/expire/recover 四处直写（均有 CAS 但绕过转换表）→ 扩 patch 回流；archived/opened 不覆盖 replied 已证（markReplyDelivered 只写独立列）
- [x] 测试真实性：RED 记录按仓标准格式采信（模块缺失导入失败形态）；并发断言实查非恒真（单 lease/单 dispatched 事实/late_reply 存活/持锁计时）；材料 40 例五条覆盖抽验待标记
- [x] 50514164 复核：仅 content-service.test.ts +4 行，零实现——属实
- [x] 仓库专项 blocking：禁项 0；契约/依赖/迁移/DSL/samples 零触碰（diff 仅两服务+两测试+4 行）；材料读取投影无 pngPath（本批无路由，泄露面新增为零）

## 闸门追加发现（代理+亲核合并去重）
- C1 竞态分支（queue:503-519）：唯一索引兜底分支只比 4 结构字段、缺 question 正文——同键异内容并发静默幂等命中而非 409 → 修（与预检查共享谓词）
- E1 HIGH listStudentAiTasks N+1（每行 ~10 查询×50 行）→ 批量预取+页内策略记忆化修；E2 每次列表跑写事务 recoverAiQueue → 只读预检门控；E3 领取扫描 50×policyUsable → 记忆化；unreadReplyCount 全量拉行无上界 → isNull 下推
- 跳过（记录）：invalid/conflict 本地构造器（仓惯例）、策略可用谓词三处内联（抛错/bool/文案变体）、BEIJING_OFFSET/sha256Hex 上提 lib（无既有共享符号）、LOW 级聚合优化（配额有界）

## 处置纪律
- 确认缺陷当场修（小步提交+定向测试证明）；简化只做低风险；不确定列遗留
- 每遍完成跑 node C:/Users/HUAYU/.claude/orchestration/student-ai/check-self.cjs（单独成命令）
- 禁：push、装依赖、改契约、动 apps/server/tsconfig.tsbuildinfo、进 B07
- 收尾：更新验收记录 B06 行（闸门结论）；最终回复 ≤8 行

## 已知事实（开题即核）
- check-self.cjs 按主仓库项目目录找最新 glm 转录；本会话在 stt-b06 工作树（转录目录不同），首跑 STOP 读数系误测别会话，按 harness 配额（15M 剩 ~14.95M）判断，此差异记遗留
