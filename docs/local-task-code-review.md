# 本地开发任务的代码审查交付

开发任务使用自己的 Git 分支和工作树。实现与直接验证完成后，将该分支推送到任务所属的仓库，GitLab 创建或复用同一任务的 MR，并在原始任务契约（或 ledger 条目）保存：

```json
{
  "mergeRequest": {
    "url": "https://gitlab.example.com/group/project/-/merge_requests/123"
  }
}
```

GitHub 仓库同样创建或复用 PR，保存 `pullRequest.url`。

MR / PR 应指向实际开发分支及约定的目标分支，描述包含问题、最终行为和验证结果。已有 MR 应继续更新，不重复创建。没有对应远端或发布权限时，记录缺失条件并等待补齐，不创建虚假的审查链接。

任务详情中的“代码审查”按钮读取 MR / PR 字段，经已有的受认证 iframe 通道，调用 Codex 的 `navigate-to-route` 消息，打开左侧“代码审查”的 `/mcp-app/code-review/pull_requests.open` 路由，以 `pullRequest` hash 参数选中 MR / PR。Codex 原生插件负责对应平台账号、访问权限、差异和审查操作。

打开审查只导航，不发送开发指令、不创建 MR、不合并、不写验收结果。审查与用户验收仍是各自的步骤。未关联 MR / PR 的任务不显示此按钮。
