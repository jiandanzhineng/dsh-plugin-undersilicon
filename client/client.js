window.__ModuleLoader__.load({
  id: "dsh-plugin-undersilicon",
  factory: (require) => {
    const React = require("react")
    const h = React.createElement
    const NS = "undersilicon"
    const PKG = "dsh-plugin-undersilicon"

    const zh = {
      "tab.title": "硅基之下",
      "header.open": "硅基之下",
      "panel.title": "硅基之下控制中心",
      "panel.refresh": "刷新",
      "panel.emergency": "急停",
      "panel.emergencyHint": "立即停止所有设备、玩法与脚本",
      "panel.emergencyLatched": "已急停 · 点击恢复",
      "panel.emergencyResumeHint": "用户在侧栏锁定了急停；点击此按钮恢复 agent 控制",
      "panel.emergencyLatchedBanner": "急停已锁定：agent 的所有控制都会被拒绝，点上方按钮恢复。",
      "panel.mode": "模式",
      "panel.mode.local": "本机",
      "panel.mode.remote-operator": "远程主控",
      "panel.mode.remote-controlled": "被远程控制",
      "panel.mode.unknown": "未知",
      "panel.thresholds": "阈值",
      "panel.devices": "设备",
      "panel.noDevices": "没有可见设备",
      "panel.connected": "已连接",
      "panel.disconnected": "未连接",
      "panel.scripts": "脚本",
      "panel.noScripts": "没有运行中的脚本",
      "panel.subscriptions": "事件订阅",
      "panel.noSubscriptions": "没有事件订阅",
      "panel.audit": "最近审计",
      "panel.noAudit": "没有记录",
      "panel.stop": "停止",
      "panel.loading": "加载中…",
      "panel.updated": "更新于",
      "panel.stream": "事件流",
      "panel.stream.on": "已连接",
      "panel.stream.off": "未连接",
      "panel.stream.idle": "待命（无订阅）",
      "panel.stream.fallback": "轮询兜底",
      "panel.stream.connecting": "连接中…",
      "panel.stream.reconnecting": "重连中",
      "panel.stream.error": "错误",
      "panel.busy": "执行中…",
      "panel.emergencyDone": "已急停",
      "panel.error": "连接失败",
      "panel.clientPage": "当前页面",
      "panel.game": "玩法",
      "panel.noGame": "未运行",
      "panel.settings": "设置",
      "panel.settings.open": "编辑设置",
      "panel.settings.close": "收起",
      "panel.settings.threshold": "总阈值",
      "panel.settings.capability": "按能力阈值",
      "panel.settings.stopOnEnd": "会话结束停机",
      "panel.settings.allowPersist": "允许持久脚本",
      "panel.settings.watchdog": "看门狗 TTL（秒）",
      "panel.settings.save": "保存设置",
      "panel.settings.saved": "已保存，立即生效",
      "panel.settings.note": "只有此面板能改阈值；agent 没有修改设置的 tool。",
      "panel.settings.file": "设置文件",
    }
    const en = {
      "tab.title": "Undersilicon",
      "header.open": "Undersilicon",
      "panel.title": "Undersilicon Control Center",
      "panel.refresh": "Refresh",
      "panel.emergency": "Emergency stop",
      "panel.emergencyHint": "Stop every device, game and script now",
      "panel.emergencyLatched": "Stopped · click to resume",
      "panel.emergencyResumeHint": "The user latched the emergency stop; click to let the agent control again",
      "panel.emergencyLatchedBanner": "Emergency stop is latched: every agent control is refused. Click the button above to resume.",
      "panel.mode": "Mode",
      "panel.mode.local": "Local",
      "panel.mode.remote-operator": "Remote operator",
      "panel.mode.remote-controlled": "Remote-controlled",
      "panel.mode.unknown": "Unknown",
      "panel.thresholds": "Thresholds",
      "panel.devices": "Devices",
      "panel.noDevices": "No visible devices",
      "panel.connected": "connected",
      "panel.disconnected": "disconnected",
      "panel.scripts": "Scripts",
      "panel.noScripts": "No running scripts",
      "panel.subscriptions": "Event subscriptions",
      "panel.noSubscriptions": "No subscriptions",
      "panel.audit": "Recent audit",
      "panel.noAudit": "No entries",
      "panel.stop": "Stop",
      "panel.loading": "Loading…",
      "panel.updated": "Updated",
      "panel.stream": "Event stream",
      "panel.stream.on": "connected",
      "panel.stream.off": "disconnected",
      "panel.stream.idle": "idle (no subscriptions)",
      "panel.stream.fallback": "polling fallback",
      "panel.stream.connecting": "connecting…",
      "panel.stream.reconnecting": "reconnecting",
      "panel.stream.error": "error",
      "panel.busy": "Working…",
      "panel.emergencyDone": "Stopped",
      "panel.error": "Connection failed",
      "panel.clientPage": "Current page",
      "panel.game": "Game",
      "panel.noGame": "Not running",
      "panel.settings": "Settings",
      "panel.settings.open": "Edit settings",
      "panel.settings.close": "Close",
      "panel.settings.threshold": "Global threshold",
      "panel.settings.capability": "Per-capability threshold",
      "panel.settings.stopOnEnd": "Stop on session end",
      "panel.settings.allowPersist": "Allow persistent scripts",
      "panel.settings.watchdog": "Watchdog TTL (seconds)",
      "panel.settings.save": "Save settings",
      "panel.settings.saved": "Saved and applied",
      "panel.settings.note": "Only this panel can change thresholds; the agent has no settings tool.",
      "panel.settings.file": "Settings file",
    }

    const style = {
      panel: { padding: "12px", display: "flex", flexDirection: "column", gap: "10px", fontSize: "12px", color: "inherit", minWidth: 0 },
      row: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" },
      between: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" },
      card: { border: "1px solid rgba(127,127,127,.28)", borderRadius: "8px", padding: "8px", display: "flex", flexDirection: "column", gap: "4px", minWidth: 0 },
      grid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: "8px" },
      title: { fontSize: "13px", fontWeight: 600, margin: 0 },
      muted: { opacity: .62, fontSize: "11px" },
      badge: { padding: "1px 7px", borderRadius: "999px", border: "1px solid rgba(127,127,127,.35)", fontSize: "11px" },
      dot: { width: "7px", height: "7px", borderRadius: "999px", display: "inline-block" },
      button: { padding: "4px 9px", borderRadius: "6px", border: "1px solid rgba(127,127,127,.35)", background: "transparent", color: "inherit", cursor: "pointer", fontSize: "11px" },
      emergency: { padding: "10px 12px", borderRadius: "8px", border: "1px solid #d92d20", background: "#d92d20", color: "#fff", cursor: "pointer", fontWeight: 700, fontSize: "13px", width: "100%" },
      emergencyLatched: { padding: "10px 12px", borderRadius: "8px", border: "1px solid #f97066", background: "#7a271a", color: "#fff", cursor: "pointer", fontWeight: 700, fontSize: "13px", width: "100%" },
      warning: { padding: "7px 9px", borderRadius: "6px", background: "rgba(247,144,9,.14)", border: "1px solid rgba(247,144,9,.45)", fontSize: "11px" },
      barTrack: { position: "relative", height: "5px", borderRadius: "999px", background: "rgba(127,127,127,.2)", overflow: "hidden", marginTop: "2px" },
      barFill: { position: "absolute", left: 0, top: 0, bottom: 0, borderRadius: "999px" },
      barLimit: { position: "absolute", top: "-2px", bottom: "-2px", width: "1px", background: "#f79009" },
      barZone: { position: "absolute", top: 0, bottom: 0, background: "rgba(127,127,127,.13)" },
      settings: { border: "1px solid rgba(127,127,127,.28)", borderRadius: "8px", padding: "8px", display: "flex", flexDirection: "column", gap: "6px" },
      field: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" },
      input: { width: "70px", padding: "2px 4px", borderRadius: "4px", border: "1px solid rgba(127,127,127,.35)", background: "transparent", color: "inherit", fontSize: "11px" },
      error: { padding: "8px", borderRadius: "6px", background: "rgba(217,45,32,.12)", border: "1px solid rgba(217,45,32,.35)" },
      list: { listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: "5px" },
      item: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px", padding: "5px 6px", borderRadius: "6px", background: "rgba(127,127,127,.07)" },
      pre: { margin: 0, fontSize: "10px", whiteSpace: "pre-wrap", wordBreak: "break-all", opacity: .8 },
    }

    function modeLabel(t, mode) {
      const key = `panel.mode.${mode || "unknown"}`
      const labels = {
        local: t("panel.mode.local"), "remote-operator": t("panel.mode.remote-operator"),
        "remote-controlled": t("panel.mode.remote-controlled"), unknown: t("panel.mode.unknown"),
      }
      return labels[mode] || labels.unknown
    }

    function liveText(data) {
      if (!data || typeof data !== "object") return ""
      const parts = []
      if (data.power !== undefined) parts.push(`power ${data.power}`)
      if (data.voltage !== undefined) parts.push(`${data.voltage}V`)
      if (data.shock) parts.push("shock on")
      if (data.vibration !== undefined) parts.push(`vib ${data.vibration}`)
      if (data.suction !== undefined) parts.push(`suc ${data.suction}`)
      if (data.heart_rate !== undefined) parts.push(`HR ${data.heart_rate}`)
      if (data.pressure !== undefined) parts.push(`P ${data.pressure}`)
      if (data.weight !== undefined) parts.push(`${data.weight}g`)
      return parts.join(" · ")
    }

    function DeviceBar({ bar }) {
      const span = Math.max(1, bar.max - bar.min)
      const valuePct = Math.max(0, Math.min(100, ((bar.value - bar.min) / span) * 100))
      const limitPct = Math.max(0, Math.min(100, ((bar.limit - bar.min) / span) * 100))
      const over = bar.value > bar.limit
      return h("div", { style: { minWidth: 0 }, title: `${bar.label}: ${bar.value}${bar.unit || ""} / ${bar.max} · limit ${bar.limit}` },
        h("div", { style: style.between },
          h("span", { style: style.muted }, `${bar.label} ${bar.value}${bar.unit || ""}`),
          h("span", { style: style.muted }, `≤ ${bar.limit}`)),
        h("div", { style: style.barTrack },
          h("div", { style: { ...style.barZone, left: `${limitPct}%`, right: 0 } }),
          h("div", { style: { ...style.barFill, width: `${valuePct}%`, background: over ? "#f04438" : "#12b76a" } }),
          h("div", { style: { ...style.barLimit, left: `${limitPct}%` } })))
    }

    function settingsDraft(state) {
      const limits = state.thresholds || {}
      const caps = {}
      for (const key of state.availableCapabilities || []) {
        caps[key] = Math.round(Number(limits.capabilities?.[key] ?? limits.default ?? 60))
      }
      return {
        limits: { default: Math.round(Number(limits.default ?? 60)), capabilities: caps },
        stopOnSessionEnd: state.settings?.stopOnSessionEnd !== false,
        watchdogTtlSec: Math.round(Number(state.settings?.watchdogTtlSec ?? 30)),
        scripts: { allowPersist: state.settings?.scripts?.allowPersist !== false },
      }
    }

    function streamLabel(t, stream) {
      const status = stream?.status || (stream?.connected ? "connected" : "off")
      const map = {
        connected: t("panel.stream.on"), connecting: t("panel.stream.connecting"),
        reconnecting: t("panel.stream.reconnecting"), fallback: t("panel.stream.fallback"),
        idle: t("panel.stream.idle"), off: t("panel.stream.off"),
      }
      let text = map[status] || t("panel.stream.off")
      if (stream?.error && status !== "connected" && status !== "idle") {
        text += ` · ${t("panel.stream.error")}: ${stream.error}`
      }
      return text
    }

    function Panel({ t, call }) {
      const [data, setData] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [updated, setUpdated] = React.useState(null)
      const [settingsOpen, setSettingsOpen] = React.useState(false)
      const [draft, setDraft] = React.useState(null)
      const [saved, setSaved] = React.useState(false)
      const load = React.useCallback(async () => {
        try {
          const result = await call("state", {})
          if (!result || !result.ok) throw new Error(result?.error?.message || t("panel.error"))
          setData(result.value)
          setError(null)
          setUpdated(new Date().toLocaleTimeString())
        } catch (failure) {
          setError(String(failure?.message || failure))
        }
      }, [call, t])
      React.useEffect(() => {
        void load()
        const timer = setInterval(() => { void load() }, 4000)
        return () => clearInterval(timer)
      }, [load])
      const run = async (label, fn) => {
        setBusy(true)
        try { await fn(); await load() }
        catch (failure) { setError(`${label}: ${failure?.message || failure}`) }
        finally { setBusy(false) }
      }
      const emergency = () => run(t("panel.emergency"), async () => {
        const result = await call("emergency.stop", { reason: "sidebar emergency stop" })
        if (!result?.ok) throw new Error(result?.error?.message || "emergency stop failed")
      })
      const resume = () => run(t("panel.emergencyLatched"), async () => {
        const result = await call("emergency.resume", { reason: "sidebar resume" })
        if (!result?.ok) throw new Error(result?.error?.message || "resume failed")
      })
      const openSettings = () => {
        setDraft(settingsDraft(data || {}))
        setSaved(false)
        setSettingsOpen(true)
      }
      const saveSettings = () => run(t("panel.settings.save"), async () => {
        const result = await call("settings.set", draft)
        if (!result?.ok) throw new Error(result?.error?.message || "save failed")
        setSaved(true)
      })
      const setThreshold = (key, value) => {
        setDraft((current) => {
          if (!current) return current
          if (key === "default") {
            return { ...current, limits: { ...current.limits, default: Number(value) } }
          }
          return {
            ...current,
            limits: {
              ...current.limits,
              capabilities: { ...current.limits.capabilities, [key]: Number(value) },
            },
          }
        })
      }
      const stopScript = (id) => run(t("panel.stop"), async () => {
        const result = await call("script.stop", { id })
        if (!result?.ok) throw new Error(result?.error?.message || "stop failed")
      })
      const stopSubscription = (id) => run(t("panel.stop"), async () => {
        const result = await call("subscription.stop", { id })
        if (!result?.ok) throw new Error(result?.error?.message || "stop failed")
      })
      const state = data || {}
      const devices = state.devices || []
      const scripts = state.scripts || []
      const subscriptions = state.subscriptions || []
      const audit = state.audit || []
      const clientState = state.client || {}
      const game = state.game || {}
      const latched = Boolean(state.emergency?.latched)
      const streamStatus = state.stream?.status || (state.stream?.connected ? "connected" : "off")
      const streamDot = streamStatus === "connected" ? "#12b76a"
        : (streamStatus === "fallback" ? "#f79009" : (streamStatus === "reconnecting" ? "#f79009" : "#98a2b3"))
      const section = (title, body) => h("section", { style: { display: "flex", flexDirection: "column", gap: "6px" } },
        h("h3", { style: style.title }, title), body)
      const thresholdKeys = Object.keys(draft?.limits?.capabilities || {})

      return h("div", { style: style.panel },
        h("div", { style: style.between },
          h("div", { style: style.row },
            h("span", { style: { ...style.dot, background: streamDot } }),
            h("h2", { style: { ...style.title, fontSize: "15px" } }, t("panel.title"))),
          h("div", { style: style.row },
            h("span", { style: style.badge }, `${t("panel.mode")}: ${modeLabel(t, state.mode)}`),
            state.thresholds ? h("span", { style: style.badge }, `${t("panel.thresholds")}: ${state.thresholds.default}% / ${state.thresholds.capabilities?.shock ?? "-"}%`) : null,
            h("button", { style: style.button, onClick: () => { void load() }, disabled: busy }, t("panel.refresh")))),
        h("button", {
          style: latched ? style.emergencyLatched : style.emergency,
          onClick: latched ? resume : emergency,
          disabled: busy,
          title: latched ? t("panel.emergencyResumeHint") : t("panel.emergencyHint"),
        }, busy ? t("panel.busy") : (latched ? t("panel.emergencyLatched") : t("panel.emergency"))),
        latched ? h("div", { style: style.warning }, t("panel.emergencyLatchedBanner")) : null,
        error ? h("div", { style: style.error }, error) : null,
        h("div", { style: style.muted },
          `${t("panel.stream")}: ${streamLabel(t, state.stream)}` +
          (updated ? ` · ${t("panel.updated")} ${updated}` : "") +
          (state.baseUrl ? ` · ${state.baseUrl}` : "")),
        h("div", { style: style.row },
          h("button", { style: style.button, onClick: () => (settingsOpen ? setSettingsOpen(false) : openSettings()) },
            settingsOpen ? t("panel.settings.close") : t("panel.settings.open"))),
        settingsOpen && draft ? h("div", { style: style.settings },
          h("h3", { style: style.title }, t("panel.settings")),
          h("div", { style: style.field },
            h("span", null, `${t("panel.settings.threshold")}: ${draft.limits.default}%`),
            h("input", {
              type: "range", min: 0, max: 100, value: draft.limits.default,
              onChange: (event) => setThreshold("default", event.target.value),
            })),
          ...thresholdKeys.map((key) => h("div", { key, style: style.field },
            h("span", null, `${t("panel.settings.capability")} · ${key}: ${draft.limits.capabilities[key]}%`),
            h("input", {
              type: "range", min: 0, max: 100, value: draft.limits.capabilities[key],
              onChange: (event) => setThreshold(key, event.target.value),
            }))),
          h("label", { style: style.field },
            h("span", null, t("panel.settings.stopOnEnd")),
            h("input", {
              type: "checkbox", checked: draft.stopOnSessionEnd,
              onChange: (event) => setDraft({ ...draft, stopOnSessionEnd: event.target.checked }),
            })),
          h("label", { style: style.field },
            h("span", null, t("panel.settings.allowPersist")),
            h("input", {
              type: "checkbox", checked: draft.scripts.allowPersist,
              onChange: (event) => setDraft({ ...draft, scripts: { ...draft.scripts, allowPersist: event.target.checked } }),
            })),
          h("label", { style: style.field },
            h("span", null, t("panel.settings.watchdog")),
            h("input", {
              style: style.input, type: "number", min: 5, max: 600, value: draft.watchdogTtlSec,
              onChange: (event) => setDraft({ ...draft, watchdogTtlSec: Number(event.target.value) }),
            })),
          h("div", { style: style.row },
            h("button", { style: style.button, disabled: busy, onClick: saveSettings }, t("panel.settings.save")),
            saved ? h("span", { style: style.muted }, t("panel.settings.saved")) : null),
          h("div", { style: style.muted }, t("panel.settings.note")),
          state.settings?.file ? h("div", { style: style.pre }, `${t("panel.settings.file")}: ${state.settings.file}`) : null) : null,
        section(t("panel.devices"), devices.length === 0 ? h("div", { style: style.muted }, t("panel.noDevices")) :
          h("div", { style: style.grid }, devices.map((device) => h("div", { key: device.id, style: style.card },
            h("div", { style: style.between },
              h("strong", { style: { overflow: "hidden", textOverflow: "ellipsis" } }, device.name || device.id),
              h("span", { style: style.dot, background: device.connected ? "#12b76a" : "#98a2b3" })),
            h("div", { style: style.muted }, `${device.type} · ${device.connected ? t("panel.connected") : t("panel.disconnected")}`),
            liveText(device.data) ? h("div", { style: style.muted }, liveText(device.data)) : null,
            ...(device.bars || []).map((bar) => h(DeviceBar, { key: bar.key, bar })))))),
        section(t("panel.clientPage"), h("div", { style: style.muted },
          [clientState.route || (clientState.available === false ? clientState.error : "-"),
            clientState.window ? `${t("panel.game")}: ${game.status?.gameId || game.runtime?.gameId || t("panel.noGame")}` : ""]
            .filter(Boolean).join(" · "))),
        section(t("panel.scripts"), scripts.length === 0 ? h("div", { style: style.muted }, t("panel.noScripts")) :
          h("ul", { style: style.list }, scripts.map((script) => h("li", { key: script.id, style: style.item },
            h("span", { style: { minWidth: 0 } },
              h("strong", null, script.name || script.id),
              h("span", { style: style.muted }, ` · ${script.status}`),
              script.lastError ? h("div", { style: { ...style.pre, color: "#d92d20" } }, script.lastError) : null,
              (script.logs || []).slice(-2).map((line, index) => h("div", { key: index, style: style.pre }, line.text))),
            h("button", { style: style.button, disabled: busy || script.status === "completed" || script.status === "stopped", onClick: () => { void stopScript(script.id) } }, t("panel.stop")))))),
        section(t("panel.subscriptions"), subscriptions.length === 0 ? h("div", { style: style.muted }, t("panel.noSubscriptions")) :
          h("ul", { style: style.list }, subscriptions.map((subscription) => h("li", { key: subscription.id, style: style.item },
            h("span", { style: { minWidth: 0 } },
              h("strong", null, subscription.id),
              h("span", { style: style.muted }, ` · ${(subscription.types || []).join(",")}${subscription.deviceId ? ` · ${subscription.deviceId}` : ""} · ${subscription.mode} · ${subscription.delivered}/${subscription.maxEvents}`)),
            h("button", { style: style.button, disabled: busy, onClick: () => { void stopSubscription(subscription.id) } }, t("panel.stop")))))),
        section(t("panel.audit"), audit.length === 0 ? h("div", { style: style.muted }, t("panel.noAudit")) :
          h("ul", { style: style.list }, audit.slice(0, 8).map((entry, index) => h("li", { key: index, style: style.item },
            h("span", { style: { minWidth: 0 } },
              h("span", null, entry.action || entry.source?.name || "-"),
              h("span", { style: style.muted }, ` · ${entry.ts ? new Date(entry.ts).toLocaleTimeString() : ""} · ${entry.result?.ok === false ? "failed" : "ok"}`)))))),
        state.watchdog?.length ? h("div", { style: style.muted }, `watchdog: ${state.watchdog.map((item) => item.clientId).join(", ")}`) : null)
    }

    function TabTitle({ t }) {
      return h("span", null, t("tab.title"))
    }

    function OpenButton({ t, openPanel }) {
      return h("button", {
        onClick: openPanel,
        style: { ...style.button, padding: "3px 8px" },
        title: t("header.open"),
      }, t("header.open"))
    }

    const KEY = "dsh-plugin-undersilicon"
    const inject = ["connection", "locale", "slots", "sidebarRight", "sidebarRightTabs"]

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "undersilicon: dictionaries")
      const t = ctx.locale.bind(NS)
      const call = async (endpoint, payload) => {
        const response = await fetch("/api/undersilicon", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ endpoint, payload: payload || {} }),
        })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return await response.json()
      }
      ctx.effect(() => ctx.sidebarRightTabs.register({
        id: KEY,
        kind: "undersilicon",
        priority: "extension",
        title: () => t("tab.title"),
      }), "undersilicon: sidebar type")
      ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({
        name: "sidebar.right.pane.tab", key: KEY, locale: NS,
        inject: () => ({ call }),
      }, Panel))
      ctx.slots.inject("sidebar.right.pane.tab.title", () => ctx.slots.register({
        name: "sidebar.right.pane.tab.title", key: KEY, locale: NS,
      }, TabTitle))
      ctx.slots.inject("conversation.session.header.actions", () => ctx.slots.register({
        name: "conversation.session.header.actions", id: "undersilicon-open",
        order: 40, locale: NS,
        inject: () => ({ openPanel: () => ctx.sidebarRight.openTab("undersilicon") }),
      }, OpenButton))
    }

    return { apply, inject, name: "undersilicon" }
  }
})
