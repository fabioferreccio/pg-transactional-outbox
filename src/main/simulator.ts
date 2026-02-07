/**
 * Event Simulator Service
 *
 * Generates realistic domain events for testing and demonstration.
 */

import crypto from "node:crypto";

export interface SimulatedEvent {
  trackingId: string;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
}

export class EventSimulator {
  private static producerIndex = 0;
  private static producers = ["Producer-A", "Producer-B", "Producer-C"];

  static getProducers(): string[] {
    return [...this.producers];
  }

  static addProducer(): string {
    const nextChar = String.fromCharCode(65 + this.producers.length);
    const newId = `Producer-${nextChar}`;
    this.producers.push(newId);
    return newId;
  }

  static removeProducer(): string | null {
    if (this.producers.length <= 1) return null;
    return this.producers.pop() || null;
  }

  private static getNextProducerId(): string {
    const id = this.producers[this.producerIndex]!;
    this.producerIndex = (this.producerIndex + 1) % this.producers.length;
    return id;
  }

  /**
   * Generates a successful Order flow
   */
  static generateOrderCreated(
    meta: Record<string, unknown> = {},
  ): SimulatedEvent {
    const orderId = crypto.randomUUID();
    return {
      trackingId: crypto.randomUUID(),
      aggregateType: "Order",
      aggregateId: orderId,
      eventType: "OrderCreated",
      payload: {
        orderId,
        producerId: this.getNextProducerId(),
        amount: Math.floor(Math.random() * 500) + 10,
        currency: "USD",
        customer: "John Doe",
        simulation: meta, // Failure injection metadata
        items: [
          { id: "prod-1", qty: 1 },
          { id: "prod-2", qty: 2 },
        ],
      },
    };
  }

  /**
   * Generates a payment failed event
   */
  static generatePaymentFailed(
    meta: Record<string, unknown> = {},
  ): SimulatedEvent {
    return {
      trackingId: crypto.randomUUID(),
      aggregateType: "Payment",
      aggregateId: crypto.randomUUID(),
      eventType: "PaymentFailed",
      payload: {
        producerId: this.getNextProducerId(),
        reason: "Insufficient funds",
        code: "E_FUNDS",
        attempt: 1,
        simulation: meta,
      },
    };
  }

  /**
   * Generates a user registration event
   */
  static generateUserRegistered(
    meta: Record<string, unknown> = {},
  ): SimulatedEvent {
    const userId = crypto.randomUUID();
    return {
      trackingId: crypto.randomUUID(),
      aggregateType: "User",
      aggregateId: userId,
      eventType: "UserRegistered",
      payload: {
        userId,
        producerId: this.getNextProducerId(),
        email: `user_${Math.floor(Math.random() * 1000)}@example.com`,
        tier: "premium",
        simulation: meta,
      },
    };
  }
}
