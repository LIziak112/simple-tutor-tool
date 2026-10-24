# 我的记录排序精进（2026-10-24）

## 当前问题与已确认决策

- 当前 SQL 使用 `coalesce(submittedAt, startedAt)` 倒序；进行中记录继续作答不更新排序，交卷才跳顶。前端原样呈现接口顺序。
- 用户已确认在独立分支 `codex/student-records-sorting` 实施：一个排序选择器提供「最近作答」（默认）、「最近开始」、「最早开始」。
- 最近作答时间仅由有效作答写入推动：答案变更、草稿/正式手写/标画正文变更、逐题提交、整卷交卷。读取、重复上传、教师批改、订正、自评与 AI 对话不推动。
- 开卷以 startedAt 为基线；历史缺少可靠活动事实时回退 submittedAt/startedAt，不推测历史编辑时间。本机编辑在服务端成功确认时计入。
- SQL 先排序再分页；活动时间并列再按开始时间和 ID 稳定兜底，ID 不代表真实创建顺序。
- 卡片按当前排序标「最近作答」或「开始于」；日期筛选固定为「作答活动时间」。排序同步 URL，切换回第一页，回看返回保留。

## 实施清单

1. 先增加契约、后端排序/活动写入、前端 URL/呈现回归测试，运行并确认失败。
2. 修改 packages/contract/src/student-records-api.ts；增加可选排序参数及公开活动时间字段，类型从契约推断。
3. 修改 apps/server/src/db/schema.ts，使用 drizzle-kit 生成迁移；历史列保持空值并读时回退。
4. 增加统一活动时间写入入口，在 attempt-service、ink-service、note-service、annotation-service 成功事务内调用；有效变更才计时。
5. 修改 student-records SQL、web API 参数、records-filters、records-views、StudentRecordsPage 与返回来源白名单链路。
6. 同步 docs/页面功能清单.md 与 AGENTS.md，刷新契约分发产物。
7. 完整 diff 做简化、正确性及学生载荷安全审查；运行测试、类型检查、lint、build、相关真实 Playwright；通过后小步提交，按仓库流程合并 v2、main。

## 验收与手动验证

- 旧卷保存新答案后回列表置顶，纯手写/草稿/标画保存同样生效；逐题提交无需整卷交卷即更新。
- 相同内容、幂等重试、失败写入、读取、批改与订正不更新活动时间。
- 三种排序跨页正确，同刻顺序稳定；时间筛选始终使用活动时间；非法排序 URL 安全回默认。
- 更改排序后第一页，刷新保留，进入记录再返回保留筛选、排序和阅读位置。
- 普通记录响应继续通过 assertNoLeak，记录可见性与作废过滤保持。
- 手动：打开 /s/records?status=draft，依次切换三种排序，进入旧练习保存答案/笔迹后返回，检查位置与时间；查看结果并返回不改变活动时间。

## 进度

- 已完成：根因分析、方案确认、独立分支创建、契约/迁移/服务端/页面实现与文档同步。
- 初始失败测试：契约排序缺失、URL 排序缺失、旧卷续作不置顶，3 项均确认失败后实现。
- 边界失败测试：同笔迹仅更改时间戳/版本号并改用原始 JSON 上传，不得更新活动时间；已复现并修正。
- 已通过：首轮相关 10 文件 238 测试；迁移/记录/正式笔迹 4 文件 107 测试；Chromium 与 WebKit 真实端到端 2 项；全仓类型检查、lint、build；gen:spec 已刷新。
- 已完成：受控并发全量回归（484 文件、5742 测试全部通过），实施与验收完成；按顺序提交并合入本地 v2、main。初次全量默认并发出现超时，已终止该次运行并使用 `--maxWorkers=2` 重新执行。

## 质量闸门记录

已读取并按仓库 `.zcode/skills/code-review/SKILL.md` 的四阶段审查与七项 blocking 检查核对变更，并使用其 security-review-guide；迁移流程按 `.claude/skills/db-change/SKILL.md` 复核。systematic-debugging / simplify / security-review / verification-before-completion 的独立 SKILL.md 未在会话目录与仓库中找到，按对应目标直接完成根因定位、简化审查、安全审查与真实命令验证，未宣称调用不存在的技能。完整 diff 分为活动写入、查询与界面、迁移与产物三组逐行检查。

- 简化审查：统一 touchAttemptActivity 写入入口；API 类型从契约推断；卡片直接复用 SQL 的活动时间表达式，排序、筛选和下发时间保持单一口径。
- 正确性审查及修复：有效写入与活动时间同事务；相同正文/幂等/失败不计时；开始时间排序先于分页；随机 UUID 仅用于稳定并列；返回列表重新核对，修复原 15 秒缓存造成的续作不置顶窗口。
- 安全审查：新增载荷仅本人作答时间，未增加题目内容读取；排序由契约枚举裁决，SQL 不拼接用户字符串；失权、作废、公布 gate 保留；records 泄露测试覆盖三种排序及活动时间筛选；写入仍经现有归属/CAS/锁题守卫。
- 迁移审查：0041 由 drizzle-kit 生成，仅新增可空列，旧记录为空；保留原 startedAt/submittedAt，旧库升级保真测试补充新列为空断言。
- 端到端夹具维护：有参考答案的手写题现走自评，原教师待批用例改用无参考答案题，结果图标断言改为当前可见的判定状态文本；未更改判分行为。
- 视觉验收：已查看 Chromium 的记录页截图；排序/来源/状态在同一筛选行，卡片明确显示开始时间，无遮挡与异常溢出。

## 发布说明与边界

- 需要部署包含 0041 迁移的服务端与新前端；本次开发验证未直接修改用户正在访问的线上数据库。
- 历史缺少可靠保存时间的记录不能还原最近编辑；仍回退交卷/开始时间，后续有效保存开始记录。
- 离线稿只有同步成功后才改变服务端排序；教师批改、订正、自评、AI 对话不改变本期排序语义。
- 无新增依赖。正式笔迹为了识别仅协议元信息变化的重复上传，会读取上一份矢量文档做内容比较；保持既有上传限额与解压上限。


## 最终验证输出（2026-10-24）

```text
pnpm test -- --maxWorkers=2
Test Files  484 passed (484)
Tests       5742 passed (5742)
Duration    668.23s

pnpm e2e e2e/student-records.spec.ts --workers=2
2 passed (32.2s)  [Chromium / WebKit]

pnpm typecheck
packages/contract / packages/grading / packages/md-dsl / apps/server / apps/web: Done

pnpm lint
Checked 1228 files in 1511ms. No fixes applied.

pnpm build
apps/web: built; PWA files generated
apps/server / packages: 构建通过

pnpm gen:spec
生成成功；暂存后再次生成，git diff --exit-code -- docs/dsl dsl-kit 退出 0。

git diff --cached --check
退出 0。
```

代码审查结论：通过，无未处理的 blocking / important 问题。简化、正确性、安全、迁移与兼容性检查已完成。

本地 main 开始时领先 origin/main 36 个既有提交；本次仅本地合并，不顺带推送这些未发布提交，不打发布 tag，不操作线上数据库。已有的其他未跟踪文档保持原样且不纳入本次提交。


## 云服务器部署验收（2026-10-24）

用户后续明确授权「合并 v2 并推送到云服务器」。已推送 origin/v2，运行代码部署提交为 `d4b8fdf6373bca5d0e9ba6b39c76bf55dd9c33ef`。

- 目标：`47.116.99.166`，systemd 服务 `simple-tutor-tool`，部署目录 `/opt/simple-tutor-tool`。
- 沿用服务器既有 tar-over 脚本：Node 24 / pnpm 12.6.0，先停服务、备份完整 data、在独立 staging 安装和构建，再切换程序目录，保留原数据目录；失败有旧程序与数据备份回退路径。
- 停服：16:14:05；启动：16:14:30；健康检查及部署完成：16:14:32（北京时间）。
- 完整数据备份：`/opt/simple-tutor-backups/data-before-d4b8fdf6-20261024-161405.tar.gz`。
- 旧程序：`/opt/simple-tutor-backups/app-before-d4b8fdf6-20261024-161405`。
- 自动启动迁移成功，迁移总数 42，`attempts.last_activity_at` 已存在；SQLite quick_check = ok，未手工修改线上库结构。
- 升级前后业务行数一致：attempts 47、responses 770、ink 2、notes 56、annotations 28。
- 公网健康接口成功；公开演示学生登录后，三种排序各读取 5 条实际记录，均含活动时间且顺序符合约定；非法 sort 返回 400。验证只读取记录，未创建/修改作答。
- 公网新前端资源已核对，包含「最近作答／最近开始／最早开始」；排序控件所在共享 chunk 正常返回。
- 服务器日志：`/opt/simple-tutor-staging/deploy-d4b8fdf6.log`；本地验证摘要与日志位于被 git 忽略的 `e2e/.artifacts/records-deploy/`。

上文「未推送/未部署」描述的是首轮实现验收结束时的状态，本节为后续实际部署结果。未推送本地 main 中原有的未发布提交；本次服务器使用已验收 v2 代码。
