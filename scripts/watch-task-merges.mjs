#!/usr/bin/env node
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout } from "node:timers/promises";
import { readLocalTaskSources } from "../server/local-task-sources.mjs";
import { updateLocalTaskContract } from "../server/local-task-contract.mjs";

import { taskTransition } from "../server/local-task-state.mjs";

const execute = promisify(execFile);

export function repositoryRequest(rawUrl) {
  const url = new URL(rawUrl);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password
    || url.search || url.hash || url.port) throw new Error("Invalid repository request URL");
  const mr = url.pathname.match(/^\/(.+)\/-\/merge_requests\/([1-9]\d*)\/?$/);
  const pr = url.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/([1-9]\d*)\/?$/);
  if (mr) return { provider: "gitlab", hostname: url.hostname,
    endpoint: `projects/${encodeURIComponent(mr[1])}/merge_requests/${mr[2]}` };
  if (pr) return { provider: "github", hostname: url.hostname,
    endpoint: `repos/${pr[1]}/${pr[2]}/pulls/${pr[3]}` };
  throw new Error("Expected a GitHub PR or GitLab MR URL");
}

export async function readRepositoryMerge(url, run = execute) {
  const request = repositoryRequest(url);
  const { stdout } = await run(request.provider === "github" ? "gh" : "glab",
    ["api", "--hostname", request.hostname, request.endpoint],
    { timeout: 20_000, maxBuffer: 2 * 1024 * 1024 });
  const data = JSON.parse(stdout);
  const merged = request.provider === "github" ? data.merged === true : data.state === "merged";
  if (!merged) return null;
  if (typeof data.merged_at !== "string" || !Number.isFinite(Date.parse(data.merged_at))) {
    throw new Error("Merged request has no valid merged_at");
  }
  return { provider: request.provider, url, state: "merged", mergedAt: data.merged_at,
    commit: data.merge_commit_sha || data.sha || null };
}

export async function recordTaskMerge(task, merge, mergedStatus) {
  if (!["review", "done"].includes(mergedStatus)) throw new Error("Choose merged status: review or done");
  let changed = false;
  await updateLocalTaskContract(task.sourcePath, task.id, (current) => {
    const currentUrl = current.mergeRequest?.url || current.pullRequest?.url;
    if (currentUrl !== merge.url || current.status === "done"
      || current.repositorySync?.url === merge.url && current.repositorySync?.state === "merged") return null;
    changed = true;
    const recordedAt = new Date().toISOString();
    return {
      status: taskTransition("repository-merged", mergedStatus),
      repositorySync: { ...merge, recordedAt, mergedStatus },
      statusChange: { requestedAt: recordedAt, status: mergedStatus, kind: "repository-merged" },
      ...(mergedStatus === "done" ? {
        acceptance: current.acceptance || `按用户配置，${merge.url} 于 ${merge.mergedAt} 合入，任务自动验收。`,
        userAcceptance: { state: "accepted", acceptedAt: recordedAt, via: "repository-merge-policy", url: merge.url },
        delivery: { ...current.delivery, state: "accepted" },
      } : {}),
    };
  });
  return changed;
}

export async function syncTaskMerges({ sources, mergedStatus, readMerge = readRepositoryMerge }) {
  const snapshot = await readLocalTaskSources(sources);
  const results = [];
  for (const source of snapshot.sources) {
    if (source.error) results.push({ sourceId: source.id, error: source.error });
  }
  for (const task of snapshot.tasks) {
    if (!task.reviewUrl || task.status === "done") continue;
    try {
      const merge = await readMerge(task.reviewUrl);
      if (merge && await recordTaskMerge(task, merge, mergedStatus)) {
        results.push({ taskId: task.id, url: task.reviewUrl, status: mergedStatus, mergedAt: merge.mergedAt });
      }
    } catch (error) {
      results.push({ taskId: task.id, error: error.message });
    }
  }
  return results;
}

async function main() {
  const args = process.argv.slice(2);
  let sources = process.env.CODEX_SESSION_BOARD_SOURCES;
  let mergedStatus;
  let watch = false;
  let interval = 60;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--sources") sources = args[++i];
    else if (args[i] === "--merged-status") mergedStatus = args[++i];
    else if (args[i] === "--interval") interval = Number(args[++i]);
    else if (args[i] === "--watch") watch = true;
    else throw new Error(`Unknown argument: ${args[i]}`);
  }
  if (!sources || !path.isAbsolute(sources) || !["review", "done"].includes(mergedStatus)
    || !Number.isInteger(interval) || interval < 5) {
    throw new Error("Usage: watch-task-merges.mjs --sources ABSOLUTE_PATH --merged-status review|done [--watch] [--interval SECONDS]");
  }
  const controller = new AbortController();
  process.once("SIGTERM", () => controller.abort());
  process.once("SIGINT", () => controller.abort());
  do {
    for (const result of await syncTaskMerges({ sources, mergedStatus })) console.log(JSON.stringify(result));
    if (!watch || controller.signal.aborted) break;
    try { await setTimeout(interval * 1000, undefined, { signal: controller.signal }); }
    catch (error) { if (error.name !== "AbortError") throw error; }
  } while (!controller.signal.aborted);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
