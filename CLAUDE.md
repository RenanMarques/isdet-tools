# isdet-tools

Ferramentas internas para IsdetCompany hospedadas no Cloudflare Pages. Cada ferramenta é uma página HTML isolada que usa um SDK compartilhado para persistência local-first com sync automático.

## Stack

- **Cloudflare Pages** — hospedagem estática + Pages Functions
- **Cloudflare D1** (SQLite) — persistência via `env.DB`
- **Cloudflare Access** — autenticação no browser (JWT automático)
- Sem build step, sem npm, JS vanilla

## Camadas

```
apps/<tool>/index.html       UI + lógica da ferramenta
shared/isdetart-sdk.js       SDK compartilhado (IIFE → window.IsdetTools)
functions/api/[[route]].js   Worker gateway (REST → D1)
```

## Modelo de dados

Rotas do Worker seguem sempre o padrão de 3 segmentos:

```
/api/:namespace/:collection/:id
```

D1 — tabela `records(namespace, collection, id, data, created_at, updated_at)`.
`namespace` = ferramenta. `collection` = tipo de entidade. `id` = TEXT (string).

## Invariantes do SDK

- **Local-first**: `findAll()` e `find()` retornam o cache local imediatamente; o servidor é consultado em background. Não assuma dados frescos do servidor na chamada.
- **Índice de coleção**: `__isdet__<ns>__<coll>__$index` é um array de IDs em localStorage, fonte de verdade local para `findAll()`. É reconstruído automaticamente após sync remoto — nunca manipular diretamente.
- **IDs numéricos** (`Date.now()`) são aceitos — o SDK os stringifica internamente para chaves de storage e URLs; o campo `id` dentro do objeto `data` preserva o tipo original.
- `save()` e `remove()` já disparam flush. Não chamar `store.sync()` em fluxos normais.
- **Single-user**: sem resolução de conflito além de last-write-wins por `updated_at`. Não adicionar lógica de merge.

## Invariantes do Worker

- `created_at` nunca é sobrescrito no `ON CONFLICT DO UPDATE` — ausente da cláusula UPDATE intencionalmente.
- Mudanças no schema D1 são **sempre aditivas** (novas tabelas ou colunas). Nunca `DROP TABLE` nem `DROP COLUMN`.
- Auth aceita Bearer token (`ISDET_TOOLS_API_TOKEN`) **ou** CF Access JWT — ambos válidos; não remover nenhum dos dois caminhos.

## Adicionar uma nova ferramenta

1. Criar `apps/<nome>/index.html`
2. Carregar o SDK: `<script src="/shared/isdetart-sdk.js"></script>`
3. Inicializar: `IsdetTools.configure({})` e `const store = IsdetTools.createStore('<nome>')`
4. Usar coleções: `const col = store.collection('<entidade>')` com `save / find / findAll / remove`

Sem migração de banco necessária — coleções novas surgem no primeiro `save()`.

## Naming Convention

**All names in code must be English.** Only UI text displayed to the user stays in Portuguese.

This applies to:
- JavaScript identifiers (variables, functions, constants)
- HTML element IDs and CSS class names introduced by tools
- Data object property names (stored as JSON in D1)
- Stored enum values (e.g. status codes like `"validated"`, `"failed"`)
- Namespace and collection names passed to the SDK
- Folder and file names under `apps/`

Does **not** apply to:
- Visible UI text: labels, button text, placeholders, headings, alert messages
- Sync status strings rendered by the SDK (`"Sincronizando…"`, etc.)


# Instruções para Claude Code

## Push de commits

**Em ambientes normais (CLI, IDE), use `git push` normalmente — funciona sem restrições.**

O método alternativo abaixo é exclusivo do **Claude Code on the Web**, onde o proxy
git local bloqueia push com 403. Antes de qualquer push, detecte o ambiente:

```bash
# Estou no Claude Code on the Web se o remote usa o proxy local:
git remote get-url origin
# web:  http://127.0.0.1:38841/...  → usar método via API (abaixo)
# demais: https://github.com/...    → usar git push normalmente
```

Ou verifique a variável de ambiente `CCR_TEST_GITPROXY`:
```bash
# Se CCR_TEST_GITPROXY=1, estamos no Claude Code on the Web
echo $CCR_TEST_GITPROXY
```

---

### Método padrão (CLI / IDE)

```bash
git push -u origin NOME-DA-BRANCH
```

---

### Método alternativo — somente Claude Code on the Web

O proxy git e o servidor MCP do GitHub não têm permissão de escrita neste ambiente.
Usar `$GITHUB_TOKEN` (disponível no ambiente) via API REST do GitHub.

**1. Garantir autor correto no commit:**
```bash
git config user.email noreply@anthropic.com
git config user.name Claude
```

**2. Criar a branch no remoto (se ainda não existir):**
```bash
BASE_SHA=$(curl -s -H "Authorization: Bearer $GITHUB_TOKEN" \
  https://api.github.com/repos/RenanMarques/isdet-tools/git/ref/heads/master \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['object']['sha'])")

curl -s -X POST \
  -H "Authorization: Bearer $GITHUB_TOKEN" \
  -H "Content-Type: application/json" \
  https://api.github.com/repos/RenanMarques/isdet-tools/git/refs \
  -d "{\"ref\": \"refs/heads/NOME-DA-BRANCH\", \"sha\": \"$BASE_SHA\"}"
```

**3. Publicar cada arquivo alterado:**
```bash
FILE_SHA=$(curl -s -H "Authorization: Bearer $GITHUB_TOKEN" \
  "https://api.github.com/repos/RenanMarques/isdet-tools/contents/CAMINHO?ref=NOME-DA-BRANCH" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['sha'])")

NEW_CONTENT=$(base64 -w 0 CAMINHO-LOCAL)

curl -s -X PUT \
  -H "Authorization: Bearer $GITHUB_TOKEN" \
  -H "Content-Type: application/json" \
  "https://api.github.com/repos/RenanMarques/isdet-tools/contents/CAMINHO" \
  -d "{
    \"message\": \"mensagem do commit\",
    \"content\": \"$NEW_CONTENT\",
    \"sha\": \"$FILE_SHA\",
    \"branch\": \"NOME-DA-BRANCH\",
    \"committer\": {\"name\": \"Claude\", \"email\": \"noreply@anthropic.com\"},
    \"author\": {\"name\": \"Claude\", \"email\": \"noreply@anthropic.com\"}
  }"
```

**4. Sincronizar o branch local com o remoto (obrigatório após push via API):**

Após publicar via API, o branch local tem commits diferentes dos criados pela API.
Isso faz o hook de fim de sessão reclamar de commits não enviados. Resolver com:
```bash
git fetch origin NOME-DA-BRANCH
git reset --hard origin/NOME-DA-BRANCH
```

---

**Verificar permissões do token (diagnóstico):**
```bash
curl -s -H "Authorization: Bearer $GITHUB_TOKEN" \
  https://api.github.com/repos/RenanMarques/isdet-tools \
  | python3 -c "import sys,json; print(json.load(sys.stdin).get('permissions'))"
# deve retornar: {'admin': True, 'push': True, ...}
```
