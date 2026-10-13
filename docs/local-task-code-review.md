# 本地开发任务的仓库交付

开发任务使用自己的 Git 分支和工作树。实现与验证完成后，推送该分支，在所属仓库创建或复用 GitLab MR / GitHub PR，并在最上层任务契约保存 `mergeRequest.url` / `pullRequest.url`：

```json
{
  "pullRequest": {
    "url": "https://github.com/owner/project/pull/123"
  }
}
```

任务详情中的“查看 PR / MR”按钮直接打开仓库网页。未关联请求的任务不显示按钮。已有请求继续更新，不重复创建；缺少远端或权限时记录缺失条件，不使用其他项目的链接代替。

## 合入监听

`scripts/watch-task-merges.mjs` 使用本机已登录的 `gh` / `glab` 查询当前登记的最上层任务，不处理内部 Worker ledger。它只读取远端，不合并、不发送评论、不启动开发 session。需选择合入后的状态：

```sh
node scripts/watch-task-merges.mjs \
  --sources /absolute/path/to/task-sources.json \
  --merged-status review \
  --watch --interval 60
```

不传 `--watch` 则只检查一次。`--sources` 也可由 `CODEX_SESSION_BOARD_SOURCES` 提供。

- `review`：合入后进入“待确认”，保留人工验收步骤。
- `done`：仅在用户明确采用“合入即验收”策略时使用；保存该策略的验收记录和 accepted 交付状态。

只有 API 明确返回已合入及合入时间时才写入任务。仍打开、未合入即关闭、认证失败或网络错误都不改变任务状态。写入时记录 `repositorySync` 中的请求地址、平台、合入时间、commit 和状态策略；重新核对任务身份与链接。相同请求的合入结果只应用一次，已验收任务不回退。

监听与看板拖动使用同一任务文件锁，并读取最新契约后原子替换，保留其他任务字段。异常终止留下 `.lock` 目录时，先确认没有写入者，再人工移除该锁；不自动抢占存量锁。
