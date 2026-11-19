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

归档来自已验收的内核修订 `fbe7cc11aadb51cd767154b232278d86acb3e4d5` 的干净构建，SHA-256 为 `0333e20083867c65060c0345542b277b7ad965cc5883eb129c2d4ef79b3bc4d0`。仓内保留原字节，文件名登记摘要，pnpm 锁定归档完整性和 Zod 版本。

默认探针要求重复开卷获得同一个真实内核回执、本人在既有详情 URL 读到相同冻结题、另一个学生被拒绝。关闭重开内核 SQLite 后复验本人读取。教师移出作业名单后本人仍可取回已有作答，新开卷被拒。真实注销与教师归档后，旧 Cookie 无法读取。探针输出各库路径和实际行数。Vitest 的独占路由用例使用候选替身。

## 历史拒绝证据

早期 K1 原包 SHA-256 为 `4f24ba26cda0f0b2688cbd8057189186f55bc88e783470346acc4f20df4937b8`。同一个正常开卷请求返回 `500 M04_PUBLISH_REJECTED`，包内部拒绝 `material` 与 `practice.material`。产品没有作答、成绩、证据和结算，内核没有练法或活动。

已有原归档时，可在独立目录执行 `npm install --offline --ignore-scripts --no-audit --no-fund ./learning-kernel-0.1.0.tgz ./zod-4.6.5.tgz`，从产品根执行 `pnpm --dir apps/server exec tsx src/test/m04-p1/probe.ts --historical-k1 <安装目录>`。探针核对原包和 Zod 摘要后重验拒绝与两库空白。

活动与作业的关联只保存在本次隔离进程。隔离详情输出内核公开只读结果，题目冻结身份、草稿版本与整卷确认仍需实证。固定产物只有 `publish`、`start`、`read`、`close`，探针记录实际方法供后续对照。

## 草稿写入试验

草稿试验读取内核修订 `15c03a1` 的固定预览包，保持产品锁使用开卷产物。将预览包与 `zod-4.6.5.tgz` 按上节命令离线装到独立目录，再执行 `pnpm --dir apps/server exec tsx src/test/m04-p1/draft-probe.ts <安装目录>`。探针核对预览包 SHA-256，使用真实草稿 PUT 与同一两题的实际冻结行，保存后在原详情 URL 回读草稿。

同一保存标识改选另一项时，旧行为返回 409 `ANSWER_REVISION_CONFLICT` 和本人 `_current`，原预览包 `0f946a65…` 返回 409 `OPERATION_CONFLICT`。本地修复包 `b3fd31c5…` 随同一异常给出当前稿，试验适配从该异常构造旧响应。两边均对不同保存标识的陈旧写入返回本人 `_current`。名单移出后新开卷被拒，但已建卷可续读写；注销或归档后旧 Cookie 的读写均被拒。

旧客户端只发 `{answer}` 时，旧端首次及原样重发都会计数。带凭据的客户端接管后，无凭据写返回 409 及本人当前稿。隔离适配在这三处均返回 400。旧端首次保存会让详情从 `opened` 进入 `active`，记录从 0 增至 1，冲突后维持。隔离详情暂无产品的 `phase`，记录列表仍为空。
