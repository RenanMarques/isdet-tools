/**
 * IsdetTools Sync Status Component
 *
 * Optional UI add-on. Requires isdet-tools-sdk.js to be loaded first.
 *
 * Usage:
 *   <script src="/shared/isdet-tools-sdk.js"></script>
 *   <script src="/shared/isdet-tools-sync-status.js"></script>
 *   <script>
 *     IsdetTools.configure({})
 *     IsdetTools.mountSyncStatus(document.getElementById('sync-indicator'))
 *   </script>
 */

(function (global) {
  "use strict";

  if (!global.IsdetTools) {
    console.error("isdet-tools-sync-status.js requires isdet-tools-sdk.js to be loaded first");
    return;
  }

  const states = {
    idle:        { icon: "ti-clock",          text: "Aguardando sync",     color: "var(--color-text-tertiary)" },
    syncing:     { icon: "ti-refresh",        text: "Sincronizando…",      color: "var(--color-text-secondary)", spin: true },
    synced:      { icon: "ti-cloud-check",    text: "Sincronizado",        color: "var(--color-text-success)" },
    error:       { icon: "ti-cloud-x",        text: "Erro na sync",        color: "var(--color-text-danger)" },
    dead_letter: { icon: "ti-alert-octagon",  text: "Ação necessária",     color: "var(--color-text-danger)" },
    quota:       { icon: "ti-database-off",   text: "Armazenamento cheio", color: "var(--color-text-danger)" },
    offline:     { icon: "ti-wifi-off",       text: "Offline",             color: "var(--color-text-secondary)" },
  };

  global.IsdetTools.mountSyncStatus = function mountSyncStatus(el) {
    if (!el) return;

    el.style.cssText =
      "display:inline-flex;align-items:center;gap:5px;font-size:12px;user-select:none";

    function render({ status, pending, lastSync, count }) {
      const s = states[status] || states.idle;
      let label = s.text;
      if (status === "error" && pending) label += ` (${pending})`;
      if (status === "dead_letter" && count) label += ` (${count})`;
      if (status === "synced" && lastSync) {
        const h = lastSync.getHours().toString().padStart(2, "0");
        const m = lastSync.getMinutes().toString().padStart(2, "0");
        label += ` às ${h}:${m}`;
      }

      el.innerHTML = `
        <i class="ti ${s.icon}"
           style="font-size:14px;color:${s.color};${s.spin ? "animation:__isdet_spin .8s linear infinite" : ""}"
           aria-hidden="true"></i>
        <span style="color:${s.color}">${label}</span>
      `;
    }

    if (!document.getElementById("__isdet_spin_style")) {
      const style = document.createElement("style");
      style.id = "__isdet_spin_style";
      style.textContent = "@keyframes __isdet_spin{to{transform:rotate(360deg)}}";
      document.head.appendChild(style);
    }

    global.IsdetTools.onSyncStatus(render);
    render({ status: "idle" });
  };
})(window);
