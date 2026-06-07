## TODO

### Decisões arquiteturais

- [x] Avaliar Event Sourcing vs OCC + causalidade — decidido: OCC + causalidade (ver `docs/local-first-consistency.md`)
- [x] Implementar OCC + dependências causais no SDK
- [x] **Conflito 409 sem `onConflict` configurado** — resolvido: ops sem handler (409, causal conflict, max-retries) vão para fila dead-letter persistente em localStorage (`__isdet_dead_letter__`). Sobrevive ao reload. Exposto via `IsdetTools.getDeadLetterOps()` / `IsdetTools.dismissDeadLetterOp(id)`. Indicador mostra estado `"dead_letter"` com contagem.

---

### Pitfalls do modelo local-first

- [x] **Background read sobrescreve pending write** — corrigido: `find()`/`findAll()` verificam a fila antes de sobrescrever; se houver pending write para o mesmo id, o cache local é preservado
- [x] **Clock skew** — resolvido: background read em `find()`, `findWithMeta()` e `findAll()` agora compara `version` UUID para detectar se o servidor tem dados mais novos; fallback para `updated_at` somente quando `version` está ausente (registros legados pré-OCC)
- [x] **Queue snapshot vs estado atual** — resolvido como consequência do fix de background read: o cache local nunca é sobrescrito enquanto há pending write, então o snapshot da fila permanece consistente com o localStorage
- [x] **Max retries silencioso** — resolvido: op que esgota `maxRetries` vai para dead-letter persistente em vez de ser descartada silenciosamente (ver item de Conflito 409 acima)
- [x] **Múltiplas abas** — resolvido: escritas e remoções são propagadas entre abas via `BroadcastChannel("__isdet_sync__")`; localStorage é atualizado imediatamente em outras abas (com guarda contra pending writes). Apps registram `IsdetTools.onCrossTabWrite(() => load())` para reagir na camada de memória
- [x] **Index desync não atômico** — resolvido: `save()` agora escreve o índice ANTES do registro; falha parcial gera entrada órfã no índice (inofensiva, `findAll()` filtra nulls) em vez de registro invisível
- [x] **Storage quota** — resolvido: `LocalStorage.set` não silencia mais erros de storage; `save()` rejeita a promise quando a quota é atingida, permitindo que a app faça `catch` e alerte o usuário. Indicador tem estado `"quota"` disponível.
