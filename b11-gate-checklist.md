# B11 合并前闸门清单（simplify → code-review → security-review）

范围：v2...codex/student-ai-b11（Head 6312e459），30 文件 +5060/-128。
纪律：确认缺陷当场修（小步提交+定向测试）；简化只做低风险；不确定列遗留。

## 第一遍 simplify
- [ ] S1 面板/控制器/受限渲染重复：模式标签、时间格式化、fetch 封装（lib/api.ts 三种写法口径是否统一）
- [ ] S2 AiConversationPanel 与 AiCompanionSession 状态重复
- [ ] S3 测试 fixture 重复
- [ ] 跑 check-self.cjs

## 第二遍 code-review
- [ ] C1 SAI-20 遗留①裁决：firstUseRequired 知情门只有客户端呈现、create 可直调绕过——当场补服务端强制（推荐）或明确归属后续批次，落验收记录
- [ ] C2 SAI-20 遗留②：材料上传失败分支（413 预检/网络失败/multipart 异常）无专项控制器测试——补或裁决归属
- [ ] C3 SAI-21 回执 dedup 修复复核：追问后同文回信不再误判重放；worker 出站取末条学生消息与多轮一致性；测试断言真实性
- [ ] C4 追问语义：followupStudentAiTask 恒不重采材料；AI_TURNS_MAX 边界（=上限友好拒绝非崩溃）；replied→created 重排队与并发 lease 交互；同文在途幂等
- [ ] C5 面板查询策略：同 key 轮询观察者真实共享缓存（不双请求）；隐藏暂停、恢复可见零出站；错误退避不风暴
- [ ] C6 opened 幂等：失败回滚本地标记不虚报已读；与 replyDeliveredAt 合判
- [ ] C7 门禁语义：禁用期历史/轮询拿不到未获准正文——面板「已收到回信暂不能查看」分支服务端支撑真实性
- [ ] C8 测试真实性：RED 记录、断言非恒真（notifyManager/fake timers 适配不掩盖真实行为）
- [ ] C9 本仓库七项 blocking 专项（答案泄露/契约/判分/迁移/DSL/samples/禁项）
- [ ] 跑 check-self.cjs

## 第三遍 security-review（XSS 面 + 追问端点）
- [ ] X1 受限渲染绕过面穷举：HTML 实体/嵌套编码、KaTeX \href/\includegraphics/\link、协议大小写与空白变体、data: URI、svg/mxfile/mermaid、unicode 控制字符、markdown 表单/详情 HTML 注入、autolink——逐向量确认测试存在或当场补
- [ ] X2 零图片真实性：清洗 schema 剥 img 与源文本替换双层是否真零网络请求（断言级别）
- [ ] X3 超限可解释失败：字节/公式/节点三上限绕过（分片拼接、压缩向量）
- [ ] X4 追问端点：他人任务 id 越权、attempt 归属、question 长度上限、注入出站 prompt 的转义边界
- [ ] X5 防泄露双断言：允许场景答案确实进外发载荷；禁止场景与普通学生接口无 answers/solutionMd/教师私注哨兵；未改 assertNoLeak 全局键
- [ ] 跑 check-self.cjs

## 收尾
- [ ] 验证：定向 vitest + typecheck + lint；触及公共路径加跑全仓 pnpm test
- [ ] 更新验收记录 B11 行（闸门结论与遗留裁决）
- [ ] 删除 b11-gate-checklist.md
- [ ] 最终回复 ≤8 行
