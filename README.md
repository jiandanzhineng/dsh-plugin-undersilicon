# dsh-plugin-undersilicon

DeepSeek Harness (dsh) 插件：让 agent 检查并控制本机「硅基之下控制中心」PC 客户端。
A dsh plugin that lets an agent inspect and control the local
「硅基之下控制中心」 (Silicon Below Control Center) desktop client.

- 后端默认 `http://127.0.0.1:5278/api`，仅允许 loopback。
- 所有控制入口（tool、脚本、原始请求）统一经过安全层：百分比缩放、看门狗、急停、审计。
- 20 个 tool、脚本沙箱、SSE 事件订阅、中英双语右侧栏面板。

## 功能 / Features

- 设备：状态、能力/预置操作、阈值缩放（只作用于强度字段）、设备管理。
- 客户端 UI：窗口、路由跳转、截图（模型支持图像时直接附图）。
- 游戏：列表、状态、完整启动（含 iframe）、停止/参数/动作；manifest 中的强度参数同样缩放。
- 脚本：独立子进程 + 每脚本一个 `vm` context，子进程启用 Node 权限模型；`us.*` RPC 全部经过安全层与审计。
- 事件：共享 SSE，按类型/设备/条件过滤，节流合并，`inject` 或 `wake` 投递。
- 安全：会话结束默认停机；用户侧栏急停锁存；本机 `stop-all`，远程主控走远程急停；JSONL 审计。
- 设置：侧栏设置区即时修改全局/按能力阈值、`stopOnSessionEnd`、脚本持久化与看门狗 TTL；
  `~/.dsh/undersilicon/settings.json` 优先于 profile 配置，只有已认证的面板 RPC 能写入。

## 安装 / Install

作为 dsh profile 的本地依赖安装（不要发布 npm）：

```json
{
  "dependencies": {
    "dsh-plugin-undersilicon": "file:./plugin-src"
  }
}
```

> Windows 上 pnpm 10 无法解析跨盘的 `file:E:/...`（会拼成 profile 下的相对路径），`file:///`
> 同样失败。做法：在 profile 内 `mklink /J plugin-src E:\smart\project\dsh-undersilicon`，
> 再用相对 `file:./plugin-src`。目录依赖安装为复制件，改插件源码后重跑 `pnpm install`。
> 其它平台直接写仓库路径即可。

在 profile 的 `cordis.patch.yml` 增加（用户 patch 不能按 id 新增，必须 `insert`）：

```yaml
- insert:
    - id: undersilicon
      name: dsh-plugin-undersilicon
      config:
        baseUrl: http://127.0.0.1:5278/api
        limits:
          default: 60
          capabilities:
            shock: 30
        stopOnSessionEnd: true
        scripts:
          allowPersist: false
```

启动：`dsh --profile <name>`。独立测试 profile 与验证命令见 `docs/note.md`。
Start with `dsh --profile <name>`; see `docs/note.md` for the isolated `us-test` profile.

## 配置 / Config

| key | 默认 / default | 说明 / meaning |
|---|---|---|
| `baseUrl` | `http://127.0.0.1:5278/api` | 后端地址；非 loopback 直接拒绝 |
| `limits.default` | `60` | 默认强度上限百分比 |
| `limits.capabilities` | `{shock:30}` | 按能力覆盖阈值 |
| `stopOnSessionEnd` | `true` | 会话结束是否停所有设备 |
| `watchdogTtlSec` | `30` | 看门狗租约秒数 |
| `auditEnabled` | `true` | 是否写 JSONL 审计 |
| `scripts.maxConcurrent` | `8` | 并发脚本上限 |
| `scripts.allowPersist` | `true` | 是否允许脚本存盘/恢复 |
| `scripts.memoryMb` | `64` | 沙箱子进程 V8 heap 上限 |
| `scripts.syncTimeoutMs` | `5000` | 同步代码卡死上限 |
| `scripts.heartbeatTimeoutMs` | `5000` | 子进程心跳超时 |
| `scripts.maxLogs` | `500` | 每脚本日志环大小 |
| `events.maxSubscriptions` | `20` | 每会话订阅上限（总上限 64） |
| `events.minThrottleMs` | `500` | 最小合并窗口（500ms） |
| `events.defaultThrottleMs` | `1000` | 默认合并窗口 |
| `events.maxEvents` | `30` | 默认自动退订条数（1-1000） |

运行时设置（侧栏「设置」）保存在 `~/.dsh/undersilicon/settings.json`，覆盖 profile 的
`limits`、`stopOnSessionEnd`、`scripts.allowPersist`、`watchdogTtlSec`；保存后立即生效并写审计。
删除该文件即回到 profile 配置。agent 没有修改设置的 tool。

## Tools（20）

| tool | 关键参数 | 作用 |
|---|---|---|
| `panel_status` | — | 模式、设备、客户端、游戏、脚本、订阅、阈值、审计摘要 |
| `device_list` / `device_get` | `deviceId` | 设备状态 / 单设备能力、范围、阈值 |
| `device_control` | `deviceId` + `capability/action/input` 或 `operation/params` | 控制设备，自动缩放 |
| `device_manage` | `action`、`deviceId`、`name`、`connectionType`、`brand` 等 | 重命名/昵称/连接方式/品牌 |
| `emergency_stop` | `reason` | 急停：设备 + 游戏 + runtime + 脚本 + 订阅；agent 急停不锁存 |
| `game_list` | `includeManifest` | 游戏与 HostRuntime 列表 |
| `game_status` | — | iframe/HostRuntime/客户端状态 |
| `game_start` | `gameId`、`deviceMapping`、`parameters`、`show` | 按 UI 流程启动（含 iframe） |
| `game_control` | `action`(stop/params/action)、`params`、`actionName`、`payload` | 停止/改参/动作 |
| `client_control` | `action`(state/routes/window/navigate)、`windowAction`、`path`、`show` | 客户端窗口与页面 |
| `client_screenshot` | `format`、`maxWidth`、`delayMs` | 截图；支持图像时直接附附件 |
| `script_run` | `code`、`name`、`persist` | 沙箱子进程内运行 agent JS |
| `script_list` / `script_stop` / `script_logs` | `all`/`includeCode`、`scriptId`、`limit` | 脚本管理 |
| `events_subscribe` | `types`、`deviceId`、`where`、`mode`、`prompt`、`throttleMs`、`maxEvents` | 免代码订阅（500ms-1h / 1-1000） |
| `events_unsubscribe` | `subscriptionId` | 取消一个/本会话全部 |
| `events_recent` | `limit`、`types` | 最近事件 |
| `panel_api` | `method`、`path`、`body`、`query` | 兜底请求（写操作白名单 + 路径规范化） |

## 脚本 API / Script API

```js
const devs = await us.devices();
await us.control(id, 'strength', 'set', { value: 120 });  // 自动缩放 + 审计
await us.operate(id, 'start', {});
us.on('device.updated', async (e) => {
  if (e.data.heart_rate > 150) await us.control(id, 'strength', 'set', { value: 0 });
}, { deviceId: hr });
us.every(2000, async () => us.log(await us.mode()));
us.notify('心率过高，已降强度', { wake: true });
us.state.count = (us.state.count || 0) + 1;
await us.sleep(500); await us.stopAll(); us.stop();
```

另有 `us.device / us.game.* / us.client.* / us.api / us.recent`，以及 `console` 与
`setTimeout/setInterval/clearTimeout/clearInterval`。顶层执行完且没有事件/定时器即结束，
否则常驻。限制：8 个并发脚本共用一个子进程（64MB heap）、5s 同步超时、5s 心跳、500 行日志环。

## 安全 / Security

- `baseUrl` 只接受 `127.0.0.1`/`localhost`/`::1`，非 loopback 直接拒绝。
- 阈值缩放只作用于强度类字段：数字或严格十进制字符串（按数字发送），拒绝 NaN/Infinity/
  非数字；强度能力里的未知数字字段直接拒绝，整数上限向下取整，缩放后 <1 或阈值 0 拒绝；
  `pump.ss` 缩放，电击电压始终显式发送。配置值（reportDelay、distance 等）不缩放；超限写
  `clamped[]`。
- 原始请求先规范化路径（大小写匹配、`.`/`..`、编码斜杠、重复斜杠、尾部斜杠），再按最终
  `pathname` 判定；GET/HEAD 放行，写请求仅白名单：能力动作、预置操作（同一套缩放与默认值）、
  `/client/*`、游戏启动/停止/runtime（manifest 参数缩放）、品牌 BLE 扫描/连接/断开、设备改名
  PATCH（只允许 `name`/`nickname`）。body 同时含 `input` 与 `params` 拒绝；其余请求给出提示。
- 预置操作走显式表：invoke 风格的强度操作翻译成能力动作，无法翻译的直接拒绝；纯停止操作放行。
- 急停：agent 急停提升 halt epoch、中止在途请求、停本机游戏/runtime/全部脚本；远程主控模式走
  远程急停；每步返回结果并重试 3 次。用户按侧栏急停会锁存：所有 agent 控制（tool、脚本、raw、
  游戏）被拒绝，只有用户在面板点「恢复」才能解除，agent 没有解锁 tool。
- 看门狗在发送前续租；续租失败且不是远程 423 就拒绝控制；停机后不再重建；`stopOnSessionEnd`
  时停全部设备不超过 3 秒。
- 脚本边界：所有脚本共用一个子进程，每脚本独立 `vm` context（`DONT_CONTEXTIFY`、
  `codeGeneration` 关闭 strings/wasm），只暴露 context 内的 `us`/`console`/定时器，回调走
  structured clone。子进程以 Node 权限模型启动（`--permission`，只 `--allow-fs-read` 沙箱文件，
  无 fs 写/child_process/worker/addon），安全层在父进程二次校验；Electron 下用
  `ELECTRON_RUN_AS_NODE`。
- 事件：`throttleMs` 500ms-1h，`maxEvents` 1-1000，每会话 ≤20 个订阅；通知限速 3 次/10s，
  超出合并；面板打开期间单独保持 SSE 连接并显示真实状态/重连/错误。
- 会话结束停本会话脚本/订阅；`stopOnSessionEnd` 控制是否停所有设备。
- 审计 JSONL：`~/.dsh/undersilicon/audit-YYYY-MM-DD.jsonl`，带 sessionId，敏感字段脱敏，
  dispose 时 flush。
- 已知限制：阈值和设置只在 dsh 插件内部强制。agent 若同时拥有 shell/文件写入权限，仍可能直接
  改 profile 配置或 `settings.json`；沙箱只隔离插件内的脚本，不能约束 dsh 宿主给 agent 的其它
  权限。这属于 dsh 自身的权限模型问题，部署时应限制 agent 的 shell 能力。
- 已知限制：控制面板后端仍接受未经插件校验的本地请求；插件只是 agent 的强制边界，面板/客户端
  自身的安全由后端负责。

## 测试 / Tests

```bash
npm install
npm test
```

`node:test` 85 项：缩放/边界、路径规范化与写白名单、预置操作翻译、游戏参数缩放、面板锁存与
恢复、急停 epoch/重试、看门狗、沙箱逃逸与权限模型、RPC、并发/内存/卡死、订阅节流/限速、
设置优先级与面板写入、SDK 与 tool 集成。独立 mock 后端与 headless 验证命令见 `docs/note.md`。

