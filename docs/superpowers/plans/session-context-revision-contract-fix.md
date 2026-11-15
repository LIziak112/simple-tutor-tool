# PR160 questionRevisionId 契约收敛

根裁定的字段SSOT兼容修复，与链接登录修复分开提交。已有attempt-submission.questionRevisionIdSchema允许无首尾空白、非空、最长512字符的opaque TEXT行引用；LearningContext.session.questionRevisionId改为直接引用这一schema，不再额外收窄为UUID。其他真实UUID字段、DDL/迁移、归属与冻结题快照可见门保持。

先写契约合法opaque/UUID/512边界原样保留、空白/513拒绝及真实DB冻结行canonical投影/随笔往返/他人或缺失题引用拒绝的红测试，再改一个字段引用。没有证据表明线上有opaque存量，不推断存量、不读取真实DB。

完成后单worker定点，contract/server类型，完整gen:spec两轮零漂移并跑现成CLI及既有合法0/非法1与source诊断等价。记录真实产物/哈希与首失败；独立commit末行Krow-Task: session-context，scope分登录/本契约/合计及全58路径基线，交根独审，不发布或派子。

边界：160历史memo-context投影尚无165后续canonical的坏快照过滤保证，本修复不改其实现或强化门；该更强门随已审165及166各自来源。首次测试oracle误将新建随笔写为200、假设160会拒绝{}快照，已在改schema前更正并重红，保留原日志而不混算为字段需求。
