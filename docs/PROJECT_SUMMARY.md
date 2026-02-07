# Resumo do Projeto: pg-transactional-outbox

## 1. Visão Geral
**Framework Transactional Outbox** de nível de produção para ambientes PostgreSQL e Node.js.
Projetado para garantir a entrega **at-least-once** de eventos em arquiteturas de microsserviços, resolvendo o problema de dual-write (atualizar banco de dados + publicar evento) de forma transacional e segura.

Versão Atual: `v0.3.2`

---

## 2. Principais Funcionalidades Implementadas

### Core (Transactional Outbox)
- **Outbox Repository**: Persistência atômica de eventos na mesma transação de negócio.
- **Worker Resiliente**: Processamento em segundo plano com lease, heartbeat e recuperação de falhas.
- **Idempotência (Inbox Pattern)**: Deduplicação de eventos no consumidor usando `PostgresIdempotencyStore`.
- **Upcasting**: Migração de esquema de eventos on-the-fly para suportar evolução de contratos.

### Mensageria & Concorrência
- **Polling Relay**: Versão robusta baseada em polling para menor carga.
- **Notify Relay**: Versão baixa latência usando `LISTEN/NOTIFY` do Postgres.
- **Controle de Concorrência**: Semáforos para limitar processamento paralelo por worker.
- **Reaper**: Processo automático para "ressuscitar" eventos travados por workers mortos.

### Observabilidade & UX
- **Painel de Controle (Dashboard)**: UI completa para visualizar fluxo de eventos, status dos workers e simular cenários.
- **Simulador de Eventos**: Ferramenta integrada para gerar carga, injetar falhas e testar resiliência visualmente.
- **Telemetria**: Preparado para OpenTelemetry (Tracing e Métricas).

### Arquitetura & Flexibilidade
- **DB Abstraction Layer**: Interface `SqlExecutor` permite usar qualquer driver/ORM (pg, Knex, Prisma, TypeORM).
- **Driver Agnostic Scripts**: Scripts de migração e seed desacoplados do driver.

---

## 3. Arquitetura e Estrutura

O projeto segue estritamente a **Arquitetura Hexagonal (Ports & Adapters)**:

### Estrutura de Pastas
```
src/
├── core/                   # Lógica de Negócio Pura (Sem dependências externas)
│   ├── domain/             # Entidades (OutboxEvent) e Value Objects (RetryPolicy)
│   ├── ports/              # Interfaces (OutboxRepositoryPort, EventPublisherPort)
│   └── use-cases/          # Orquestração (ProcessOutbox, ReapStaleEvents)
│
├── adapters/               # Implementações Concretas
│   ├── persistence/        # PostgresOutboxRepository, PostgresIdempotencyStore
│   ├── messaging/          # PollingRelay, NotifyRelay, PgNotificationListener
│   └── telemetry/          # Tracing e Métricas (OpenTelemetry)
│
├── scripts/                # Lógica Reutilizável de Infra (Migrations, Seed)
├── main/                   # Composition Root e Entry Points
│   ├── simulator.ts        # Lógica do Simulador
│   ├── dashboard-api.ts    # Backend do Dashboard
│   └── index.ts            # Public API Exports
│
└── main.ts                 # Aplicação de Exemplo/Dashboard Runner
```

### Dependências Principais
- **pg**: Driver PostgreSQL nativo (única dependência de produção direta, mas abstraída).
- **vitest**: Framework de testes (Unitários e Integração).
- **typescript**: Linguagem base.
- **eslint/prettier**: Qualidade de código.

---

## 4. Pontos Fortes e Fracos

### ✅ Pontos Fortes
1.  **Robustez**: Tratamento exaustivo de falhas, retries, backoff exponencial e recuperação de processos mortos (zombies).
2.  **Desacoplamento**: A arquitetura hexagonal blindou o core. A recente abstração do banco de dados (`SqlExecutor`) torna o framework compatível com qualquer ORM, um diferencial enorme.
3.  **Observabilidade**: O Dashboard incluído não é apenas um exemplo, é uma ferramenta operacional poderosa para entender o estado do sistema.
4.  **Qualidade de Código**: 100% TypeScript, cobertura de testes unitários e de integração, lint rigoroso e CI/CD configurado.
5.  **Simplicidade de Uso**: APIs claras e scripts de suporte (migrate, seed) facilitam a adoção.

### ⚠️ Pontos Fracos / Melhorias Futuras
1.  **Dependência de Polling (Padrão)**: O polling, mesmo ajustado, gera carga constante no banco. O `NotifyRelay` resolve isso, mas exige conexões dedicadas (`LISTEN`).
2.  **Particionamento Manual**: O suporte a particionamento de tabelas existe (`pg_partman`), mas a complexidade operacional de manter partições recai sobre o usuário.
3.  **Monolito de Adapters**: Atualmente os adaptadores (Postgres) estão no mesmo pacote do Core. No futuro, poderiam ser separados em `@pg-outbox/core` e `@pg-outbox/postgres` para reduzir o bundle size se alguém quiser implementar outro adapter (ex: MySQL).

---

## Conclusão
O projeto está em um estado de **maturidade alta**. Ele deixou de ser apenas um "exemplo de pattern" para se tornar uma **lib agnóstica de infraestrutura**, pronta para ser plugada em projetos Prisma, TypeORM ou Knex, com garantias fortes de consistência de dados.
