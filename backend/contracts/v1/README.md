# Workflow contract v1 (Mathmodel Agent candidate)

这是一份供 Mathmodel Agent 后端实现使用的数模 Agent 工作流候选契约。它参考了数模阶段化产物和可恢复执行记录的设计，但不复制任何外部仓库的源码、路由或数据库结构。

当前版本只在 Mathmodel Agent 侧落地，Theia 尚未绑定这份契约。待前端方案确定后，双方应各自保存内容完全一致的版本包，并通过版本断言钉住兼容范围。

## 文件

- `run.schema.json`：一次工作流运行及其可恢复状态。
- `step-attempt.schema.json`：一个步骤的一次尝试；重试应创建更大的 `attempt`，不能覆盖历史尝试。
- `artifact-version.schema.json`：带内容哈希和输入依赖的产物版本。
- `checkpoint.schema.json`：等待用户动作的人工检查点。
- `event-envelope.schema.json`：实时事件和断线补读使用的事件信封。
- `error.schema.json`：跨接口传递的结构化错误。
- `commands/command.schema.json`：`create_run`、`approve_checkpoint`、`retry_step`、`cancel_run` 四种写命令。

所有时间使用 RFC3339 字符串，内容哈希使用 `sha256:` 加 64 位小写十六进制字符，产物路径是工作区内的相对正斜杠路径。所有写命令都必须带调用方生成的 `idempotency_key`，服务端应按命令类型和该键保证重复提交不会产生第二个副作用。

## 事件和恢复

同一个 `run_id` 的事件 `sequence` 从 1 开始严格递增。客户端保存最后一个已应用的序号；建立连接后先读取 `GET /runs/{id}` 快照，再用 `GET /runs/{id}/events?after=<sequence>` 补齐缺失事件，去重后再订阅实时事件。WebSocket 连接本身不是状态来源。

`contract_version` 当前固定为 `v1`。向后兼容的可选字段或新事件类型应发布为兼容的小版本说明；改变 required 字段、枚举语义、路径语义或事件序列规则属于破坏性变更，必须先由两侧各自完成 ADR，再发布新的主版本。

## 校验范围

仓库没有引入第三方 JSON Schema 实现。`tests/contracts/v1.test.mjs` 使用 Node 内建模块提供一个仅覆盖本批 schema 所用关键字的最小校验器：`type`、`required`、`properties`、`additionalProperties`、`enum`、`const`、`pattern`、数值/长度限制、`items`、`uniqueItems`、`oneOf` 和相对 `$ref`。它不是完整的 Draft 2020-12 验证器；生产服务仍应使用经过选型和单独评估的标准实现。
