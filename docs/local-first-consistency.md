## Consistência no modelo local-first

Este documento registra os limites do modelo de sync atual do SDK e as alternativas
avaliadas para endereçá-los. Serve de referência para a decisão de evoluir o SDK.

---

### O problema não é single-user vs multi-user

O SDK opera em modo local-first: o cliente grava localmente de forma imediata e
sincroniza com o servidor em background. Isso cria dois escritores assíncronos —
o cliente offline e o servidor — mesmo que seja um único usuário.

O modelo atual resolve conflitos por **last-write-wins** (`updated_at`): a versão mais
recente prevalece, sem detecção de relações causais entre registros.

---

### O problema de causalidade entre registros

O cenário que expõe a limitação:

```
T1  Carrega A.v1 do servidor  →  local: A = { v1 }

T2  save(A.v2.local)          →  local: A = { v2.local }
                                  fila:  [save A.v2.local]
                                  (sync offline — falha)

T3  save(B, baseado em A.v2.local)
                              →  local: B = { ... baseado em v2.local ... }
                                  fila:  [save A.v2.local, save B]

    Nesse intervalo, alguém altera A no servidor:
    servidor: A = { v2.remote },  updated_at = T3

T4  Sync volta →  flush envia A.v2.local e B para o servidor
                  background read detecta A.v2.remote mas já é tarde
```

**O que acontece com B?** B sincroniza normalmente com os dados que recebeu em `save()`.
O SDK não tem nenhum conceito de "B foi derivado de A". A inconsistência é semântica —
B foi computado a partir de uma versão de A que não reflete mais a realidade —
e é completamente silenciosa.

---

### Espectro de modelos de consistência

```
simplicidade ──────────────────────────────────────────► complexidade
garantia     ◄──────────────────────────────────────────

  LWW          OCC           CRDT          Event Sourcing
  ───          ───           ────          ──────────────
  atual        detecta       auto-merge    histórico total
               conflito      (tipos        causalidade
               rejeita       limitados)    completa
               PUT
```

| Modelo | O que muda no SDK | O que muda na aplicação |
|---|---|---|
| **LWW** (atual) | nada | aceita inconsistência silenciosa |
| **OCC** | version por registro; PUT condicional na API | tratar rejeição do PUT; decidir: forçar, merge, abortar |
| **OCC + causalidade** | tudo acima + `dependsOn` no save; varredura de deps no sync | `onCausalConflict` handler; lógica de re-derivação ou invalidação |
| **CRDTs** | estruturas de dados específicas por tipo | dados devem caber nos tipos CRDT suportados |
| **Event Sourcing** | reescrever o SDK (armazenar eventos, não estados) | reescrever lógica como eventos; projeções derivadas |

---

### OCC + Dependências causais (abordagem adotada)

Três peças necessárias:

**1. Versão por registro**

`updated_at` é fraco como critério de causalidade (clock skew, precisão de ms).
Cada registro precisa de um identificador de versão que muda a cada write:

```js
// internamente no SDK, ao salvar:
{ data, _version: crypto.randomUUID(), _updatedAt: Date.now() }
```

**2. Declaração opcional de dependência no `save()`**

```js
// sem dependência (comportamento atual preservado)
await sessions.save({ id: 'b', cost: 50 })

// com dependência causal declarada
await sessions.save(
  { id: 'b', cost: 50 },
  { dependsOn: [{ collection: 'supplies', id: 'a', version: 'abc123' }] }
)
```

O metadado `dependsOn` é gravado junto ao registro local e enviado ao servidor.

**3. Detecção no sync e callback na aplicação**

Quando o sync traz A com uma versão diferente da declarada em `dependsOn` de B:

```js
IsdetTools.configure({
  onCausalConflict({ stale, changedDependency }) {
    // exemplos de resolução:
    // re-computar B com os novos dados de changedDependency
    // marcar B como "requer revisão"
    // remover B e forçar re-entrada
  }
})
```

**Ponto crítico:** o SDK detecta o conflito causal, mas apenas a aplicação sabe
como resolvê-lo — ela conhece a semântica do que "B derivado de A" significa.

---

### Event Sourcing — alternativa futura

> **Não adotado.** Registrado como referência caso o projeto demande consistência total.

Em vez de armazenar estados ("A = v2"), armazenar eventos ("preço de A foi alterado
de 100 para 200"). A causalidade fica registrada no log:

```
events:
  { id: 1, type: "price_updated", entity: "A", from: 100, to: 200, at: T1 }
  { id: 2, type: "session_created", entity: "B", based_on_price: 100, at: T2 }
```

O evento 2 tem `based_on_price: 100`, mas o evento 1 já mostra que o preço era 200.
O conflito é **rastreável pelo próprio modelo de dados**, não apenas detectável no sync.

O que a abordagem oferece além do OCC + causalidade:
- Histórico completo e auditável de toda mutação
- Possibilidade de re-projetar qualquer estado a partir de um ponto no tempo
- Conflitos entre eventos concorrentes podem ser resolvidos com regras por tipo de evento
- Pitfalls estruturais do local-first (queue snapshot, clock skew, index desync) ficam
  cobertos naturalmente pela ordenação do log de eventos

O custo é reescrita completa do SDK e das aplicações. Vale considerar se os pitfalls
que o OCC não cobre se tornarem recorrentes ou críticos na prática.

---

### Outros pitfalls do modelo local-first atual

Além do problema de causalidade, o modelo atual tem as seguintes fragilidades:

**Background read sobrescreve pending local write**
`find()` e `findAll()` atualizam o cache local se o servidor tiver `updated_at` mais
recente. Se houver uma gravação local pendente na fila que ainda não foi sincronizada,
ela pode ser sobrescrita silenciosamente antes do flush — o usuário vê os dados remotos
e, após o flush, os dados locais voltam ao servidor (flip-flop).

**Clock skew**
`Date.now()` no cliente não é confiável como critério de ordem causal entre eventos de
dispositivos diferentes ou em relação ao servidor. Dois saves com menos de 1ms de
diferença podem ter `updated_at` idênticos; relógios de sistemas mal ajustados podem
inverter a ordem real dos eventos.

**Queue snapshot vs estado atual**
A fila guarda um snapshot dos dados no momento do `save()`, não o estado atual do
registro. Se o registro for atualizado remotamente e lido em background antes do flush,
a fila envia o snapshot antigo ao servidor — sobrescrevendo a versão remota mais recente.

**Max retries silencioso**
Após 5 falhas de sync, a operação é descartada da fila sem nenhum rastro persistente.
O status emite `"error"` mas, se a aplicação não tiver um handler, o dado é perdido
silenciosamente sem possibilidade de recuperação.

**Múltiplas abas**
Duas abas do mesmo usuário compartilham o localStorage mas têm filas e ciclos de sync
independentes. Uma aba pode gravar A.v2 enquanto a outra ainda exibe A.v1 e deriva
novos registros com base nele — o mesmo problema de causalidade, agora dentro do
mesmo navegador, sem nenhuma comunicação entre contextos.

**Index desync não atômico**
`_addToIndex` não é atômico com o `set` do registro. Se `LocalStorage.set(recordKey)`
tiver sucesso mas `LocalStorage.set(indexKey)` falhar (ex: quota atingida na segunda
chamada), o registro existe em storage mas não aparece no `findAll()` — invisível até
o próximo sync remoto reconstruir o índice.

**Storage quota**
`localStorage` tem limite de aproximadamente 5–10 MB por origem. Quando a quota é
atingida, `localStorage.setItem` lança uma exceção que o SDK captura e silencia
(retorna `false`). O registro parece salvo para a aplicação mas não foi gravado.
Não há nenhum alerta para o usuário.

---

### Estado atual e próximos passos

- **Modelo atual:** LWW, sem versionamento de registros, sem detecção de conflito causal
- **Decisão:** adotar OCC + dependências causais
- **Event Sourcing:** descartado por ora — ver seção acima; reconsiderar se os pitfalls
  não cobertos pelo OCC se tornarem críticos na prática
