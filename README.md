# isdet-tools

Infraestrutura compartilhada para ferramentas pessoais hospedadas em `tools.isdet.net`.

## Estrutura do projeto

```
isdet-tools/
├── index.html                  ← página inicial (lista de ferramentas)
├── apps/
│   └── custos/
│       └── index.html          ← ferramenta de controle de custos
├── shared/
│   └── isdetart-sdk.js         ← SDK compartilhado (storage, sync, status)
├── functions/
│   └── api/
│       └── [[route]].js        ← Worker gateway (D1, autenticação)
├── wrangler.toml               ← configuração do Cloudflare
├── .dev.vars                   ← segredos locais (não entra no git)
└── .gitignore
```

## Adicionar uma nova ferramenta

1. Crie `apps/nome-da-ferramenta/index.html`
2. Inclua o SDK e inicialize com um namespace único:
   ```html
   <script src="/shared/isdetart-sdk.js"></script>
   <script>
     IsdetTools.configure({ token: window.__ISDET_TOKEN__ || "" });
     IsdetTools.mountSyncStatus(document.getElementById("sync-status"));
     const db = IsdetTools.createStore("nome-da-ferramenta");
   </script>
   ```
3. Adicione um link em `index.html`
4. Faça commit — o Cloudflare Pages publica automaticamente

---

## Publicação inicial (passo a passo)

### Pré-requisitos

- Conta GitHub (gratuita)
- Conta Cloudflare com o domínio `isdet.net` já configurado
- Node.js instalado localmente (para usar o Wrangler CLI)

---

### Passo 1 — Instalar o Wrangler CLI

```bash
npm install -g wrangler
wrangler login
```

O `wrangler login` abre o navegador para autenticar com sua conta Cloudflare.

---

### Passo 2 — Criar o banco D1

```bash
wrangler d1 create isdet-tools-db
```

O comando retorna algo como:

```
✅ Successfully created DB 'isdet-tools-db'
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

Copie o `database_id` e cole no `wrangler.toml`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "isdet-tools-db"
database_id   = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"  ← aqui
```

---

### Passo 3 — Criar o repositório no GitHub

```bash
cd isdet-tools
git init
git add .
git commit -m "chore: estrutura inicial"
```

No GitHub, crie um repositório (pode ser privado) chamado `isdet-tools`.
Depois:

```bash
git remote add origin https://github.com/SEU_USUARIO/isdet-tools.git
git push -u origin main
```

---

### Passo 4 — Criar o projeto no Cloudflare Pages

1. No painel da Cloudflare: **Workers & Pages → Create → Pages → Connect to Git**
2. Autorize o GitHub e selecione o repositório `isdet-tools`
3. Configurações de build:
   - **Framework preset**: None
   - **Build command**: *(deixar em branco)*
   - **Build output directory**: *(deixar em branco ou `/`)*
4. Clique em **Save and Deploy**

Após o deploy, o projeto estará em `isdet-tools.pages.dev`.

---

### Passo 5 — Vincular o banco D1 ao Pages

No painel do Cloudflare, no projeto Pages recém-criado:

1. Vá em **Settings → Functions → D1 database bindings**
2. Clique em **Add binding**
3. Variable name: `DB`
4. D1 database: selecione `isdet-tools-db`
5. Salve

---

### Passo 6 — Configurar variáveis de ambiente (segredos)

No painel do Cloudflare, ainda nas Settings do projeto Pages:

1. Vá em **Settings → Environment variables**
2. Em **Production**, clique em **Add variable**
3. Nome: `ISDET_TOOLS_API_TOKEN`
4. Valor: `vdbJEKmk1DROS9j5nTCwhRbXMQMED8GCZfKV8pdGtyE`
5. Marque como **Encrypt** (transforma em segredo — não fica visível depois)
6. Salve e faça **redeploy** (Settings → Deployments → Retry deployment)

> ⚠️ Nunca coloque o token diretamente no código ou no `wrangler.toml`.
> O `.dev.vars` é só para desenvolvimento local e já está no `.gitignore`.

---

### Passo 7 — Configurar o domínio customizado

No painel do Cloudflare, no projeto Pages:

1. Vá em **Custom domains → Add custom domain**
2. Digite `tools.isdet.net`
3. Como o domínio já está na Cloudflare, o DNS é configurado automaticamente
4. Aguarde a propagação (geralmente menos de 1 minuto)

---

### Passo 8 — Ativar o Cloudflare Access (autenticação do browser)

Em vez de expor o token no HTML, usamos o **Cloudflare Access** (plano free)
para proteger o domínio. O Access autentica o visitante por e-mail/OTP e injeta
um JWT assinado em cada requisição — o Worker valida esse JWT sem precisar de
nada no HTML.

#### 8.1 — Criar a aplicação no Zero Trust

1. No painel da Cloudflare: **Zero Trust → Access → Applications → Add an application**
2. Escolha **Self-hosted**
3. Preencha:
   - **Application name**: `isdet-tools`
   - **Application domain**: `tools.isdet.net`
4. Em **Policies**, crie uma regra do tipo **Allow** com selector **Emails** e
   adicione o seu e-mail (`renan_gmarques@hotmail.com`)
5. Salve a aplicação

#### 8.2 — Obter o AUD tag e o Team Domain

Após salvar a aplicação:

1. Clique em **Configure** na aplicação recém-criada
2. Em **Additional settings**, copie o **Application Audience (AUD) Tag** (string hexadecimal)
3. O **Team Domain** está em **Zero Trust → Settings → Custom Pages** ou na URL do
   painel: `https://seutime.cloudflareaccess.com`

#### 8.3 — Adicionar as variáveis de ambiente no Pages

No painel da Cloudflare, no projeto Pages:

1. **Settings → Environment variables → Production → Add variable**
2. Adicione as duas variáveis abaixo e marque ambas como **Encrypt**:

   | Nome | Valor |
   |------|-------|
   | `CF_TEAM_DOMAIN` | `https://seutime.cloudflareaccess.com` |
   | `CF_POLICY_AUD` | o AUD tag copiado no passo anterior |

3. Faça **redeploy** (Settings → Deployments → Retry deployment)

#### Como funciona a partir de agora

- **Browser**: o Access autentica via e-mail/OTP. Após o login, o Cloudflare injeta
  automaticamente o header `Cf-Access-Jwt-Assertion` em cada requisição ao Worker.
  O Worker valida o JWT com a chave pública do seu team domain — nenhum token
  aparece no HTML.
- **Claude.ai / acesso programático**: ainda usa o Bearer token via
  `IsdetTools.configure({ token: "..." })`. O Worker aceita ambos os métodos.

> **Teste local**: para desenvolvimento com `wrangler pages dev`, o Cloudflare
> Access não está ativo. Adicione `CF_TEAM_DOMAIN` e `CF_POLICY_AUD` no `.dev.vars`
> com os valores reais, ou use o Bearer token normalmente.

---

## Desenvolvimento local

Para testar com o Worker e o D1 localmente:

```bash
wrangler pages dev . --d1=DB
```

O Wrangler lê o `.dev.vars` automaticamente e serve o projeto em
`http://localhost:8788`.

---

## API do Worker (referência)

Todos os endpoints exigem o header:
```
Authorization: Bearer <ISDET_TOOLS_API_TOKEN>
```

| Método | Rota | Descrição |
|--------|------|-----------|
| `GET` | `/api/:namespace` | Lista chaves do namespace |
| `GET` | `/api/:namespace/:key` | Lê um valor |
| `PUT` | `/api/:namespace/:key` | Escreve um valor |
| `DELETE` | `/api/:namespace/:key` | Remove um valor |

Namespaces em uso:
- `custos` — ferramenta de controle de custos (IsdetArt)

---

## API do SDK (referência)

```javascript
// Inicialização (uma vez por ferramenta)
IsdetTools.configure({ token: "..." })

// Indicador de status de sync
IsdetTools.mountSyncStatus(document.getElementById("sync-status"))

// Store por ferramenta
const db = IsdetTools.createStore("namespace-da-ferramenta")

await db.get("chave")           // lê local, busca remoto em background
await db.set("chave", valor)    // escreve local + enfileira sync
await db.delete("chave")        // remove local + enfileira sync
await db.sync()                 // força flush da fila de sync
```
