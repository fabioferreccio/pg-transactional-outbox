/**
 * Stripe Integration Example (v0.6)
 *
 * Demonstrates how to use the IdempotentExecutor with Stripe's
 * built-in idempotency key feature for payment processing.
 *
 * This example shows the recommended pattern for:
 * - Forwarding outbox tracking ID as Stripe idempotency key
 * - Handling duplicate payment requests
 * - Proper error handling
 */

import { IdempotentExecutor } from "../src/core/domain/services/idempotent-executor.js";
import type { IdempotencyStorePort } from "../src/core/ports/idempotency-store.port.js";

// Mock Stripe types (in real code, use 'stripe' package)
interface StripePaymentIntent {
  id: string;
  amount: number;
  currency: string;
  status: string;
}

interface StripeClient {
  paymentIntents: {
    create: (
      params: { amount: number; currency: string },
      options?: { idempotencyKey?: string },
    ) => Promise<StripePaymentIntent>;
  };
}

/**
 * Example: Processing a payment event from the outbox
 */
export async function processPaymentEvent(
  event: { trackingId: string; payload: { amount: number; currency: string } },
  store: IdempotencyStorePort,
  stripe: StripeClient,
): Promise<void> {
  const executor = new IdempotentExecutor({
    store,
    consumerId: "payment-processor",
  });

  const result = await executor.withIdempotency(event.trackingId, async () => {
    // The key insight: forward the outbox tracking ID to Stripe
    // This provides double-layer idempotency protection:
    // 1. Our IdempotencyStore prevents duplicate function calls
    // 2. Stripe's idempotency key prevents duplicate API calls
    const paymentIntent = await stripe.paymentIntents.create(
      {
        amount: event.payload.amount,
        currency: event.payload.currency,
      },
      {
        // CRITICAL: Forward the tracking ID as Stripe's idempotency key
        idempotencyKey: event.trackingId,
      },
    );

    console.log(`[Stripe] Payment created: ${paymentIntent.id}`);
    return paymentIntent;
  });

  if (result.executed) {
    console.log(`[Handler] Payment processed successfully:`, result.result?.id);
  } else {
    console.log(`[Handler] Duplicate event - originally processed at ${result.processedAt?.toISOString()}`);
    // Event is idempotent - no action needed
  }
}

/**
 * Best Practices for Stripe Integration:
 *
 * 1. ALWAYS forward the trackingId as idempotencyKey
 *    - This ensures Stripe won't create duplicate payments even if our DB fails
 *
 * 2. Use the IdempotentExecutor wrapper
 *    - Prevents unnecessary API calls for already-processed events
 *    - Reduces Stripe API usage and potential rate limiting
 *
 * 3. Handle Stripe's idempotency errors gracefully
 *    - Stripe returns the original response for idempotent requests
 *    - This is expected behavior, not an error
 *
 * 4. Set appropriate Stripe idempotency key expiry
 *    - Default is 24 hours
 *    - Consider your event retention policy
 *
 * 5. Log both successful and duplicate processing
 *    - Helps with debugging and audit trails
 */
