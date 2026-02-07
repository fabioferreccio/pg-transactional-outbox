/**
 * CDC Adapters Index (v0.8)
 *
 * Exports all CDC-related adapters and utilities.
 */

export { DebeziumConfig } from "./debezium-config.js";
export type {
  DebeziumConnectorOptions,
  DebeziumOutboxRouteOptions,
} from "./debezium-config.js";

export { CDCEventTransformer } from "./cdc-event-transformer.js";
export type {
  DebeziumMessage,
  DebeziumRow,
  LogicalReplicationMessage,
} from "./cdc-event-transformer.js";

export { LogicalReplicationAdapter } from "./logical-replication-adapter.js";
export type {
  LogicalReplicationConfig,
  ReplicationStatus,
} from "./logical-replication-adapter.js";
