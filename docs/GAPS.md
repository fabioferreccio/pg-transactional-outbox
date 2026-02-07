# Débitos Técnicos e Roadmap de Remediação

> **Status:** Documento vivo. Atualizar conforme itens forem resolvidos.

---

## Sumário Executivo

O `pg-transactional-outbox` é um **framework funcional** para o padrão Transactional Outbox. Porém, para se tornar uma **plataforma corporativa governada**, os seguintes gaps precisam ser endereçados.

---

## 🟡 Pontos Frágeis (Existem, mas Incompletos)

### 1. Dead Letter Queue (DLE)
| Existe | Falta |
|--------|-------|
| Status `DEAD_LETTER` | API de redrive programática |
| Método `cleanup()` | Workflow de tratamento |
| Query SQL de redrive | Ownership (quem é dono?) |
| | SLA de resolução |
| | Classificação automática de erro |
| | Priorização por criticidade |

**Diagnóstico:** DLE é um *estacionamento*, não um *hospital*.

---

### 2. CDC (Change Data Capture)
| Existe | Falta |
|--------|-------|
| Schema compatível com Debezium | Dual-run (polling + CDC simultâneo) |
| | Reconciliação automática |
| | Validação de consistência |

---

### 3. Observabilidade
| Existe | Falta |
|--------|-------|
| `getOldestPendingAgeSeconds()` | Alertas automáticos |
| `getPendingCount()` | Circuit breaker |
| Dashboard visual | Integração Prometheus/Grafana |
| | Webhooks de notificação |

**Diagnóstico:** Mede, mas não reage.

---

## 🔴 Vazios Importantes

### 4. Governança de Backlog
**Problema:** Backlog cresce infinitamente → latência infinita.

**Falta:**
- Limite máximo de backlog
- Modo de degradação graceful
- Backpressure para produtores
- Política de emergência (drop oldest? pause inserts?)

---

### 5. Efeito Externo Vulnerável
**Problema:** Fencing protege o banco, mas não protege pagamentos, emails, webhooks.

**Falta:**
- Helper/SDK para idempotência externa
- Padrão de "idempotency key forwarding" documentado
- Exemplo de integração com Stripe/SendGrid

---

### 6. DLE sem Dono = Dívida Infinita
**Problema:** Sem SLA, eventos crescem eternamente.

**Falta:**
- Ownership tag por evento
- SLA configurável
- Alerta quando SLA estourar
- Escalation automático

---

### 7. Snapshot Inexistente
**Problema:** Replay em escala impossível se dados foram expurgados.

**Falta:**
- Snapshot periódico antes do purge
- Integração com S3/GCS para cold storage
- API de rebuild a partir de snapshot

---

### 8. Compliance Externo
**Problema:** Auditoria e retenção delegadas ao DBA.

**Falta:**
- Política de retenção declarativa na aplicação
- Export automático para Data Lake antes do purge
- Integração com sistemas de compliance (ex: GDPR delete)

---

### 9. Rebuild/Replay Perigosos
**Problema:** Operações manuais sem guard rails.

**Falta:**
- Rate limiting no replay
- Dry-run mode
- Rollback automático se erro > threshold

---

### 10. Métricas Passivas
**Problema:** Mede → Humano decide → Humano age.

**Falta:**
- Auto-scaling de workers baseado em lag
- Circuit breaker automático
- Self-healing (restart worker se stale)

---

### 11. Ordenação Implícita
**Problema:** Consumidores assumem ordem que não existe.

**Falta:**
- Documentação explícita em README
- Warning no log se concorrência > 1
- Opção de "ordered mode" (single worker)

---

## 📋 Roadmap de Remediação

### Fase 1: Governança Básica (v0.4)
**Objetivo:** Tornar DLE e backlog gerenciáveis.

| Item | Entregável | Esforço |
|------|------------|---------|
| DLE API | `redriveByEventType()`, `getDeadLetterStats()` | 2h |
| DLE Ownership | Campo `owner` na tabela, filtro por owner | 1h |
| Backlog Limit | Config `maxBacklogSize`, erro se exceder | 2h |
| Ordenação Explícita | Seção no README, warning no log | 1h |

---

### Fase 2: Observabilidade Ativa (v0.5)
**Objetivo:** O sistema reage, não apenas mede.

| Item | Entregável | Esforço |
|------|------------|---------|
| Prometheus Metrics | Endpoint `/metrics` com gauges | 3h |
| Alertas | Webhook configurável para lag > threshold | 2h |
| Health Check | Endpoint `/health` com status agregado | 1h |
| Auto-restart Worker | Detectar stale e reiniciar | 2h |

---

### Fase 3: Resiliência Externa (v0.6)
**Objetivo:** Ajudar consumidores a lidar com duplicatas.

| Item | Entregável | Esforço |
|------|------------|---------|
| Idempotency SDK | Helper `withIdempotency(key, fn)` | 3h |
| Exemplo Stripe | Integração documentada | 2h |
| Exemplo SendGrid | Integração documentada | 1h |

---

### Fase 4: Snapshot & Replay (v0.7)
**Objetivo:** Permitir rebuild seguro.

| Item | Entregável | Esforço |
|------|------------|---------|
| Snapshot Export | Job que exporta para JSON/Parquet antes do purge | 4h |
| Replay com Rate Limit | `replayFromSnapshot(file, { rateLimit: 100 })` | 3h |
| Dry-run Mode | Flag `--dry-run` para simular replay | 2h |

---

### Fase 5: CDC Integration (v0.8)
**Objetivo:** Migração suave para Debezium.

| Item | Entregável | Esforço |
|------|------------|---------|
| Dual-run Mode | Polling + CDC simultâneo com dedup | 4h |
| Reconciliation Job | Compara estado entre modos | 3h |
| Cutover Guide | Runbook de migração | 2h |

---

### Fase 6: Compliance (v0.9)
**Objetivo:** Auditoria e retenção governadas.

| Item | Entregável | Esforço |
|------|------------|---------|
| Retention Policy | Config `retentionDays` com auto-purge | 2h |
| Audit Export | Job para S3/GCS antes do purge | 3h |
| GDPR Delete | API `deleteByAggregateId()` | 2h |

---

## Priorização Recomendada

```
v0.4 (Governança)     ████████░░░░░░░░  [ALTA] - Resolve DLE e backlog
v0.5 (Observabilidade) ██████░░░░░░░░░░  [ALTA] - Sistema reage
v0.6 (Resiliência)    ████░░░░░░░░░░░░  [MÉDIA] - Ajuda consumidores
v0.7 (Snapshot)       ████░░░░░░░░░░░░  [MÉDIA] - Replay seguro
v0.8 (CDC)            ██░░░░░░░░░░░░░░  [BAIXA] - Migração futura
v0.9 (Compliance)     ██░░░░░░░░░░░░░░  [BAIXA] - Governança avançada
```

---

## Métricas de Sucesso

| Fase | Métrica |
|------|---------|
| v0.4 | DLE count < 100 após 7 dias |
| v0.5 | MTTR (Mean Time to React) < 5 min |
| v0.6 | Zero duplicatas em integrações de exemplo |
| v0.7 | Replay de 1M eventos em < 1h sem OOM |
| v0.8 | Cutover para CDC sem perda de eventos |
| v0.9 | Compliance audit passa sem achados |
