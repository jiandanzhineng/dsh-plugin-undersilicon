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
      "panel.mode": "模式",
      "panel.mode.local": "本机",
      "panel.mode.remote-operator": "远程主控",
      "panel.mode.remote-controlled": "被远程控制",
      "panel.mode.unknown": "未知",
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
      "panel.stream.fallback": "轮询兜底",
      "panel.busy": "执行中…",
      "panel.emergencyDone": "已急停",
      "panel.error": "连接失败",
      "panel.clientPage": "当前页面",
      "panel.game": "玩法",
      "panel.noGame": "未运行",
    }
    const en = {
      "tab.title": "Undersilicon",
      "header.open": "Undersilicon",
      "panel.title": "Undersilicon Control Center",
      "panel.refresh": "Refresh",
      "panel.emergency": "Emergency stop",
      "panel.emergencyHint": "Stop every device, game and script now",
      "panel.mode": "Mode",
      "panel.mode.local": "Local",
      "panel.mode.remote-operator": "Remote operator",
      "panel.mode.remote-controlled": "Remote-controlled",
      "panel.mode.unknown": "Unknown",
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
      "panel.stream.fallback": "polling fallback",
      "panel.busy": "Working…",
      "panel.emergencyDone": "Stopped",
      "panel.error": "Connection failed",
      "panel.clientPage": "Current page",
      "panel.game": "Game",
      "panel.noGame": "Not running",
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

    function Panel({ t, call }) {
      const [data, setData] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [updated, setUpdated] = React.useState(null)
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

      const section = (title, body) => h("section", { style: { display: "flex", flexDirection: "column", gap: "6px" } },
        h("h3", { style: style.title }, title), body)

      return h("div", { style: style.panel },
        h("div", { style: style.between },
          h("div", { style: style.row },
            h("span", { style: { ...style.dot, background: state.stream?.connected ? "#12b76a" : (state.stream?.fallback ? "#f79009" : "#98a2b3") } }),
            h("h2", { style: { ...style.title, fontSize: "15px" } }, t("panel.title"))),
          h("div", { style: style.row },
            h("span", { style: style.badge }, `${t("panel.mode")}: ${modeLabel(t, state.mode)}`),
            h("button", { style: style.button, onClick: () => { void load() }, disabled: busy }, t("panel.refresh")))),
        h("button", { style: style.emergency, onClick: emergency, disabled: busy, title: t("panel.emergencyHint") },
          busy ? t("panel.busy") : t("panel.emergency")),
        error ? h("div", { style: style.error }, error) : null,
        h("div", { style: style.muted },
          `${t("panel.stream")}: ${state.stream?.connected ? t("panel.stream.on") : (state.stream?.fallback ? t("panel.stream.fallback") : t("panel.stream.off"))}` +
          (updated ? ` · ${t("panel.updated")} ${updated}` : "") +
          (state.baseUrl ? ` · ${state.baseUrl}` : "")),
        section(t("panel.devices"), devices.length === 0 ? h("div", { style: style.muted }, t("panel.noDevices")) :
          h("div", { style: style.grid }, devices.map((device) => h("div", { key: device.id, style: style.card },
            h("div", { style: style.between },
              h("strong", { style: { overflow: "hidden", textOverflow: "ellipsis" } }, device.name || device.id),
              h("span", { style: style.dot, background: device.connected ? "#12b76a" : "#98a2b3" })),
            h("div", { style: style.muted }, `${device.type} · ${device.connected ? t("panel.connected") : t("panel.disconnected")}`),
            liveText(device.data) ? h("div", { style: style.muted }, liveText(device.data)) : null)))),
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
      const call = (endpoint, payload) => ctx.connection.rpc.call("/undersilicon", endpoint, payload)
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

    module.exports = { apply, inject, name: "undersilicon" }
    return module.exports
  }
})
