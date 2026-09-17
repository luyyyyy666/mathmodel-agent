# Mathmodel Agent

数模 Agent 的后端核心。当前实现以一个有明确验收标准的建模任务为运行单位，
提供项目、持久化执行尝试、Codex App Server 适配、执行审批、取消、恢复核对、
结果人工验收和可补读的业务事件。前端目录尚未接入业务界面。

本服务使用自行构建的 Codex 源码产物，通过本地 stdio JSON-RPC 通信。
运行数据由 Mathmodel Agent 保存，Codex 会话历史由独立的 Codex 数据目录保存。
不依赖终端文本解析，也不会退回全局安装的官方可执行程序。

## 实现位置

- `contracts/v2/core.schema.json`：可执行的业务契约，运行时使用标准 JSON Schema 验证器。
- `contracts/v2/README.md`：命令、读取接口、状态机和恢复语义。
- `server/contracts.mjs`：校验、错误与幂等命令规范化。
- `server/store.mjs`：SQLite 事务、运行状态、事件和幂等回执。
- `server/codex.mjs`：App Server 子进程、RPC、执行请求和审批回复。
- `server/service.mjs`：业务状态机、执行生命周期与恢复核对。
- `server/http.mjs`：带认证的本机 HTTP API。
- `server/main.mjs`：启动、源码产物校验、目录锁和退出清理。
- `contracts/v1/`：保留的早期候选契约；当前服务不实现 v1 API。

## 启动

需要 Node.js 24.19.0 或更新版本，以及从产品 Codex 分支生成的本机可执行程序。
独立构建工作区提供 build-runtime 脚本，构建成功后输出 runtime.json 登记文件，
其中包含源码提交、可执行文件绝对路径及 SHA-256。登记是本机构建追溯记录，
不是发布者签名或供应链认证。

先安装锁定的应用依赖：

```sh
npm ci --ignore-scripts
```

在仓库外准备服务 JSON 配置，填入本机绝对路径：

```json
{
  "data_directory": "/absolute/private/mathmodel-agent-data",
  "runtime_registration": "/absolute/build/runtime.json",
  "codex_home": "/absolute/private/mathmodel-agent-codex",
  "port": 18089
}
```

数据目录和 Codex 目录需由当前用户拥有，权限为 0700。目录不存在时由服务创建。
服务不会读取聊天中的密钥。通过环境变量 MATHMODEL_AGENT_TOKEN 设置长度至少 32 字符的
随机访问令牌；不要把令牌写入源码、提交或日志。使用源码构建的 Codex 在同一个
codex_home 完成登录或配置模型供应方，再启动任务。安装依赖和健康检查本身不调用模型。

```sh
npm start -- --config /absolute/service.json
```

服务只监听 127.0.0.1。所有请求，包括健康检查，都需要 Bearer 令牌；带 Origin
的浏览器请求被拒绝。这里暂未提供浏览器接入策略、多人账户或远程访问。
本机调用方式见 `contracts/v2/README.md`。

每个项目的可写工作区位于服务数据目录的 workspaces 子目录，名称为 project_id。
可在任务开始前把题目和数据放入该目录。当前没有上传接口或产物导出 API。

## 已实现的可靠性边界

- 业务状态、顺序事件和幂等回执在同一 SQLite 事务内写入。
- 修改已有运行需要 expected_version；重复键不同内容返回冲突。
- 同时最多一个执行；未核对的中断也会占用调度条件，避免不明副作用被重复执行。
- 每次尝试创建独立 Codex 会话；重试保留历史尝试和事件。
- Codex 正常结束进入 awaiting_review，用户验收后才进入 completed。
- 取消 RPC 返回不等于进程已停止，收到终态通知才确认结果。
- 断连、启动超时、审批回复不确定或异常退出进入 recovery_required，不自动重发推理请求。
- reconcile_run 只读取已保存的会话历史；仅确认终态，不能证明的状态继续等待人工排查。
- 未支持的交互请求会返回明确错误并停止本次连接，不会默认批准。

异常退出可能留下数据目录锁。先确认旧服务及其执行进程已经结束，再由操作者
移除数据目录中的 .daemon-lock。服务不会根据一个可能复用的 PID 擅自删除锁。
正常退出会等待子进程结束后释放锁。

## 验证

```sh
npm test
node tools/verify-spec-consistency.mjs
node tools/verify-doc-facts.mjs
node tools/verify-test-coverage-policy.mjs
node tools/build-content-manifest.mjs --check
npm run verify:format
node tools/verify-gate-baselines.mjs
```

应用测试使用临时 SQLite 数据库和独立的协议模拟子进程，不消费模型额度。
它们覆盖业务状态及 JSON-RPC 交互，不代表真实模型已解出数模题。
真实源码构建、握手与模型调用是不同的验证层，应分别记录结果。

原有治理工具仍位于 `lib/`、`tools/`、`governance/` 与 `docs/standards/`。
覆盖映射跳过测试夹具目录，其行为由适配器和服务测试实际执行。
CI 已改为 Node.js 24，并在应用测试前安装锁定依赖；在线安装失败不表示离线门禁失败。
云端 CI 的当前执行结果未在本轮查询，不沿用历史快照作为当前成功证据。

## 当前范围

这一版是可运行的后端核心，不是完整数模产品。尚未实现任务 DAG、科学结果自动验收、
数据与产物版本存储、实验环境重现、多 Agent 调度、预算结算和完整交付打包。
运行过程中目前支持命令与文件修改的单次执行审批；工具问答、MCP elicitation 等
其他交互尚不支持。业务契约 v2 仍处于本地开发阶段，未向前端发布兼容性承诺。

实施范围与用户授权背景记录在 `docs/implementation/core-scope.md`。
