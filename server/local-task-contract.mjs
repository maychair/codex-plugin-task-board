import { mkdir, readFile, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";

// Shared by the native status writer and the repository listener process.
export async function updateLocalTaskContract(filename, taskId, update) {
  const lock = `${filename}.lock`;
  const deadline = Date.now() + 5000;
  for (;;) {
    try { await mkdir(lock, { mode: 0o700 }); break; }
    catch (error) {
      if (error.code !== "EEXIST" || Date.now() >= deadline) throw error;
      await setTimeout(50);
    }
  }
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    const current = JSON.parse(await readFile(filename, "utf8"));
    if (current.taskId !== taskId) throw new Error("任务 contract 身份已变化");
    const updates = await update(current);
    if (!updates) return current;
    const next = { ...current, ...updates };
    await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, filename);
    return next;
  } finally {
    await unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; });
    await rmdir(lock);
  }
}
