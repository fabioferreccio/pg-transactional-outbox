/**
 * PostgreSQL Notification Listener
 *
 * Uses 'pg' driver's LISTEN/NOTIFY capability.
 */
import type { Pool, PoolClient } from "pg";
import { NotificationListener } from "./notification-listener.js";

export class PgNotificationListener implements NotificationListener {
  private client?: PoolClient;

  constructor(private readonly pool: Pool) {}

  async connect(): Promise<void> {
    this.client = await this.pool.connect();
  }

  async listen(
    channel: string,
    onNotify: (payload?: string) => void,
  ): Promise<void> {
    if (!this.client) {
      throw new Error("Not connected. Call connect() first.");
    }

    this.client.on("notification", (msg) => {
      if (msg.channel === channel) {
        onNotify(msg.payload);
      }
    });

    await this.client.query(`LISTEN ${channel}`);
  }

  async unlisten(channel: string): Promise<void> {
    if (this.client) {
      await this.client.query(`UNLISTEN ${channel}`);
    }
  }

  async close(): Promise<void> {
    if (this.client) {
      this.client.release();
      this.client = undefined;
    }
  }
}
