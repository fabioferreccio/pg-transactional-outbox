# Arquitetura e Decisões de Design (FAQ)

Este documento detalha as decisões arquiteturais, garantias e limitações do sistema `pg-transactional-outbox`.

---

## 🧱 BLOCO 1 — Identidade do Sistema

**O sistema continua assumindo PostgreSQL como requisito obrigatório?**
Sim e não. O driver é abstraído via `SqlExecutor`, permitindo teoricamente outros bancos SQL. Porém, o repositório padrão (`PostgresOutboxRepository`) utiliza sintaxe específica do Postgres (`FOR UPDATE SKIP LOCKED`, `RETURNING *`, `gen_random_uuid`), tornando o port para MySQL/Oracle não-trivial sem reescrever as queries.

**Existe alguma parte do design que funciona sem SKIP LOCKED?**
Não o `claimBatch`. A implementação atual depende fortemente de `FOR UPDATE SKIP LOCKED` para garantir que múltiplos workers não processem os mesmos eventos simultaneamente sem travar a tabela inteira. Backends sem essa feature exigiriam uma estratégia de "tenta pegar lock" muito menos eficiente.

**Existe algum fluxo que dependa de features ausentes no PostgreSQL?**
A funcionalidade de **particionamento automático** (`pg_partman`) depende de uma extensão que não vem habilitada por padrão em todos os DBs gerenciados (ex: RDS suporta, mas precisa ativar). O código TypeScript não gerencia a criação de partições, assume que o banco cuida disso.

**O modelo continua sendo Transactional Outbox e não um broker?**
Sim. O foco é a garantia de entrega da *fonte* (banco) para o *destino*. O "Worker" atua como um *Relay* (transportador), não como um Broker de mensagens complexo com roteamento dinâmico.

**Há alguma promessa de exactly-once?**
Não. A garantia é estritamente **at-least-once** (pelo menos uma vez). Falhas de rede ou crashes após o efeito colateral mas antes do commit podem causar duplicatas. A idempotência deve ser tratada no consumidor.

---

## 🔒 BLOCO 2 — Garantias de Concorrência

**Onde o lease é adquirido?**
No método `claimBatch` do repositório. O lease é definido pela coluna `locked_until` e validado pelo `lock_token`.

**Como a expiração do lease é tratada?**
Passivamente. Se `locked_until < NOW()`, o evento torna-se elegível para ser pego por *outro* worker (ou pelo mesmo). O `Reaper` (se ativo) também pode resetar explicitamente esses eventos para `PENDING`.

**O que impede um worker antigo de continuar executando após perder o lease?**
O `lock_token` (fencing token). Toda operação de atualização (`markCompleted`, `markFailed`) exige que o `lock_token` enviado combine com o do banco. Se o lease expirou e outro worker pegou o evento, o `lock_token` no banco mudou, e a query do worker antigo afetará 0 linhas (falha otimista).

**Existe fencing token? Onde ele é validado?**
Sim, a coluna `lock_token` (BigInt). Ele é validado na cláusula `WHERE` de todas as operações de mudança de estado (`UPDATE outbox ... WHERE id = $1 AND lock_token = $2`).

**Ele protege apenas o banco ou também efeitos externos?**
Apenas o banco. O worker pode ter executado o efeito externo (ex: chamada HTTP), mas falhará ao tentar commitar o sucesso no banco se perdeu o lease. Isso gera a duplicidade garantida "at-least-once".

---

## 🔁 BLOCO 3 — Idempotência

**A idempotência é por consumidor?**
Sim. A tabela `inbox` possui chave composta `(tracking_id, consumer_id)`.

**Onde é armazenada?**
Na tabela `inbox` do banco de dados do consumidor.

**O resultado da execução é guardado ou apenas a presença?**
Apenas a presença (`processed_at`). O payload da resposta não é armazenado. O objetivo é evitar reprocessamento, não servir como cache de resposta.

**Um novo consumidor consegue iniciar processamento histórico?**
Se ele usar um `consumer_id` novo, sim, o `IdempotencyStore` não terá registros para ele. Porém, o *OutboxWorker* processa a fila sequencialmente/em lote. Se os eventos já foram marcados como `COMPLETED` no outbox, o novo consumidor não os receberá a menos que o *Outbox* seja reconfigurado para reenviar ou se utilize um *fan-out* para um broker real antes. **Nota:** No modelo atual, o worker consome e marca como completo. Se houver múltiplos *handlers* lógicos dentro do mesmo worker, eles compartilham o sucesso do processamento do evento.

---

## ☠️ BLOCO 4 — Dead Letter

**Quem é dono da DLE?**
O próprio banco (tabela `outbox`, status `DEAD_LETTER`). Não há fila separada.

**Qual SLA de tratamento?**
Indefinido pelo sistema. Eventos ficam lá até intervenção manual ou expurgo.

**Existe redrive?**
SQL manual (`docs/outbox-schema.sql` tem uma query preparada `redrive_dle`) ou script customizado. Não há API automática de redrive no momento.

**Existe expurgo?**
Sim, `cleanup()` remove eventos `COMPLETED` e `DEAD_LETTER` antigos.

**Como auditoria futura acessa dados removidos?**
Se o expurgo rodar, os dados somem. Para auditoria de longo prazo, deve-se habilitar a tabela de auditoria (`outbox_audit_log` via triggers) ou fazer backup/CDC para Data Lake antes do expurgo.

---

## 📦 BLOCO 5 — Dados e Crescimento

**O sistema assume particionamento?**
O schema SQL (`outbox-schema.sql`) define particionamento nativo por Range (`created_at`).

**Quem cria partições futuras?**
O sistema assume o uso de `pg_partman` (definido no SQL) para criar partições periodicamente. A aplicação Node.js **NÃO** cria partições.

**O que acontece se não existirem?**
O insert falhará com erro do Postgres se não houver partição cobrindo a data atual (a menos que exista partição `DEFAULT`, que não é recomendada com `pg_partman` para performance).

**Existe política de retenção?**
Sim, configurável no `pg_partman` (ex: "30 days"). O método `cleanup` da aplicação serve para limpeza lógica (soft retention) se o particionamento não estiver em uso.

**Existe cold storage?**
Não nativo. Depende da estratégia de backup do DBA.

---

## 📊 BLOCO 6 — Observabilidade Operacional

**Quais métricas indicam saturação do banco?**
Aumento no tempo de execução das queries (`avg_latency_seconds`), crescimento do backlog (`getPendingCount`), e alta contagem de *dead tuples* (monitorado via SQL de bloat).

**O que acontece quando backlog cresce?**
A latência de entrega aumenta. O sistema continua funcionando, mas o atraso entre `created_at` e `processed_at` cresce (Lag).

**Há automação ou só dashboard?**
Só dashboard e queries de monitoramento. Autoscaling de workers deve ser externo (K8s HPA baseado na métrica de Lag).

**Existe medição de idade da fila?**
Sim, `getOldestPendingAgeSeconds()` retorna a idade do evento mais antigo pendente.

**Existe alerta de starvation?**
Visualmete no Dashboard (eventos travados em `PROCESSING` por muito tempo).

---

## 🧠 BLOCO 7 — Ordenação e Semântica

**O sistema promete ordem global?**
NÃO, se houver múltiplos workers (concorrência > 1). Dentro de um único worker (concorrência = 1), a entrega é "quase" ordenada, mas retries de falhas quebram a ordem estrita (eventos novos podem passar na frente de um antigo que falhou e está em backoff).

**Ele educa consumidores sobre reordenação?**
A documentação implícita é "Order is generally preserved but not guaranteed due to retries and parallelism".

**Existe estratégia para ignorar eventos antigos?**
Não automática. O consumidor deve verificar `created_at` se a ordem for crítica ("Last Write Wins" lógico).

---

## 💥 BLOCO 8 — Falhas Reais

**O que acontece se o worker cair após efeito externo?**
O lease expira. Outro worker pega o evento. Executa o efeito de novo. É o cenário clássico de "At-Least-Once".

**Existe commit gap tracking?**
SQL de "Gap Detection" está disponível nos docs, mas a aplicação não monitora gaps em tempo real. Gaps de ID são normais em Postgres (rollbacks, concorrência).

**Há como diferenciar “tentou” de “confirmado”?**
Sim, `retry_count > 0` indica que houve tentativa falha (ou crash) anterior.

---

## 🧬 BLOCO 9 — Snapshot & Replay

**Existe versionamento de snapshot?**
Não.

**É possível rebuild global?**
Apenas se os eventos não tiverem sido expurgados. Se houve expurgo (`cleanup`), o histórico foi perdido.

**Lazy rebuild pode gerar pico?**
Sim, reprocessar histórico gera carga massiva de leitura e escrita (update status).

**Existe controle disso?**
Não embutido. Scripts de replay devem ser rodados com cuidado.

---

## 🔄 BLOCO 10 — Migração futura

**Como CDC será introduzido?**
A estrutura atual facilita **Debezium**: ele pode ler a tabela `outbox` diretamente (connector outbox). A aplicação apenas insere na `outbox` e o Debezium transmite, dispensando o `polling/notify relay`.

**Há dual run?**
Não implementado.

**Como validar consistência?**
Audit log (`outbox_audit_log`) vs Backups.

**Quem autoriza desligar o consumo pelo banco?**
Decisão operacional. Basta parar os containers dos workers (`replicas: 0`) ou desabilitar o `crontab` dos scripts.

---

## 🧯 BLOCO 11 — Operação & Incidente

**Existem runbooks?**
As queries em `docs/outbox-schema.sql` (seção Observabilidade) servem como base para runbooks de incidente (bloat, lag, dead letters).

**Quando pode matar backend?**
A qualquer momento. Transações em voo sofrem rollback. Leases expiram. O sistema se recupera sozinho.

**Como detectar vacuum starvation?**
Query de `Autovacuum lag monitoring` incluída nos docs.

**Como detectar locks longos?**
Monitoramento padrão do Postgres (`pg_stat_activity` com `state = 'active'` e `wait_event_type = 'Lock'`).

---

## ⚙️ BLOCO 12 — ORM vs SQL

**O ORM substitui queries críticas?**
Não. As queries críticas (`claimBatch` com `SKIP LOCKED`) são SQL puro executado via `executor.query()`, garantindo performance e corretude que a maioria dos ORMs não abstrai bem.

**O framework permite cair para SQL nativo?**
Sim, o `SqlExecutor` é a porta de escape para SQL nativo em qualquer driver.

**É possível auditar exatamente o que está sendo executado?**
Sim, inspecionando as strings SQL nos arquivos de repositório ou habilitando log de queries no driver/banco.
