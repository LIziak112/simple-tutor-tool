# PR165 CI 竞争测试 harness 窄修

## 事实与边界

公开 canonical c70ca0dda107e5f97329ea38fb2d0ca3f417c11e 的 CI run43514251850/job132192951791：708 文件中707通过，8320项中8319通过、1失败；`attempt-settlement-race.test.ts` 的「逐题末题与整卷交卷竞争，只收尾一次」20秒超时，并有 child exit1 的 Unhandled Rejection。完整30223行/2600419字符日志已保存树外 `session-focus/logs/ci-settlement-race-job.log`。原stderr管道未消费，日志没有该child的原始stderr、ready或屏障阶段，不能恢复其退出1的最初原因，不能断言是产品竞争、SQLite启动或资源抖动。

该原测试在本地UI冻结4bf58f95与origin/session-settle的blob同为 `36039a7b1efc2da526a69906728b1388c618265a`，没有因 canonical/UI修改；上游1.3独审/full CI通过事实保留。原样本机单worker 3/3 exit0，7.61s。这只表示本机未重现CI最初child退出，不是CI失败已被治愈。

## 已确认的独立缺陷与修正

原逻辑先创建 outcome Promise，却先 await 一个永不因child退出而拒绝的ready Promise。child在ready前退出时，outcome独自拒绝成为Unhandled，而ready继续挂起；测试超时也无法运行它后面的finally。原清理发kill后立即删数据库，没有等待子进程/stdio关闭，且stderr既丢诊断也存在管道背压问题。

真实fork的启动失败夹具在ready前写入stderr marker并exit1。将原ready/outcome逻辑原样提取后，不等待短超时，只等两个真实child close即可确认completion仍pending；首轮1项失败并出现2个同型Unhandled Rejection，221ms，exit1。证据 `settlement-harness-ready-red.log`，并非模块缺失式假红。

生命周期抽到 `src/test/settlement-race-harness.ts`：只有一个立即被观察的completion拒绝通道，ready前/ready后退出、启动error、IPC send error或缺结果均拒绝它。两child都ready才发go，结果同时要求真实child正常close；持续消费stderr并保留有界16Ki字符尾部，错误含worker/pid/phase/ready/closed及exit code/signal。stop幂等，先终止仍存活peer、等待所有close后撤掉自有listener；SIGTERM后1秒仍未退出才SIGKILL。这个1秒只界定失败清理，不延长测试或业务操作预算。

原3项测试继续使用原真实数据库backup、两个真实独立进程/连接和同一服务worker。只替换启动/屏障/清理的测试支撑，finally await stop后才删临时数据库，并注册onTestFinished兜底超时清理。未改任何产品提交/结算服务或真实worker业务代码，未预设退出1最初原因，也未加重试、skip或放宽20000ms。

业务断言与原3个测试用例（含输入和20000ms）逐字节相同；SQLITE_BUSY_SNAPSHOT/SQLITE_BUSY不得出现、final=1、settlement_seq=1的responses=2、submit事件=1、仅允许既有幂等冲突码且至少一方成功全部保留。原业务断言块SHA256为 `8432f1ce9d05f585005bc2277bdb95e8dacdc585d5d4f80242c15a8acd09013f`，新旧一致，见树外 `settlement-harness-assertion-proof.json`。

## 验证

- `pnpm exec vitest run apps/server/src/test/settlement-race-harness.test.ts --maxWorkers=1` 红：1文件1fail，2Unhandled Errors，exit1；两个真实child已关闭，测试221ms完成。
- 首轮修后原3项+启动失败回归：2文件4/4，exit0，无Unhandled。
- 扩展仍存活peer清理回归后：2文件5/5，exit0，无Unhandled。新回归检查真实peer均关闭/disconnected，自有message/error/close/stderr data listener全部清掉。
- server类型首轮exit1（IPC unknown code类型没有在对象spread处收窄）；用局部变量按同一字符串/缺省契约收窄后，`pnpm --filter server run typecheck` exit0。首失败日志保留。
- 仅类型修正后重跑同一2文件5项：`settlement-harness-final-green-3.log`：2文件5项全部通过，11.37s，exit0，无skip/Unhandled。相关4代码文件Biome、diff/check与全仓规模/治理检查留树外日志。

本窄修只保证已确认的ready/outcome失败不会再被变成20秒挂起和Unhandled，并为将来真实启动失败保留诊断；CI那次exit1的初因仍未知。独立UI提交 `4bf58f95d5f0ee99bc6155fd874c733fa6adb742` 的48文件不再改动，UI验证证据复用；后端业务、contract/生成物均无变动，不重跑全量/浏览器/生成。此窄修单独commit并交原settlement审核员补审，不在执行端声明独审通过。
