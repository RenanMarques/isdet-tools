/**
 * isdet-tools SDK  —  isdetart-sdk.js
 *
 * Uso em qualquer ferramenta:
 *
 *   <script src="/shared/isdetart-sdk.js"></script>
 *   <script>
 *     const store = IsdetTools.createStore('minha-ferramenta')
 *     const itens = store.collection('item')
 *
 *     await itens.save({ id: 'abc', nome: 'Exemplo' })
 *     const item  = await itens.find('abc')
 *     const todos = await itens.findAll()
 *     await itens.remove('abc')
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
    token: "",
    syncInterval: 30_000,
    retryDelay: 5_000,
    maxRetries: 5,
  };

  // ─── Storage local (híbrido) ─────────────────────────────────────────────────

  const LocalStorage = {
    async get(key) {
      try {
        if (typeof window.storage?.get === "function") {
          const r = await window.storage.get(key);
          return r ? JSON.parse(r.value) : null;
        }
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
      const h = { "Content-Type": "application/json" };
      if (CONFIG.token) h["Authorization"] = `Bearer ${CONFIG.token}`;
      return h;
    },

    async getAll(namespace, collection) {
      const r = await fetch(`${CONFIG.apiBase}/${namespace}/${collection}`, {
        headers: this.headers(),
      });
      if (!r.ok) throw new Error(`API ${r.status}`);
      return r.json();
    },

    async getOne(namespace, collection, id) {
      const r = await fetch(`${CONFIG.apiBase}/${namespace}/${collection}/${id}`, {
        headers: this.headers(),
      });
      if (!r.ok) throw new Error(`API ${r.status}`);
      return r.json();
    },

    async put(namespace, collection, id, data) {
      const r = await fetch(`${CONFIG.apiBase}/${namespace}/${collection}/${id}`, {
        method: "PUT",
        headers: this.headers(),
        body: JSON.stringify(data),
      });
      if (!r.ok) throw new Error(`API ${r.status}`);
      return r.json();
    },

    async delete(namespace, collection, id) {
      const r = await fetch(`${CONFIG.apiBase}/${namespace}/${collection}/${id}`, {
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
      const filtered = queue.filter(
        (o) => !(
          o.namespace  === op.namespace  &&
          o.collection === op.collection &&
          o.id         === op.id
        )
      );
      filtered.push({ ...op, retries: 0, timestamp: Date.now() });
      await this.save(filtered);
    },

    async remove(namespace, collection, id) {
      const queue = await this.load();
      await this.save(
        queue.filter(
          (o) => !(o.namespace === namespace && o.collection === collection && o.id === id)
        )
      );
    },
  };

  // ─── Motor de sincronização ───────────────────────────────────────────────────

  const SyncEngine = {
    _status: "idle",
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
      const queue = await Queue.load();
      if (!queue.length) {
        this._emit("synced", { lastSync: this._lastSync });
        return;
      }

      this._emit("syncing", { pending: queue.length });

      const failed = [];
      for (const op of queue) {
        try {
          if (op.type === "save") {
            await Api.put(op.namespace, op.collection, op.id, op.data);
          } else if (op.type === "remove") {
            await Api.delete(op.namespace, op.collection, op.id);
          }
          await Queue.remove(op.namespace, op.collection, op.id);
        } catch {
          const retries = (op.retries || 0) + 1;
          if (retries < CONFIG.maxRetries) {
            failed.push({ ...op, retries });
          }
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

      window.addEventListener("online", () => this.flush());
      window.addEventListener("focus", () => this.flush());
    },

    stop() {
      if (this._timer) clearInterval(this._timer);
      this._timer = null;
    },
  };

  // ─── Coleção ──────────────────────────────────────────────────────────────────

  function createCollection(namespace, collectionName) {
    if (!/^[a-zA-Z0-9_-]+$/.test(collectionName)) {
      throw new Error("collection inválida: use apenas letras, números, - e _");
    }

    function recordKey(id) {
      return `__isdet__${namespace}__${collectionName}__${id}`;
    }
    const indexKey = `__isdet__${namespace}__${collectionName}__$index`;

    const col = {
      // ── índice local ──────────────────────────────────────────────────────────

      async _getIndex() {
        return (await LocalStorage.get(indexKey)) || [];
      },

      async _addToIndex(id) {
        const idx = await this._getIndex();
        if (!idx.includes(id)) {
          idx.push(id);
          await LocalStorage.set(indexKey, idx);
        }
      },

      async _removeFromIndex(id) {
        const idx = await this._getIndex();
        await LocalStorage.set(indexKey, idx.filter((x) => x !== id));
      },

      // ── API pública ───────────────────────────────────────────────────────────

      /**
       * Salva (insert ou update) um registro.
       * Se data.id for omitido, gera um UUID automaticamente.
       * Retorna o objeto salvo com o id usado.
       */
      async save(data) {
        const id = data.id != null ? String(data.id) : crypto.randomUUID();
        const now = Date.now();

        const existing = await LocalStorage.get(recordKey(id));
        const createdAt = existing?._createdAt ?? now;

        await LocalStorage.set(recordKey(id), { data, _createdAt: createdAt, _updatedAt: now });
        await this._addToIndex(id);
        await Queue.push({ type: "save", namespace, collection: collectionName, id, data });
        SyncEngine.flush();

        return { ...data, id: data.id != null ? data.id : id };
      },

      /**
       * Busca um registro pelo id. Retorna null se não encontrado.
       * Verifica versão remota em background sem bloquear.
       */
      async find(id) {
        const sid = String(id);
        const local = await LocalStorage.get(recordKey(sid));

        Api.getOne(namespace, collectionName, sid)
          .then(async (remote) => {
            if (remote.updated_at > (local?._updatedAt ?? 0)) {
              await LocalStorage.set(recordKey(sid), {
                data: remote.data,
                _createdAt: remote.created_at,
                _updatedAt: remote.updated_at,
              });
              await col._addToIndex(sid);
            }
          })
          .catch(() => {});

        return local ? local.data : null;
      },

      /**
       * Retorna todos os registros da coleção (local-first).
       * Sincroniza com o servidor em background.
       */
      async findAll() {
        const idx = await this._getIndex();
        const entries = await Promise.all(idx.map((id) => LocalStorage.get(recordKey(id))));
        const local = entries.filter(Boolean).map((r) => r.data);

        Api.getAll(namespace, collectionName)
          .then(async (remote) => {
            for (const r of remote.records) {
              const existing = await LocalStorage.get(recordKey(r.id));
              if (r.updated_at > (existing?._updatedAt ?? 0)) {
                await LocalStorage.set(recordKey(r.id), {
                  data: r.data,
                  _createdAt: r.created_at,
                  _updatedAt: r.updated_at,
                });
                await col._addToIndex(r.id);
              }
            }
          })
          .catch(() => {});

        return local;
      },

      /**
       * Remove um registro pelo id.
       */
      async remove(id) {
        const sid = String(id);
        await LocalStorage.delete(recordKey(sid));
        await this._removeFromIndex(sid);
        await Queue.push({ type: "remove", namespace, collection: collectionName, id: sid });
        SyncEngine.flush();
        return true;
      },
    };

    return col;
  }

  // ─── Store por namespace ──────────────────────────────────────────────────────

  function createStore(namespace) {
    if (!namespace || !/^[a-zA-Z0-9_-]+$/.test(namespace)) {
      throw new Error("namespace inválido: use apenas letras, números, - e _");
    }

    const _collections = {};

    return {
      namespace,

      /**
       * Retorna (ou cria) a coleção com o nome dado.
       * Instâncias são memoizadas dentro do store.
       */
      collection(name) {
        if (!_collections[name]) {
          _collections[name] = createCollection(namespace, name);
        }
        return _collections[name];
      },

      /**
       * Força sincronização imediata da fila pendente.
       */
      sync() {
        return SyncEngine.flush();
      },
    };
  }

  // ─── Componente de status de sync ────────────────────────────────────────────

  function mountSyncStatus(el) {
    if (!el) return;

    const states = {
      idle:    { icon: "ti-clock",       text: "Aguardando sync",  color: "var(--color-text-tertiary)" },
      syncing: { icon: "ti-refresh",     text: "Sincronizando…",   color: "var(--color-text-secondary)", spin: true },
      synced:  { icon: "ti-cloud-check", text: "Sincronizado",     color: "var(--color-text-success)" },
      error:   { icon: "ti-cloud-x",     text: "Erro na sync",     color: "var(--color-text-danger)" },
      offline: { icon: "ti-wifi-off",    text: "Offline",          color: "var(--color-text-secondary)" },
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

    if (!document.getElementById("__isdet_spin_style")) {
      const style = document.createElement("style");
      style.id = "__isdet_spin_style";
      style.textContent = "@keyframes __isdet_spin{to{transform:rotate(360deg)}}";
      document.head.appendChild(style);
    }

    SyncEngine.onStatus(render);
    render({ status: SyncEngine._status });
  }

  // ─── API pública ──────────────────────────────────────────────────────────────

  global.IsdetTools = {
    /**
     * Configura o SDK e inicia o motor de sync.
     * Chamar uma vez, antes de criar stores.
     */
    configure({ token, syncInterval, apiBase } = {}) {
      if (token) CONFIG.token = token;
      if (syncInterval) CONFIG.syncInterval = syncInterval;
      if (apiBase) CONFIG.apiBase = apiBase;
      SyncEngine.start();
    },

    /**
     * Cria um store isolado por namespace.
     * Use store.collection(name) para acessar coleções.
     */
    createStore,

    /**
     * Monta o indicador visual de status de sync.
     */
    mountSyncStatus,

    /**
     * Força sincronização imediata da fila pendente.
     */
    sync: () => SyncEngine.flush(),
  };
})(window);
