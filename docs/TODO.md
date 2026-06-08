## TODO

### Decisões arquiteturais

- [x] Avaliar Event Sourcing vs OCC + causalidade — decidido: OCC + causalidade (ver `docs/local-first-consistency.md`)
- [x] Implementar OCC + dependências causais no SDK
- [x] **Conflito 409 sem `onConflict` configurado** — resolvido: ops sem handler (409, causal conflict, max-retries) vão para fila dead-letter persistente em localStorage (`__isdet_dead_letter__`). Sobrevive ao reload. Exposto via `IsdetTools.getDeadLetterOps()` / `IsdetTools.dismissDeadLetterOp(id)`. Indicador mostra estado `"dead_letter"` com contagem.

---

### Pitfalls do modelo local-first

- [x] **Background read sobrescreve pending write** — corrigido: `find()`/`findAll()` verificam a fila antes de sobrescrever; se houver pending write para o mesmo id, o cache local é preservado
- [x] **Clock skew** — resolvido: background read em `find()`, `findWithMeta()` e `findAll()` compara `version` UUID diretamente; `version` é obrigatório, sem fallback para timestamp
- [x] **Queue snapshot vs estado atual** — resolvido como consequência do fix de background read: o cache local nunca é sobrescrito enquanto há pending write, então o snapshot da fila permanece consistente com o localStorage
- [x] **Max retries silencioso** — resolvido: op que esgota `maxRetries` vai para dead-letter persistente em vez de ser descartada silenciosamente (ver item de Conflito 409 acima)
- [x] **Múltiplas abas** — resolvido: escritas e remoções são propagadas entre abas via `BroadcastChannel("__isdet_sync__")`; localStorage é atualizado imediatamente em outras abas (com guarda contra pending writes). Apps registram `IsdetTools.onCrossTabWrite(() => load())` para reagir na camada de memória
- [x] **Index desync não atômico** — resolvido: `save()` agora escreve o índice ANTES do registro; falha parcial gera entrada órfã no índice (inofensiva, `findAll()` filtra nulls) em vez de registro invisível
- [x] **Storage quota** — resolvido: `LocalStorage.set` não silencia mais erros de storage; `save()` rejeita a promise quando a quota é atingida, permitindo que a app faça `catch` e alerte o usuário. Indicador tem estado `"quota"` disponível.

---

### Lacunas de teste

- [ ] **`dismissDeadLetterOp` — teste de integração real** — coberto apenas com mocks; falta teste contra wrangler dev que dispara OCC 409 real → verifica dead-letter → chama dismiss → confirma remoção
- [ ] **Multi-aba — teste de integração real** — `onCrossTabWrite` coberto só com mocks; falta teste Playwright com duas páginas reais contra wrangler dev
- [ ] **Quota + sync race** — `save()` rejeitando por quota está testado no browser isolado; falta testar o que acontece quando Worker responde 200 mas o browser falha ao persistir (quota esgotada durante flush)
- [ ] **Worker: rotas inválidas e métodos não permitidos** — sem testes de contrato para 404 (rota inexistente) e 405 (método não permitido); validar que o Worker responde corretamente nesses casos
- [ ] **Testes E2E das ferramentas em `apps/`** — nenhum app tem teste de ponta a ponta; cobrir pelo menos o fluxo principal de cada ferramenta existente
