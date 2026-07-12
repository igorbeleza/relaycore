# Software Requirements Specification (SRS)

**Projeto:** Claude Proxy **Versão:** 0.1-draft **Baseado em:**
ISO/IEC/IEEE 29148 (estrutura adaptada)

------------------------------------------------------------------------

# 1. Introdução

## 1.1 Objetivo

Este documento especifica os requisitos de software do Claude Proxy e
será a principal referência para arquitetura, implementação, testes e
operação.

## 1.2 Escopo

O Claude Proxy é um proxy HTTP compatível com a Anthropic Messages API,
destinado a clientes como Claude Code e provedores compatíveis.

## 1.3 Público-alvo

-   Arquitetos
-   Desenvolvedores
-   QA
-   DevOps
-   Maintainers
-   Contribuidores

------------------------------------------------------------------------

# 2. Glossário

-   Provider: serviço compatível com a API Anthropic.
-   Core: núcleo do proxy.
-   Plugin: extensão carregada pelo mecanismo oficial.
-   Request Context: contexto interno da requisição.
-   SSE: Server-Sent Events.

------------------------------------------------------------------------

# 3. Visão Geral do Sistema

Fluxo lógico:

Cliente ↓ Router ↓ Middleware ↓ Core ↓ Provider Client ↓ Provider

------------------------------------------------------------------------

# 4. Premissas

-   Compatibilidade com a API Anthropic.
-   Configuração por ambiente.
-   Arquitetura modular.
-   Execução stateless no núcleo.

------------------------------------------------------------------------

# 5. Restrições

-   Não alterar o contrato público da API.
-   Evitar dependência de um provedor específico.
-   Preservar compatibilidade de streaming.

------------------------------------------------------------------------

# 6. Casos de Uso

## UC-001

Receber POST /v1/messages.

## UC-002

Encaminhar ao provider.

## UC-003

Retransmitir SSE.

## UC-004

Consultar /health.

## UC-005

Consultar métricas.

------------------------------------------------------------------------

# 7. Requisitos Funcionais

## API

REQ-F-001 Receber POST /v1/messages.

REQ-F-002 Validar payload conforme especificação.

REQ-F-003 Encaminhar ao provider configurado.

REQ-F-004 Preservar códigos de resposta quando apropriado.

REQ-F-005 Suportar streaming SSE.

## Administração

REQ-F-020 Expor /health.

REQ-F-021 Expor /version.

REQ-F-022 Expor /metrics.

## Configuração

REQ-F-040 Validar configuração na inicialização.

REQ-F-041 Configurar provider por variáveis de ambiente.

REQ-F-042 Permitir timeout configurável.

REQ-F-043 Permitir retry configurável.

## Plugins

REQ-F-060 Carregar plugins registrados.

REQ-F-061 Disponibilizar hooks documentados.

REQ-F-062 Isolar falhas de plugins.

## Transformações

REQ-F-100 Converter automaticamente blocos de texto longos do payload em
imagens (estilo pxpipe) antes do encaminhamento ao provider, para reduzir
o consumo de tokens.

REQ-F-101 Permitir habilitar/desabilitar a conversão e configurar o limiar
de tamanho por variáveis de ambiente.

REQ-F-102 Preservar a semântica do conteúdo e a compatibilidade com o
contrato da Anthropic Messages API (blocos de imagem válidos).

REQ-F-103 Registrar métricas da conversão (tokens estimados antes/depois,
número de blocos convertidos), sem registrar o conteúdo em logs.

## Observabilidade

REQ-F-080 Gerar Request ID.

REQ-F-081 Registrar logs estruturados.

REQ-F-082 Exportar métricas.

------------------------------------------------------------------------

# 8. Requisitos Não Funcionais

REQ-NF-001 Código em TypeScript.

REQ-NF-002 Arquitetura modular.

REQ-NF-003 Docker oficial.

REQ-NF-004 CI/CD automatizado.

REQ-NF-005 Testes automatizados.

REQ-NF-006 Compatibilidade de protocolo.

REQ-NF-007 Configuração validada por esquema.

REQ-NF-008 Observabilidade integrada.

------------------------------------------------------------------------

# 9. Interfaces Externas

## HTTP

Compatível com Anthropic Messages API.

## Ambiente

Variáveis .env.

## Logs

JSON estruturado.

## Métricas

Prometheus.

------------------------------------------------------------------------

# 10. Modelo de Dados (Inicial)

Entidades:

-   RequestContext
-   ProviderRequest
-   ProviderResponse
-   Plugin
-   Configuration
-   MetricSnapshot

------------------------------------------------------------------------

# 11. Segurança

-   Segredos por ambiente.
-   Validação de entrada.
-   Timeouts.
-   Auditoria de dependências.
-   Rate limiting (configurável).

------------------------------------------------------------------------

# 12. Observabilidade

-   Logs estruturados
-   Request ID
-   Correlation ID
-   Prometheus
-   OpenTelemetry

------------------------------------------------------------------------

# 13. Estratégia de Testes

-   Unitários
-   Integração
-   Contrato
-   E2E
-   Carga

Todo requisito deverá possuir rastreabilidade para pelo menos um teste.

------------------------------------------------------------------------

# 14. Critérios de Aceite

Cada requisito será considerado implementado quando:

-   código aprovado;
-   testes aprovados;
-   documentação atualizada;
-   cobertura adequada;
-   CI verde.

------------------------------------------------------------------------

# 15. Matriz de Rastreabilidade (Inicial)

  Requisito   Arquitetura       Teste
  ----------- ----------------- -------------
  REQ-F-001   Router            Integration
  REQ-F-005   Streaming Relay   E2E
  REQ-F-020   Admin API         Unit
  REQ-F-082   Metrics           Integration

------------------------------------------------------------------------

# 16. Evolução

Este SRS será expandido continuamente antes da implementação de cada
domínio funcional. Ele será a referência oficial para PRD, ADRs,
OpenAPI, testes e código.
