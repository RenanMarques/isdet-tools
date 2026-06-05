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
│   └── isdet-tools-sdk.js         ← SDK compartilhado (storage, sync, status)
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
   <script src="/shared/isdet-tools-sdk.js"></script>
   <script>
     IsdetTools.configure({ token: window.__ISDET_TOKEN__ || "" });
     IsdetTools.mountSyncStatus(document.getElementById("sync-status"));
     const db = IsdetTools.createStore("nome-da-ferramenta");
   </script>
   ```
3. Adicione um link em `index.html`
4. Faça commit — o Cloudflare Pages publica automaticamente

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
