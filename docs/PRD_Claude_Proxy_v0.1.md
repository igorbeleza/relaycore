# Product Requirements Document (PRD)

**Projeto:** Claude Proxy\
**Versão:** 0.1 (Draft)

---

# 1. Objetivo

Definir os requisitos funcionais e não funcionais do Claude Proxy,
estabelecendo a base para arquitetura, implementação, testes e operação.

---

# 2. Escopo

O Claude Proxy será um proxy compatível com a Anthropic Messages API,
destinado a clientes como Claude Code e provedores compatíveis.

---

# 3. Stakeholders

- Product Owner
- Arquiteto de Software
- Desenvolvedores
- DevOps
- QA
- Usuários finais
- Contribuidores Open Source

---

# 4. Casos de Uso

## UC-001

Cliente envia uma requisição `/v1/messages` ao proxy.

## UC-002

Proxy encaminha a requisição ao provedor configurado.

## UC-003

Proxy retransmite streaming SSE.

## UC-004

Administrador consulta `/health`.

## UC-005

Operador acompanha métricas.

---

# 5. Requisitos Funcionais

---

ID Requisito Prioridade Critério de Aceite

---

RF-001 Aceitar Must Compatível com o contrato
`POST /v1/messages` esperado.

RF-002 Encaminhar Must Resposta recebida com sucesso.
requisições ao  
provedor configurado

RF-003 Suportar SSE Must Eventos retransmitidos na
ordem correta.

RF-004 Expor `/health` Must Retorna status operacional.

RF-005 Expor `/version` Must Retorna versão do serviço.

RF-006 Expor `/metrics` Should Métricas Prometheus
disponíveis.

RF-007 Validar configuração Must Serviço não inicia com
na inicialização configuração inválida.

RF-008 Registrar logs Must Logs em formato JSON.
estruturados

RF-009 Suportar plugins Should Plugins carregados pelo
mecanismo oficial.

RF-010 Permitir troca de Must Sem alteração de código.
provedor por  
configuração

RF-011 Implementar timeouts Must Requisições encerradas
configuráveis conforme política.

RF-012 Implementar política Should Apenas para operações
de retry configurável elegíveis.

RF-013 Preservar códigos de Must Cliente recebe resposta
erro do provedor consistente.
quando apropriado

RF-014 Gerar Request ID Should Cada requisição possui
identificador único.

RF-015 Suportar configuração Must Configuração carregada na
por `.env` inicialização.

RF-016 Converter Should Blocos de texto acima de um
automaticamente limiar configurável são
textos longos em renderizados como imagem,
imagens para reduzir com redução mensurável de
tokens (estilo tokens, sem perda de
pxpipe) legibilidade e com opção de
desativação por configuração.
--------------------------------------------------------------------------------

---

# 6. Requisitos Não Funcionais

ID Requisito

---

RNF-001 Código em TypeScript.
RNF-002 Cobertura mínima de testes do núcleo: 90% (meta inicial).
RNF-003 Arquitetura modular.
RNF-004 Docker oficial.
RNF-005 Pipeline CI/CD automatizado.
RNF-006 Observabilidade com logs e métricas.
RNF-007 Configuração validada por esquema.
RNF-008 Compatibilidade de protocolo como princípio de projeto.

---

# 7. Restrições

- Não alterar o protocolo da Anthropic.
- Não depender de funcionalidades exclusivas de um provedor específico
  no núcleo.
- Evitar acoplamento entre plugins e core.

---

# 8. Critérios de Aceite do Produto

- Compatibilidade funcional com clientes da Anthropic Messages API.
- Testes automatizados aprovados.
- Documentação atualizada.
- Docker funcional.
- Pipeline CI verde.

---

# 9. Matriz de Rastreabilidade (Inicial)

Requisito Arquitetura Testes

---

RF-001 Router Integração
RF-002 Provider Client Integração
RF-003 Streaming Relay E2E
RF-004 Admin API Unitário
RF-006 Metrics Unitário + Integração
RF-016 Transform Layer Unitário + Integração

---

# 10. Evolução do PRD

Este documento será expandido ao longo do projeto. A meta é detalhar
todos os requisitos relevantes antes da implementação correspondente,
mantendo rastreabilidade entre requisitos, arquitetura, código e testes.
