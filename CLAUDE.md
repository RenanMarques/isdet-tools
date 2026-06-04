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
