# 🏦 Exemplo Real: Integração CERC (Fluxo AP001)

Este exemplo demonstra como usar a biblioteca para um processo crítico de registro de Estabelecimento Comercial (EC) na CERC, envolvendo geração de arquivos, upload para S3 e processamento assíncrono.

## O Cenário
1. **Cadastro**: O usuário cadastra um novo EC no sistema.
2. **Registro (Sincronismo)**: O sistema deve gerar um arquivo AP001 e enviar para um S3 Bucket da CERC.
3. **Retorno (Assíncrono)**: A CERC processa o arquivo e devolve um arquivo de resposta em outra pasta.
4. **Finalização**: Ao ler a resposta, o sistema atualiza o status do EC para `ATIVO`.

---

## 1. O Produtor (Cadastro do EC)

Aqui garantimos que, se o EC for salvo no banco, a intenção de registro na CERC **também** seja salva de forma atômica.

```typescript
// service/ec-service.ts
import { PostgresOutboxRepository, PublishEventUseCase } from 'pg-transactional-outbox';

async function registerNewEC(ecData: any) {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');

    // 1. Salva o EC com status inicial 'PENDING_REGISTRATION'
    const ecId = crypto.randomUUID();
    await client.query(
      'INSERT INTO estabelecimentos (id, nome, cnpj, status) VALUES ($1, $2, $3, $4)',
      [ecId, ecData.nome, ecData.cnpj, 'PENDING_REGISTRATION']
    );

    // 2. Registra o evento de intenção de registro na Outbox
    const repository = new PostgresOutboxRepository(client);
    const publish = new PublishEventUseCase(repository);
    
    await publish.execute({
      aggregateId: ecId,
      aggregateType: 'Estabelecimento',
      eventType: 'EC_REGISTRATION_REQUESTED',
      payload: { ...ecData, ecId },
      maxRetries: 10 // Mais retries para integração externa crítica
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

## 2. O Worker (Relay para S3/CERC)

O Worker garantirá que o arquivo seja gerado e enviado, mesmo que o S3 oscile.

```typescript
// integration/cerc-publisher.ts
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

const s3 = new S3Client(...);

export const cercPublisher = {
  publish: async (event) => {
    if (event.eventType === 'EC_REGISTRATION_REQUESTED') {
      // 1. Gera o conteúdo do AP001 (CSV/JSON/FixedLength)
      const fileContent = generateAP001(event.payload);
      const fileName = `AP001_${event.payload.ecId}.csv`;

      // 2. Upload para o S3
      await s3.send(new PutObjectCommand({
        Bucket: 'cerc-inbound',
        Key: `pending/${fileName}`,
        Body: fileContent
      }));

      console.log(`[CERC] Arquivo enviado para EC: ${event.payload.ecId}`);
      return { success: true };
    }
    return { success: false };
  }
};

// No arquivo de inicialização (main.ts):
const worker = new OutboxWorker(repository, cercPublisher, {
  pollIntervalMs: 2000,
  batchSize: 10
});
await worker.start();
```

## 3. Callback / Poller de Resposta

Quando a CERC processar, ela colocará um arquivo na pasta de resposta. Note que aqui usamos a Outbox novamente para garantir que a atualização de status e o próximo evento sejam atômicos.

```typescript
// service/response-listener.ts
async function handleCercResponse(fileName: string) {
  const file = await s3.get(fileName);
  const { ecId, success, description } = parseAP001Response(file);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Atualiza o status do negócio
    const finalStatus = success ? 'ACTIVE' : 'REJECTED';
    await client.query(
      'UPDATE estabelecimentos SET status = $1, last_msg = $2 WHERE id = $3',
      [finalStatus, description, ecId]
    );

    // 2. Notifica o resto do sistema via Outbox (ex: para liberar vendas)
    const repository = new PostgresOutboxRepository(client);
    const publish = new PublishEventUseCase(repository);
    
    await publish.execute({
      aggregateId: ecId,
      aggregateType: 'Estabelecimento',
      eventType: success ? 'EC_ACTIVATED' : 'EC_REGISTRATION_FAILED',
      payload: { ecId, reason: description }
    });

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
  } finally {
    client.release();
  }
}
```

## Benefícios Deste Modelo
1. **Consistência Atômica**: O EC nunca ficará "ativo" no banco se o evento de ativação falhar, e nunca um evento dirá que está ativo sem o banco estar atualizado.
2. **Resiliência**: Se o S3 da CERC cair no momento do upload, o Worker tentará novamente com backoff exponencial. Seu código de negócio não precisa lidar com retries de rede.
3. **Auditabilidade**: Você tem o rastro completo de cada tentativa de envio na tabela `outbox`.
4. **Isolamento**: O seu serviço de cadastro não "espera" o S3. Ele apenas faz o commit e libera o usuário. O Worker trabalha em background.
