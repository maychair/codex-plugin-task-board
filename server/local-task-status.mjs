import { readFile, writeFile, rename } from "node:fs/promises";
import { readLocalTaskSources } from "./local-task-sources.mjs";
import { createLocalTaskReplyHandler, validateLocalTaskReply } from "./local-task-reply.mjs";

const statuses = ["ready", "running", "blocked", "review", "completed", "failed", "done"];
const sixCases = ["M01", "M02", "M03", "M04", "M05", "M06"];

function accepted(task) {
  if (task.delivery?.state === "accepted") return true;
  const record = task.acceptanceRecord ?? task.acceptance;
  if (typeof record === "string") return !!record.trim();
  if (Array.isArray(record)) return record.some((entry) => typeof entry === "string" && !!entry.trim());
  return record?.state === "accepted" || record?.status === "accepted" || record?.accepted === true;
}

function usable(task) {
  return task.status === "done" ? accepted(task)
    : task.status === "completed" && ["accepted", "usable"].includes(task.delivery?.state);
}

// These are the existing Qwen contracts' authorization clauses, not a general
// parser for arbitrary release conditions. Unknown closed gates remain closed.
function dragOpensAuthorization(gate) {
  if (gate?.kind === "substantive") return false;
  if (gate?.kind === "authorization") return true;
  return gate?.currentStage === "只读接管已结束" && [
    "在本任务的后续执行阶段被明确开放、所需输入和资源具备后开始。",
    "全部依赖交付被验收，且后续模块验证阶段开放、固定输入与资源就绪后开始。",
    "M01～M06 全部验收通过，且原计划要求的实施门槛开放后开始。",
  ].includes(gate.releaseCondition);
}
export function validateLocalTaskStatus(value) {
  validateLocalTaskReply({ ...value, reply: "status" });
  if (!statuses.includes(value.status)) throw new Error("任务状态请求无效");
  if (value.confirmAcceptance !== undefined && typeof value.confirmAcceptance !== "boolean") throw new Error("验收确认无效");
  return { requestId: value.requestId, sourceId: value.sourceId, taskId: value.taskId, status: value.status, confirmAcceptance: value.confirmAcceptance === true };
}

export function createLocalTaskStatusHandler({ rpc, readSources = readLocalTaskSources }) {
  const reply = createLocalTaskReplyHandler({ rpc, readSources });
  const operations = new Map();
  let writes = Promise.resolve();
  return (value, context) => {
    const request = validateLocalTaskStatus(value);
    const identity = JSON.stringify(request);
    const previous = operations.get(request.requestId);
    if (previous) {
      if (previous.identity !== identity) throw new Error("状态请求编号已被使用");
      return previous.promise;
    }
    const promise = writes.then(async () => {
      const snapshot = await readSources();
      const matches = snapshot.tasks.filter((t) => t.id === request.taskId && t.sourceId === request.sourceId);
      if (matches.length !== 1) throw new Error("未找到唯一的已登记任务");
      const task = matches[0];
      let document = JSON.parse(await readFile(task.sourcePath, "utf8"));
      if (document.taskId !== task.id) throw new Error("任务 contract 身份已变化");
      const save = async (updates) => {
        const current = JSON.parse(await readFile(task.sourcePath, "utf8"));
        if (current.taskId !== task.id) throw new Error("任务 contract 身份已变化");
        const temporary = `${task.sourcePath}.${request.requestId}.tmp`;
        document = { ...current, ...updates };
        await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
        await rename(temporary, task.sourcePath);
      };
      if (request.status !== "running") {
        if (request.status === "done") {
          if (!request.confirmAcceptance && !accepted(document)) throw new Error("请在看板内确认验收后再移到已验收");
          const acceptedAt = new Date().toISOString();
          await save({ status: "done", blocker: "",
            ...(request.confirmAcceptance ? {
              acceptance: document.acceptance || `用户于 ${acceptedAt} 在本地任务看板确认验收通过。`,
              userAcceptance: { state: "accepted", acceptedAt, via: "board-drag-confirmation", requestId: request.requestId, taskId: task.id, sourceId: task.sourceId, threadId: task.session.threadId },
              delivery: { ...document.delivery, state: "accepted" },
            } : {}),
            statusChange: { requestedAt: acceptedAt, status: "done", kind: request.confirmAcceptance ? "user-acceptance" : "user-record-only" },
          });
          return { status: "done", notice: "已保存你的验收确认，任务已移到已验收。" };
        }
        await save({ status: request.status, statusChange: { requestedAt: new Date().toISOString(), status: request.status, kind: "user-record-only" } });
        return { status: request.status, notice: "已更新任务记录；未停止 session，未生成执行结果或验收证据。" };
      }
      if (document.startDispatch && (document.startDispatch.state !== "received" || document.status === "running")) {
        return { status: document.status, notice: "已有启动记录；请打开所属对话核实。本次未重复启动。" };
      }
      const authorization = {
        kind: "board-drag", requestId: request.requestId, taskId: task.id,
        sourceId: task.sourceId, threadId: task.session.threadId,
        authorizedAt: new Date().toISOString(), scope: document.scope || task.goal,
      };
      const requiresSixCases = /M01[～~-]M06\s*全部验收/.test(`${document.executionGate?.releaseCondition || ""} ${document.blocker || ""}`)
        || sixCases.every((id) => document.executionGate?.requiredAcceptedTasks?.includes(id));
      await save({ executionAuthorization: authorization,
        ...(requiresSixCases ? { executionGate: { ...document.executionGate, requiredAcceptedTasks: sixCases } } : {}),
      });
      const blockers = [];
      for (const id of task.dependencies) {
        const dependencies = snapshot.tasks.filter((t) => t.id === id);
        if (dependencies.length !== 1) { blockers.push(`${id}：依赖缺失或编号不唯一`); continue; }
        const dependency = dependencies[0];
        if (!usable(dependency)) {
          blockers.push(`${id}：状态 ${dependency.status}，需已验收，或执行完成且交付明确 accepted / usable`);
        }
      }
      const gate = document.executionGate;
      if (requiresSixCases) {
        for (const id of sixCases) {
          const matches = snapshot.tasks.filter((t) => t.id === id);
          if (matches.length !== 1 || !["done", "completed"].includes(matches[0].status) || !accepted(matches[0])) {
            blockers.push(`基础六例门槛：${id} 尚无完整交付验收`);
          }
        }
      }
      if (gate?.inputsReady === false || gate?.resourcesReady === false) {
        blockers.push(`输入或资源尚未就绪：${gate.reason || gate.releaseCondition || "需任务负责人确认"}`);
      }
      if (gate && gate.state !== "open" && !dragOpensAuthorization(gate)) {
        blockers.push(`实质执行门槛未开放：${gate.reason || gate.releaseCondition || gate.state}`);
      }
      if (blockers.length) {
        await save({ status: "blocked", blocker: blockers.join("；") });
        return { status: "blocked", notice: blockers.join("；") };
      }
      const dispatch = { requestId: request.requestId, state: "pending", requestedAt: new Date().toISOString(), threadId: task.session.threadId };
      await save({ status: "blocked", blocker: "正在等待绑定 session 的启动回执", startDispatch: dispatch,
        ...(gate && dragOpensAuthorization(gate) ? { executionGate: { ...gate, state: "open", releaseEvidence: authorization } } : {}),
      });
      const instruction = [
        "用户已在本地任务看板将本任务拖到进行中，授权本任务范围内的后续执行。",
        `任务目标：${task.goal}`, `工作树 / 范围：${task.worktree || task.workspacePath}`,
        `明确范围：${JSON.stringify(document.scope || "以任务目标和验收标准为边界")}`,
        `验收标准：\n${task.acceptanceCriteria.join("\n")}`,
        ...(["feature", "fix", "refactor"].includes(document.changeType) ? [
          "开发交付：实现并验证后，在任务所属仓库创建或复用本任务审查请求。GitLab 使用 MR，并保存任务契约 mergeRequest.url；GitHub 使用 PR，并保存 pullRequest.url，供用户在 Codex 原生代码审查中检查。缺少远端或发布权限时登记缺失条件；不得用其他项目的审查请求代替，不自动合并或标记验收。",
        ] : []),
        `既有实质条件：${gate?.releaseCondition || "遵守合同中其他执行条件"}。本次拖动授予执行权限，不证明输入和资源已就绪；执行前仍需核实。`,
        `下一步：${task.next}`, "现在开始或继续执行以上绑定任务。遵守项目规则及其他实质执行门槛；不得扩展范围，不得自行标记已验收。",
      ].join("\n");
      try {
        const receipt = await reply({ ...request, reply: instruction }, context, task.session);
        await save({ status: "running", blocker: "", startDispatch: { ...dispatch, state: "received", ...receipt } });
        return { status: "running", ...receipt, notice: "启动指令已由绑定 session 接收。" };
      } catch (error) {
        await save({ status: "blocked", blocker: `${error.uncertain ? "启动结果不确定" : "启动失败"}：${error.message}；请打开所属对话核实，不会自动重发。`, startDispatch: { ...dispatch, state: error.uncertain ? "uncertain" : "failed", error: error.message } });
        throw error;
      }
    });
    writes = promise.catch(() => {});
    operations.set(request.requestId, { identity, promise });
    return promise;
  };
}
