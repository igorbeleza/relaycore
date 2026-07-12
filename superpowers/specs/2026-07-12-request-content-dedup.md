# Spec 1 — Deduplicação de conteúdo repetido no request

- **Status:** Draft (aguardando revisão)
- **Data:** 2026-07-12
- **Autor:** brainstorming session
- **Projeto:** RelayCore
- **Relacionado:** Spec 2 — Dashboard de acompanhamento de tokens economizados (a ser escrito)

---

## 1. Contexto e problema

O RelayCore é um proxy da Anthropic Messages API voltado para agentes de código. Nesse
uso, o mesmo conteúdo é frequentemente reenviado várias vezes dentro de um único request:
o mesmo arquivo é lido repetidamente (gerando `tool_result`s idênticos), ou um trecho
colado num user message reaparece depois numa leitura de ferramenta.

Hoje já existe o **pxpipe**, que converte blocos grandes de texto em imagens PNG para
economizar tokens de entrada, e um **render-cache** (LRU chaveado pelo texto) que evita
re-renderizar texto idêntico. Porém, mesmo com cache de render, o bloco duplicado
**ainda é enviado** ao upstream — apenas não é re-renderizado.

A deduplicação vai um passo além: **remove o bloco duplicado do payload**, mantendo apenas
a primeira ocorrência completa e substituindo as demais por uma referência curta.

## 2. Objetivo

Reduzir tokens de entrada removendo blocos de conteúdo **byte-a-byte idênticos** (após
normalização apenas de line-endings) que se repetem dentro de um mesmo request, mantendo a
primeira ocorrência completa e substituindo as demais por uma referência curta que aponta
para trás. Roda **antes do pxpipe** e **preserva o prefixo cacheável** da Anthropic.

### Não-objetivos (fora de escopo deste spec)

- Dashboard visual de acompanhamento (é o **Spec 2**).
- Near-dup / detecção baseada em diff (ex.: arquivo antes/depois de uma edição).
- Correspondência de sub-blocos / trechos parciais.
- Prompt caching automático (inserção de `cache_control`).
- Cache de respostas idênticas (evitar a chamada ao upstream).

## 3. Decisões de design (travadas na brainstorming)

| #   | Decisão                 | Escolha                                                       |
| --- | ----------------------- | ------------------------------------------------------------- |
| 1   | Tipo de dedup           | Conteúdo repetido **dentro do mesmo request**                 |
| 2   | Granularidade           | **Bloco inteiro idêntico** por hash exato                     |
| 3   | Estratégia              | **Manter a 1ª ocorrência**, referenciar as demais (para trás) |
| 4   | Ordem no pipeline       | **Dedup antes do pxpipe**                                     |
| 5   | Alcance                 | `user + tool_results` (default), configurável                 |
| 6   | Limite mínimo           | Config própria `DEDUP_MIN_CHARS` (default 500)                |
| 7   | Métricas                | Espelham o padrão do pxpipe (Prometheus + diagnostics)        |
| 8   | Guard de turns recentes | `DEDUP_KEEP_RECENT_TURNS` com default `0` (sem proteção)      |
| 9   | Arquitetura             | Abordagem A (módulo isolado) + orquestração fina              |

### Justificativa da decisão 3 (manter a 1ª)

1. **Leitura sequencial** — o modelo lê o conteúdo uma vez; ao reencontrá-lo, vê a
   referência. Referência para trás é sempre resolvível; para frente não.
2. **Prompt caching da Anthropic (decisivo)** — o cache nativo funciona por _prefixo
   estável_. Reescrever ocorrências antigas (prefixo) invalidaria o cache do request
   inteiro. Reescrevendo só as ocorrências mais recentes, preservamos o prefixo cacheável.

## 4. Arquitetura

Abordagem A (módulo isolado espelhando o pxpipe) + uma camada fina de orquestração que
chama `dedup → pxpipe` em ordem fixa e agrega as estatísticas das duas etapas.

```
request handler
   └─ optimize(messages, config)          ← camada de orquestração fina (nova)
        ├─ dedup.transform(...)           ← src/dedup/ (novo módulo, espelha pxpipe)
        ├─ pxpipe.transform(...)          ← módulo existente, inalterado
        └─ agrega stats → OptimizationResult
```

### 4.1 Novo módulo `src/dedup/`

- **`index.ts`** — API pública `dedupeMessages(messages, config): DedupResult`.
- **`block-index.ts`** — varre os blocos elegíveis em ordem; calcula `SHA-256` do texto
  **normalizado apenas para line-endings** (`\r\n` → `\n`; nenhuma outra normalização,
  para preservar a garantia de "idêntico"); mapeia
  `hash → { turnIndex, blockIndex, refId }` da **primeira** ocorrência.
- **`transform.ts`** — substitui ocorrências posteriores pela referência; respeita
  `DEDUP_MIN_CHARS`, `DEDUP_SCOPE`, `DEDUP_KEEP_RECENT_TURNS`.
- **`estimator.ts`** — estima tokens economizados usando a mesma heurística char→token do
  pxpipe.
- **`metrics.ts`** — contadores Prometheus.

### 4.2 Camada de orquestração `src/optimize/`

- **`optimize.ts`** — chama `dedup` e depois `pxpipe`, em ordem fixa; retorna
  `OptimizationResult { dedup: DedupStats; pxpipe: PxpipeStats }`. É o ponto único de onde
  a dashboard (Spec 2) irá ler as estatísticas agregadas.

## 5. Formato da referência

A primeira ocorrência recebe um id estável e curto derivado do hash, ex.: `#dedup-a1b2`.
As ocorrências posteriores têm seu conteúdo textual trocado por:

```
[conteúdo idêntico ao bloco #dedup-a1b2 exibido anteriormente — omitido para economizar tokens]
```

Regras:

- Para `tool_result`: preserva `tool_use_id` e demais campos estruturais; **apenas o
  conteúdo textual interno** é trocado pela referência, mantendo a estrutura válida da API.
- Só deduplica se a referência for **comprovadamente menor** que o bloco original
  (garantido na prática por `DEDUP_MIN_CHARS`, mas verificado explicitamente).

## 6. Configuração (`src/config/env.ts`, estilo pxpipe)

| Flag                      | Default                 | Validação              | Descrição                                         |
| ------------------------- | ----------------------- | ---------------------- | ------------------------------------------------- |
| `DEDUP_ENABLED`           | `false`                 | `enum('true','false')` | Liga/desliga (igual pxpipe)                       |
| `DEDUP_MIN_CHARS`         | `500`                   | `int 100..1_000_000`   | Tamanho mínimo do bloco elegível                  |
| `DEDUP_SCOPE`             | `user_and_tool_results` | `enum`                 | `user_and_tool_results` \| `tool_results_only`    |
| `DEDUP_KEEP_RECENT_TURNS` | `0`                     | `int 0..50`            | Protege os N turns mais recentes (0 = dedup tudo) |

Adicionar os campos correspondentes a `AppConfig` e ao retorno de `loadConfig`, seguindo
exatamente o padrão dos campos `pxpipe*`.

## 7. Métricas e observabilidade

Espelham **exatamente** o padrão do pxpipe (contadores Prometheus simples, **sem labels**) e
alimentam o Spec 2 (dashboard). No `src/metrics/metrics-registry.ts`, adicionar um método
`recordDedup(blocksDeduped: number, estTokensSaved: number)` (análogo a `recordPxpipeConversion`)
e expor no texto Prometheus:

- `relaycore_dedup_blocks_deduped_total` — counter
- `relaycore_dedup_tokens_saved_estimate_total` — counter

> Nota: diferente do rascunho inicial, **não** usar um counter com label `{applied=...}` — o
> `MetricsRegistry` atual não usa labels; segue o mesmo estilo dos `relaycore_pxpipe_*`.

Registrar também no `DiagnosticsRegistry` (mesmo padrão de `diagnostics.recordError`) para
inspeção via `/debug`, quando aplicável.

## 8. Garantias de correção / segurança

- **Nunca** reescreve a primeira ocorrência (prefixo estável → cache Anthropic intacto).
- Referência sempre aponta para trás → sempre resolvível pelo modelo.
- Blocos abaixo de `DEDUP_MIN_CHARS`, ou onde a referência não economizaria, passam intactos.
- `DEDUP_ENABLED=false` → no-op total (zero mudança de comportamento).
- Idempotente e determinístico (mesmo input → mesmo output).
- Estrutura da Messages API sempre válida após a transformação.

## 9. Plano de testes

**Unit:**

- `block-index`: detecção de duplicatas; normalização de line-endings (`\r\n` vs `\n`
  contam como iguais; qualquer outra diferença conta como distinto).
- `transform`: mantém a 1ª, referencia as demais; respeita `SCOPE`, `MIN_CHARS`,
  `KEEP_RECENT_TURNS`; preserva `tool_use_id`.
- `estimator`: estimativa de tokens economizados coerente com a heurística do pxpipe.
- `optimize`: ordem `dedup → pxpipe`; agregação de stats; no-op quando desligado.

**Integração:**

- Request com o mesmo arquivo lido 3× → 1 bloco completo + 2 referências; estrutura da API
  válida; `tool_use_id` preservado; métricas incrementadas corretamente.

## 10. Sequência de implementação sugerida

1. Config (`env.ts`) + testes de config.
2. `src/dedup/block-index.ts` + testes.
3. `src/dedup/transform.ts` + `estimator.ts` + testes.
4. `src/dedup/metrics.ts` + registro nos diagnostics.
5. `src/optimize/optimize.ts` (orquestração + agregação) + testes.
6. Ligar a orquestração no request handler (substituindo a chamada direta ao pxpipe).
7. Teste de integração ponta-a-ponta.

## 11. Riscos e mitigações

| Risco                           | Mitigação                                                                                  |
| ------------------------------- | ------------------------------------------------------------------------------------------ |
| Referência confundir o modelo   | Texto explícito apontando para trás; alcance/threshold conservadores; flag off por default |
| Falso positivo de "idêntico"    | Hash exato, sem normalização além de line-endings                                          |
| Quebrar estrutura da API        | Só troca conteúdo textual interno; testes de integração validam o schema                   |
| Interação inesperada com pxpipe | Ordem fixa dedup→pxpipe; testes de `optimize` cobrindo blocos que são duplicados E grandes |
