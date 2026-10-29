import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { Button } from "@/components/ui/button";
import { useTeacherMe } from "@/features/auth/teacher-auth";
import { useStudentLinkLogin } from "@/features/auth/student-auth";
import { createStudentApi, fetchStudentsApi } from "@/lib/api";

/** v3 opt-in workspace. Authentication and account isolation remain server-enforced. */
export function PersonalStudyPage() {
  const owner = useTeacherMe();
  const navigate = useNavigate();
  const login = useStudentLinkLogin();
  const [selected, setSelected] = useState("");
  const learners = useQuery({
    queryKey: ["teacher", "personal-learners"],
    queryFn: () => fetchStudentsApi(false),
    enabled: Boolean(owner.data),
  });
  const create = useMutation({
    mutationFn: () => createStudentApi({
      displayName: "我",
      loginName: `self_${crypto.randomUUID().slice(0, 20)}`,
    }),
    onSuccess: () => { void learners.refetch(); },
  });
  const rows = learners.data?.students ?? [];
  const learner = rows.length === 1 ? rows[0] : rows.find((row) => row.id === selected);
  async function start() {
    if (!learner?.linkEnabled) return;
    try {
      await login.mutateAsync(learner.linkToken);
      navigate("/s/home");
    } catch {
      // Mutation error is rendered below. Never print the bearer link.
    }
  }
  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col gap-6 p-6">
      <h1 className="text-2xl font-semibold">个人学习</h1>
      <p>准备资料 → 连接 agent → 练习 → 回看反馈。保留账号保护，不因同 Wi-Fi 而开放访问。</p>
      {owner.isPending ? <p role="status">正在确认本机管理权限…</p> : owner.isError ? (
        <section className="flex flex-col gap-3">
          <p>首次使用先设置本机账号；已有账号请登录。仅在初始化时需要管理身份。</p>
          <Link to="/t/setup">首次设置</Link>
          <Link to="/t/login">登录本机账号</Link>
          <Button onClick={() => void owner.refetch()}>重试连接</Button>
        </section>
      ) : (
        <>
          <section className="flex flex-col gap-3" aria-label="开始学习">
            <h2 className="text-lg font-semibold">1. 我的学习空间</h2>
            {learners.isPending ? <p role="status">加载学习空间…</p> : learners.isError ? (
              <Button onClick={() => void learners.refetch()}>重新加载</Button>
            ) : rows.length === 0 ? (
              <Button disabled={create.isPending} onClick={() => create.mutate()}>
                {create.isPending ? "创建中…" : "创建我的学习空间"}
              </Button>
            ) : (
              <>
                {rows.length > 1 && (
                  <label>选择已有学习空间（不会自动猜选）
                    <select className="block min-h-11 w-full border p-2" value={selected}
                      onChange={(event) => setSelected(event.target.value)}>
                      <option value="">请选择</option>
                      {rows.map((row) => <option key={row.id} value={row.id}>{row.displayName}</option>)}
                    </select>
                  </label>
                )}
                <Button disabled={!learner?.linkEnabled || login.isPending}
                  onClick={() => void start()}>进入练习与反馈</Button>
                {learner && !learner.linkEnabled && <p>此空间的专属登录已关闭，请在高级管理中显式开启。</p>}
              </>
            )}
            {(create.isError || login.isError) && <p role="alert">操作未成功，请检查网络与账号状态后重试。</p>}
          </section>
          <section className="flex flex-col gap-3" aria-label="准备学习资料">
            <h2 className="text-lg font-semibold">2. 准备资料与连接 agent</h2>
            <Link to="/t/connect">连接 AI / MCP</Link>
            <Link to="/t/import">导入 agent 生成的讲练资料</Link>
            <Link to="/t/library">我的资源库</Link>
            <p>资料需加入课程并对当前学习空间可见。现有 CLI 可显式发布至个人课程；不会自动发布到多人课程。</p>
          </section>
        </>
      )}
      <details>
        <summary>高级管理与兼容入口</summary>
        <Link className="block min-h-11" to="/t">本机资料管理</Link>
        <Link className="block min-h-11" to="/s/login">已有学习账号登录</Link>
      </details>
    </main>
  );
}
