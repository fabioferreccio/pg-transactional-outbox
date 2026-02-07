# 📖 Guia de Uso: pg-transactional-outbox

Este guia fornece instruções práticas sobre como integrar e operar a biblioteca `pg-transactional-outbox` em seu projeto Node.js com PostgreSQL.

## 🚀 1. Configuração do Banco de Dados

A biblioteca requer uma tabela `outbox` no seu esquema. É altamente recomendado usar **particionamento por tempo desde o dia 0**.

```sql
CREATE TABLE outbox (
  id              BIGSERIAL,
  tracking_id     UUID NOT NULL DEFAULT gen_random_uuid(),
  aggregate_id    UUID NOT NULL,
  aggregate_type  TEXT NOT NULL,
  event_type      TEXT NOT NULL,
  payload         JSONB NOT NULL,
  metadata        JSONB NOT NULL DEFAULT '{}',
  status          TEXT NOT NULL DEFAULT 'PENDING',
  retry_count     INT NOT NULL DEFAULT 0,
  max_retries     INT NOT NULL DEFAULT 5,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at    TIMESTAMPTZ,
  locked_until    TIMESTAMPTZ,
  lock_token      BIGINT,
  last_error      TEXT,
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

-- Criar partição inicial (exemplo mensal)
CREATE TABLE outbox_2024_02 PARTITION OF outbox
  FOR VALUES FROM ('2024-02-01') TO ('2024-03-01');
```

## 📝 2. Integrando o Produtor

O produtor deve escrever o estado de negócio e o evento na outbox **dentro da mesma transação**.

```typescript
import { Pool } from 'pg';
import { PostgresOutboxRepository, PublishEventUseCase } from 'pg-transactional-outbox';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function createOrder(orderData: any) {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');

    // 1. Persistir estado de negócio
    const orderId = '...';
    await client.query('INSERT INTO orders ...', [...]);

    // 2. Persistir evento na Outbox
    const repository = new PostgresOutboxRepository(client); // Usa o client da transação!
    const publishUseCase = new PublishEventUseCase(repository);
    
    await publishUseCase.execute({
      aggregateId: orderId,
      aggregateType: 'Order',
      eventType: 'OrderCreated',
      payload: { ...orderData, orderId },
    });

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
```

## ⚙️ 3. Operando o Worker

O Worker é responsável por ler a tabela outbox e enviar os eventos para o sistema externo (Kafka, SNS, etc).

```typescript
import { OutboxWorker, PostgresOutboxRepository } from 'pg-transactional-outbox';

const pool = new Pool(...);
const repository = new PostgresOutboxRepository(pool);

// Implementação do seu publicador externo
const myPublisher = {
  publish: async (event) => {
    // Lógica para enviar para Kafka/SNS/etc
    console.log('Sending event:', event.eventType);
    return { success: true };
  },
  isHealthy: async () => true
};

const worker = new OutboxWorker(repository, myPublisher, {
  pollIntervalMs: 1000,
  batchSize: 50,
  reaperEnabled: true, // Ativa a recuperação automática de eventos travados
});

await worker.start();
```

## 🖥️ 4. Painel de Controle e Simulação

A biblioteca inclui um **Control Plane Dashboard** integrado para desenvolvimento local e UAT.

### Como Iniciar:
```bash
npm run start
```
Acesse: `http://localhost:3000`

### Recursos do Dashboard:
- **Visualização em Tempo Real**: Veja os eventos fluindo do Produtor -> DB -> Consumidor.
- **Simulador de Falhas**: Teste sequências de re-tentativa e Dead Letter Events (DLE) com um clique.
- **Gestão de Frota**: Adicione ou remova produtores dinamicamente para testar concorrência.
- **Navegação Histórica**: Filtre e acompanhe eventos passados com paginação Keyset.

## 🛡️ 5. Boas Práticas

1. **Idempotência no Consumidor**: O sistema garante entrega *at-least-once*. Seu consumidor **DEVE** ser idempotente usando o `tracking_id`.
2. **Monitoramento de DLE**: Eventos que atingem o máximo de re-tentativas vão para `DEAD_LETTER`. Monitore esses casos para intervenção manual.
3. **Particionamento**: Nunca use uma tabela única sem partições para produção; a performance do VACUUM irá degradar.

## 💡 6. Exemplos Reais

- [**Integração CERC (AP001)**](EXAMPLE_CERC.md): Fluxo completo envolvendo geração de arquivos, upload para S3 e resposta assíncrona.

---
Para mais detalhes arquiteturais, veja o [README.md](../README.md).
