# Codex Local Task Board

Based on dashi-taskboard 1.1.26, upstream commit `6a79ef522238ff11681cb85a9d803d19442a3d00`. Upstream license remains in LICENSE.

The default view displays tasks from explicitly registered local task contracts and active ledgers. Sessions are bindings, not task sources. The original issue view is available at `?view=issues`.

Set `CODEX_SESSION_BOARD_SOURCES` to an absolute local JSON file containing `sources`. Each source has `id`, `name`, absolute `path`, `format` (`contract` or `ledger`), and a complete `session` binding (`threadId`, `codexProjectId`, `codexProjectKind: local`, `codexHostId: local`, absolute `workspacePath`). An optional `archivedTaskIds` array removes selected ledger tasks from the current board without modifying the owning ledger. Keep source configuration and execution records outside Git.

`GET /api/local-tasks` reads these files without modifying them. Contracts use taskId/goal/status; ledgers use schema_version 1/coordinator_thread/tasks with id/target/status. A task's explicit threadBinding takes priority. Ledger tasks without their own binding open the configured Coordinator; the card labels this distinction. Worker names are not session IDs. Raw execution results remain distinct from acceptance.

Cards open a detail dialog with blocker/dependency status, acceptance criteria/results, evidence excerpts and a reply form. The explicit Open Conversation button uses the stored binding through the existing authenticated bridge. Reply sends resolve the task and binding again in the host, validate thread identity/cwd, and steer an active turn or resume/start an idle thread with existing defaults. A receipt means the conversation accepted the reply, not task acceptance. Uncertain sends are not retried automatically. Verify final native navigation and real reply delivery manually in Codex.

The view polls every five seconds and supports project/source/search filters and expandable evidence. Desktop columns share the available width; narrow views scroll horizontally.

Development deliveries create or reuse a GitLab MR (`mergeRequest.url`) or GitHub PR (`pullRequest.url`) in the task contract or ledger item. Task details offer a View PR / MR button that opens the repository website. `scripts/watch-task-merges.mjs` polls linked requests through authenticated gh / glab and applies an explicitly configured merged-task status. See [the delivery contract](docs/local-task-code-review.md).

## Task hierarchy

Only explicit top-level contracts become board cards. Worker ledgers are attached through an optional absolute `childLedgerPath` on the contract source, and appear as internal execution steps in the parent detail. Child completion/review does not change the parent status. The parent owns user interaction and acceptance. The attached ledger must have schema_version 1 and the same coordinator_thread as the saved parent binding.
