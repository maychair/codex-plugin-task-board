import { useCallback, useEffect, useRef, useState } from "react";
import { resolveTaskboardUrl } from "../api";
import { postEmbeddedHostMessage, setEmbeddedFrameChallenge } from "../embeddedHost.mjs";
import "./LocalTaskBoard.css";

interface LocalTask {
  id: string;
  title: string;
  status: string;
  goal: string;
  role: string;
  projectId: string;
  projectName: string;
  workspacePath: string;
  worktree: string;
  reviewUrl?: string;
  dependencies: string[];
  children?: LocalTask[];
  dependencyDetails?: { id: string; status: string; title: string }[];
  evidence: string[];
  evidencePreviews?: { reference: string; text: string; truncated: boolean }[];
  next: string;
  session: {
    threadId: string;
    codexProjectId: string;
    codexProjectKind: "local";
    codexHostId: "local";
    workspacePath: string;
  } | null;
  sessionKind: "task" | "coordinator";
  sourceId: string;
  sourceName: string;
  sourcePath: string;
  acceptance?: string;
  blocker?: string;
  acceptanceCriteria?: string[];
  interaction?: { question: string; options: string[] } | null;
}

interface LocalTasksSnapshot {
  tasks: LocalTask[];
  sources: { id: string; name: string; path: string; error?: string }[];
  updatedAt: string;
}

const lanes = [
  { id: "ready", label: "待开始", statuses: ["ready", "todo", "queued", "backlog"], result: false },
  { id: "running", label: "进行中", statuses: ["running", "in_progress"], result: false },
  { id: "blocked", label: "遇到阻碍", statuses: ["blocked"], result: false },
  { id: "review", label: "待确认", statuses: ["review", "in_review"], result: false },
  { id: "completed", label: "执行完成", statuses: ["completed"], result: true },
  { id: "failed", label: "执行失败", statuses: ["failed"], result: true },
  { id: "done", label: "已验收", statuses: ["done"], result: true },
  { id: "unknown", label: "未标记", statuses: [], result: false },
];

function taskLane(status: string) {
  return lanes.find((lane) => lane.statuses.includes(status)) ?? lanes[lanes.length - 1];
}

function shortPath(path: string) {
  return path.replace(/\/$/, "").split(/[\\/]/).filter(Boolean).slice(-2).join("/");
}

function refreshTime(value: string) {
  const time = new Date(value);
  return Number.isNaN(time.getTime()) ? value : time.toLocaleTimeString("zh-CN", { hour12: false });
}

export function LocalTaskBoard() {
  const [snapshot, setSnapshot] = useState<LocalTasksSnapshot | null>(null);
  const [error, setError] = useState("");
  const [statusError, setStatusError] = useState("");
  const [changingStatus, setChangingStatus] = useState(false);
  const pendingStatus = useRef<{ requestId: string; timer: number } | null>(null);
  const draggedTask = useRef<LocalTask | null>(null);
  const [statusConfirmation, setStatusConfirmation] = useState<{ task: LocalTask; status: string } | null>(null);
  const statusDialogRef = useRef<HTMLDialogElement>(null);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [project, setProject] = useState("");
  const [source, setSource] = useState("");
  const [showResults, setShowResults] = useState(false);
  const [selectedKey, setSelectedKey] = useState("");
  const [reply, setReply] = useState("");
  const [replyNotice, setReplyNotice] = useState("");
  const dialogRef = useRef<HTMLDialogElement>(null);
  const pendingReply = useRef<{ requestId: string; taskKey: string; timer: number } | null>(null);
  const [sending, setSending] = useState(false);
  const [uncertainReplyKeys, setUncertainReplyKeys] = useState<string[]>([]);

  useEffect(() => () => {
    if (pendingReply.current) window.clearTimeout(pendingReply.current.timer);
    if (pendingStatus.current) window.clearTimeout(pendingStatus.current.timer);
  }, []);

  useEffect(() => {
    if (selectedKey && !dialogRef.current?.open) dialogRef.current?.showModal();
    if (!selectedKey && dialogRef.current?.open) dialogRef.current.close();
  }, [selectedKey]);

  useEffect(() => {
    if (statusConfirmation && !statusDialogRef.current?.open) statusDialogRef.current?.showModal();
    if (!statusConfirmation && statusDialogRef.current?.open) statusDialogRef.current.close();
  }, [statusConfirmation]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(resolveTaskboardUrl("/api/local-tasks"), { cache: "no-store" });
      if (!response.ok) throw new Error(`读取任务契约失败（${response.status}）`);
      const data = await response.json() as LocalTasksSnapshot;
      setSnapshot(data);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法读取本地任务契约");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    if (window.parent === window) return;
    let acknowledgedFrameChallenge = "";
    function applyTheme(theme: unknown) {
      if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
    }
    function receiveHostMessage(event: MessageEvent) {
      if (event.source !== window.parent || !event.data || typeof event.data !== "object") return;
      const message = event.data;
      if (message.type === "taskboard:frame-challenge") {
        const challenge = typeof message.payload?.challenge === "string" ? message.payload.challenge : "";
        if (!challenge || challenge === acknowledgedFrameChallenge) return;
        acknowledgedFrameChallenge = challenge;
        setEmbeddedFrameChallenge(challenge);
        postEmbeddedHostMessage({ type: "taskboard:ready" });
      } else if (message.type === "taskboard:theme") {
        applyTheme(message.theme);
      } else if (message.type === "taskboard:host-context") {
        applyTheme(message.payload?.theme);
      } else if (message.type === "taskboard:local-task-status-result") {
        if (!pendingStatus.current || message.payload?.requestId !== pendingStatus.current.requestId) return;
        window.clearTimeout(pendingStatus.current.timer);
        pendingStatus.current = null;
        setChangingStatus(false);
        setStatusError(!message.payload.ok ? message.payload.error || "状态更新失败"
          : message.payload.status === "blocked" ? message.payload.notice : "");
        void refresh();
      } else if (message.type === "taskboard:local-task-reply-result") {
        if (!pendingReply.current || message.payload?.requestId !== pendingReply.current.requestId) return;
        const taskKey = pendingReply.current.taskKey;
        window.clearTimeout(pendingReply.current.timer);
        pendingReply.current = null;
        setSending(false);
        if (message.payload.ok) setReply("");
        if (message.payload.uncertain) setUncertainReplyKeys((keys) => [...keys, taskKey]);
        setReplyNotice(message.payload.ok
          ? "回复已由所属 session 接收。任务状态仍以契约更新为准。"
          : message.payload.uncertain
            ? `发送结果不确定：${message.payload.error || "未收到回执"}。请打开所属对话核实，不会自动重发。`
            : `发送失败：${message.payload.error || "所属 session 未接收回复"}`);
      } else if (message.type === "taskboard:thread-open-error") {
        setError(message.payload?.error ?? "无法打开绑定对话");
      }
    }
    window.addEventListener("message", receiveHostMessage);
    postEmbeddedHostMessage({ type: "taskboard:frame-awaiting-challenge" });
    return () => {
      window.removeEventListener("message", receiveHostMessage);
      setEmbeddedFrameChallenge("");
    };
  }, []);

  const tasks = snapshot?.tasks ?? [];
  const projects = [...new Map(tasks.map((task) => [task.projectId, task.projectName || task.projectId])).entries()];
  const search = query.trim().toLocaleLowerCase();
  const filtered = tasks.filter((task) => (
    (!project || task.projectId === project)
    && (!source || task.sourceId === source)
    && (!search || [task.id, task.title, task.goal, task.workspacePath, task.worktree, task.role, task.next]
      .join(" ").toLocaleLowerCase().includes(search))
  ));
  const results = tasks.filter((task) => taskLane(task.status).result).length;
  const visibleLanes = lanes.filter((lane) => (
    (!lane.result || showResults)
    && (lane.id !== "unknown" || filtered.some((task) => taskLane(task.status).id === "unknown"))
  ));
  const visibleTasks = filtered.filter((task) => showResults || !taskLane(task.status).result);
  const sourceErrors = snapshot?.sources.filter((item) => item.error) ?? [];
  const selected = tasks.find((task) => `${task.sourceId}:${task.id}` === selectedKey);
  const openConversation = (task: LocalTask) => {
    if (task.session) postEmbeddedHostMessage({ type: "taskboard:open-thread", payload: task.session });
  };
  const changeStatus = (task: LocalTask, status: string, confirmed = false) => {
    if (pendingStatus.current || status === "unknown" || task.status === status) return;
    if (window.parent === window) { setStatusError("请在 Codex 内的看板中操作任务。"); return; }
    if (status === "done" && !confirmed) { setStatusConfirmation({ task, status }); return; }
    setStatusConfirmation(null);
    const requestId = crypto.randomUUID();
    setChangingStatus(true);
    setStatusError("");
    const timer = window.setTimeout(() => {
      if (pendingStatus.current?.requestId !== requestId) return;
      pendingStatus.current = null;
      setChangingStatus(false);
      setStatusError("状态操作回执未到达。请刷新并打开所属对话核实；不会自动重试。");
      void refresh();
    }, 100_000);
    pendingStatus.current = { requestId, timer };
    postEmbeddedHostMessage({ type: "taskboard:local-task-status", payload: { requestId, sourceId: task.sourceId, taskId: task.id, status, confirmAcceptance: status === "done" && confirmed } });
  };
  const sendReply = (task: LocalTask) => {
    if (pendingReply.current || !reply.trim() || !task.session || uncertainReplyKeys.includes(`${task.sourceId}:${task.id}`)) return;
    if (window.parent === window) {
      setReplyNotice("请在 Codex 内的看板中发送回复，或打开所属对话回复。");
      return;
    }
    const requestId = crypto.randomUUID();
    const taskKey = `${task.sourceId}:${task.id}`;
    setSending(true);
    setReplyNotice("正在发送至所属 session…");
    const timer = window.setTimeout(() => {
      if (pendingReply.current?.requestId !== requestId) return;
      pendingReply.current = null;
      setSending(false);
      setUncertainReplyKeys((keys) => [...keys, taskKey]);
      setReplyNotice("尚未收到发送回执，结果不确定。请打开所属对话核实；不会自动重发。");
    }, 100_000);
    pendingReply.current = { requestId, taskKey, timer };
    postEmbeddedHostMessage({ type: "taskboard:local-task-reply", payload: { requestId, sourceId: task.sourceId, taskId: task.id, reply: reply.trim() } });
  };

  return (
    <main className="local-task-board">
      <header className="local-task-header">
        <div>
          <h1>本地任务</h1>
          <p>任务契约 · {snapshot?.sources.length ?? 0} 个来源 <span>共 {tasks.length} 项 · 执行结果 {results} 项</span></p>
        </div>
        <div className="local-task-refresh">
          {snapshot && <span>更新于 {refreshTime(snapshot.updatedAt)} · 每 5 秒刷新</span>}
          <button type="button" onClick={() => void refresh()} disabled={loading}>{loading ? "读取中…" : "刷新"}</button>
        </div>
      </header>
      <div className="local-task-toolbar">
        <input type="search" aria-label="搜索任务" placeholder="搜索任务、角色或路径…" value={query} onChange={(event) => setQuery(event.target.value)} />
        <select aria-label="筛选项目" value={project} onChange={(event) => setProject(event.target.value)}>
          <option value="">所有本地项目</option>
          {projects.filter(([id]) => id).map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select>
        <select aria-label="筛选契约来源" value={source} onChange={(event) => setSource(event.target.value)}>
          <option value="">所有契约来源</option>
          {snapshot?.sources.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
        <label className="local-task-results"><input type="checkbox" checked={showResults} onChange={(event) => setShowResults(event.target.checked)} />显示执行结果</label>
      </div>
      {(error || statusError || sourceErrors.length > 0) && <div className="local-task-errors" role="alert">
        {error && <p>{error}{snapshot && "；当前保留上次读取结果。"}</p>}
        {statusError && <p>{statusError}</p>}
        {sourceErrors.map((item) => <p key={item.id} title={item.path}>{item.name}：{item.error}</p>)}
      </div>}
      {snapshot && snapshot.sources.length === 0 && <div className="local-task-notice">尚未登记活动任务契约来源。</div>}
      {snapshot && tasks.length > 0 && visibleTasks.length === 0 && <div className="local-task-notice">{filtered.length > 0 ? "当前任务均为执行结果，勾选“显示执行结果”查看。" : "没有符合筛选条件的任务。"}</div>}
      <div className="local-task-columns">
        {visibleLanes.map((lane) => {
          const laneTasks = visibleTasks.filter((task) => taskLane(task.status).id === lane.id);
          return <section key={lane.id} className={`local-task-column local-task-column-${lane.id}`} aria-label={lane.label}
            onDragOver={(event) => { if (!changingStatus && lane.id !== "unknown") { event.preventDefault(); event.dataTransfer.dropEffect = "move"; } }}
            onDrop={(event) => { event.preventDefault(); const task = draggedTask.current; draggedTask.current = null; if (task) changeStatus(task, lane.id); }}>
            <div className="local-task-column-heading"><span className="local-task-status-dot" /><h2>{lane.label}</h2><span className="local-task-count">{laneTasks.length}</span></div>
            <div className="local-task-cards">
              {laneTasks.map((task) => <article key={`${task.sourceId}:${task.id}`} className="local-task-card" draggable={!changingStatus}
                onDragStart={(event) => { draggedTask.current = task; event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", `${task.sourceId}:${task.id}`); }}
                onDragEnd={() => { draggedTask.current = null; }}>
                <button type="button" className="local-task-card-main" onClick={() => {
                  if (pendingReply.current) return;
                  setSelectedKey(`${task.sourceId}:${task.id}`);
                  setReply("");
                  setReplyNotice(uncertainReplyKeys.includes(`${task.sourceId}:${task.id}`) ? "尚未收到发送回执，结果不确定。请打开所属对话核实；不会自动重发。" : "");
                }} aria-label={`${task.title}，查看详情与回复`}>
                  <div className="local-task-card-top"><span className="local-task-id">{task.id}</span><span className="local-task-raw-status">{task.status || "未标记"}</span></div>
                  <h3>{task.title}</h3>
                  {task.goal && <p className="local-task-goal">{task.goal}</p>}
                  <div className="local-task-badges">
                    {task.role && <span>{task.role}</span>}
                    {(task.projectName || task.projectId) && <span>{task.projectName || task.projectId}</span>}
                    {(task.worktree || task.workspacePath) && <span title={task.worktree || task.workspacePath}>{shortPath(task.worktree || task.workspacePath)}</span>}
                  </div>
                  {task.next && <p className="local-task-next"><span>下一步</span>{task.next}</p>}
                  <div className="local-task-card-footer">
                    <span title={task.dependencies.join("、")}>依赖 {task.dependencies.length} 项</span>
                    <span>查看详情与回复 →</span>
                  </div>
                </button>
                <div className="local-task-provenance" title={task.sourcePath}>来源 · {task.sourceName}</div>
                {(task.evidence.length > 0 || task.acceptance) && <details className="local-task-evidence">
                  <summary>证据与验收{task.evidence.length > 0 && ` · ${task.evidence.length}`}</summary>
                  {task.evidence.map((item, index) => <p key={index}>{item}</p>)}
                  {task.acceptance && <p>验收：{task.acceptance}</p>}
                </details>}
              </article>)}
              {laneTasks.length === 0 && <p className="local-task-empty">{loading && !snapshot ? "正在读取任务契约…" : "暂无任务"}</p>}
            </div>
          </section>;
        })}
      </div>
      <dialog ref={dialogRef} className="local-task-dialog" onClose={() => setSelectedKey("")} onCancel={(event) => { if (sending) event.preventDefault(); }} aria-labelledby="local-task-detail-title">
        {selected ? <>
          <header className="local-task-detail-header">
            <div><span className="local-task-id">{selected.id}</span><h2 id="local-task-detail-title">{selected.title}</h2><p>{taskLane(selected.status).label} · 原始状态：{selected.status || "未标记"}</p></div>
            <button type="button" disabled={sending} onClick={() => dialogRef.current?.close()} aria-label="关闭任务详情">关闭</button>
          </header>
          <div className="local-task-detail-body">
            <section><h3>任务目标</h3><p>{selected.goal || "契约未填写任务目标。"}</p>
              {selected.role && <p>执行角色：{selected.role}</p>}
              {(selected.projectName || selected.projectId) && <p>项目：{selected.projectName || selected.projectId}</p>}
            </section>
            {selected.status === "blocked" && <section className="local-task-attention"><h3>为什么阻塞</h3>
              <p>{selected.blocker || (selected.dependencies.length ? "等待依赖任务；契约未单独填写阻塞原因。" : "契约未填写阻塞原因。")}</p>
              {!selected.interaction?.question && <p>尚未登记需要你决定的问题。阻塞状态本身不代表需要人工回复。</p>}
            </section>}
            <section><h3>下一步</h3><p>{selected.next || "契约未填写下一步。"}</p></section>
            <section><h3>依赖任务</h3>{selected.dependencies.length ? <ul>{selected.dependencies.map((id) => {
              const dependency = selected.dependencyDetails?.find((task) => task.id === id) ?? tasks.find((task) => task.id === id);
              return <li key={id}><strong>{id}</strong> — {dependency ? `${taskLane(dependency.status).label}（${dependency.status}）` : "当前来源未提供该任务的状态"}{dependency?.title && ` · ${dependency.title}`}</li>;
            })}</ul> : <p>未登记依赖。</p>}</section>
            {!!selected.children?.length && <section><h3>内部执行步骤 · {selected.children.length}</h3><p className="local-task-detail-muted">由 Coordinator 管理，不需要你逐项创建或验收；不会改变父任务状态。</p>
              {selected.children.map((child) => <details className="local-task-evidence" key={child.id}><summary>{child.id} · {child.title} · {child.status}</summary>
                <p>{child.goal}</p><p>下一步：{child.next || "未登记"}</p><p>依赖：{child.dependencies.join("、") || "无"}</p>
                {child.acceptance && <p>执行核验记录：{child.acceptance}</p>}{child.evidence.map((e, i) => <p key={i}>{e}</p>)}
              </details>)}
            </section>}
            <section><h3>验收标准</h3>{selected.acceptanceCriteria?.length ? <ul>{selected.acceptanceCriteria.map((item, i) => <li key={i}>{item}</li>)}</ul> : <p>契约未填写独立验收标准。</p>}</section>
            <section><h3>验收记录</h3><p>{selected.acceptance || "尚无验收记录。"}</p><p className="local-task-detail-muted">执行完成、待确认均不表示已经人工验收。</p></section>
            <section><h3>证据</h3>{selected.evidence.length ? <ul className="local-task-evidence-list">{selected.evidence.map((item, i) => {
              const preview = selected.evidencePreviews?.find((entry) => entry.reference === item);
              return <li key={i}><span>{item}</span>{preview && <details className="local-task-evidence-preview"><summary>查看证据内容{preview.truncated && "（节选）"}</summary><pre>{preview.text}</pre>{preview.truncated && <p className="local-task-detail-muted">内容已截断；完整信息请查看原始证据文件。</p>}</details>}</li>;
            })}</ul> : <p>尚无证据路径或结果记录。</p>}</section>
            <section className="local-task-reply"><h3>{selected.interaction?.question ? "需要你的回复" : "补充意见"}</h3>
              <p>{selected.interaction?.question || "当前契约没有登记具体问题；可补充信息或向所属对话询问。"}</p>
              {!!selected.interaction?.options.length && <div className="local-task-reply-options">{selected.interaction.options.map((option) => <button type="button" key={option} disabled={sending} onClick={() => { setReply(option); setReplyNotice(""); }}>{option}</button>)}</div>}
              <label htmlFor="local-task-reply-text">你的回复</label>
              <textarea id="local-task-reply-text" value={reply} disabled={sending} onChange={(event) => { setReply(event.target.value); setReplyNotice(""); }} placeholder="填写决定、验收反馈或补充信息…" rows={4} maxLength={16000} />
              <p className="local-task-detail-muted">发送时附带任务上下文，送至下方保存的所属 session。发送回执仅表示回复已被接收，不会直接改变任务状态或代替验收记录。</p>
              <div className="local-task-detail-actions">
                <button type="button" className="local-task-reply-primary" disabled={!selected.session || !reply.trim() || sending || uncertainReplyKeys.includes(selectedKey)} onClick={() => sendReply(selected)}>{sending ? "发送中…" : "发送回复"}</button>
                <button type="button" disabled={!selected.session || sending} onClick={() => openConversation(selected)}>打开{selected.sessionKind === "coordinator" ? " Coordinator 对话" : "任务对话"} ↗</button>
                {selected.reviewUrl && <button type="button" onClick={() => postEmbeddedHostMessage({ type: "taskboard:open-code-review", payload: { url: selected.reviewUrl } })}>代码审查 ↗</button>}
              </div>
              {replyNotice && <p role="status">{replyNotice}</p>}
              {!selected.session && <p>未保存完整 session 绑定，无法打开所属对话。</p>}
            </section>
            <details className="local-task-detail-source"><summary>来源与对话目的地</summary>
              <p>契约来源：{selected.sourceName}</p><p>{selected.sourcePath}</p>
              {selected.worktree && <p>工作树：{selected.worktree}</p>}
              {selected.workspacePath && <p>Workspace：{selected.workspacePath}</p>}
              <p>对话归属：{selected.sessionKind === "coordinator" ? "来源的 Coordinator（任务没有独立绑定）" : "任务绑定"}</p>
              {selected.session && <><p>Session：{selected.session.threadId}</p><p>Host：{selected.session.codexHostId} · Project：{selected.session.codexProjectId}</p></>}
            </details>
          </div>
        </> : <div className="local-task-detail-body"><h2 id="local-task-detail-title">任务不在当前活动来源中</h2><p>刷新后未找到该任务，已有回复仍保留。请关闭详情查看当前任务。</p><button type="button" onClick={() => dialogRef.current?.close()}>关闭</button></div>}
      </dialog>
      <dialog ref={statusDialogRef} className="local-task-dialog" onClose={() => setStatusConfirmation(null)} aria-labelledby="local-task-status-confirm-title">
        {statusConfirmation && <>
          <header className="local-task-detail-header"><h2 id="local-task-status-confirm-title">确认验收通过</h2></header>
          <div className="local-task-detail-body">
            <p>{statusConfirmation.task.title}</p>
            <>
              <p>确认表示你已核对本任务交付和验收标准。系统会保存你的验收记录，并将任务移到“已验收”。</p>
              {!!statusConfirmation.task.acceptanceCriteria?.length && <ul>{statusConfirmation.task.acceptanceCriteria.map((item, index) => <li key={index}>{item}</li>)}</ul>}
            </>
            <div className="local-task-detail-actions">
              <button type="button" onClick={() => setStatusConfirmation(null)}>取消</button>
              <button type="button" className="local-task-reply-primary" onClick={() => changeStatus(statusConfirmation.task, statusConfirmation.status, true)}>确认验收通过</button>
            </div>
          </div>
        </>}
      </dialog>
      <footer className="local-task-board-footer">只展示最上层任务；内部执行步骤由 Coordinator 管理。{snapshot && <span>显示 {visibleTasks.length} / {tasks.length} 项</span>}</footer>
    </main>
  );
}
