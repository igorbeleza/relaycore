# Spec 2 — Dashboard de acompanhamento de tokens economizados

- **Status:** Draft (aguardando revisão)
- **Data:** 2026-07-12
- **Autor:** brainstorming session
- **Projeto:** RelayCore
- **Relacionado:** Spec 1 — Deduplicação de conteúdo repetido no request (implementado, commit `fd0492c`)

---

## 1. Contexto e problema

O RelayCore já otimiza requests de duas formas — **pxpipe** (texto → imagem PNG) e
**dedup** (remoção de blocos duplicados) — e ambas emitem contadores Prometheus em
`/metrics` (`relaycore_pxpipe_*`, `relaycore_dedup_*`). Mas hoje esses números só existem
como texto Prometheus cru: **não há forma visual de acompanhar** quantos tokens estão sendo
economizados, a tendência ao longo do tempo, nem o breakdown por otimização.

Além disso, os contadores do `MetricsRegistry` são **in-memory** e **resetam a cada
restart** — não servem para acompanhamento histórico.

A referência de UX é o **dashboard do pxpipe** (`npx pxpipe-proxy`, servido em
`http://127.0.0.1:47821/`): um shell HTML servido pelo próprio proxy que faz _polling_ de
um fragmento de stats, com identidade visual "flame" (claro/escuro), cards, KPIs de tokens
economizados e tabela de requests recentes. O pxpipe persiste os eventos em
`~/.pxpipe/events.jsonl` (uma linha por request, com um contrafactual de `count_tokens`).

## 2. Objetivo

Entregar uma **dashboard web embutida** no RelayCore que mostra, de forma visual e com
auto-refresh, quanto está sendo economizado (dedup + pxpipe) e a saúde de tráfego do
gateway, **com histórico que sobrevive a restarts**. Deve espelhar o estilo do dashboard do
pxpipe e incorporar também as stats de deduplicação.

### Não-objetivos (fora de escopo deste spec)

- Autenticação/multi-tenant (dashboard é uso local, aberta em localhost).
- Medição real de billing via `count_tokens` da Anthropic (usamos a estimativa
  char→token já existente; um contrafactual real fica para um spec futuro).
- Banco de dados relacional / série temporal externa (Prometheus/Grafana permanece
  disponível via `/metrics` para quem quiser, mas não é requisito).
- Alertas, exportação, ou edição de configuração pela UI.
- Build step / framework de frontend (mantém a filosofia zero-build do projeto).

## 3. Decisões de design (travadas na brainstorming)

| #   | Decisão              | Escolha                                                                 |
| --- | -------------------- | ----------------------------------------------------------------------- |
| 1   | Formato/renderização | HTML embutido servido pelo Fastify, estilo do dashboard do pxpipe       |
| 2   | Histórico            | **Persistido** em disco (sobrevive a restarts)                          |
| 3   | Local + retenção     | `~/.relaycore/events.jsonl`, descarta eventos com **> 30 dias**         |
| 4   | Escopo de métricas   | **Otimizações + tráfego** (economia de tokens + requests/latência/erros) |
| 5   | Controle de acesso   | **Aberta em localhost** (sem token); bind default `127.0.0.1`           |
| 6   | Gráficos             | SVG inline gerado no servidor/cliente — **zero dependência de chart**   |
| 7   | Transporte de dados  | Página faz _polling_ de um endpoint JSON (`~5s`), estilo pxpipe         |

## 4. Arquitetura

```
request handler (messages.ts)
   └─ optimize(...) já produz OptimizationResult { dedup, pxpipe }
        └─ eventStore.append(event)        ← NOVO: 1 linha por request otimizado
                                              (~/.relaycore/events.jsonl)

startup (create-app.ts)
   └─ StatsAggregator.loadFrom(eventStore) ← relê o arquivo, reconstrói totais + buckets

GET /dashboard          → shell HTML self-contained (CSS + JS inline, zero build)
GET /dashboard/stats.json → StatsAggregator.snapshot() (polled ~5s pela página)
GET /metrics            → inalterado (Prometheus)
```

### 4.1 Novo módulo `src/dashboard/`

- **`event-store.ts`** — append-only em `~/.relaycore/events.jsonl`.
  - `append(event: OptimizationEvent): void` — serializa 1 linha JSON; escrita
    assíncrona best-effort (falha de I/O nunca derruba o request — apenas loga `warn`).
  - `readAll(): OptimizationEvent[]` — lê e faz parse tolerante (linhas corrompidas são
    ignoradas, não quebram o load).
  - **Retenção:** no startup e a cada N appends (ou via timer), reescreve o arquivo
    descartando eventos com `ts` mais antigo que 30 dias (`DASHBOARD_RETENTION_DAYS`).
  - Path configurável via `RELAYCORE_DATA_DIR` (default `os.homedir()/.relaycore`);
    cria o diretório se não existir. `os.homedir()` resolve corretamente em win32.
- **`aggregator.ts`** — `StatsAggregator` mantém, a partir dos eventos:
  - **Totais lifetime:** tokens economizados (dedup + pxpipe, separados e somados),
    blocos deduplicados, blocos convertidos, páginas renderizadas, requests, economia %
    estimada (tokens salvos / tokens de entrada estimados).
  - **Séries temporais:** buckets **por hora nas últimas 24h** e **por dia nos últimos
    30d** (tokens economizados + requests por bucket) → alimentam os gráficos de tendência.
  - **Tráfego:** total de requests, latência média e p95, erros upstream por tipo.
  - **Recent requests:** últimos N (ex.: 50) eventos, mais novos primeiro.
  - Atualização incremental: `record(event)` no caminho quente (append em memória) +
    `snapshot()` para o endpoint JSON. Evita reprocessar o arquivo a cada request.
- **`html.ts`** — gera o shell HTML estático (template string). Sem dados embutidos além
  do CSS/JS; os números vêm do polling de `/dashboard/stats.json`.

### 4.2 Rotas `src/routes/dashboard.ts`

- `registerDashboardRoute(app, config, aggregator)`.
- `GET /dashboard` → `text/html` com o shell.
- `GET /dashboard/stats.json` → `application/json` com `aggregator.snapshot()`.
- Registradas em `create-app.ts` apenas quando `DASHBOARD_ENABLED=true`.

### 4.3 Modelo do evento (`OptimizationEvent`)

```ts
type OptimizationEvent = {
  ts: number; // Date.now()
  requestId: string;
  method: string;
  route: string; // ex.: /v1/messages
  statusCode: number;
  durationMs: number;
  model?: string;
  bytesIn: number; // tamanho do body original
  bytesOut: number; // tamanho do body enviado ao upstream
  dedup: { blocksDeduped: number; estTokensSaved: number };
  pxpipe: {
    blocksConverted: number;
    pagesRendered: number;
    estTokensSaved: number;
    cacheHits: number;
    renderFailures: number;
    upstreamRejected: boolean;
  };
};
```

## 5. UI (espelhando o dashboard do pxpipe)

Layout single-page, tema "flame" claro/escuro com toggle (persistido em `localStorage`),
fonte monoespaçada, cards com `--radius`/`--shadow`. Sem framework, sem build.

Seções (de cima para baixo):

1. **Hero KPI** — número grande de **tokens economizados** (dedup + pxpipe somados) desde
   o início do histórico, com economia estimada em `%` e sub-labels de dedup vs pxpipe.
2. **Breakdown de otimizações** — dois cards lado a lado (espelha o "Image vs text
   breakdown" do pxpipe): **dedup** (blocos deduplicados, tokens) e **pxpipe** (blocos
   convertidos, páginas, cache hits, render failures).
3. **Tendência** ("Full history") — gráfico SVG inline: tokens economizados por hora (24h)
   / por dia (30d), com toggle de janela.
4. **Tráfego & erros** — requests totais, latência média/p95, tabela de erros upstream
   por `status_code` + `error_type`.
5. **Recent requests** — tabela dos últimos N requests: hora, rota, modelo, status,
   duração, tokens economizados.

Auto-refresh: JS faz `fetch('/dashboard/stats.json')` a cada ~5s e re-renderiza. Estado
vazio ("nenhum request otimizado ainda") tratado explicitamente, como no pxpipe.

## 6. Configuração (`src/config/env.ts`, estilo existente)

| Flag                       | Default            | Validação              | Descrição                                         |
| -------------------------- | ------------------ | ---------------------- | ------------------------------------------------- |
| `DASHBOARD_ENABLED`        | `true`             | `enum('true','false')` | Liga/desliga a dashboard e o event store          |
| `RELAYCORE_DATA_DIR`       | `~/.relaycore`     | string (trim)          | Diretório de persistência dos eventos             |
| `DASHBOARD_RETENTION_DAYS` | `30`               | `int 1..365`           | Descarta eventos mais antigos que N dias          |
| `DASHBOARD_RECENT_LIMIT`   | `50`               | `int 1..500`           | Quantos requests recentes exibir                  |

Adicionar os campos correspondentes a `AppConfig` e ao retorno de `loadConfig`, seguindo o
padrão dos campos existentes. `bind`/host permanece como já é hoje (localhost em dev).

## 7. Wiring no request handler

Em `src/routes/messages.ts`, no ponto onde `optimize` já retornou e as métricas são
gravadas, emitir **um** `OptimizationEvent` para o `eventStore` (injeção opcional, igual ao
`pxpipe`/`metrics`). Calcular `bytesIn`/`bytesOut` a partir do body original e do
`outboundBody`. A emissão é **best-effort** e **nunca** altera o fluxo/resposta do request.

Sempre registra o evento quando a dashboard está ligada — inclusive requests sem economia
(para que tráfego e latência reflitam a realidade), não só os otimizados.

## 8. Garantias de correção / segurança

- Falha de I/O no event store **nunca** derruba nem atrasa o request (best-effort + log).
- `DASHBOARD_ENABLED=false` → nenhuma rota registrada, nenhum arquivo criado (no-op total).
- Parse tolerante: linha corrompida no `.jsonl` é ignorada, não quebra o load nem a UI.
- Dashboard exibe apenas **metadados** (rota, modelo, tamanhos, contadores) — **nunca** o
  conteúdo dos prompts/respostas.
- Escrita append-only + reescrita atômica na rotação (grava em tmp + `rename`).
- Bind default `127.0.0.1` documentado; sem exposição de rede por padrão.

## 9. Plano de testes

**Unit:**

- `event-store`: append + readAll round-trip; parse tolerante (linha corrompida ignorada);
  retenção descarta > 30 dias e preserva o resto; cria diretório ausente; falha de I/O não
  lança (best-effort).
- `aggregator`: totais lifetime corretos (dedup + pxpipe somados); buckets horários/diários
  corretos; p95 de latência; erros agrupados; `snapshot()` estável; estado vazio.
- `config`: defaults e validação das 4 novas flags (aceita válidos, rejeita inválidos).
- `html`: shell contém as seções esperadas e referencia `/dashboard/stats.json`.

**Integração:**

- `DASHBOARD_ENABLED=false` → `GET /dashboard` responde 404, nenhum arquivo criado.
- `DASHBOARD_ENABLED=true` → request otimizado gera evento; `GET /dashboard/stats.json`
  reflete os totais; `GET /dashboard` responde `text/html` com as seções.
- Restart simulado: aggregator recarregado de um `events.jsonl` semeado reconstrói os
  totais (prova do "histórico persistido").

## 10. Sequência de implementação sugerida

1. Config (`env.ts`) + testes das 4 flags.
2. `src/dashboard/event-store.ts` (append/read/retenção) + testes.
3. `src/dashboard/aggregator.ts` (totais, buckets, p95, snapshot) + testes.
4. `src/dashboard/html.ts` (shell) + teste de conteúdo.
5. `src/routes/dashboard.ts` (`/dashboard`, `/dashboard/stats.json`) + integração.
6. Wiring do evento em `messages.ts` (bytesIn/bytesOut, best-effort).
7. Registro condicional em `create-app.ts` (load do aggregator no startup).
8. Teste de integração ponta-a-ponta + restart simulado.
9. Docs: README + `.env.example`.

## 11. Riscos e mitigações

| Risco                                | Mitigação                                                                       |
| ------------------------------------ | -------------------------------------------------------------------------------- |
| Arquivo `.jsonl` crescer sem limite  | Retenção por 30 dias + reescrita na rotação; append best-effort                  |
| I/O bloqueando o caminho quente      | Escrita assíncrona best-effort; agregação incremental em memória, não relê disco |
| Corrupção parcial do arquivo         | Parse linha-a-linha tolerante; linhas inválidas ignoradas                        |
| `~` não resolver em win32            | `os.homedir()` (cross-platform); `RELAYCORE_DATA_DIR` como override              |
| Exposição acidental na rede          | Bind default `127.0.0.1`; só metadados, nunca conteúdo; documentado              |
| Divergência de estilo com o pxpipe   | Reusar a paleta/estrutura de cards do dashboard de referência                    |
```