import path from "node:path";
import { readLocalTaskSources } from "./local-task-sources.mjs";

export function validateLocalTaskReply(request) {
  if (!request || typeof request.requestId !== "string"
    || !/^[a-z0-9-]{1,128}$/i.test(request.requestId)
    || ![request.sourceId, request.taskId].every((value) => typeof value === "string"
      && value.length > 0 && value.length <= 240 && !/[\u0000-\u001f\u007f]/.test(value))
    || typeof request.reply !== "string" || !request.reply.trim()
    || request.reply.length > 16_000 || request.reply.includes("\u0000")) {
    throw new Error("回复需要有效的任务、请求编号和 1 至 16000 字的内容");
  }
  return {
    requestId: request.requestId,
    sourceId: request.sourceId,
    taskId: request.taskId,
    reply: request.reply,
  };
}

function verifyThread(thread, session) {
  if (thread?.id !== session.threadId || typeof thread.cwd !== "string"
    || path.resolve(thread.cwd) !== path.resolve(session.workspacePath)) {
    throw new Error("所属对话与保存的任务工作目录不一致，未发送回复");
  }
}

function activeTurn(thread) {
  return [...(thread.turns || [])].reverse().find((turn) => turn.status === "inProgress");
}

// One operation per request ID, including uncertain outcomes: never retry a send automatically.
export function createLocalTaskReplyHandler({ rpc, readSources = readLocalTaskSources }) {
  const operations = new Map();
  return (value, context, expectedSession) => {
    const request = validateLocalTaskReply(value);
    const identity = JSON.stringify(request);
    const existing = operations.get(request.requestId);
    if (existing) {
      if (existing.identity !== identity) throw new Error("请求编号已用于另一条回复，请勿重复使用");
      return existing.promise;
    }
    const promise = (async () => {
      const sources = await readSources();
      const matches = sources.tasks.filter((task) => task.sourceId === request.sourceId && task.id === request.taskId);
      if (matches.length !== 1) throw new Error("任务已不在当前看板中或任务编号不唯一，未发送回复");
      const task = matches[0];
      const session = task.session;
      if (expectedSession && JSON.stringify(session) !== JSON.stringify(expectedSession)) {
        throw new Error("所属 session 绑定已变化，未发送启动指令");
      }
      if (session?.codexHostId !== "local" || session.codexProjectKind !== "local") {
        throw new Error("任务没有有效的本地对话绑定，未发送回复");
      }
      const call = (method, params) => rpc(session.codexHostId, method, params, context);
      let { thread } = await call("thread/read", { threadId: session.threadId, includeTurns: true });
      verifyThread(thread, session);
      let turn = activeTurn(thread);
      if (!turn) {
        const resumed = await call("thread/resume", { threadId: session.threadId });
        thread = resumed.thread;
        verifyThread(thread, session);
        turn = activeTurn(thread);
      }
      const text = [
        "用户在本地任务看板中提交的回复：",
        `任务编号：${task.id}`,
        `任务标题：${String(task.title).slice(0, 2000)}`,
        `当前状态：${task.status}`,
        `当前问题：${String(task.interaction?.question || task.blocker || task.next || "未提供具体问题").slice(0, 8000)}`,
        "",
        "用户回复：",
        request.reply,
      ].join("\n");
      const input = [{ type: "text", text }];
      try {
        const result = turn
          ? await call("turn/steer", { threadId: session.threadId, expectedTurnId: turn.id, input })
          : await call("turn/start", { threadId: session.threadId, input });
        const turnId = turn ? result?.turnId : result?.turn?.id;
        if (typeof turnId !== "string" || !turnId) throw new Error("Codex 未返回回复回执");
        return { threadId: session.threadId, turnId };
      } catch (error) {
        error.threadId = session.threadId;
        error.uncertain = true;
        throw error;
      }
    })();
    operations.set(request.requestId, { identity, promise });
    return promise;
  };
}
