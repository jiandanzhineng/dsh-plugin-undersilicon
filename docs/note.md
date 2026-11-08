# dsh-undersilicon note

## 结构（事实）

- `index.js`：`name=undersilicon`、`inject=['tools']`、schemastery `Config`、`apply(ctx, config)`。
  创建 client/audit/watchdog/safety/events/scripts 与 20 个 tool；`ctx.inject(['skills'])` 注册
  `undersilicon-control` skill；`ctx.inject(['connection'])` 挂 `/undersilicon` 面板 RPC；
  `agent/disposed` 停本会话脚本/订阅并按 `stopOnSessionEnd` 停机；dispose 清理定时器与流。
- `src/sdk/client.js`：`ControlPanelClient` 覆盖 devices/capabilities/operations、watchdog、
  stop-all、games/game-runtime、remote-session、client state/window/routes/navigate/screenshot/
  launch、events recent、brands。`classifyMode()` 按 remote status 判 local / remote-operator /
  remote-controlled。`src/sdk/events-stream.js` 解析 SSE（普通 data 帧的 typed hello）。
- `src/safety/`：`ranges.js` 只把强度类字段列入缩放（strength.value、shock.voltage、
  vibration/suction.value、estim.intensity、motors.channels.*、pump.rate）；配置类
  （reportDelay、distance.*、boolean/字符串）不缩放。`scale.js` 百分比上限 =
  `min + (max-min)*pct/100`，结果带 `clamped[]`。`safety.js` 的 raw 通道有 DENY_RULES
  （device message、batch、mqtt-client、serial、wired-flash、firmware、本地 app/plugin/auth 写、
  模型写、设备删除、远程会话生命周期等）。`watchdog.js` 每会话一个 clientId，ttl/2 续租；
  remote-operator 的 423 会停租。`audit.js` 写 `~/.dsh/undersilicon/audit-YYYY-MM-DD.jsonl`，
  token/secret/password 等字段脱敏。
- `src/scripts/`：worker 内 `vm.compileFunction` 编译 agent 代码，host bridge 只在闭包中；
  `codeGeneration:{strings:false,wasm:false}`；仅 JSON 跨域；同步超时、心跳、内存上限、
  并发上限、日志环形 500。`manager.js` 提供 RPC 白名单与持久化恢复。
- `src/events/manager.js`：单条共享 SSE，按 types/deviceId/where 过滤，按 throttleMs 合并，
  inject 用 `agent.inject`、wake 用 `agent.followup`；到达 maxEvents 自动退订并投递汇总。
- `client/client.js`：手写 `window.__ModuleLoader__.load({id, factory})` bundle；注册
  locale、右侧栏 tab 类型与 slots、会话 header 按钮；急停按钮常驻；4s 刷新。
- `mock/server.js`：进程内 mock 后端，支持 `mode` 与 `clientAvailable`，含设备、能力范围、
  远程过滤/423、typed hello SSE、routes titleKey、launch 返回结构、请求日志。

## us-test profile（独立桌面运行时）

位置：`C:\Users\46907\.dsh\profiles\us-test`。只动这个 profile，不要动用户 desktop/web/headless。

- `package.json` 依赖：`"dsh-plugin-undersilicon": "file:./plugin-src"`；`plugin-src` 是指向
  `E:\smart\project\dsh-undersilicon` 的目录 junction（`mklink /J`）。pnpm 10 on Windows 无法
  正确解析跨盘的 `file:E:/...`（会拼成 profile 下的相对路径并 ENOENT，`file:///` 同样失败），
  所以用 profile 内 junction + 相对 `file:`。目录依赖安装出来是复制件，改插件源码后要重跑
  `pnpm install`。安装后 `--dump-config` 应能看到 `undersilicon` 行。
- `cordis.patch.yml`：用户 patch 不能按 id 新增行，必须用 `- insert:`：
  ```yaml
  - insert:
      - id: undersilicon
        name: dsh-plugin-undersilicon
        config:
          baseUrl: http://127.0.0.1:5278/api
          stopOnSessionEnd: true
          scripts: { allowPersist: false }
  ```
- tako provider 配置从 `~/.dsh/profiles/desktop/cordis.patch.yml` 抄到本 profile；key 走
  `apiKeyEnv: TAKO_API_KEY`（`~/.dsh/.env`），仓库内不写 key。默认模型
  `tako/deepseek-v4.1-flash`。
- 本机 tako key 校验失败（401 Invalid token），真实模型调用暂不可验证。临时验证用
  `tmp/mock-overlay.yml` 覆盖 `agent-default-model` 到 `mock/mock-model`（`127.0.0.1:5299`），
  并 `set MOCK_API_KEY=dummy`。
- 启动：`E:\software\dsh\resources\runtime\cli\bin\dsh.cmd --profile us-test --json "..."`；
  加 `--dump-config` 可确认插件行与工具加载。验证命令示例见 `AGENTS.md`。

## 测试

- `npm test` → `node --test --test-concurrency=1 test/*.test.js`，当前 60 项全过。
- 单测覆盖：缩放与上下限、拦截端点、模式切换急停、看门狗续租/423、沙箱逃逸（constructor/
  process/require 均 blocked）、RPC、并发/内存/卡死限制、订阅节流、SDK、tool 集成。
- mock 集成：`test/sdk.test.js`、`test/tools.test.js` 内部 `createMockServer()`；
  独立 mock 后端用 `tmp/run-mock-backend.mjs`（`127.0.0.1:5278`）。

## dsh 0.2.1-rc.3 插件 API 坑

1. **tool 返回值必须 lossless JSON**：dsh-tools 用 `snapshotJsonValue` 校验并 detach；对象里
   有 `undefined`、NaN、Infinity、-0、稀疏数组、class 实例、循环引用都会报
   `value is not lossless JSON`。后端 JSON 本身干净，但插件拼字段时很容易带进 `undefined`
   （如 `where: undefined`、`game.description`）。统一用 `src/tools/helpers.js` 的
   `jsonTool()` / `jsonSafe()`（JSON round-trip，丢 undefined、NaN→null）。
2. **`defineTool` 的 `output.schema = {type:'json'}` 在工具列表里编译成 `{}`**：不要断言
   schema 内容，测 `output.render` 或工具调用结果。
3. **用户 patch 不能新增行**：`cordis.patch.yml` 按 id 覆盖；新增插件必须
   `- insert: [ ... ]`，否则 `patch: entry "undersilicon" not found`。
4. **客户端 bundle 不走构建**：手写 `window.__ModuleLoader__.load`，`package.json` 同时声明
   `dsh.client` 与 `exports['./client']`；slots 名（`sidebar.right.pane.tab` 等）与 locale API
   需与 dsh 客户端版本一致。
5. **截图附件**：先 `ctx.get('llm').resolveModelInfo(provider, model).inputModalities` 判断图像
   能力，再 `attachments.saveImage`；不支持图像时只返回保存路径。
6. **SSE 契约**：hello 是普通 data 帧 `{type:'hello',seq,mode}`；`/events/recent` 直接返回数组；
   纯后端 `client/state` 返回 200 + `available:false`，控制接口 503；`launch` 返回
   `{ok,gameId,mode,started,path,state}`；无令牌 bridge 的 `gameId` 可能为 null；截图首帧可能晚约 1s
   （`delayMs` 默认建议 1000）。
7. **远程模式**：remote-operator 只看到投影设备，watchdog/stop-all 返回 423，急停改走
   `/remote-session/emergency-stop`；不要把它当成本机 stop-all 的成功。

## 未完成/风险

- Tako key 401，真实模型 tool-call 未验证；headless 验证用本地 mock model（45 tools 可见）。
- A 侧真实后端（虚拟设备）联调按协调要求留到后续步骤。
- 侧栏面板 bundle 尚未在真实 dsh web/Electron 客户端里做 UI E2E；设置卡自动生成行为未确认。


