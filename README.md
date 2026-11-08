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
- 游戏：列表、状态、完整启动（含 iframe）、停止/参数/动作。
- 脚本：`worker_threads` + `vm` 沙箱，`us.*` RPC 全部经过安全层与审计。
- 事件：共享 SSE，按类型/设备/条件过滤，节流合并，`inject` 或 `wake` 投递。
- 安全：会话结束默认停机；本机 `stop-all`，远程主控走远程急停；JSONL 审计。

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
| `scripts.memoryMb` | `64` | 单 worker 内存上限 |
| `scripts.syncTimeoutMs` | `5000` | 同步代码卡死上限 |
| `scripts.heartbeatTimeoutMs` | `5000` | worker 心跳超时 |
| `scripts.maxLogs` | `500` | 每脚本日志环大小 |
| `events.maxSubscriptions` | `16` | 订阅上限 |
| `events.minThrottleMs` | `200` | 最小合并窗口 |
| `events.defaultThrottleMs` | `1000` | 默认合并窗口 |
| `events.maxEvents` | `30` | 默认自动退订条数 |

## Tools（20）

| tool | 关键参数 | 作用 |
|---|---|---|
| `panel_status` | — | 模式、设备、客户端、游戏、脚本、订阅、阈值、审计摘要 |
| `device_list` / `device_get` | `deviceId` | 设备状态 / 单设备能力、范围、阈值 |
| `device_control` | `deviceId` + `capability/action/input` 或 `operation/params` | 控制设备，自动缩放 |
| `device_manage` | `action`、`deviceId`、`name`、`connectionType`、`brand` 等 | 重命名/昵称/连接方式/品牌 |
| `emergency_stop` | `reason` | 急停：设备 + 游戏 + 脚本 + 订阅 |
| `game_list` | `includeManifest` | 游戏与 HostRuntime 列表 |
| `game_status` | — | iframe/HostRuntime/客户端状态 |
| `game_start` | `gameId`、`deviceMapping`、`parameters`、`show` | 按 UI 流程启动（含 iframe） |
| `game_control` | `action`(stop/params/action)、`params`、`actionName`、`payload` | 停止/改参/动作 |
| `client_control` | `action`(state/routes/window/navigate)、`windowAction`、`path`、`show` | 客户端窗口与页面 |
| `client_screenshot` | `format`、`maxWidth`、`delayMs` | 截图；支持图像时直接附附件 |
| `script_run` | `code`、`name`、`persist` | 沙箱内运行 agent JS |
| `script_list` / `script_stop` / `script_logs` | `all`/`includeCode`、`scriptId`、`limit` | 脚本管理 |
| `events_subscribe` | `types`、`deviceId`、`where`、`mode`、`prompt`、`throttleMs`、`maxEvents` | 免代码订阅 |
| `events_unsubscribe` | `subscriptionId` | 取消一个/本会话全部 |
| `events_recent` | `limit`、`types` | 最近事件 |
| `panel_api` | `method`、`path`、`body`、`query` | 兜底请求（仍受安全拦截） |

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
否则常驻。限制：并发、64MB、同步超时、心跳、日志环。

## 安全 / Security

- `baseUrl` 只接受 `127.0.0.1`/`localhost`/`::1`，非 loopback 直接拒绝。
- 阈值缩放只作用于强度类字段，配置值（reportDelay、distance 等）不缩放；超限写 `clamped[]`。
- 原始请求拦截：device message、batch、mqtt-client、serial、wired-flash、firmware、
  本地 app/plugin/auth 写、模型写、设备删除、远程会话生命周期等。
- 会话结束停本会话脚本/订阅；`stopOnSessionEnd` 控制是否停所有设备。
- 审计 JSONL：`~/.dsh/undersilicon/audit-YYYY-MM-DD.jsonl`，敏感字段脱敏。
- 急停免确认、永远可用；远程主控模式改走远程急停。

## 测试 / Tests

```bash
npm install
npm test
```

`node:test` 60 项：缩放/边界、拦截端点、急停、看门狗、沙箱逃逸、RPC、并发/内存/卡死、
订阅节流、SDK 与 tool 集成。独立 mock 后端与 headless 验证命令见 `docs/note.md`。

