/**
 * Application Entry Point
 * 
 * Orchestrates the Outbox Worker and a basic HTTP server for Prometheus metrics.
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';
import { OutboxWorker } from './adapters/messaging/outbox-worker.js';
import { PostgresOutboxRepository } from './adapters/persistence/postgres-outbox.repository.js';
import { DashboardApi } from './main/dashboard-api.js';
import { EventSimulator } from './main/simulator.js';
import { PublishEventUseCase } from './core/use-cases/publish-event.use-case.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration from environment
const dbConfig = {
  connectionString: process.env.DATABASE_URL || 'postgresql://outbox:outbox_secret@localhost:5432/outbox',
};

const PORT = 3000;

async function bootstrap() {
  const pool = new pg.Pool(dbConfig);
  
  // 1. Initialize Adapters
  const repository = new PostgresOutboxRepository(pool);
  
  // 2. Simple Mock Publisher for testing
  const mockPublisher = {
    publish: async (event: any) => {
      // Simulate network latency
      await new Promise(resolve => setTimeout(resolve, Math.random() * 800));

      // FAILURE INJECTION LOGIC
      const sim = event.payload?.simulation;
      if (sim?.fail_always) {
        throw new Error(`[Simulator] Fatal failure for event ${event.id}`);
      }
      
      if (sim?.fail_times && (event.retryCount || 0) < sim.fail_times) {
        throw new Error(`[Simulator] Temporary failure (retry ${event.retryCount}) for event ${event.id}`);
      }

      console.log(`[Publisher] Publishing event: ${event.eventType} (${event.id})`);
      return { success: true };
    },
    isHealthy: async () => true
  };

  // 3. Initialize Use Cases
  const publishUseCase = new PublishEventUseCase(repository);
  const dashboardApi = new DashboardApi(repository);

  // 4. Initialize Worker
  const worker = new OutboxWorker(repository, mockPublisher, {
    pollIntervalMs: 2000,
    batchSize: 5,
    reaperEnabled: true,
  });

  // 5. API and Static Server
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://localhost:${PORT}`);

    // API: Stats
    if (url.pathname === '/api/stats') {
      const stats = await dashboardApi.getStats();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(stats));
      return;
    }

    // API: Recent Events
    if (url.pathname === '/api/events') {
      const before = url.searchParams.get('before') || undefined;
      const after = url.searchParams.get('after') || undefined;
      
      const result = await dashboardApi.getRecentEvents({ before, after });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    // API: Simulate
    if (url.pathname === '/api/simulate' && req.method === 'POST') {
      const type = url.searchParams.get('type') || 'order';
      const mode = url.searchParams.get('mode') || 'success';
      
      const simMeta: Record<string, any> = {};
      if (mode === 'retry') simMeta.fail_times = 2;
      if (mode === 'fail') simMeta.fail_always = true;

      let event;
      if (type === 'order') event = EventSimulator.generateOrderCreated(simMeta);
      else if (type === 'payment') event = EventSimulator.generatePaymentFailed(simMeta);
      else event = EventSimulator.generateUserRegistered(simMeta);

      await publishUseCase.execute(event);
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ 
        success: true, 
        eventId: event.trackingId, 
        producerId: (event.payload as any).producerId 
      }));
      return;
    }

    // API: Simulate Concurrency (Burst)
    if (url.pathname === '/api/simulate-concurrency' && req.method === 'POST') {
      const burstSize = 20;
      const types = ['order', 'payment', 'user'];
      const promises = [];

      for (let i = 0; i < burstSize; i++) {
        const type = types[Math.floor(Math.random() * types.length)];
        let event;
        if (type === 'order') event = EventSimulator.generateOrderCreated();
        else if (type === 'payment') event = EventSimulator.generatePaymentFailed();
        else event = EventSimulator.generateUserRegistered();
        
        promises.push(publishUseCase.execute(event));
      }

      await Promise.all(promises);
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, burstSize }));
      return;
    }

    // Metrics (Prometheus)
    if (url.pathname === '/metrics') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('# HELP outbox_worker_up Status\noutbox_worker_up 1\n');
      return;
    }

    // API: Add Producer
    if (url.pathname === '/api/producers/add' && req.method === 'POST') {
      const newId = EventSimulator.addProducer();
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, producerId: newId }));
      return;
    }

    // API: Remove Producer
    if (url.pathname === '/api/producers/remove' && req.method === 'POST') {
      const removedId = EventSimulator.removeProducer();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: !!removedId, producerId: removedId }));
      return;
    }

    // API: Cleanup
    if (url.pathname === '/api/cleanup' && req.method === 'POST') {
      const count = await dashboardApi.cleanupEvents();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, count }));
      return;
    }

    // Static Files (Dashboard)
    let filePath = path.join(__dirname, '../dashboard', url.pathname === '/' ? 'index.html' : url.pathname);
    
    if (fs.existsSync(filePath)) {
      const ext = path.extname(filePath);
      const contentTypes: any = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
      res.writeHead(200, { 'Content-Type': contentTypes[ext] || 'text/plain' });
      fs.createReadStream(filePath).pipe(res);
      return;
    }

    res.writeHead(404);
    res.end('Not Found');
  });

  // 6. Start everything
  server.listen(PORT, () => {
    console.log(`🚀 Control Plane Dashboard: http://localhost:${PORT}`);
    console.log(`📈 Metrics available: http://localhost:${PORT}/metrics`);
  });

  console.log('👷 Starting Outbox Worker...');
  await worker.start();

  // Handle Shutdown
  const shutdown = async () => {
    console.log('\n🛑 Shutting down...');
    await worker.stop();
    server.close();
    await pool.end();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  worker.on('processed', (data: { id: bigint, eventType: string }) => {
    console.log(`✅ Event processed: ${data.eventType} (ID: ${data.id})`);
  });

  worker.on('error', (err: Error) => {
    console.error('❌ Worker error:', err);
  });
}

bootstrap().catch(err => {
    console.error('💥 Bootstrap failed:', err);
    process.exit(1);
  });

