# dsh-plugin-undersilicon

DeepSeek Harness (dsh) 插件，让 agent 检查/控制本机「硅基之下控制中心」PC 客户端。
后端地址默认 `http://127.0.0.1:5278/api`，只允许 loopback。

## 必读

- 工作区规则：`E:\smart\AGENTS.md`（回复末尾「喵~」、中文、临时文件放 `tmp/`）。
- 方案与契约：`E:\smart\project\worktrees\control-panel-agent-control\docs\plans\dsh-agent-plugin.md`。
- 本仓详情：`docs/note.md`；安装与安全说明：`README.md`。

## 结构

- `index.js`：cordis 插件入口、Config schema、生命周期清理、可选 skill/面板挂载。
- `src/sdk/`：HTTP 客户端（loopback 校验）、SSE 事件流、模式识别。
- `src/safety/`：百分比缩放（只作用于强度字段）、看门狗、急停、审计、原始请求拦截。
- `src/tools/`：7 个文件共 20 个 tool。
- `src/scripts/`：`worker_threads` + `vm` 沙箱与脚本管理。
- `src/events/`：共享 SSE 流、过滤/节流、inject/wake 投递。
- `client/`：手写 `window.__ModuleLoader__` 前端 bundle（右侧栏页签）。
- `mock/`：本地 mock 后端（单测与 headless 验证用）。

## 命令

```bash
npm install
npm test          # node:test，串行
node mock/server.js   # 或 node test/... 内部自起；独立 mock 见 docs/note.md
```

headless 验证（独立 profile `us-test`，不碰用户 desktop/web/headless）：

```bash
E:\software\dsh\resources\runtime\cli\bin\dsh.cmd --profile us-test --json "查一下设备"
```

临时覆盖模型走本地 mock（`tmp/mock-overlay.yml` 与 `tmp/mock-model.mjs`，均被 gitignore）：

```bash
set MOCK_API_KEY=dummy && E:\software\dsh\resources\runtime\cli\bin\dsh.cmd --profile us-test --patch tmp\mock-overlay.yml --json "TOOL:device_control"
```

## 约束

- 禁止把 API key 写入仓库或回复；密钥只从 `~/.dsh` 环境读取。
- 安全语义不得弱化：所有控制入口必须经过 safety（缩放/看门狗/审计）。
- 单次文件改动 ≤50 行；长文件分段编辑。
- 不推远端、不发布 npm。
