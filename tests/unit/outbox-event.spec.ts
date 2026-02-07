/**
 * OutboxEvent Unit Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { OutboxEvent } from '../../src/core/domain/entities/outbox-event.js';

describe('OutboxEvent', () => {
  describe('create', () => {
    it('should create an event with default values', () => {
      const event = OutboxEvent.create({
        trackingId: 'test-tracking-id',
        aggregateId: 'agg-123',
        aggregateType: 'Order',
        eventType: 'OrderCreated',
        payload: { orderId: 123 },
      });

      expect(event.trackingId).toBe('test-tracking-id');
      expect(event.aggregateId).toBe('agg-123');
      expect(event.aggregateType).toBe('Order');
      expect(event.eventType).toBe('OrderCreated');
      expect(event.status).toBe('PENDING');
      expect(event.retryCount).toBe(0);
      expect(event.maxRetries).toBe(5);
    });

    it('should generate tracking ID if not provided', () => {
      const event = OutboxEvent.create({
        aggregateId: 'agg-123',
        aggregateType: 'Order',
        eventType: 'OrderCreated',
        payload: {},
      });

      expect(event.trackingId).toBeDefined();
      expect(event.trackingId.length).toBeGreaterThan(0);
    });
  });

  describe('canRetry', () => {
    it('should return true when retry count is below max', () => {
      const event = OutboxEvent.reconstitute({
        trackingId: 'test',
        aggregateId: 'agg-123',
        aggregateType: 'Order',
        eventType: 'OrderCreated',
        payload: {},
        retryCount: 2,
        maxRetries: 5,
      });

      expect(event.canRetry()).toBe(true);
    });

    it('should return false when retry count equals max', () => {
      const event = OutboxEvent.reconstitute({
        trackingId: 'test',
        aggregateId: 'agg-123',
        aggregateType: 'Order',
        eventType: 'OrderCreated',
        payload: {},
        retryCount: 5,
        maxRetries: 5,
      });

      expect(event.canRetry()).toBe(false);
    });
  });

  describe('isLeased', () => {
    it('should return true when locked_until is in the future', () => {
      const event = OutboxEvent.reconstitute({
        trackingId: 'test',
        aggregateId: 'agg-123',
        aggregateType: 'Order',
        eventType: 'OrderCreated',
        payload: {},
        lockedUntil: new Date(Date.now() + 30000),
      });

      expect(event.isLeased()).toBe(true);
    });

    it('should return false when locked_until is in the past', () => {
      const event = OutboxEvent.reconstitute({
        trackingId: 'test',
        aggregateId: 'agg-123',
        aggregateType: 'Order',
        eventType: 'OrderCreated',
        payload: {},
        lockedUntil: new Date(Date.now() - 1000),
      });

      expect(event.isLeased()).toBe(false);
    });
  });

  describe('isLeaseExpired', () => {
    it('should return true when lease has expired', () => {
      const event = OutboxEvent.reconstitute({
        trackingId: 'test',
        aggregateId: 'agg-123',
        aggregateType: 'Order',
        eventType: 'OrderCreated',
        payload: {},
        lockedUntil: new Date(Date.now() - 1000),
      });

      expect(event.isLeaseExpired()).toBe(true);
    });
  });

  describe('getAgeMs', () => {
    it('should return age in milliseconds', () => {
      const createdAt = new Date(Date.now() - 5000);
      const event = OutboxEvent.reconstitute({
        trackingId: 'test',
        aggregateId: 'agg-123',
        aggregateType: 'Order',
        eventType: 'OrderCreated',
        payload: {},
        createdAt,
      });

      const age = event.getAgeMs();
      expect(age).toBeGreaterThanOrEqual(5000);
      expect(age).toBeLessThan(6000);
    });
  });
});
