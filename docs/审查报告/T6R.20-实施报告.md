# T6R.20 实施报告：固定底图题干标画（桌面自动化部分）

- 任务：docs/Phase6任务清单.md §4 T6R.20；设计权威 docs/题目草稿功能方案.md §10（固定底图＋独立矢量标注）＋ §4（输入状态机纪律）。
- 分支 task/T6R-20（独立 worktree，基于 v2@d17d1a0），共 **27 提交**＝实现 13（代理 A 契约/迁移/服务端 6＋代理 B 前端/E2E 7）＋审查修复 12＋E2E 收尾 2；合并 v2 **ad8aef7**（56 文件 +16672/−406，与同期 v2@2ca25ea 启动加固零重叠零冲突）。
- **R6 未宣称交付**：方案 §11 判据——C 批次「真机可读、下载可用、重排不漂」需 iPad 实测；本报告只闭合桌面自动化。R4（T6R.19）真机同样待用户。

## 1. 架构落地（编排者裁决要点）

1. **固定底图＋独立矢量标注**：服务端装配学生 stem 投影载荷（`assembleAnnotationBase`，materialOf 学生级＋选项，**不含学生答案节与任何教师节**）→ 客户端复用 T6R.19 栅格化机制生成单张底图（宽恒 1440px=720CSS×2 契约单源；内容高上限 1976CSS，超高题**显式禁用标注并说明原因、草稿照用**）→ 上传落库（身份三要素回传校验）→ `annotation_bases.state=ready` 后才允许落墨（客户端不挂画布＋服务端 PUT 409 双层 gate）。底图 ready 永不重生成（同字节幂等/异字节 409），旋转/布局变化仅整体缩放。
2. **底图身份三要素**：questionRevisionId（=responses.id，attempt 级冻结）＋ snapshotHash（canonicalJson→sha256 题目内容身份，服务端单源 `questionSnapshotHashOf`）＋ baseRenderVersion（契约常量 1，语义＝底图生成管线版本；**刻意不复用** note_versions.render_version——那是派生图渲染器版本）。**snapshotHash 不下发学生端**（实施偏差 1，编排者裁定通过）：它覆盖含 [[答案]] 原文的完整快照、规范化算法随仓库公开——学生可离线枚举碰撞恢复答案（review-pack 安全 F1 同理）；身份校验与 stale 判定全部服务端自做。
3. **stale 判定**（审查修复 4 真化）：与**题库当前内容**比对（建卷冻结同构路径 questionOfRow 单源重建快照算 hash）——题目编辑→回看显示「旧版本题干的标注」横幅、装配载荷不动旧 base；题目软删→stale=true；题库行缺失防御态不指认改版。初次实现误与 attempt 自身冻结快照比对（恒 false 死代码，gemini 补漏 HIGH，编排者核码确认后修正）。
4. **笔迹独立链**：AnnotationDoc v1（坐标域=底图像素，superRefine 限额 ANNOTATION_MAX_*）走独立 annotations 表（CAS revision＋mutationId 全局唯一幂等），**不塞 NoteDoc 覆盖载荷**；IDB `tutor-annotations`＋SerialTaskQueue 串行同步（2s 防抖/10s 强制、退避 1s→60s、CAS「以本机为准」、SEALED/ALREADY_SUBMITTED/403 终态、切账号中止）。画布为标注专用 `annotation-surface`（引擎件全复用 ink engine：pointer-machine/InkStore/erase/atrament 程序化绘制；backing store 恒=底图像素域 resize 不重设位图；指针直接绑画布**不依赖 event.target.closest 穿透**——测试含中间层插入/目标被替换仍正确收点；§4.1 输入状态机全矩阵：第二指针/pointercancel/lostpointercapture/失焦/visibility/合并采样能力探测）。
5. **交卷固定与订正**（审查修复 2/3 定稿语义）：交卷成功回调后 seal（失败非阻断＋结果视图「标注封存待重试」警示）；服务端**懒补封自愈**（getAnnotationView/assembleAnnotationPairs 入口，已交卷未封存 scratch 行现场补封，幂等——requireUsableAttempt 懒冻结同款先例）；seal 路由门槛（draft 期 scratch seal 409，防自害自封；correction 恒合法）。**标注未追平不阻止交卷**（编排者拍板口径：C 批次独立附件不得阻断 A/B 核心交卷；本地稿保留）。订正：结果页「保存订正标注」检查点（对齐 CorrectionPanel 模式）→ phase=correction 另开记录，旧 scratch bytes 不变；教师详情卡作答/订正阶段切换查看。
6. **存储与伺服**：底图 `blobs/annotations/<sha256>.png`＋正文 `blobs/annotation-bodies/<hash>.json.gz`（内容寻址），**绝不进 /blobs 公开段**（media/ 白名单不变量不破；题干内容绕过题目可见性控制是泄露面）；伺服走 attempt 授权直出路由（他学生 403、跨 attempt 404、无存在性泄露），URL 模板契约单源 `annotationBaseImageUrl`。
7. **导出与装配**：客户端「导出合成图」=canvas 直绘（drawImage 底图＋笔迹重放，不走 html-to-image），底图文件丢失→显式「底图缺失」拒绝导出（**绝不导出孤立的圈**）；导出后接「复制图片」（lib/copy 单源，降级不谎报）。review-pack/学情包 v2：`annotation/aNNN-base.png＋aNNN-strokes.json` **成对装配**（任一不可读整对进 manifest.missing），v1 与未勾 evidence 零夹带（测试双锁定）。
8. **迁移 0027**（drizzle-kit 生成）：annotation_bases（身份三要素＋state CHECK）＋annotations（CAS/FK/mutationId 唯一索引）；唯一性服务层先查后插（notes scratch 先例）。

## 2. 任务条目五项失败测试对应

| 要求 | 落点 |
| --- | --- |
| 旋转/字体更新/题目编辑/fold 改变不挪旧圈 | backing store 恒定＋坐标域=底图像素（surface 单测）；ready 永不重生成＋题目编辑 stale 单测；E2E 两视口（820×1180↔1180×820）画布与底图 img 同尺寸断言＋GET 回读 doc 不变 |
| 没有可靠底图不能落墨 | 客户端 base 非 ready 不挂画布（UI 测试含 too-tall/装配哨兵 500/403 三禁用态）＋服务端 PUT 409 ANNOTATION_BASE_NOT_READY（route 测试） |
| 跨角色图不含隐藏答案 | 服务端三检（assertNoLeak＋stemMdLeaksAnswers＋教师节标记）覆盖成功与全部错误响应；教师视图同检；E2E attachLeakMonitor 全程零告警 |
| 不依赖 event.target.closest 穿透 canvas | 指针直接绑画布；单测：中间层插入/事件目标被替换仍正确收点 |
| 订正不改旧标注 | 服务端 sealed 后 PUT 409 且 bytes 不变；E2E 订正另开 correction（服务端权威断言）＋旧 scratch 视图不变 |

## 3. 验证（编排者亲跑，2026-10-08，合并前 task/T6R-20 终态）

- `pnpm test`：Test Files **278 passed (278)**、Tests **3566 passed (3566)**（exit 0）
- `pnpm typecheck`：5 包全 Done（exit 0）
- `pnpm lint`：0 error（18 warnings+2 infos=存量基线）
- `pnpm build`：绿（PWA 348 entries）
- `pnpm e2e`（chromium+webkit 双引擎全量）：**86 passed（3.4m）** exit 0（annotation.spec 3 用例×双引擎在列）
- `pnpm gen:spec`＋`pnpm schema:export` 二跑：git status **零 diff**（幂等校验通过）

## 4. 三路并行审查与处置（38 项原始发现）

- **Claude 正确性＋安全**（P0×1/P1×2/P2×3/P3×8）：安全角全绿——snapshotHash 确证不在任何学生可达载荷（契约/服务/路由三层枚举核对）、鉴权/上传校验/路径/夹带/迁移无发现、−142 行无行为删除。
- **gemini-3.8-flash 补漏规约**（HIGH×2/MED×3/LOW×2）：规约八项全「未发现」。
- **gemini-3.8-flash 质量四角**（HIGH×3/MED×7/LOW×6）。
- 去重裁决：**必修 5**（P0 AnnotationView 回放坐标比例——cssPerBase=1 致回看页笔迹错位被裁，atrament offsetWidth 再放大，静态可证；P1 seal 时序中止锁死；P1 correction 半接线教师不可见；gemini HIGH stale 死代码〔编排者核码确认：baseIsStale 与 attempt 冻结快照自比对恒 false，「教师改题库只影响之后新建的卷」〕；gemini HIGH base-image 逐块测量简化）＋**应修 10**（静态渲染/栅格化原语抽共享 static-markdown.tsx＋rasterize-utils.ts、字体嵌入 CSS 缓存、base 写路径状态门槛、孤儿文件删前查引用、URL/几何常量契约单源、ALREADY_READY 自愈、学情包缺失 refs、表单解析收敛 form-fields、AnnotationView 复制图片、三处一行级）全部修复（dfa7b1d..ed9e28e 12 提交＋4f555c3/cc9c381 E2E 收尾）。
- **不修 13 项**理由留档（要点）：pending 死锁不可达（建卷后快照恒定，防御分支保留）；annotation-surface 不参数化合并 atrament-adapter（契约 width=1000 锁定、两链画布策略语义不同、触碰 A 批次稳定链路风险>收益——实施偏差 2 已声明）；ensureBase 前置 GET 承载视图态恢复非冗余；KeyQueue 不抽象（扰动 note-store，第三处出现再抽）；热路径坐标往返/复合挂 DOM＝真机定标后评估；gzipMemo/交卷全库扫描＝量级小防抖限频；multipart 入口字节上限＝存量等价面统一处理；其余备注级。
- 修复轮两任代理：前任上下文 383.5k 超 250k 上限被编排者停止（15 项已全部提交，仅剩 E2E 收尾），接续代理完成 E2E 定位修复＋全量闸门＋本报告素材（fix-report.md）。

## 5. 实施偏差与拍板记录（编排者裁定）

1. snapshotHash 不下发（F1 离线答案 oracle 防线）——**通过**。
2. sealed 409 先于交卷门槛（幂等重放仍最优先）——**通过**。
3. aNNN 独立编号（标注 correction 不依赖笔记 correction，挂 e 编号会悬空）——**通过**。
4. strokes.json 只随 zip 成对交付不进 preview 附件——**通过**。
5. 标注未追平不阻止交卷、seal 网络失败在交卷成功后重试（修复 2 后语义）——**通过**（C 批次独立附件判据）。
6. 标注专用画布而非参数化 atrament-adapter——**通过**（引擎件全复用，适配层坐标域/画布策略不同）。
7. E2E 订正 phase 断言走服务端权威（multipart 流式体 postDataBuffer=null）——**通过**。
8. 笔粗档位=引擎 1000 纸基准×1.44（thin 3.6/medium 5.76/thick 8.64 底图像素）、默认红笔——**真机定标项**。

## 6. 真机检查清单（🧑 iPad，R6 打勾判据；未过不宣称交付）

1. 底图可读性：720CSS 宽底图上公式（KaTeX）/中文小字缩放下可读；::image 配图完整。
2. 圈画锚定：圈住具体字/公式/图上一点→横竖屏/分屏拖动后相对底图锚点不漂；反复变布局旧圈不动。
3. Pencil 手感：落笔延迟；手掌先落不落墨（auto 探测）；笔先落手掌后落笔迹不中断；Scribble 抢占不吞点。
4. 收笔语义：书写中途旋转/系统手势边缘（pointercancel）已收笔迹保留不粘笔。
5. 橡皮/撤销：整笔橡皮命中半径手感；撤销/重做/清空二次确认。
6. 同步与交卷：断网写标注→恢复自动补传；交卷后只读；订正另开旧圈不变。
7. 底图生成时长（字体嵌入＋栅格化真机耗时）；超高题禁用文案时机。
8. 教师端：iPad 回看视图（底图＋圈）与导出合成图下载可用。

## 7. 遗留与后续

- T6R.20 前置「19 底图验证通过」仍在用户真机清单中——本任务 E2E 顺带复验了同一栅格化管线（宽恒 1440/可解码 PNG），但**不替代真机判据**。
- T6R.21/22 为条件任务（未触发则记录不实施）；T6R.23 最终交付核对依赖本任务合入（已合 ad8aef7）。
- 完整素材：t6r20-gates/{plan,recon,agentA-report,agentB-report,fix-report,claude-review,gap-findings,quality-findings}.md（Temp 目录，不入库）。
