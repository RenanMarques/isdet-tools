## TODO

### Decisões arquiteturais

- [x] Avaliar Event Sourcing vs OCC + causalidade — decidido: OCC + causalidade (ver `docs/local-first-consistency.md`)
- [x] Implementar OCC + dependências causais no SDK
- [ ] **Conflito 409 sem `onConflict` configurado** — atualmente: op removida da fila, adicionada a `SyncEngine._conflicts` (memória), status `"conflict"` emitido, `console.warn`. Problema: ao recarregar a página os conflitos não resolvidos somem. Decidir: (a) dead-letter persistente em localStorage, (b) expor `IsdetTools.getConflicts()`, ou (c) tornar `onConflict` obrigatório no `configure()`

---

### Pitfalls do modelo local-first

- [x] **Background read sobrescreve pending write** — corrigido: `find()`/`findAll()` verificam a fila antes de sobrescrever; se houver pending write para o mesmo id, o cache local é preservado
- [ ] **Clock skew** — `Date.now()` do cliente não é confiável como critério de ordem causal; **parcialmente mitigado**: a detecção de conflito no flush agora usa UUID de versão (não timestamp), eliminando o clock skew do caminho principal. Residual: o background read ainda compara `updated_at` para decidir se atualiza o cache local
- [x] **Queue snapshot vs estado atual** — resolvido como consequência do fix de background read: o cache local nunca é sobrescrito enquanto há pending write, então o snapshot da fila permanece consistente com o localStorage
- [ ] **Max retries silencioso** — após 5 falhas de sync, a operação é descartada sem rastro persistente; sem handler na aplicação, o dado é perdido silenciosamente
- [ ] **Múltiplas abas** — duas abas do mesmo usuário têm filas e ciclos de sync independentes; uma aba pode derivar registros a partir de dados já desatualizados pela outra
- [ ] **Index desync não atômico** — `_addToIndex` não é atômico com o `set` do registro; falha parcial deixa o registro gravado em storage mas invisível para `findAll()`
- [ ] **Storage quota** — quando a quota do localStorage é atingida, `setItem` lança exceção que o SDK silencia; o registro parece salvo mas não foi gravado, sem nenhum alerta
