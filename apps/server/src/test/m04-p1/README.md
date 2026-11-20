# M04 P1 单选作业隔离联调

本地取证使用真实 OwnClass 教师 setup、导入、布置和两个学生登录。在原作业开卷 URL 使用与默认产品共用的请求解析和学生守卫。隔离装配早于默认路由匹配，把开卷交给固定候选包。其它产品路由由 `createApp` 提供。默认装配仍调用原作业开卷服务。

候选从产品开卷使用的题集与上下文闭包取两道合成题。题面经 `studentStemMd` 投影，评分键作为服务端发布输入，作业没有独立材料、题组或阅读步骤。夹具来自 learning-kernel 修订 `97fb964e3b6bc9192c9e761bc13d3c9d9e2759e0` 的 `docs/迁移/M04`；冻结 JSON 与原文件数据一致，采用产品的 JSON 排版。临时目录内有相互独立的产品和内核 SQLite。

## 本地复跑

使用 Node 24.19.x 和 pnpm 12.6.0，在产品根目录执行下列命令。离线安装需要已有 pnpm 缓存。内核由 `server` 直接从产品锁文件安装，探针通过包名及公开类型使用它。

```powershell
pnpm install --frozen-lockfile --offline
pnpm exec vitest run apps/server/src/routes/m04-p1-assembly.test.ts
pnpm --dir apps/server exec tsx src/test/m04-p1/probe.ts
```

当前内核以 `apps/server/package.json`、`pnpm-lock.yaml` 的固定归档路径和文件的实际 SHA-256 为准。历史 K8 归档来自内核修订 `7e9b0df1c921cad307a362f762ad9d70c3fd37b3`，SHA-256 为 `3b565090f38b16dea6051cf71c63b3ebfa331291da9ccaf42e19549f162cde1d`。历史 K6 来自 `e9311e9357f384e495c1b539c8b1a5c6df43958f`，SHA-256 为 `d3c3f4d907987405ebfbb590bc125797b79ef752c48e17477cf34b2f1314ef42`。

默认探针要求重复开卷获得同一个真实内核回执、本人在既有详情 URL 读到相同冻结题、另一个学生被拒绝。关闭重开内核 SQLite 后复验本人读取。教师移出作业名单后本人仍可取回已有作答，新开卷被拒。真实注销与教师归档后，旧 Cookie 无法读取。探针输出各库路径和实际行数。Vitest 的独占路由用例使用候选替身。

## 历史拒绝证据

早期 K1 原包 SHA-256 为 `4f24ba26cda0f0b2688cbd8057189186f55bc88e783470346acc4f20df4937b8`。同一个正常开卷请求返回 `500 M04_PUBLISH_REJECTED`，包内部拒绝 `material` 与 `practice.material`。产品没有作答、成绩、证据和结算，内核没有练法或活动。

已有原归档时，可在独立目录执行 `npm install --offline --ignore-scripts --no-audit --no-fund ./learning-kernel-0.1.0.tgz ./zod-4.6.5.tgz`，从产品根执行 `pnpm --dir apps/server exec tsx src/test/m04-p1/probe.ts --historical-k1 <安装目录>`。探针核对原包和 Zod 摘要后重验拒绝与两库空白。

本节开卷探针的活动与作业关联只保存在隔离进程。旧 K2 开卷产物的公开方法是 `publish`、`start`、`read`、`close`，其取证基线为 `fbe7cc11aadb51cd767154b232278d86acb3e4d5`、SHA-256 `0333e20083867c65060c0345542b277b7ad965cc5883eb129c2d4ef79b3bc4d0`。

## 草稿写入试验

草稿历史试验读取内核修订 `15c03a1` 的固定预览包。将预览包与 `zod-4.6.5.tgz` 按上节命令离线装到独立目录，再执行 `pnpm --dir apps/server exec tsx src/test/m04-p1/draft-probe.ts <安装目录>`。探针核对预览包 SHA-256，使用真实草稿 PUT 与同一两题的实际冻结行，保存后在原详情 URL 回读草稿。

同一保存标识改选另一项时，旧行为返回 409 `ANSWER_REVISION_CONFLICT` 和本人 `_current`，原预览包 `0f946a65…` 返回 409 `OPERATION_CONFLICT`。本地修复包 `b3fd31c5…` 随同一异常给出当前稿，试验适配从该异常构造旧响应。两边均对不同保存标识的陈旧写入返回本人 `_current`。名单移出后新开卷被拒，但已建卷可续读写；注销或归档后旧 Cookie 的读写均被拒。

旧客户端只发 `{answer}` 时，旧端首次及原样重发都会计数。带凭据的客户端接管后，无凭据写返回 409 及本人当前稿。K3 试验适配在这三处均返回 400。旧端首次保存会让详情从 `opened` 进入 `active`，记录从 0 增至 1，冲突后维持。隔离详情暂无产品的 `phase`，记录列表仍为空。

## 同卷原稿试验

从产品仓根执行下列命令，使用正式锁定的内核。探针只在隔离装配中接管已有作业开卷，产品详情、笔记与会话走现有产品路由。两库分别保存同一个真实内核活动 ID 下的各自事实。

```powershell
pnpm --dir apps/server exec tsx src/test/m04-p1/original-probe.ts
```

纯内核开卷后，产品笔记 GET 和 PUT 都返回 `404 ATTEMPT_NOT_FOUND`。只存在卷摘要、缺少冻结题行时，两条请求均返回 `404 QUESTION_NOT_FOUND`。同一开卷请求重发后复用草稿试验的宿主投影，活动 ID 保持原值，产品详情的两个题冻结行 ID 和 SQLite 一致，第一题笔记头引用同一题行，第二题保持空稿。

同卷 `enabledCapabilities` 按教师设置读回 `[] → ["ink"] → []`。本人开启时写 V1 并上传 PNG，实际原稿预留对照服务端正文哈希。关闭后、教师移出名单后，本人仍读回 V1，第二会话用版本 1 为基线保存 V2，新开卷返回 403。随后重开产品和内核 SQLite，以实际 24 小时窗口加 1 毫秒执行 GC，0 个版本候选、0 个文件删除，保留 V1 及 V2。重试同一预留取回原 V1，学生读回的 V1 gzip 170 字节、PNG 76 字节与回收前逐字节相同，当前头仍为 V2。

他人对笔记读写、版本正文与 PNG 均收到 403，注销或教师归档后旧 Cookie 对四条路径均收到 401。产品最终有一份卷、两条冻结响应和一项待确认预留，成绩、正式证据与结算为 0。内核活动仍可正常读取，提交、自动判定与完成记录为 0。该试验覆盖正常路由的存取与预留前提，浏览器画布和权威提交后的投影移交留给后续验收。

## K4 权威回执移交原稿

使用内核修订 `1269cbe421af9ec4f378e60bae0a143bde8ed8ca` 的固定试装归档，SHA-256 为 `62221d38e30bff8c64dccfca3e9c8075dd98a57a824984daa8fb07d16084063e`。用试装目录的公开 Node 入口调用 `confirmChoices` 和 `recoverChoiceConfirmation`。隔离装配的作业开卷、产品冻结题和笔记存取沿用上一节。

在已执行过产品离线安装的仓根，用固定归档创建试装目录后执行探针。解包保留归档原字节，Zod 解析到产品锁中的 4.6.5。

```powershell
$k4Archive = 'C:/Users/HUAYU/AppData/Local/Temp/ownclass-k1-fresh-d2537b8/target/m04-p1-choice-confirm-final/learning-kernel-0.1.0.tgz'
$k4Hash = '62221D38E30BFF8C64DCCFCA3E9C8075DD98A57A824984DAA8FB07D16084063E'
if ((Get-FileHash -LiteralPath $k4Archive).Hash -ne $k4Hash) { throw 'K4 归档哈希不符' }
$k4Install = Join-Path ([IO.Path]::GetTempPath()) ('ownclass-m04-k4-' + [guid]::NewGuid().ToString('N'))
$k4Module = Join-Path $k4Install 'node_modules/learning-kernel'
New-Item -ItemType Directory -Path $k4Module | Out-Null
Copy-Item -LiteralPath $k4Archive -Destination (Join-Path $k4Install 'learning-kernel-0.1.0.tgz')
tar -xf (Join-Path $k4Install 'learning-kernel-0.1.0.tgz') -C $k4Module --strip-components 1
if ($LASTEXITCODE -ne 0) { throw 'K4 归档展开失败' }
New-Item -ItemType Junction -Path (Join-Path $k4Install 'node_modules/zod') -Target (Resolve-Path 'node_modules/.pnpm/zod@4.6.5/node_modules/zod').Path | Out-Null
pnpm --dir apps/server exec tsx src/test/m04-p1/receipt-originals-probe.mjs $k4Install
```

同一两题三种声明分别取证：

- P0 原样评分声明可以发布和开卷，用新 `confirmChoices` 确认返回 `422 INVALID_SLOT`。
- 保持 P0 题面、选项和评分键，携带实际题版本并启用 `confirmFromDrafts`，发布在 `practice.steps.0.submit.slots` 被拒，要求草稿确认槽与内置评分分开声明。
- 独立的无评分统一确认夹具实际确认，三份隔离库分别验证 `frozen/none`、`missing/none`、旧客户端协议省略原稿时的 `uncollected/uncollected`。存在工作稿而省略声明，产品预检返回 `409 NOTE_EVIDENCE_MISMATCH`。

冻结场景在 V2 已成为工作头时确认选中的 V1。内核提交成功、产品证据为空后丢弃响应路径，关闭并重开两库。可信恢复按同一活动、步骤和操作取回同一回执。直接恢复未获授权，错卷、错操作以及篡改文档 ID、版本或摘要均无法移交。实际写入两条证据后注入解 pin 失败，外层事务回滚到零证据，原预留继续保护 V1。再次恢复并投影后，两题按权威确认时刻写入，V1 改由正式证据引用保护。重复投影返回原回执且行值相同。移交前后的 GC 各保留两个版本，V1 的 gzip 170 字节和 PNG 76 字节与回收前逐字节相同。

明确缺稿时，已有工作稿仍可识别，正式原稿版本为空。旧客户端省略且无稿的恢复结果保留 `uncollected`，产品没有证据行。每个无评分夹具的内核只有一份正式提交和一条完成，自动判定为 0。产品只有可重建的证据行，作答答案、成绩、正式提交时间、结算和提交事件均未生成。真实普通单选评分、公网页面交卷路由和跨进程故障演练留给后续验收。

## K5 旧客户端保存

使用内核修订 `67a35573f7bf9b161200ec5c80c612fb78ba4f5b` 的干净试装归档，SHA-256 为 `fd44d13b3707c6f68bee845663493b72f9c64ce4e3ef8c03ac81861abc2c9843`。按上节方式装入独立目录后运行 `pnpm --dir apps/server exec tsx src/test/m04-p1/receipt-originals-probe.mjs <安装目录>`。脚本按归档摘要选择旧客户端保存对照和真实评分发布拒绝检查。

## K6 宿主判分

从产品根执行 `pnpm --dir apps/server exec tsx src/test/m04-p1/scored-choice-probe.mjs`。探针使用正式锁定的公开包，通过同一教师和两名学生的真实开卷、保存、交卷与详情请求验四卷。宿主注册 `ownclass-choice@1`，核对可信回执作用域、产品冻结行和评分键后，将实际答案交给 `gradeResponseRow`。整卷确认、逐题判定保存在内核，产品用 `prepareChoiceOriginals` 和 `projectConfirmedChoiceEvidence` 移交原稿证据。

默认按 P0 的公布设置运行。乙旧卷、甲全空和甲部分交卷后可读汇总，甲完整卷的截止由教师从未来调整到已过后，同一卷重新读取才可见汇总。四卷为 100、50、0、50，均按两题计分。甲完整卷第一题改选后提交答案修订 2。乙第一题使用第二版真实存稿，确认后保留正文与 PNG 的字节回读。以 `--all-withheld` 再跑四份仍未公布的对照。当前验证覆盖隔离请求和宿主接口，正式作业的分配、持久映射和完整结果视图属于后续接线。

真实 PUT 复用产品的鉴权、请求校验和冻结行。带修订与操作标识的请求携带两项凭据，只有答案的请求由内核按旧客户端语义写入。首次和同文重发各增加一次修订，现代客户端同文接管不增加修订，接管后旧客户端收到 `409 ANSWER_REVISION_CONFLICT` 和本人当前稿。接管一题后，另一题仍能以旧客户端请求保存。他人始终被拒绝。无评分试验卷经权威确认和两库重启后沿原作业 URL 返回同一活动，确认后新旧两种 PUT 都收到 `409 ALREADY_SUBMITTED`，两库作答事实无变化。试验中的详情阶段和记录列表仍待产品正式接线。

确认成功后、产品原稿索引尚未接收确认时，原样重发已完成的现代接管请求也收到 `409 ALREADY_SUBMITTED`。内核公开接口仍可取回这次历史保存的版本 2，产品的保存入口遵循作业终态。重启两库后重复验证。

## 普通草稿保存与跨进程恢复

普通学生 PUT 在宿主授权后调用内核的当前保存接口。超宽限使用仅允许最近操作重放的模式。详情从同一活动绑定取两题当前稿和修订。激活与最近活动采用内核实际变化时间和原宿主触笔时间的最早、最晚值。宿主响应行继续用于冻结题身份。未限时冻结卷的条件读取将内核当前修订纳入原有 ETag。

```powershell
pnpm exec vitest run apps/server/src/routes/kernel-assignment-drafts.test.ts apps/server/src/routes/kernel-assignment-attempt.test.ts --maxWorkers=1
pnpm --dir apps/server exec tsx src/test/m04-p1/current-draft-restart-probe.mjs
```

跨进程探针先让内核保存落库，再用合成数据库触发器中断宿主活动投影。以相同数据目录重启服务后，详情恢复原题身份和草稿，并补回首次活动。详情前直接打开记录列表仍遗漏该卷，列表独立恢复留待 P4。另一次中断以同请求重试补回投影。旧包历史回执反例保存在 `fd237076`。

## 普通整卷确认与恢复

宿主迁移 `0081` 为每份内核卷保留一个当前确认操作及冻结题、原稿和答案修订引用。正常整卷 POST 先提交预留，再以原绑定和冻结行授权内核确认与评分。权威端明确拒绝时释放预留。回执已存在时按原操作恢复，投影卷状态和原稿索引。本人结果使用同一套公布规则，正文、逐题判定和成绩来自内核。

```powershell
pnpm exec vitest run apps/server/src/routes/kernel-assignment-confirmation.test.ts apps/server/src/routes/attempt-submit-evidence.test.ts --maxWorkers=1
pnpm --dir apps/server exec tsx src/test/m04-p1/confirmation-stage-race-probe.mjs
pnpm --dir apps/server exec tsx src/test/m04-p1/confirmation-restart-probe.mjs
```

第一条进程探针在宿主提交预留后、调用内核前暂停真实进程。另一进程的相同意图沿用原操作和原稿，随后恢复时原进程收到已交卷。不同意图仅在内核尚未确认时替换。确认前被终止的进程能由同一授权学生重启后继续原操作。

第二条进程探针在内核确认落库后中断宿主投影。独立进程重启后先验证跨账户拒绝及内核暂缺保稿，再从同一权威回执恢复 V2 正文、PNG 和成绩。另测普通 PUT 落库但活动投影中断，重启后直接交卷仍保留首次改答时刻。列表、导出涉及的汇总投影留在 P4。

M05-P04 沿用同一确认预留。新意图在原稿预留事务中记录已收件水位、旧焦点秒数和改答事件数，活动账在内核确认后才由宿主落账。相同意图沿用原水位，冲突释放意图后可以重新收件。正式改答数取事件数和内核学生保存次数的较大值。历史已确认票据缺水位时保留未知。进程探针在宿主回滚和重启期间补传事件，先从教师逐题详情恢复原活动账，再查学生详情、原稿和相同确认回执。


### P4 学生本人记录跨进程恢复

```powershell
pnpm --dir apps/server exec tsx src/test/m04-p1/student-records-restart-probe.mjs
```

用同一 P0 两题混排旧卷和内核卷。只中断宿主投影，重启后首个学生请求直接读记录列表，验证状态筛选和总数、草稿进度、时间排序、截止公布、名单和会话权限。暂移内核库时，旧作业记录仍可读，本人已公布的内核记录返回 503。


### P4 学生错题轮次跨进程恢复

```powershell
pnpm --dir apps/server exec tsx src/test/m04-p1/student-wrong-questions-restart-probe.mjs
```

用同一组 P0 冻结题验证内核确认后的重启、公布与重新收紧。保留独立课程和旧作业轮次，核对题版本、目录分页、普通与目录组卷、内核离线范围和跨账号授权。


### P4 教师学情跨进程恢复

```powershell
pnpm --dir apps/server exec tsx src/test/m04-p1/teacher-analytics-restart-probe.mjs
```

同一组 P0 冻结题分布在旧作业与内核作业，用教师真实会话验证总览、学生画像和题目视角。覆盖公布前读取、确认后宿主投影失败和重启、课程及学生隔离、内核离线和不依赖内核的旧课。


### P4 教师逐题 CSV 跨进程恢复

```powershell
pnpm --dir apps/server exec tsx src/test/m04-p1/teacher-csv-restart-probe.mjs
```

对照同一组 P0 冻结题的旧、内核作业。首个内核 CSV 请求直接恢复正式确认，验证 24 列和 BOM、精确提交时间筛选、公布前后及撤回、域隔离和内核离线范围。

### P5 双库归档的活动归属

```powershell
pnpm exec vitest run apps/server/src/routes/teacher-backup-kernel.test.ts --maxWorkers=1
node --import ./apps/server/node_modules/tsx/dist/loader.mjs apps/server/src/test/fixtures/backup-k8-upgrade.mjs $k8SyntheticDir K8
node --import ./apps/server/node_modules/tsx/dist/loader.mjs apps/server/src/test/fixtures/backup-k8-upgrade.mjs $k9SyntheticDir K9
```

旧库演练读取合成目录的原数据库和对应产品修订中的固定内核包，在隔离目录恢复并走原学生与教师详情。K8 语料是一份已交两题、教师 50 分的试卷。K9 语料是混代反例的完整较晚截面，甲正在作答，乙已经交卷且教师评分为 0。混代测试将甲开卷后的主库与乙交卷后的内核库组合，修复前下载和恢复均返回 200。修复后下载返回 500，恢复返回 400，现有乙卷仍可读取。开卷意图测试保留内核尚未开卷和已开卷待绑两种截面，验证正常恢复沿用已生成的活动。

K12 来自内核修订 `cbec8df3cb84372539cf33ecb8c3379770e2ba50`，固定包 SHA-256 为 `7bc836b57ec9140d3ee898a489e03b414490c89de491690c981580548a87c1f3`，数据库版本为 15。官方 ZIP 演练在两个隔离目录先后恢复历史下载和 K12 下载。K10 和 K11 均查验原成绩、V2 文档和 PNG 的原字节，并续写原旧草稿。带勘误的 K11 还查验历史成绩、原学生所见的修订、教师审计及学生写次数，随后从教师修订继续作答。三个来源均检查下载授权并拒绝未知和摘要错配的内核工件。

| 探针参数 | 下载所用的产品基线 | 本次历史合成 ZIP 的 SHA-256 |
| --- | --- | --- |
| `K10` | `963c0bd861e451557d5c1f776d8bc739036db797` | `91bb913d0441f6d37036345c98af65b7cd132e9e29321774259569e90d091329` |
| `K11` | `cb6ca8c18e4a64007e69cb65d0007a4a6dace3e6` | `89d76b6e50b6be1977490271323f23040a776f0b1c94ced38b7b93e97ad4d846` |
| `K11-amended` | `74a1471bfad391735eea4ebf3dfe250267c6ad95` | `5729bbd966c6761fffc645c443d9782527203bf0e170841f519f4b232abea9bc` |
| `K12-amended` | `f9504ec9` | `0a7bc1d426eea28f325461ce9ca98bc38dc7941f5c6e2bd00f1dcb9b5b9c7de2` |

要生成新的输入，在对应旧基线冻结安装并以独立合成 `DATA_DIR` 运行。沿用 `product-fixture.ts` 的合成师生与两道冻结题。K10 建立甲的 50 分已交内核卷并冻结带 PNG 的 V2 原稿，乙正常交出 100 分卷，甲另开一份传统草稿。K11 可恢复同一 K10 下载后再下载。带勘误的 K11 使用同一甲账号正常交出 50 分旧卷，再开内核草稿，按 `kernel-teacher-draft-amendment.test.ts` 的教师 SDK 操作把第一题从空改为 B@1。按部署文档配置 `INSTANCE_BACKUP_OPERATOR_ID`，由已登录管理员访问 `/api/teacher/backup/download` 取得 ZIP。

使用每次下载实测的 ZIP 指纹作为 `$inputZipSha256`。探针分别核对 ZIP 指纹、历史基线的固定 `.tgz` 指纹、清单与双库字节。临时 ZIP 和合成口令保存在仓外。用环境变量 `OWNCLASS_BACKUP_FIXTURE_TEACHER_PASSWORD` 和 `OWNCLASS_BACKUP_FIXTURE_STUDENT_PASSWORD` 提供源站口令。`$currentKernelSha256` 取当前固定 `.tgz` 的实测指纹。

```powershell
$inputZipSha256 = (Get-FileHash -LiteralPath $officialZip -Algorithm SHA256).Hash.ToLowerInvariant()
node --import ./apps/server/node_modules/tsx/dist/loader.mjs apps/server/src/test/fixtures/backup-official-upgrade.mjs $officialZip $fixture $inputZipSha256 $currentKernelSha256
```

K13 固定包来自内核修订 `3e48ce73cd322323cecbc7242cba8090d9aa2fb5`，SHA-256 为 `baaea5f3ed29fd75f1bc06c3727a2ac311c0bebe6b6188619678cca994a5af07`。双库核验从归档主库中的绑定作答、教师审计及未结勘误意图取声明。若只有一侧记录已完成勘误，管理员下载返回 500，恢复返回 400，当前草稿仍可读。同一未结答案勘误在内核写入前和写入后均可归档，恢复后交卷沿原操作补回一条审计。

K13 复验了表中的四份合成下载 ZIP，以及用 K8 和 K9 固定包、既有合成双库截面组装的两份历史归档。K12 的样本包含教师勘误后学生又改答的修订 2，恢复时保留这一修订和教师审计，学生可继续保存到修订 3。

### P4 教师批改工作台跨进程恢复

```powershell
pnpm --dir apps/server exec tsx src/test/m04-p1/teacher-review-workbench-restart-probe.mjs
```

用两份同一 P0 冻结卷，在独立进程重启后分别由待批队列和作答卡片首读恢复。验证自动完成卷、分页总数、传统主观待批、已开始草稿、教师域与内核离线范围，并用真实教师 SDK 验证查询同一页的提交及对错计数。
