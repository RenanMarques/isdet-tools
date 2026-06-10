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
 *
 * When the status is "dead_letter", the indicator becomes clickable and opens
 * a conflict resolution modal for each actionable dead-letter entry.
 */

(function (global) {
  "use strict";

  if (!global.IsdetTools) {
    console.error("isdet-tools-sync-status.js requires isdet-tools-sdk.js to be loaded first");
    return;
  }

  // ─── Status labels ─────────────────────────────────────────────────────────────

  const STATUS = {
    idle:        { icon: "ti-clock",         text: "Aguardando sync",     color: "var(--color-text-tertiary)" },
    syncing:     { icon: "ti-refresh",       text: "Sincronizando…",      color: "var(--color-text-secondary)", spin: true },
    synced:      { icon: "ti-cloud-check",   text: "Sincronizado",        color: "var(--color-text-success)" },
    error:       { icon: "ti-cloud-x",       text: "Erro na sync",        color: "var(--color-text-danger)" },
    dead_letter: { icon: "ti-alert-octagon", text: "Ação necessária",     color: "var(--color-text-danger)" },
    auth_expired:{ icon: "ti-lock",          text: "Sessão expirada",     color: "var(--color-text-danger)" },
    quota:       { icon: "ti-database-off",  text: "Armazenamento cheio", color: "var(--color-text-danger)" },
    offline:     { icon: "ti-wifi-off",      text: "Offline",             color: "var(--color-text-secondary)" },
  };

  // ─── Conflict resolution modal ────────────────────────────────────────────────

  function formatAge(ts) {
    const diff = Date.now() - ts;
    const m = Math.floor(diff / 60000);
    if (m < 1) return "agora mesmo";
    if (m < 60) return `há ${m}min`;
    const h = Math.floor(m / 60);
    if (h < 24) return `há ${h}h`;
    return `há ${Math.floor(h / 24)}d`;
  }

  function displayVal(v) {
    if (v === null || v === undefined) return '<em style="color:var(--text3,#999)">—</em>';
    if (typeof v === "object") {
      const s = JSON.stringify(v);
      return `<code style="font-size:10px">${s.length > 80 ? s.slice(0, 80) + "…" : s}</code>`;
    }
    return String(v);
  }

  function buildComparisonTable(mine, theirs) {
    const allKeys = [...new Set([...Object.keys(mine || {}), ...Object.keys(theirs || {})])];
    const rows = allKeys.map((key) => {
      const mineVal   = mine?.[key];
      const theirsVal = theirs?.[key];
      const differs   = JSON.stringify(mineVal) !== JSON.stringify(theirsVal);
      const rowStyle  = differs ? 'style="background:var(--warning-bg,#fffbe6)"' : "";
      return `<tr ${rowStyle}>
        <td style="padding:3px 8px;font-family:monospace;font-size:11px;color:var(--text2,#666);border-bottom:0.5px solid var(--border,#e5e7eb)">${key}</td>
        <td style="padding:3px 8px;font-size:12px;border-bottom:0.5px solid var(--border,#e5e7eb)">${displayVal(mineVal)}</td>
        <td style="padding:3px 8px;font-size:12px;border-bottom:0.5px solid var(--border,#e5e7eb);${differs ? "color:var(--accent,#f97316);font-weight:500" : ""}">${displayVal(theirsVal)}</td>
      </tr>`;
    });
    return `
      <table style="width:100%;border-collapse:collapse;margin-top:8px;border:0.5px solid var(--border,#e5e7eb);border-radius:4px;overflow:hidden;font-size:12px">
        <thead>
          <tr style="background:var(--bg2,#f9fafb)">
            <th style="padding:4px 8px;text-align:left;font-size:11px;color:var(--text2,#666);font-weight:500">Campo</th>
            <th style="padding:4px 8px;text-align:left;font-size:11px;color:var(--text2,#666);font-weight:500">Sua versão</th>
            <th style="padding:4px 8px;text-align:left;font-size:11px;color:var(--accent,#f97316);font-weight:500">Versão no servidor</th>
          </tr>
        </thead>
        <tbody>${rows.join("")}</tbody>
      </table>`;
  }

  function buildEntryHeader(entry) {
    const typeLabels = {
      conflict:        "Conflito de versão",
      causal_conflict: "Operação desatualizada",
    };
    const collectionLabels = { supplies: "Insumo", sessions: "Sessão", purchases: "Compra" };
    const collLabel = collectionLabels[entry.op.collection] || entry.op.collection;
    return `
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:4px">
        <span style="font-size:13px;font-weight:500">${collLabel}
          <code style="font-size:10px;font-weight:400;color:var(--text2,#666)">${entry.op.namespace}/${entry.op.collection}/${entry.op.id}</code>
        </span>
        <span style="font-size:11px;color:var(--text3,#999);white-space:nowrap;margin-left:8px">${formatAge(entry.addedAt)}</span>
      </div>
      <div style="font-size:11px;color:var(--text2,#666);margin-bottom:6px">${typeLabels[entry.type] || entry.type}</div>`;
  }

  function buildEntryBody(entry) {
    if (entry.type === "conflict") {
      if (entry.remote?.currentData) {
        return buildComparisonTable(entry.op.data, entry.remote.currentData);
      }
      return `<p style="font-size:12px;color:var(--text2,#666);margin:4px 0 0">
        Versão do servidor não disponível neste registro (salvo antes da atualização do SDK).
        Você pode forçar seu dado ou descartar esta operação.
      </p>`;
    }
    if (entry.type === "causal_conflict") {
      const dep = entry.changedDependency;
      return `<p style="font-size:12px;color:var(--text2,#666);margin:4px 0 0">
        Esta operação dependia de <code>${dep.collection}/${dep.id}</code> na versão
        <code style="font-size:10px">${dep.declaredVersion?.slice(0, 8)}…</code>, mas esse
        registro foi alterado por outro usuário antes do envio.
        Os dados podem estar desatualizados.
      </p>`;
    }
    return "";
  }

  function renderCard(entry, onResolved) {
    const card = document.createElement("div");
    card.id = `__isdet_dlq_card_${entry.id}`;
    card.style.cssText = "border:0.5px solid var(--border,#e5e7eb);border-radius:6px;padding:12px;margin-bottom:10px";
    card.innerHTML = buildEntryHeader(entry) + buildEntryBody(entry);

    const actions = document.createElement("div");
    actions.style.cssText = "display:flex;gap:6px;justify-content:flex-end;margin-top:10px";

    const btnAccept = document.createElement("button");
    btnAccept.textContent = "Aceitar do servidor";
    btnAccept.style.cssText = `
      font-size:12px;padding:4px 10px;border-radius:4px;cursor:pointer;
      border:0.5px solid var(--border,#e5e7eb);background:var(--bg2,#f9fafb);color:var(--text,#111)
    `;
    btnAccept.title = "Descarta sua alteração e mantém a versão do servidor";

    const btnKeep = document.createElement("button");
    btnKeep.textContent = "Manter o meu";
    btnKeep.style.cssText = `
      font-size:12px;padding:4px 10px;border-radius:4px;cursor:pointer;
      border:0.5px solid var(--accent,#f97316);background:transparent;color:var(--accent,#f97316)
    `;
    btnKeep.title = "Envia sua versão ao servidor sem verificação de conflito";

    const setLoading = (btn, label) => {
      btnAccept.disabled = true;
      btnKeep.disabled = true;
      btn.textContent = label;
    };

    btnAccept.onclick = async () => {
      setLoading(btnAccept, "Aguarde…");
      await global.IsdetTools.acceptRemoteVersion(entry.id);
      onResolved(entry.id);
    };

    btnKeep.onclick = async () => {
      setLoading(btnKeep, "Aguarde…");
      await global.IsdetTools.forceResave(entry.id);
      onResolved(entry.id);
    };

    actions.appendChild(btnAccept);
    actions.appendChild(btnKeep);
    card.appendChild(actions);
    return card;
  }

  async function openConflictModal() {
    const existing = document.getElementById("__isdet_dlq_overlay__");
    if (existing) { existing.remove(); return; }

    const all = await global.IsdetTools.getDeadLetterOps();
    const actionable = all.filter((e) => e.type !== "max_retries");
    if (!actionable.length) return;

    // ── Overlay ──────────────────────────────────────────────────────────────
    const overlay = document.createElement("div");
    overlay.id = "__isdet_dlq_overlay__";
    overlay.style.cssText = `
      position:fixed;inset:0;background:rgba(0,0,0,0.45);z-index:9999;
      display:flex;align-items:center;justify-content:center;padding:16px
    `;
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };

    // ── Modal ─────────────────────────────────────────────────────────────────
    const modal = document.createElement("div");
    modal.style.cssText = `
      background:var(--bg,#fff);border-radius:8px;width:min(600px,100%);
      max-height:80vh;overflow-y:auto;padding:20px;
      box-shadow:0 8px 32px rgba(0,0,0,0.18)
    `;

    // ── Header ────────────────────────────────────────────────────────────────
    const header = document.createElement("div");
    header.style.cssText = "display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:14px";

    const headerText = document.createElement("div");
    const countEl = document.createElement("div");
    countEl.style.cssText = "font-size:12px;color:var(--text2,#666);margin-top:2px";

    const updateCount = (n) => {
      countEl.textContent = `${n} ${n === 1 ? "item requer atenção" : "itens requerem atenção"}`;
    };
    updateCount(actionable.length);

    headerText.innerHTML = '<div style="font-size:14px;font-weight:600">Conflitos de sincronização</div>';
    headerText.appendChild(countEl);

    const btnClose = document.createElement("button");
    btnClose.innerHTML = '<i class="ti ti-x" style="font-size:16px" aria-hidden="true"></i>';
    btnClose.style.cssText = "background:none;border:none;cursor:pointer;color:var(--text2,#666);padding:4px;margin-left:8px";
    btnClose.onclick = () => overlay.remove();

    header.appendChild(headerText);
    header.appendChild(btnClose);

    // ── Entry list ────────────────────────────────────────────────────────────
    const list = document.createElement("div");

    const onResolved = (resolvedId) => {
      document.getElementById(`__isdet_dlq_card_${resolvedId}`)?.remove();
      const remaining = list.querySelectorAll('[id^="__isdet_dlq_card_"]').length;
      if (!remaining) { overlay.remove(); return; }
      updateCount(remaining);
    };

    for (const entry of actionable) {
      list.appendChild(renderCard(entry, onResolved));
    }

    // ── Bulk actions ──────────────────────────────────────────────────────────
    const footer = document.createElement("div");
    footer.style.cssText = `
      border-top:0.5px solid var(--border,#e5e7eb);margin-top:12px;
      padding-top:12px;display:flex;gap:8px;justify-content:flex-end
    `;

    const btnAcceptAll = document.createElement("button");
    btnAcceptAll.textContent = "Aceitar todos do servidor";
    btnAcceptAll.style.cssText = `
      font-size:12px;padding:5px 12px;border-radius:4px;cursor:pointer;
      border:0.5px solid var(--border,#e5e7eb);background:var(--bg2,#f9fafb);color:var(--text,#111)
    `;

    const btnKeepAll = document.createElement("button");
    btnKeepAll.textContent = "Manter todos os meus";
    btnKeepAll.style.cssText = `
      font-size:12px;padding:5px 12px;border-radius:4px;cursor:pointer;
      border:0.5px solid var(--accent,#f97316);background:transparent;color:var(--accent,#f97316)
    `;

    const setBulkLoading = (btn, label) => {
      btnAcceptAll.disabled = true;
      btnKeepAll.disabled = true;
      btn.textContent = label;
    };

    btnAcceptAll.onclick = async () => {
      setBulkLoading(btnAcceptAll, "Aguarde…");
      for (const entry of actionable) {
        await global.IsdetTools.acceptRemoteVersion(entry.id);
      }
      overlay.remove();
    };

    btnKeepAll.onclick = async () => {
      setBulkLoading(btnKeepAll, "Aguarde…");
      for (const entry of actionable) {
        await global.IsdetTools.forceResave(entry.id);
      }
      overlay.remove();
    };

    footer.appendChild(btnAcceptAll);
    footer.appendChild(btnKeepAll);

    modal.appendChild(header);
    modal.appendChild(list);
    modal.appendChild(footer);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
  }

  // ─── Mount sync status indicator ─────────────────────────────────────────────

  global.IsdetTools.mountSyncStatus = function mountSyncStatus(el) {
    if (!el) return;

    el.style.cssText = "display:inline-flex;align-items:center;gap:5px;font-size:12px;user-select:none";

    function render({ status, pending, lastSync, count }) {
      const s = STATUS[status] || STATUS.idle;
      let label = s.text;
      if (status === "error"       && pending) label += ` (${pending})`;
      if (status === "dead_letter" && count)   label += ` (${count})`;
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

      if (status === "dead_letter") {
        el.style.cursor = "pointer";
        el.title = "Clique para resolver conflitos";
        el.onclick = openConflictModal;
      } else if (status === "auth_expired") {
        el.style.cursor = "pointer";
        el.title = "Clique para re-autenticar";
        el.onclick = () => window.location.reload();
      } else {
        el.style.cursor = "";
        el.title = "";
        el.onclick = null;
      }
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
