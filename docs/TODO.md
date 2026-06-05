## TODO

### Decisões arquiteturais

- [ ] Avaliar Event Sourcing vs OCC + causalidade antes de fechar abordagem — ver `docs/local-first-consistency.md`
- [ ] Implementar OCC + dependências causais no SDK (versionamento de registros, `dependsOn` no save, `onCausalConflict` no configure)

---

### Pitfalls do modelo local-first

- [ ] **Background read sobrescreve pending write** — `find()`/`findAll()` podem sobrescrever dados locais não sincronizados se o servidor tiver `updated_at` mais recente, causando flip-flop entre estado local e remoto
- [ ] **Clock skew** — `Date.now()` do cliente não é confiável como critério de ordem causal; dois saves com menos de 1ms de diferença ou relógios desajustados podem inverter a ordem real dos eventos
- [ ] **Queue snapshot vs estado atual** — a fila guarda snapshot do momento do `save()`, não o estado atual; se o registro for atualizado remotamente e lido em background antes do flush, o snapshot antigo sobrescreve a versão remota mais recente
- [ ] **Max retries silencioso** — após 5 falhas de sync, a operação é descartada sem rastro persistente; sem handler na aplicação, o dado é perdido silenciosamente
- [ ] **Múltiplas abas** — duas abas do mesmo usuário têm filas e ciclos de sync independentes; uma aba pode derivar registros a partir de dados já desatualizados pela outra
- [ ] **Index desync não atômico** — `_addToIndex` não é atômico com o `set` do registro; falha parcial deixa o registro gravado em storage mas invisível para `findAll()`
- [ ] **Storage quota** — quando a quota do localStorage é atingida, `setItem` lança exceção que o SDK silencia; o registro parece salvo mas não foi gravado, sem nenhum alerta
