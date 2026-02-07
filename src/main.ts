/**
 * Application Entry Point
 *
 * Orchestrates the Outbox Worker and a basic HTTP server for Prometheus metrics.
 */

import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import pg from "pg";
import { OutboxWorker } from "./adapters/messaging/outbox-worker.js";
import { PostgresOutboxRepository } from "./adapters/persistence/postgres-outbox.repository.js";
import { DashboardApi } from "./main/dashboard-api.js";
import { EventSimulator } from "./main/simulator.js";
import { PublishEventUseCase } from "./core/use-cases/publish-event.use-case.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration from environment
const PORT = parseInt(process.env.PORT || "3000", 10);
const DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgresql://outbox:outbox_secret@localhost:5432/outbox";

// Global simulation state
let isSlowConsumer = false;
let backgroundTrafficInterval: NodeJS.Timeout | null = null;

// Resilient connection check
async function checkConnection(pool: pg.Pool, retries = 15) {
  for (let i = 0; i < retries; i++) {
    try {
      await pool.query("SELECT 1");
      console.log("✅ Database connection established.");
      return;
    } catch (err) {
      console.warn(`⚠️ Database connection failed (attempt ${i + 1}/${retries}). Retrying in 3s...`);
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
  }
  process.exit(1);
}

async function bootstrap() {
  const pool = new pg.Pool({ connectionString: DATABASE_URL });
  await checkConnection(pool);

  // 1. Initialize Adapters
  const repository = new PostgresOutboxRepository(pool);

  /**
   * 2. Simulated Publisher for Testing
   * Custom mock that handles failure injection via payload
   */
  const mockPublisher = {
    publish: async (
      event: import("./core/domain/entities/outbox-event.js").OutboxEvent,
    ) => {
      // Base latency
      let delay = 50 + Math.random() * 200;
      
      // Global Slow Consumer Mode
      if (isSlowConsumer) {
        delay += 2000;
      }

      await new Promise((resolve) => setTimeout(resolve, delay));

      const payload = event.payload as { simulation?: Record<string, unknown> };
      const sim = payload.simulation;

      // FAILURE INJECTION LOGIC
      if (sim?.fail_always || sim?.shouldFail) {
        throw new Error(`[Simulator] Fatal failure for event ${event.id}`);
      }

      if (
        sim?.fail_times &&
        (event.retryCount || 0) < (sim.fail_times as number)
      ) {
        throw new Error(
          `[Simulator] Temporary failure (retry ${event.retryCount}) for event ${event.id}`,
        );
      }

      console.log(
        `📡 [EXTERNAL] Published ${event.eventType} (${event.id})`,
      );
      return { success: true };
    },
    isHealthy: async () => true,
  };

  // 3. Initialize Use Cases
  const publishUseCase = new PublishEventUseCase(repository);
  const dashboardApi = new DashboardApi(repository);

  // 4. Initialize Worker
  const worker = new OutboxWorker(repository, mockPublisher, {
    pollIntervalMs: 1000,
    batchSize: 10,
    reaperEnabled: true,
  });

  // 5. API and Static Server
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://localhost:${PORT}`);

    // CORS headers for local development
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // API: Stats
    if (url.pathname === "/api/stats") {
      const stats = await dashboardApi.getStats();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(stats));
      return;
    }

    // API: Recent Events
    if (url.pathname === "/api/events") {
      const before = url.searchParams.get("before") || undefined;
      const after = url.searchParams.get("after") || undefined;

      const result = await dashboardApi.getRecentEvents({ before, after });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
      return;
    }

    // API: Simulate
    if (url.pathname === "/api/simulate" && req.method === "POST") {
      const type = url.searchParams.get("type") || "order";
      const mode = url.searchParams.get("mode") || "success";

      const simMeta: Record<string, unknown> = {};
      if (mode === "retry") simMeta.fail_times = 2;
      if (mode === "fail") simMeta.shouldFail = true;

      let event;
      if (type === "order")
        event = EventSimulator.generateOrderCreated(simMeta);
      else if (type === "payment")
        event = EventSimulator.generatePaymentFailed(simMeta);
      else event = EventSimulator.generateUserRegistered(simMeta);

      await publishUseCase.execute(event);
      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          success: true,
          eventId: event.trackingId,
          producerId:
            (event.payload as { producerId?: string })?.producerId || "Unknown",
        }),
      );
      return;
    }

    // API: Simulate Concurrency (Burst)
    if (url.pathname === "/api/simulate-concurrency" && req.method === "POST") {
      const burstSize = 20;
      const types = ["order", "payment", "user"];
      const promises = [];

      for (let i = 0; i < burstSize; i++) {
        const type = types[Math.floor(Math.random() * types.length)];
        let event;
        if (type === "order") event = EventSimulator.generateOrderCreated();
        else if (type === "payment")
          event = EventSimulator.generatePaymentFailed();
        else event = EventSimulator.generateUserRegistered();

        promises.push(publishUseCase.execute(event));
      }

      await Promise.all(promises);
      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, burstSize }));
      return;
    }

    // Metrics (Prometheus Format)
    if (url.pathname === "/metrics") {
      const stats = await dashboardApi.getStats();
      const metrics = `
# HELP outbox_pending_events Number of pending events
# TYPE outbox_pending_events gauge
outbox_pending_events ${stats.pendingEvents}

# HELP outbox_completed_events Number of completed events
# TYPE outbox_completed_events gauge
outbox_completed_events ${stats.completedEvents}

# HELP outbox_dead_letter_events Number of dead letter events
# TYPE outbox_dead_letter_events gauge
outbox_dead_letter_events ${stats.deadLetterEvents}

# HELP outbox_workers Number of active workers
# TYPE outbox_workers gauge
outbox_workers ${stats.workers}

# HELP outbox_producers Number of producers
# TYPE outbox_producers gauge
outbox_producers ${stats.producers}

# HELP outbox_worker_up Worker health status
# TYPE outbox_worker_up gauge
outbox_worker_up 1
`;
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(metrics.trim());
      return;
    }

    // API: Add Producer
    if (url.pathname === "/api/producers/add" && req.method === "POST") {
      const newId = EventSimulator.addProducer();
      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, producerId: newId }));
      return;
    }

    // API: Remove Producer
    if (url.pathname === "/api/producers/remove" && req.method === "POST") {
      const removedId = EventSimulator.removeProducer();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: !!removedId, producerId: removedId }));
      return;
    }

    // API: Toggle Slow Consumer
    if (url.pathname === "/api/toggle-slow" && req.method === "POST") {
      isSlowConsumer = !isSlowConsumer;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, isSlowConsumer }));
      return;
    }

    // API: Toggle Background Traffic
    if (url.pathname === "/api/toggle-traffic" && req.method === "POST") {
      if (backgroundTrafficInterval) {
        clearInterval(backgroundTrafficInterval);
        backgroundTrafficInterval = null;
      } else {
        backgroundTrafficInterval = setInterval(async () => {
          const type = ["order", "payment", "user"][Math.floor(Math.random() * 3)];
          let event;
          if (type === "order") event = EventSimulator.generateOrderCreated();
          else if (type === "payment") event = EventSimulator.generatePaymentFailed();
          else event = EventSimulator.generateUserRegistered();
          
          await publishUseCase.execute(event).catch(console.error);
        }, 3000);
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, isBackgroundBusy: !!backgroundTrafficInterval }));
      return;
    }

    // API: Toggle CDC Slot (Mock)
    if (url.pathname === "/api/toggle-cdc" && req.method === "POST") {
      try {
        const slots = await pool.query("SELECT slot_name FROM pg_replication_slots WHERE slot_name = 'outbox_slot'");
        if (slots.rowCount === 0) {
          await pool.query("SELECT * FROM pg_create_logical_replication_slot('outbox_slot', 'pgoutput')");
        } else {
          await pool.query("SELECT pg_drop_replication_slot('outbox_slot')");
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: (err as Error).message }));
      }
      return;
    }

    // --- HEAVY CHAOS ENDPOINTS ---

    // API: Simulate DB Bloat (Massive Insert/Delete)
    if (url.pathname === "/api/simulate-bloat" && req.method === "POST") {
      try {
        console.log("💣 [SIMULATOR] Generating HEAVY DB Bloat (100,000 rows)...");
        // Insert 100,000 small rows
        await pool.query(`INSERT INTO outbox (event_type, aggregate_type, aggregate_id, payload, status) 
                         SELECT 'bloat_event', 'system', gen_random_uuid(), '{"data":"heavy_bloat"}'::jsonb, 'COMPLETED'
                         FROM generate_series(1, 100000)`);
        
        await pool.query("ANALYZE outbox");

        // Stage 2: Create more dead tuples via massive updates at 15s
        setTimeout(async () => {
          try {
            console.log("🔥 [SIMULATOR] Updating 50% of bloat rows to generate extra DEAD tuples...");
            await pool.query("UPDATE outbox SET payload = jsonb_set(payload, '{updated}', 'true') WHERE event_type = 'bloat_event' AND id % 2 = 0");
            await pool.query("ANALYZE outbox");
          } catch (e) {
            console.error("Failed to update bloat:", e);
          }
        }, 15000);

        // Stage 3: Delete everything at 30s
        setTimeout(async () => {
          try {
            console.log("🧹 [SIMULATOR] Cleaning up bloat rows to generate final DEAD tuples spike...");
            await pool.query("DELETE FROM outbox WHERE event_type = 'bloat_event'");
            await pool.query("ANALYZE outbox");
          } catch (e) {
            console.error("Failed to cleanup bloat:", e);
          }
        }, 30000);

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, count: 100000, message: "100k rows created. Update at 15s, Delete at 30s." }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: (err as Error).message }));
      }
      return;
    }

    // API: Simulate High-Burst (100 ev/sec for 10s)
    if (url.pathname === "/api/simulate-burst" && req.method === "POST") {
      console.log("🎢 [SIMULATOR] Starting High-Burst Stress Test (1000 events)...");
      (async () => {
        for (let i = 0; i < 1000; i++) {
          const event = EventSimulator.generateOrderCreated();
          publishUseCase.execute(event).catch(() => {});
          if (i % 100 === 0) await new Promise(r => setTimeout(r, 100)); // Rate limit 1000ev/sec roughly
        }
      })();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true }));
      return;
    }

    // API: Simulate Sequence Stress (Jump to ~90% of BIGINT for visualization)
    if (url.pathname === "/api/simulate-sequence-stress" && req.method === "POST") {
      try {
        console.log("📉 [SIMULATOR] Stressing Sequence Gauge (BIGINT Scale)...");
        // Set sequence to ~8.3 quintillion (approx 90% of BIGINT limit 9.22E18)
        await pool.query("SELECT setval('outbox_id_seq', 8300000000000000000)");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: (err as Error).message }));
      }
      return;
    }

    // API: Simulate Partitions (Create dummy tables)
    if (url.pathname === "/api/simulate-partitions" && req.method === "POST") {
      try {
        console.log("🧩 [SIMULATOR] Creating dummy declarative partitions...");
        for (let i = 1; i <= 5; i++) {
          const year = 2099;
          const month = i.toString().padStart(2, '0');
          const nextMonth = (i + 1).toString().padStart(2, '0');
          
          await pool.query(`
            CREATE TABLE IF NOT EXISTS outbox_p_demo_${i} 
            PARTITION OF outbox 
            FOR VALUES FROM ('${year}-${month}-01') TO ('${year}-${nextMonth}-01')
          `);
        }
        // FORCE ANALYZE TO UPDATE STATS FOR PARTITIONS
        await pool.query("ANALYZE outbox");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: (err as Error).message }));
      }
      return;
    }

    // --- END HEAVY CHAOS ---

    // API: Cleanup
    if (url.pathname === "/api/cleanup" && req.method === "POST") {
      const count = await dashboardApi.cleanupEvents();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, count }));
      return;
    }

    // API: Get Simulation State (Extra)
    if (url.pathname === "/api/simulation-state") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        isSlowConsumer,
        isBackgroundBusy: !!backgroundTrafficInterval,
        isCdcActive: (await pool.query("SELECT 1 FROM pg_replication_slots WHERE slot_name = 'outbox_slot'")).rowCount! > 0
      }));
      return;
    }

    // Static Files (Dashboard)
    const filePath = path.join(
      __dirname,
      "../dashboard",
      url.pathname === "/" ? "index.html" : url.pathname,
    );

    if (fs.existsSync(filePath)) {
      const ext = path.extname(filePath);
      const contentTypes: Record<string, string> = {
        ".html": "text/html",
        ".js": "text/javascript",
        ".css": "text/css",
        ".json": "application/json",
      };
      res.writeHead(200, { "Content-Type": contentTypes[ext] || "text/plain" });
      fs.createReadStream(filePath).pipe(res);
      return;
    }

    res.writeHead(404);
    res.end("Not Found");
  });

  // 6. Start everything
  server.listen(PORT, () => {
    console.log(`
╔═══════════════════════════════════════════════════════════════╗
║  🎯 Transactional Outbox Control Plane                        ║
╠═══════════════════════════════════════════════════════════════╣
║                                                               ║
║  Dashboard:    http://localhost:${PORT}                          ║
║  Prometheus:   http://localhost:${PORT}/metrics                  ║
║                                                               ║
║  Grafana:      http://localhost:3001 (admin/admin)            ║
║  Prometheus:   http://localhost:9090                          ║
║                                                               ║
╚═══════════════════════════════════════════════════════════════╝
    `);
  });

  console.log("👷 Starting Outbox Worker...");
  await worker.start();

  // Handle Shutdown
  const shutdown = async () => {
    console.log("\n🛑 Shutting down...");
    await worker.stop();
    server.close();
    await pool.end();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  worker.on("processed", (data: { id: bigint; eventType: string }) => {
    console.log(`✅ Event processed: ${data.eventType} (ID: ${data.id})`);
  });

  worker.on("error", (err: Error) => {
    console.error("❌ Worker error:", err);
  });
}

bootstrap().catch((err) => {
  console.error("💥 Bootstrap failed:", err);
  process.exit(1);
});

