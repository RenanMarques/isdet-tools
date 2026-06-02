/**
 * isdet-tools SDK  —  isdetart-sdk.js
 *
 * Uso em qualquer ferramenta:
 *
 *   <script src="/shared/isdetart-sdk.js"></script>
 *   <script>
 *     const db = IsdetTools.createStore('minha-ferramenta')
 *     await db.set('chave', dados)
 *     const dados = await db.get('chave')
 *   </script>
 *
 * O SDK cuida de:
 *   - Storage híbrido: window.storage (claude.ai) → localStorage (navegador)
 *   - Sync automático com o Worker gateway (local-first)
 *   - Fila de operações offline com retry
 *   - Indicador de status de sincronização
 */

(function (global) {
  "use strict";

  // ─── Configuração ────────────────────────────────────────────────────────────

  const CONFIG = {
    apiBase: "https://tools.isdet.net/api",
    token: "", // definido via IsdetTools.configure({ token: '...' })
    syncInterval: 30_000,   // tenta sincronizar a cada 30s
    retryDelay: 5_000,      // espera 5s antes de tentar de novo após falha
    maxRetries: 5,
  };

  // ─── Storage local (híbrido) ─────────────────────────────────────────────────

  const LocalStorage = {
    async get(key) {
      try {
        // claude.ai
        if (typeof window.storage?.get === "function") {
          const r = await window.storage.get(key);
          return r ? JSON.parse(r.value) : null;
        }
        // navegador padrão
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : null;
      } catch {
        return null;
      }
    },

    async set(key, value) {
      try {
        const serialized = JSON.stringify(value);
        if (typeof window.storage?.set === "function") {
          await window.storage.set(key, serialized);
        } else {
          localStorage.setItem(key, serialized);
        }
        return true;
      } catch {
        return false;
      }
    },

    async delete(key) {
      try {
        if (typeof window.storage?.delete === "function") {
          await window.storage.delete(key);
        } else {
          localStorage.removeItem(key);
        }
        return true;
      } catch {
        return false;
      }
    },
  };

  // ─── Cliente HTTP ─────────────────────────────────────────────────────────────

  const Api = {
    headers() {
      return {
        "Content-Type": "application/json",
        Authorization: `Bearer ${CONFIG.token}`,
      };
    },

    async get(namespace, key) {
      const url = key
        ? `${CONFIG.apiBase}/${namespace}/${key}`
        : `${CONFIG.apiBase}/${namespace}`;
      const r = await fetch(url, { headers: this.headers() });
      if (!r.ok) throw new Error(`API ${r.status}`);
      return r.json();
    },

    async put(namespace, key, value) {
      const r = await fetch(`${CONFIG.apiBase}/${namespace}/${key}`, {
        method: "PUT",
        headers: this.headers(),
        body: JSON.stringify({ value }),
      });
      if (!r.ok) throw new Error(`API ${r.status}`);
      return r.json();
    },

    async delete(namespace, key) {
      const r = await fetch(`${CONFIG.apiBase}/${namespace}/${key}`, {
        method: "DELETE",
        headers: this.headers(),
      });
      if (!r.ok) throw new Error(`API ${r.status}`);
      return r.json();
    },
  };

  // ─── Fila de sync pendente ────────────────────────────────────────────────────

  const QUEUE_KEY = "__isdet_sync_queue__";

  const Queue = {
    async load() {
      return (await LocalStorage.get(QUEUE_KEY)) || [];
    },

    async save(queue) {
      await LocalStorage.set(QUEUE_KEY, queue);
    },

    async push(op) {
      const queue = await this.load();
      // Remove operações anteriores para a mesma namespace+key (a mais nova substitui)
      const filtered = queue.filter(
        (o) => !(o.namespace === op.namespace && o.key === op.key)
      );
      filtered.push({ ...op, retries: 0, timestamp: Date.now() });
      await this.save(filtered);
    },

    async remove(namespace, key) {
      const queue = await this.load();
      await this.save(
        queue.filter((o) => !(o.namespace === namespace && o.key === key))
      );
    },
  };

  // ─── Motor de sincronização ───────────────────────────────────────────────────

  const SyncEngine = {
    _status: "idle", // idle | syncing | synced | error | offline | no-token
    _listeners: [],
    _timer: null,
    _lastSync: null,

    onStatus(fn) {
      this._listeners.push(fn);
    },

    _emit(status, detail = {}) {
      this._status = status;
      this._listeners.forEach((fn) => fn({ status, ...detail }));
    },

    async flush() {
      if (!CONFIG.token) {
        this._emit("no-token");
        return;
      }

      const queue = await Queue.load();
      if (!queue.length) {
        this._emit("synced", { lastSync: this._lastSync });
        return;
      }

      this._emit("syncing", { pending: queue.length });

      let failed = [];
      for (const op of queue) {
        try {
          if (op.type === "put") {
            await Api.put(op.namespace, op.key, op.value);
          } else if (op.type === "delete") {
            await Api.delete(op.namespace, op.key);
          }
          await Queue.remove(op.namespace, op.key);
        } catch (err) {
          const retries = (op.retries || 0) + 1;
          if (retries < CONFIG.maxRetries) {
            failed.push({ ...op, retries });
          }
          // se excedeu maxRetries, descarta a operação
        }
      }

      if (failed.length) {
        await Queue.save(failed);
        this._emit("error", { pending: failed.length });
      } else {
        this._lastSync = new Date();
        this._emit("synced", { lastSync: this._lastSync });
      }
    },

    start() {
      if (this._timer) return;
      this.flush();
      this._timer = setInterval(() => this.flush(), CONFIG.syncInterval);

      // Sincroniza ao recuperar conexão
      window.addEventListener("online", () => this.flush());
      window.addEventListener("focus", () => this.flush());
    },

    stop() {
      if (this._timer) clearInterval(this._timer);
      this._timer = null;
    },
  };

  // ─── Store por namespace ──────────────────────────────────────────────────────

  function createStore(namespace) {
    if (!namespace || !/^[a-zA-Z0-9_-]+$/.test(namespace)) {
      throw new Error("namespace inválido: use apenas letras, números, - e _");
    }

    function localKey(key) {
      return `__isdet__${namespace}__${key}`;
    }

    return {
      namespace,

      /**
       * Lê um valor. Sempre retorna do local (rápido, funciona offline).
       * Em background, verifica se há versão mais recente no servidor.
       */
      async get(key) {
        const local = await LocalStorage.get(localKey(key));

        // Tenta buscar versão remota em background (não bloqueia)
        if (CONFIG.token) {
          Api.get(namespace, key)
            .then(async (remote) => {
              const remoteTs = remote.updated_at || 0;
              const localTs = local?._updated_at || 0;
              if (remoteTs > localTs) {
                // remoto é mais novo: atualiza local silenciosamente
                await LocalStorage.set(localKey(key), {
                  value: remote.value,
                  _updated_at: remoteTs,
                });
              }
            })
            .catch(() => {}); // silencioso — offline ou erro temporário
        }

        return local?.value ?? null;
      },

      /**
       * Escreve um valor localmente e enfileira sync com o servidor.
       */
      async set(key, value) {
        const now = Date.now();
        await LocalStorage.set(localKey(key), { value, _updated_at: now });
        await Queue.push({ type: "put", namespace, key, value });
        SyncEngine.flush(); // tenta sincronizar imediatamente
        return true;
      },

      /**
       * Remove um valor localmente e enfileira deleção no servidor.
       */
      async delete(key) {
        await LocalStorage.delete(localKey(key));
        await Queue.push({ type: "delete", namespace, key });
        SyncEngine.flush();
        return true;
      },

      /**
       * Força sincronização imediata.
       */
      async sync() {
        return SyncEngine.flush();
      },
    };
  }

  // ─── Componente de status de sync ────────────────────────────────────────────

  /**
   * Monta um indicador de status de sync num elemento existente.
   *
   * Uso:
   *   <div id="sync-status"></div>
   *   IsdetTools.mountSyncStatus(document.getElementById('sync-status'))
   */
  function mountSyncStatus(el) {
    if (!el) return;

    const states = {
      idle:     { icon: "ti-clock",        text: "Aguardando sync",   color: "var(--color-text-tertiary)" },
      syncing:  { icon: "ti-refresh",      text: "Sincronizando…",    color: "var(--color-text-secondary)", spin: true },
      synced:   { icon: "ti-cloud-check",  text: "Sincronizado",      color: "var(--color-text-success)" },
      error:    { icon: "ti-cloud-x",      text: "Erro na sync",      color: "var(--color-text-danger)" },
      offline:  { icon: "ti-wifi-off",     text: "Offline",           color: "var(--color-text-secondary)" },
      "no-token": { icon: "ti-lock-off",   text: "Token não configurado", color: "var(--color-text-danger)" },
    };

    el.style.cssText =
      "display:inline-flex;align-items:center;gap:5px;font-size:12px;user-select:none";

    function render({ status, pending, lastSync }) {
      const s = states[status] || states.idle;
      let label = s.text;
      if (status === "error" && pending) label += ` (${pending} pendente${pending > 1 ? "s" : ""})`;
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

    // Injeta keyframe de rotação uma única vez
    if (!document.getElementById("__isdet_spin_style")) {
      const style = document.createElement("style");
      style.id = "__isdet_spin_style";
      style.textContent =
        "@keyframes __isdet_spin{to{transform:rotate(360deg)}}";
      document.head.appendChild(style);
    }

    SyncEngine.onStatus(render);
    render({ status: SyncEngine._status });
  }

  // ─── API pública ──────────────────────────────────────────────────────────────

  global.IsdetTools = {
    /**
     * Configura token e inicia o motor de sync.
     * Chamar uma vez, antes de criar stores.
     *
     * IsdetTools.configure({ token: 'seu-token-aqui' })
     */
    configure({ token, syncInterval, apiBase } = {}) {
      if (token) CONFIG.token = token;
      if (syncInterval) CONFIG.syncInterval = syncInterval;
      if (apiBase) CONFIG.apiBase = apiBase;
      SyncEngine.start();
    },

    /**
     * Cria um store isolado para um namespace.
     * Cada ferramenta usa seu próprio namespace.
     */
    createStore,

    /**
     * Monta o indicador visual de status de sync.
     */
    mountSyncStatus,

    /**
     * Acesso ao motor de sync (para flush manual, etc.)
     */
    sync: () => SyncEngine.flush(),
  };
})(window);
