export const taskStatuses = ["ready", "running", "blocked", "review", "completed", "failed", "done"];

export function accepted(task) {
  if (task.delivery?.state === "accepted") return true;
  const record = task.acceptanceRecord ?? task.acceptance;
  if (typeof record === "string") return !!record.trim();
  if (Array.isArray(record)) return record.some((entry) => typeof entry === "string" && !!entry.trim());
  return record?.state === "accepted" || record?.status === "accepted" || record?.accepted === true;
}

export function usable(task) {
  return task.status === "done" ? accepted(task)
    : task.status === "completed" && ["accepted", "usable"].includes(task.delivery?.state);
}

// Event targets are shared by board changes, dependency wakeups and merge sync.
export function taskTransition(event, requestedStatus) {
  const targets = {
    "dependencies-blocked": "blocked",
    "start-requested": "blocked",
    "start-received": "running",
    "start-failed": "blocked",
    "user-acceptance": "done",
  };
  if (["user-record-only", "repository-merged"].includes(event)) {
    if (!taskStatuses.includes(requestedStatus)
      || event === "repository-merged" && !["review", "done"].includes(requestedStatus)) {
      throw new Error("任务状态转换无效");
    }
    return requestedStatus;
  }
  if (!targets[event]) throw new Error("未知任务状态事件");
  return targets[event];
}

export function dependenciesReady(task, tasks) {
  return task.dependencies.length > 0 && task.dependencies.every((id) => {
    const matches = tasks.filter((dependency) => dependency.id === id);
    return matches.length === 1 && usable(matches[0]);
  });
}
