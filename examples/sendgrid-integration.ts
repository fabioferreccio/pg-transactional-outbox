/**
 * SendGrid Integration Example (v0.6)
 *
 * Demonstrates how to use the IdempotentExecutor with SendGrid
 * for email deduplication.
 *
 * Unlike Stripe, SendGrid doesn't have built-in idempotency keys.
 * This example shows patterns for:
 * - Using Message-ID header for deduplication
 * - Custom headers for tracking
 * - Preventing duplicate email sends
 */

import { IdempotentExecutor } from "../src/core/domain/services/idempotent-executor.js";
import type { IdempotencyStorePort } from "../src/core/ports/idempotency-store.port.js";

// Mock SendGrid types (in real code, use '@sendgrid/mail' package)
interface SendGridMessage {
  to: string;
  from: string;
  subject: string;
  html: string;
  headers?: Record<string, string>;
}

interface SendGridClient {
  send: (msg: SendGridMessage) => Promise<{ statusCode: number }>;
}

/**
 * Example: Sending a notification email from the outbox
 */
export async function processEmailNotification(
  event: {
    trackingId: string;
    payload: {
      to: string;
      subject: string;
      body: string;
    };
  },
  store: IdempotencyStorePort,
  sendgrid: SendGridClient,
): Promise<void> {
  const executor = new IdempotentExecutor({
    store,
    consumerId: "email-sender",
  });

  const result = await executor.withIdempotency(event.trackingId, async () => {
    // Use the tracking ID as Message-ID for email deduplication
    // Email clients use Message-ID to detect duplicates
    const messageId = `<${event.trackingId}@your-domain.com>`;

    const response = await sendgrid.send({
      to: event.payload.to,
      from: "notifications@your-domain.com",
      subject: event.payload.subject,
      html: event.payload.body,
      headers: {
        // Message-ID helps email clients detect duplicates
        "Message-ID": messageId,
        // Custom header for our own tracking/debugging
        "X-Outbox-Tracking-ID": event.trackingId,
      },
    });

    console.log(`[SendGrid] Email sent: ${messageId}`);
    return { messageId, statusCode: response.statusCode };
  });

  if (result.executed) {
    console.log(`[Handler] Email sent successfully:`, result.result?.messageId);
  } else {
    console.log(`[Handler] Duplicate event - email already sent at ${result.processedAt?.toISOString()}`);
  }
}

/**
 * Best Practices for Email Deduplication:
 *
 * 1. Use trackingId as Message-ID base
 *    - Format: <trackingId@domain.com>
 *    - Email clients use this to detect duplicates
 *
 * 2. Add custom headers for traceability
 *    - X-Outbox-Tracking-ID for correlation
 *    - Helps with debugging delivery issues
 *
 * 3. Consider email-specific concerns
 *    - Some email systems cache by Message-ID
 *    - Recipients may see only one email even if duplicates sent
 *
 * 4. Use the IdempotentExecutor wrapper
 *    - Prevents unnecessary API calls
 *    - Reduces SendGrid API usage and costs
 *
 * 5. Handle rate limiting
 *    - SendGrid has rate limits
 *    - Consider adding delays or batching for high volume
 *
 * 6. Log for debugging
 *    - Track which emails were sent vs skipped
 *    - Correlate with outbox tracking IDs
 */

/**
 * Advanced: Batch email processing
 */
export async function processBatchEmails(
  events: Array<{
    trackingId: string;
    payload: { to: string; subject: string; body: string };
  }>,
  store: IdempotencyStorePort,
  sendgrid: SendGridClient,
): Promise<{ sent: number; skipped: number }> {
  const executor = new IdempotentExecutor({
    store,
    consumerId: "email-sender",
  });

  let sent = 0;
  let skipped = 0;

  for (const event of events) {
    const result = await executor.withIdempotency(event.trackingId, async () => {
      const messageId = `<${event.trackingId}@your-domain.com>`;

      await sendgrid.send({
        to: event.payload.to,
        from: "notifications@your-domain.com",
        subject: event.payload.subject,
        html: event.payload.body,
        headers: {
          "Message-ID": messageId,
          "X-Outbox-Tracking-ID": event.trackingId,
        },
      });

      return { messageId };
    });

    if (result.executed) {
      sent++;
    } else {
      skipped++;
    }
  }

  console.log(`[Batch] Sent: ${sent}, Skipped: ${skipped}`);
  return { sent, skipped };
}
