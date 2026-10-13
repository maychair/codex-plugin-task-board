import { readFile, stat } from "node:fs/promises";
import path from "node:path";

function localSession(value) {
  if (!value || typeof value.threadId !== "string" || !value.threadId
    || typeof value.codexProjectId !== "string" || !value.codexProjectId
    || value.codexProjectKind !== "local" || value.codexHostId !== "local"
    || typeof value.workspacePath !== "string" || !path.isAbsolute(value.workspacePath)) {
    throw new Error("A source requires an explicit device-local session binding");
  }
  return {
    threadId: value.threadId,
    codexProjectId: value.codexProjectId,
    codexProjectKind: value.codexProjectKind,
    codexHostId: value.codexHostId,
    workspacePath: value.workspacePath,
  };
}

function strings(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}

function taskFromSource(task, source, session, format) {
  const ledger = format === "ledger";
  const id = ledger ? task.id : task.taskId;
  const goal = (ledger ? task.target : task.goal) || "";
  if (typeof id !== "string" || !id
    || typeof task.status !== "string" || !task.status) {
    throw new Error("Task must contain an id and raw status");
  }
  const binding = task.threadBinding === undefined ? session : localSession(task.threadBinding);
  const acceptance = task.acceptance;
  const interaction = task.interaction;
  return {
    id,
    title: task.title || goal || id,
    status: task.status,
    goal,
    role: task.role || "",
    projectId: (ledger ? task.repo : task.projectId) || "",
    projectName: task.projectName || (ledger ? task.repo : task.projectId) || "",
    workspacePath: task.workspacePath || binding.workspacePath,
    worktree: (ledger ? task.worktree : task.checkout) || "",
    dependencies: strings(task.dependencies),
    evidence: strings(task.evidence),
    next: task.next || "",
    blocker: task.blocker || task.blockedReason || "",
    acceptanceCriteria: strings(task.acceptanceCriteria),
    delivery: task.delivery && { state: task.delivery.state },
    reviewUrl: task.mergeRequest?.url || task.pullRequest?.url || "",
    acceptanceRecord: task.acceptance,
    startDispatch: task.startDispatch,
    interaction: interaction && typeof interaction.question === "string"
      ? { question: interaction.question, options: strings(interaction.options) } : null,
    session: binding,
    sessionKind: task.threadBinding === undefined && ledger ? "coordinator" : "task",
    sourceId: source.id,
    sourceName: source.name,
    sourcePath: source.path,
    ...(acceptance ? { acceptance: Array.isArray(acceptance) ? strings(acceptance).join("\n") : String(acceptance) } : {}),
  };
}

export async function readLocalTaskSources(configPath = process.env.CODEX_SESSION_BOARD_SOURCES) {
  const result = { tasks: [], sources: [], updatedAt: new Date().toISOString() };
  let config;
  try {
    if (!configPath || !path.isAbsolute(configPath)) {
      throw new Error("CODEX_SESSION_BOARD_SOURCES must name an absolute local source configuration file");
    }
    config = JSON.parse(await readFile(configPath, "utf8"));
    if (!Array.isArray(config.sources)) throw new Error("Source configuration must contain a sources array");
  } catch (error) {
    result.sources.push({ id: "configuration", name: "Local task source configuration", path: configPath || "", error: error.message });
    return result;
  }

  for (const configured of config.sources) {
    const source = { id: configured?.id || "", name: configured?.name || "", path: configured?.path || "" };
    result.sources.push(source);
    try {
      if (!source.id || !source.name || !path.isAbsolute(source.path)) {
        throw new Error("Source requires an id, name and absolute file path");
      }
      const session = localSession(configured.session);
      if (configured.format !== "ledger" && configured.format !== "contract") {
        throw new Error("Source format must be ledger or contract");
      }
      let text = await readFile(source.path, "utf8");
      // The active ledger writer currently appends one literal backslash-n.
      if (configured.format === "ledger" && text.endsWith("\\n")) text = text.slice(0, -2);
      const document = JSON.parse(text);
      if (configured.format === "ledger") {
        if (document.schema_version !== 1 || !Array.isArray(document.tasks)) {
          throw new Error("Ledger requires schema_version 1 and a tasks array");
        }
        if (document.coordinator_thread !== session.threadId) {
          throw new Error("Ledger coordinator_thread does not match the configured session binding");
        }
        throw new Error("主看板只接受最上层 task contract；Worker ledger 请作为 childLedgerPath 登记");
      } else {
        const parent = taskFromSource(document, source, session, "contract");
        parent.children = [];
        if (configured.childLedgerPath) {
          if (!path.isAbsolute(configured.childLedgerPath)) throw new Error("childLedgerPath must be absolute");
          let childText = await readFile(configured.childLedgerPath, "utf8");
          if (childText.endsWith("\\n")) childText = childText.slice(0, -2);
          const ledger = JSON.parse(childText);
          if (ledger.schema_version !== 1 || !Array.isArray(ledger.tasks)
            || ledger.coordinator_thread !== session.threadId) throw new Error("Child ledger must belong to the parent Coordinator");
          const childSource = { ...source, path: configured.childLedgerPath };
          parent.children = ledger.tasks.map((task) => taskFromSource(task, childSource, session, "ledger"));
        }
        result.tasks.push(parent);
      }
    } catch (error) {
      source.error = error.message;
    }
  }
  for (const task of result.tasks) {
    task.evidencePreviews = [];
    for (const reference of task.evidence.slice(0, 6)) {
      if (!/\.(md|json|txt)$/.test(reference)) continue;
      const candidates = path.isAbsolute(reference) ? [reference] : [
        path.resolve(path.dirname(task.sourcePath), reference),
        path.resolve(task.session.workspacePath, reference),
      ];
      for (const filename of candidates) {
        try {
          const metadata = await stat(filename);
          if (!metadata.isFile() || metadata.size > 65536) continue;
          const text = await readFile(filename, "utf8");
          task.evidencePreviews.push({ reference, text: text.slice(0, 6000), truncated: text.length > 6000 });
          break;
        } catch { /* A missing evidence pointer remains visible in the card. */ }
      }
    }
  }
  return result;
}
