/**
 * Alert Webhook (v0.5)
 *
 * Sends alerts via webhook when thresholds are exceeded.
 */

import type { OutboxRepositoryPort } from "../../ports/outbox-repository.port.js";

export interface AlertConfig {
  /** Webhook URL to send alerts to */
  webhookUrl: string;
  /** Lag threshold in seconds (alert if oldest pending > this) */
  lagThresholdSeconds: number;
  /** Dead letter threshold (alert if DLE count > this) */
  deadLetterThreshold: number;
  /** How often to check thresholds in milliseconds */
  checkIntervalMs: number;
  /** Optional: Custom headers for webhook requests */
  headers?: Record<string, string>;
}

export interface AlertPayload {
  type: "lag" | "dead_letter" | "backlog";
  severity: "warning" | "critical";
  message: string;
  value: number;
  threshold: number;
  timestamp: string;
}

export class AlertWebhook {
  private intervalId?: ReturnType<typeof setInterval>;
  private lastAlertTime: Map<string, number> = new Map();
  private readonly cooldownMs = 60000; // 1 minute cooldown per alert type

  constructor(
    private readonly repository: OutboxRepositoryPort,
    private readonly config: AlertConfig,
  ) {}

  /**
   * Start monitoring and sending alerts
   */
  start(): void {
    if (this.intervalId) {
      return; // Already running
    }

    this.intervalId = setInterval(async () => {
      await this.check();
    }, this.config.checkIntervalMs);

    console.log(
      `[AlertWebhook] Started monitoring (interval: ${this.config.checkIntervalMs}ms)`,
    );
  }

  /**
   * Stop monitoring
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
      console.log("[AlertWebhook] Stopped monitoring");
    }
  }

  /**
   * Check thresholds and send alerts if needed
   */
  async check(): Promise<void> {
    try {
      const [lagSeconds, deadLetterCount] = await Promise.all([
        this.repository.getOldestPendingAgeSeconds(),
        this.repository.getDeadLetterCount(),
      ]);

      // Check lag threshold
      if (lagSeconds > this.config.lagThresholdSeconds) {
        await this.sendAlert({
          type: "lag",
          severity: lagSeconds > this.config.lagThresholdSeconds * 2 ? "critical" : "warning",
          message: `Event processing lag exceeded threshold`,
          value: lagSeconds,
          threshold: this.config.lagThresholdSeconds,
          timestamp: new Date().toISOString(),
        });
      }

      // Check dead letter threshold
      if (deadLetterCount > this.config.deadLetterThreshold) {
        await this.sendAlert({
          type: "dead_letter",
          severity: deadLetterCount > this.config.deadLetterThreshold * 2 ? "critical" : "warning",
          message: `Dead letter count exceeded threshold`,
          value: deadLetterCount,
          threshold: this.config.deadLetterThreshold,
          timestamp: new Date().toISOString(),
        });
      }
    } catch (error) {
      console.error("[AlertWebhook] Error during check:", error);
    }
  }

  /**
   * Send an alert via webhook
   */
  private async sendAlert(payload: AlertPayload): Promise<void> {
    // Check cooldown to prevent alert spam
    const lastAlert = this.lastAlertTime.get(payload.type) ?? 0;
    if (Date.now() - lastAlert < this.cooldownMs) {
      return; // Still in cooldown
    }

    try {
      const response = await fetch(this.config.webhookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...this.config.headers,
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        console.error(
          `[AlertWebhook] Failed to send alert: ${response.status} ${response.statusText}`,
        );
      } else {
        this.lastAlertTime.set(payload.type, Date.now());
        console.log(
          `[AlertWebhook] Alert sent: ${payload.type} (${payload.severity})`,
        );
      }
    } catch (error) {
      console.error("[AlertWebhook] Error sending alert:", error);
    }
  }
}
