/**
 * IsdetTools SDK
 *
 * Usage in any tool:
 *
 *   <script src="/shared/isdet-tools-sdk.js"></script>
 *   <script>
 *     IsdetTools.configure({
 *       onConflict({ op, remote }) { ... },       // 409: server version mismatch
 *       onCausalConflict({ stale, changedDependency }) { ... }, // dep changed before flush
 *     })
 *
 *     const store = IsdetTools.createStore('my-tool')
 *     const items = store.collection('item')
 *
 *     await items.save({ id: 'abc', name: 'Example' })
 *     const item = await items.find('abc')
 *     const { data, version } = await items.findWithMeta('abc')
 *     const all  = await items.findAll()
 *     await items.remove('abc')
 *
 *     // Declare causal dependency when deriving one record from another:
 *     const { data: supply, version: supplyVer } = await supplies.findWithMeta('s1')
 *     await sessions.save(sessionData, {
 *       dependsOn: [{ collection: 'supplies', id: 's1', version: supplyVer }]
 *     })
 *   </script>
 *
 * The SDK handles:
 *   - Hybrid storage: window.storage (claude.ai) → localStorage (browser)
 *   - Automatic sync with the Worker gateway (local-first)
 *   - Offline operation queue with retry
 *   - OCC: conditional PUT with If-Match; 409 → onConflict callback
 *   - Causal dependencies: dependsOn checked at flush; stale → onCausalConflict callback
 *   - Pitfall fix: background reads never overwrite pending local writes
 *   - Sync status indicator
 */

(function (global) {
  "use strict";

  // ─── Configuration ───────────────────────────────────────────────────────────

  const CONFIG = {
    apiBase: "https://tools.isdet.net/api",
    token: "",
    syncInterval: 30_000,
    retryDelay: 5_000,
    maxRetries: 5,
    onConflict: null,        // ({ op, remote }) => void
    onCausalConflict: null,  // ({ stale, changedDependency }) => void
  };

  // ─── Local storage (hybrid) ──────────────────────────────────────────────────

  const LocalStorage = (() => {
    const backend = typeof window.storage?.get === "function" ? window.storage : null;

    return {
      async get(key) {
        try {
          if (backend) {
            const r = await backend.get(key);
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
          if (backend) {
            await backend.set(key, serialized);
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
          if (backend) {
            await backend.delete(key);
          } else {
            localStorage.removeItem(key);
          }
          return true;
        } catch {
          return false;
        }
      },
    };
  })();

  // ─── HTTP client ─────────────────────────────────────────────────────────────

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

    async put(namespace, collection, id, data, { expectedVersion, newVersion } = {}) {
      const h = this.headers();
      if (expectedVersion) h["If-Match"]      = expectedVersion;
      if (newVersion)      h["X-New-Version"] = newVersion;

      const r = await fetch(`${CONFIG.apiBase}/${namespace}/${collection}/${id}`, {
        method: "PUT",
        headers: h,
        body: JSON.stringify(data),
      });

      if (r.status === 409) {
        const err = new Error("conflict");
        err.isConflict = true;
        err.remote = await r.json();
        throw err;
      }
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

  // ─── Pending sync queue ───────────────────────────────────────────────────────

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

  // ─── Causal dependency check ─────────────────────────────────────────────────

  async function checkCausalDeps(op) {
    for (const dep of op.dependsOn) {
      const key = `__isdet__${op.namespace}__${dep.collection}__${dep.id}`;
      const stored = await LocalStorage.get(key);
      if (stored?._version && stored._version !== dep.version) {
        return {
          collection: dep.collection,
          id: dep.id,
          declaredVersion: dep.version,
          currentVersion: stored._version,
          currentData: stored.data,
        };
      }
    }
    return null;
  }

  // ─── Sync engine ─────────────────────────────────────────────────────────────

  const SyncEngine = {
    _status: "idle",
    _listeners: [],
    _timer: null,
    _lastSync: null,
    _conflicts: [],  // unresolved 409s when no onConflict handler is configured

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
            // Check causal dependencies before sending
            if (op.dependsOn?.length) {
              const causalConflict = await checkCausalDeps(op);
              if (causalConflict) {
                CONFIG.onCausalConflict?.({ stale: op, changedDependency: causalConflict });
                await Queue.remove(op.namespace, op.collection, op.id);
                continue;
              }
            }

            await Api.put(op.namespace, op.collection, op.id, op.data, {
              expectedVersion: op.expectedVersion ?? null,
              newVersion: op.newVersion ?? null,
            });
          } else if (op.type === "remove") {
            await Api.delete(op.namespace, op.collection, op.id);
          }
          await Queue.remove(op.namespace, op.collection, op.id);
        } catch (e) {
          if (e.isConflict) {
            // 409 is not a network error — retrying will not help
            if (CONFIG.onConflict) {
              CONFIG.onConflict({ op, remote: e.remote });
            } else {
              this._conflicts.push({ op, remote: e.remote, detectedAt: Date.now() });
              console.warn("[IsdetTools] OCC conflict (no onConflict handler):", op.namespace, op.collection, op.id);
            }
            await Queue.remove(op.namespace, op.collection, op.id);
          } else {
            const retries = (op.retries || 0) + 1;
            if (retries < CONFIG.maxRetries) {
              failed.push({ ...op, retries });
            }
          }
        }
      }

      if (this._conflicts.length) {
        this._emit("conflict", { pending: this._conflicts.length });
      } else if (failed.length) {
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

  // ─── Collection ───────────────────────────────────────────────────────────────

  function createCollection(namespace, collectionName) {
    if (!/^[a-zA-Z0-9_-]+$/.test(collectionName)) {
      throw new Error("invalid collection: use only letters, numbers, - and _");
    }

    function recordKey(id) {
      return `__isdet__${namespace}__${collectionName}__${id}`;
    }
    const indexKey = `__isdet__${namespace}__${collectionName}__$index`;

    const col = {
      // ── Local index ───────────────────────────────────────────────────────────

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

      // ── Public API ────────────────────────────────────────────────────────────

      /**
       * Saves (insert or update) a record.
       * If data.id is omitted, a UUID is generated automatically.
       * Accepts an optional second argument { dependsOn } to declare causal dependencies.
       * Returns the saved object with the id used.
       */
      async save(data, { dependsOn } = {}) {
        const id = data.id != null ? String(data.id) : crypto.randomUUID();
        const now = Date.now();
        const newVersion = crypto.randomUUID();

        const existing = await LocalStorage.get(recordKey(id));
        const createdAt = existing?._createdAt ?? now;
        const expectedVersion = existing?._version ?? null;

        await LocalStorage.set(recordKey(id), {
          data,
          _createdAt: createdAt,
          _updatedAt: now,
          _version: newVersion,
          _dependsOn: dependsOn ?? null,
        });
        await this._addToIndex(id);
        await Queue.push({
          type: "save",
          namespace,
          collection: collectionName,
          id,
          data,
          expectedVersion,
          newVersion,
          dependsOn: dependsOn ?? null,
        });
        SyncEngine.flush();

        return { ...data, id: data.id != null ? data.id : id };
      },

      /**
       * Finds a record by id. Returns null if not found.
       * Checks the remote version in background without blocking.
       * Does not overwrite local cache if a write is pending in the queue.
       */
      async find(id) {
        const sid = String(id);
        const local = await LocalStorage.get(recordKey(sid));

        Api.getOne(namespace, collectionName, sid)
          .then(async (remote) => {
            const queue = await Queue.load();
            const hasPending = queue.some(
              (o) => o.type === "save" &&
                     o.namespace === namespace &&
                     o.collection === collectionName &&
                     o.id === sid
            );
            if (hasPending) return;

            if ((remote.updated_at ?? 0) > (local?._updatedAt ?? 0)) {
              await LocalStorage.set(recordKey(sid), {
                data: remote.data,
                _createdAt: remote.created_at,
                _updatedAt: remote.updated_at,
                _version: remote.version ?? null,
                _dependsOn: local?._dependsOn ?? null,
              });
              await col._addToIndex(sid);
            }
          })
          .catch(() => {});

        return local ? local.data : null;
      },

      /**
       * Finds a record by id and returns both data and version metadata.
       * Use when declaring causal dependencies via save(data, { dependsOn }).
       * Returns null if not found.
       */
      async findWithMeta(id) {
        const sid = String(id);
        const local = await LocalStorage.get(recordKey(sid));

        Api.getOne(namespace, collectionName, sid)
          .then(async (remote) => {
            const queue = await Queue.load();
            const hasPending = queue.some(
              (o) => o.type === "save" &&
                     o.namespace === namespace &&
                     o.collection === collectionName &&
                     o.id === sid
            );
            if (hasPending) return;

            if ((remote.updated_at ?? 0) > (local?._updatedAt ?? 0)) {
              await LocalStorage.set(recordKey(sid), {
                data: remote.data,
                _createdAt: remote.created_at,
                _updatedAt: remote.updated_at,
                _version: remote.version ?? null,
                _dependsOn: local?._dependsOn ?? null,
              });
              await col._addToIndex(sid);
            }
          })
          .catch(() => {});

        return local ? { data: local.data, version: local._version ?? null } : null;
      },

      /**
       * Returns all records in the collection (local-first).
       * Syncs with the server in background.
       * Does not overwrite local cache for records with pending writes.
       */
      async findAll() {
        const idx = await this._getIndex();
        const entries = await Promise.all(idx.map((id) => LocalStorage.get(recordKey(id))));
        const local = entries.filter(Boolean).map((r) => r.data);

        Api.getAll(namespace, collectionName)
          .then(async (remote) => {
            const queue = await Queue.load();
            for (const r of remote.records) {
              const hasPending = queue.some(
                (o) => o.type === "save" &&
                       o.namespace === namespace &&
                       o.collection === collectionName &&
                       o.id === r.id
              );
              if (hasPending) continue;

              const existing = await LocalStorage.get(recordKey(r.id));
              if ((r.updated_at ?? 0) > (existing?._updatedAt ?? 0)) {
                await LocalStorage.set(recordKey(r.id), {
                  data: r.data,
                  _createdAt: r.created_at,
                  _updatedAt: r.updated_at,
                  _version: r.version ?? null,
                  _dependsOn: existing?._dependsOn ?? null,
                });
                await col._addToIndex(r.id);
              }
            }
          })
          .catch(() => {});

        return local;
      },

      /**
       * Removes a record by id.
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

  // ─── Store per namespace ──────────────────────────────────────────────────────

  function createStore(namespace) {
    if (!namespace || !/^[a-zA-Z0-9_-]+$/.test(namespace)) {
      throw new Error("invalid namespace: use only letters, numbers, - and _");
    }

    const _collections = {};

    return {
      namespace,

      /**
       * Returns (or creates) the collection with the given name.
       * Instances are memoized within the store.
       */
      collection(name) {
        if (!_collections[name]) {
          _collections[name] = createCollection(namespace, name);
        }
        return _collections[name];
      },

      /**
       * Forces immediate flush of the pending sync queue.
       */
      sync() {
        return SyncEngine.flush();
      },
    };
  }

  // ─── Public API ───────────────────────────────────────────────────────────────

  global.IsdetTools = {
    /**
     * Configures the SDK and starts the sync engine.
     * Call once, before creating stores.
     *
     * onConflict({ op, remote })
     *   Called when a PUT returns 409 (server version mismatch).
     *   The op is removed from the queue — re-save to retry.
     *
     * onCausalConflict({ stale, changedDependency })
     *   Called when a record's declared dependency has changed before flush.
     *   The op is removed from the queue — re-derive and re-save to retry.
     */
    configure({ token, syncInterval, apiBase, onConflict, onCausalConflict } = {}) {
      if (token)            CONFIG.token = token;
      if (syncInterval)     CONFIG.syncInterval = syncInterval;
      if (apiBase)          CONFIG.apiBase = apiBase;
      if (onConflict)       CONFIG.onConflict = onConflict;
      if (onCausalConflict) CONFIG.onCausalConflict = onCausalConflict;
      SyncEngine.start();
    },

    /**
     * Creates an isolated store per namespace.
     * Use store.collection(name) to access collections.
     */
    createStore,

    /**
     * Subscribes to sync status changes.
     * Used by isdet-tools-sync-status.js to render the visual indicator.
     */
    onSyncStatus: (fn) => SyncEngine.onStatus(fn),

    /**
     * Forces immediate flush of the pending sync queue.
     */
    sync: () => SyncEngine.flush(),
  };
})(window);
