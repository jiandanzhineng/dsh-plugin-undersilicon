# dsh-undersilicon note

## 结构（事实）

- `index.js`：`name=undersilicon`、`inject=['tools']`、schemastery `Config`、`apply(ctx, config)`。
  创建 settings/audit/watchdog/safety/events/scripts 与 20 个 tool；`ctx.inject(['skills'])` 注册
  `undersilicon-control` skill；`ctx.inject(['connection'])` 挂 `/undersilicon` 面板 RPC
  （status/stop/resume/settings/脚本/订阅）；`agent/disposed` 停本会话脚本/订阅、释放 agent 租约，
  并按 `stopOnSessionEnd` 停机；dispose 清理定时器、脚本子进程与流、释放全部租约，审计 flush。
- `src/safety/lease.js`：每会话一个后端 agent 租约（clientId 与看门狗一致）。启动探测
  `/api/agent-control/status`，404/405 记为不支持并拒绝控制；控制前与看门狗一起续租，428 重建
  后重试一次；设置变更立即推送新 limits；会话结束释放，急停保留。`fieldCaps` 随控制结果返回。
- `src/settings.js`：`~/.dsh/undersilicon/settings.json`，同步加载、原子写入（tmp+rename），
  `applyTo()` 把设置合并到 profile 配置之上；校验 `limits.default/capabilities`、
  `stopOnSessionEnd`、`scripts.allowPersist`、`watchdogTtlSec`(5-600)。只有面板 RPC 可写，
  agent 无设置 tool；保存后热更新 watchdog/safety/events/scripts 配置并写审计。
- `src/sdk/client.js`：`ControlPanelClient` 覆盖 devices/capabilities/operations、watchdog、
  stop-all、games/game-runtime、remote-session、client state/window/routes/navigate/screenshot/
  launch、events recent、brands。`classifyMode()` 按 remote status 判 local / remote-operator /
  remote-controlled。`src/sdk/events-stream.js` 解析 SSE（普通 data 帧的 typed hello）。
- `src/safety/`：`ranges.js` 只把强度类字段列入缩放（strength.value、shock.voltage、
  vibration/suction.value、estim.intensity、motors.channels.*、pump.rate、pump.ss）；配置类
  （reportDelay、distance.*、boolean/字符串）不缩放。`scale.js` 百分比上限 =
  `min + (max-min)*pct/100`，严格数字/数字字符串解析（数字字符串按数字发送），拒绝布尔/对象/数组/
  非数字字符串，未知强度字段拒绝，整数向下取整，缩放后 <1 或阈值 0 拒绝，结果带 `clamped[]`；
  `pump.ss` 按秒硬顶 60s；`motors.set` 只接受对象通道，拒绝点号键/原型键/数组/未知字段，
  YCY_TOY 仅 a/b/c、YCY_CUP 仅 stroke/vibe/axis，direction 限 -1/0/1。
- `src/util/paths.js`：raw 请求路径规范化（解码、拒绝编码/字面斜杠与畸形转义、解析 `.`/`..`、
  折叠斜杠、去重复 `/api` 与尾斜杠），返回 `sendPath/matchPath/query`；小写只用于匹配。
- `src/safety/whitelist.js`：写请求分类白名单（capability/operation/client/game-start/
  game-stop/game-runtime/brand/nickname/device-patch/remote-emergency/stop-all），PATCH 只允许
  `name`/`nickname`；GET/HEAD 也走读白名单（设备/能力/设备类型/游戏列表、状态、manifest、
  game-runtime status、client state/routes、events recent、remote-session status、brands status、
  voice status），拒绝 auth/logs/models/test/virtual-devices/mqtt-client/serial/network/
  brands discover/external game meta 等。其余请求带提示拒绝。
- `src/safety/operations.js`：显式操作表；`FIXED_INPUT_OPS`、`SAFE_INVOKE`、`TRANSLATIONS`
  （如 CUNZHI01 start/stop、YCY_ENEMA pumpstart），`REFUSED_INVOKE` 拒绝 trigger/setMode。
- `src/safety/games.js`：按游戏 manifest 的 `device` 标签与显式 key map 缩放
  `maxMotorIntensity`/`shockVoltage`/`midIntensityMax`/`pump.ss` 等；无法识别单位的强度类参数
  拒绝（`UNKNOWN_GAME_INTENSITY_PARAM`）。
- `src/safety/safety.js`：统一控制/操作/raw/游戏入口；halt epoch + AbortController 中止在途请求，
  面板急停锁存（`EMERGENCY_LATCHED`，双语，只有 `emergency.resume` 解锁），agent 急停不锁存；
  控制前同时续看门狗与 agent 租约，428 重建租约重试一次；`emergencyStop` 每步结果 + 重试 3 次，
  并跑完整 hooks（停脚本、订阅、看门狗）；原始 stop-all/远程急停走同一流程；翻译型操作先全部
  缩放校验再发送，失败补发 stop。`watchdog.js` 每会话一个 clientId，ttl/2 续租；remote-operator
  的 423 会停租。`lease.js` 见上。`audit.js` 写 `~/.dsh/undersilicon/audit-YYYY-MM-DD.jsonl`，
  含 sessionId，token/secret/password 等脱敏。
- `src/scripts/`：每个 dsh 会话一个子进程（`sandbox-host.js` spawn，IPC 路由），
  `sandbox-child.cjs` 每脚本一个 `vm.createContext(DONT_CONTEXTIFY, {codeGeneration:{strings:false,
  wasm:false}})`，API 工厂在 context realm 内构造，回调 structured clone，仅 JSON 跨进程。子进程
  执行前删除宿主网络全局并在 context 内再次置空 fetch/WebSocket/EventSource 等；用 `--permission`
  + 只读沙箱文件 + `--max-old-space-size` 启动，无 fs 写/child_process/worker/addon；Electron 下
  设 `ELECTRON_RUN_AS_NODE`。`manager.js` 按会话管理子进程（全局 `maxSessions`），心跳超时只杀
  该会话的子进程；父进程再做安全层校验与审计，提供 RPC 白名单、每脚本 abort、通知限速
  （3/10s 合并）、持久化恢复。
- `src/events/manager.js`：单条共享 SSE，按 types/deviceId/where 过滤，按 throttleMs 合并
  （500ms-1h），maxEvents 1-1000，每会话 ≤`events.maxSubscriptions`、全局 ≤`maxTotalSubscriptions`；
  inject 用 `agent.inject`、wake 用 `agent.followup`；取消订阅按 owner 校验；状态机暴露
  connected/status/error/nextRetryAt，退避成功后重置；面板打开时 `keepPanelAlive()` 保持连接。
- `client/client.js`：手写 `window.__ModuleLoader__.load({id, factory})` bundle；注册
  locale、右侧栏 tab 类型与 slots、会话 header 按钮；急停按钮常驻（锁存时显示「已急停 · 点击恢复」），
  设备卡细强度条 + 阈值/不可达区，设置区（全局/按能力阈值、stopOnSessionEnd、allowPersist、
  watchdog TTL），事件流真实状态，4s 刷新。
- `mock/server.js`：进程内 mock 后端，支持 `mode` 与 `clientAvailable`，含设备、能力范围、
  远程过滤/423、typed hello SSE、routes titleKey、launch 返回结构、请求日志。

## 打包与安装（bundle）

- `package.json`：`dsh.manifestVersion: 1`、`dsh.bundle.patch: ./cordis.patch.yml`、`dsh.client`、
  根 `icon: ./icon.svg`、`repository` 指向 `https://github.com/jiandanzhineng/dsh-plugin-undersilicon`。
  `files` 只列 index/src/client/patch/icon/README/LICENSE；`npm pack` 共 38 个文件（含 locale），不含 tmp/test/docs/mock。
- `cordis.patch.yml` 用 `- insert:` 插入 `undersilicon` 行，不带 `config`（用 schema 默认值，
  `baseUrl=http://127.0.0.1:5278/api`）。安装器（插件页 / `dsh plugin add`）会把它加入 profile 的
  `dsh.profile.bundles` 并应用 patch，无需手改。
- `engines.dsh: ^0.2.1-rc.3`。兼容性判定在 dsh-app-boot：声明 `engines.dsh` 时它单独决定，
  **peerDependencies 不参与检查**；范围用 `semver.satisfies(..., {includePrerelease:true})`。
  dsh 0.2.1-rc.3 自带 cordis 4.0.5、schemastery 3.18.5、dsh-tools 0.2.1-rc.3，与
  `~4.0.5` / `~3.18.5` / `^0.2.1-rc.3` 相符。pnpm 会报 peers missing（profile 不自带 @deepseek-ai
  包，运行时由 dsh 模块回退提供），不影响安装或加载。
- 插件页标题/描述来自 `locale/<语言>.json` 的 `meta`（dsh-app-boot 经 `exports["./locale/*.json"]`
  解析 `<包>/locale/en.json`），没有时退回 package.json 的英文 description。
- 发布：npm `dsh-plugin-undersilicon`（账号 `undersilicon`，`publishConfig` 固定 npmjs 官方源，
  本机默认源是 npmmirror）+ GitHub 公开仓库打 `vX.Y.Z` tag。npm 账号开了安全密钥 2FA，发布必须网页确认；
  `!` 下的 `npm publish` 非交互会直接 EOTP 且网址被打码。用 `node tools/npm-publish-web.cjs <插件目录绝对路径>`
  （后台跑）：打印 `AUTH_URL` 给用户在浏览器确认，脚本轮询拿 OTP 后发布。新包首发会先出现
  `0.0.0-stage` 占位版本，约一分钟后自动替换为正式版，无需审批。
- 本机推 GitHub：全局 gitconfig 代理 7990 已失效，用 `git -c http.proxy= -c https.proxy= push`。
- 安装（0.1.2 起 npm 可用，已用全新 profile 实测）：插件页填 `dsh-plugin-undersilicon` 或 `github:jiandanzhineng/dsh-plugin-undersilicon`；
  CLI `dsh plugin --profile <name> add dsh-plugin-undersilicon`（`.tgz`/目录亦可）。
- 已用全新 profile `us-install` 验证：`dsh plugin --profile us-install add <tgz 绝对路径>` 成功，
  pnpm 11.28.5 未出现跨盘 `file:` bug；package.json 的 bundles 含本包，`--dump-config` 有
  `undersilicon` 行；`dsh --profile us-install --no-open --port 5399` 启动无报错，首页 boot 列表含
  `dsh-plugin-undersilicon/client.js`。注意自定义 profile 不能再写位置参数 `web`
  （`dsh --profile us-install web ...` 会报 too many arguments）。

## us-test profile（独立桌面运行时，开发用）

位置：`C:\Users\46907\.dsh\profiles\us-test`。只动这个 profile，不要动用户 desktop/web/headless。
以下是**源码目录安装**（开发热改）方式；正式安装用上面的 bundle。

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

- `npm test` → `node --test --test-concurrency=1 test/*.test.js`，当前 102 项全过。
- 单测覆盖：缩放与上下限、严格数字/未知字段、路径规范化与写白名单、预置操作翻译、
  游戏参数缩放、面板锁存/恢复、急停 epoch 与重试、看门狗、沙箱逃逸与权限模型拒绝、RPC、
  并发/内存/卡死限制、订阅节流/通知限速、设置优先级与面板写入、SDK、tool 集成。
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
- 需要客户端版本包含 `/api/agent-control`（尚未发版，见 control-panel PR #12）；旧客户端会被拒绝控制并提示升级。
- A 侧真实后端（虚拟设备）攻击复测已在纯后端 5340 完成，结果见 `tmp/attack/retest.md`（tmp 不入库）。
- `script_list/script_logs/script_stop/events_unsubscribe` 的 owner 校验在 manager/tool 层；面板 RPC 仍可跨会话查看/停止（这是面板的预期权限）。
- 侧栏面板 bundle 尚未在真实 dsh web/Electron 客户端里做 UI E2E；设置卡行为需实机确认。
- 阈值/设置的强制边界只在插件内。agent 若另有 shell/文件写权限，可直接改 profile 配置或
  `settings.json`；这是 dsh 宿主权限模型问题，不是沙箱能覆盖的范围。
- 控制面板后端本身不校验插件安全策略；插件是 agent 侧的强制边界，面板/客户端安全由后端负责。


