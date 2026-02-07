/**
 * Debezium Configuration Generator (v0.8)
 *
 * Generates configuration for Debezium PostgreSQL connector
 * to enable CDC-based event streaming from the outbox table.
 */

export interface DebeziumConnectorOptions {
  /** Unique connector name */
  connectorName: string;
  /** PostgreSQL host */
  dbHost: string;
  /** PostgreSQL port */
  dbPort: number;
  /** Database name */
  dbName: string;
  /** Database user */
  dbUser: string;
  /** Database password */
  dbPassword: string;
  /** Outbox table name */
  tableName?: string;
  /** Schema name */
  schemaName?: string;
  /** Kafka topic prefix */
  topicPrefix?: string;
  /** Slot name for replication */
  slotName?: string;
  /** Publication name */
  publicationName?: string;
  /** Heartbeat interval in milliseconds */
  heartbeatIntervalMs?: number;
}

export interface DebeziumOutboxRouteOptions {
  /** Route by event type field */
  routeByField?: string;
  /** Topic routing expression */
  routeTopicRegex?: string;
  /** Payload field */
  payloadField?: string;
  /** Additional fields to include */
  additionalFields?: string[];
}

export class DebeziumConfig {
  /**
   * Generate Debezium PostgreSQL connector configuration
   */
  static generateConnectorConfig(options: DebeziumConnectorOptions): object {
    const config = {
      name: options.connectorName,
      config: {
        "connector.class": "io.debezium.connector.postgresql.PostgresConnector",
        "database.hostname": options.dbHost,
        "database.port": options.dbPort,
        "database.user": options.dbUser,
        "database.password": options.dbPassword,
        "database.dbname": options.dbName,
        "database.server.name": options.connectorName,
        "table.include.list": `${options.schemaName ?? "public"}.${options.tableName ?? "outbox"}`,
        "slot.name": options.slotName ?? `${options.connectorName}_slot`,
        "publication.name": options.publicationName ?? `${options.connectorName}_publication`,
        "plugin.name": "pgoutput",
        "topic.prefix": options.topicPrefix ?? options.connectorName,
        "heartbeat.interval.ms": options.heartbeatIntervalMs ?? 10000,
        "tombstones.on.delete": false,
        "key.converter": "org.apache.kafka.connect.json.JsonConverter",
        "value.converter": "org.apache.kafka.connect.json.JsonConverter",
        "key.converter.schemas.enable": false,
        "value.converter.schemas.enable": false,
      },
    };

    return config;
  }

  /**
   * Generate Debezium Outbox Event Router SMT configuration
   */
  static generateOutboxRouterConfig(options: DebeziumOutboxRouteOptions = {}): object {
    // Use underscore separator to avoid regex escape issues
    const defaultRegex = "(.*)_outbox";

    return {
      "transforms": "outbox",
      "transforms.outbox.type": "io.debezium.transforms.outbox.EventRouter",
      "transforms.outbox.table.field.event.id": "id",
      "transforms.outbox.table.field.event.key": "aggregate_id",
      "transforms.outbox.table.field.event.type": options.routeByField ?? "event_type",
      "transforms.outbox.table.field.event.payload": options.payloadField ?? "payload",
      "transforms.outbox.table.field.event.timestamp": "created_at",
      "transforms.outbox.route.topic.regex": options.routeTopicRegex ?? defaultRegex,
      "transforms.outbox.route.topic.replacement": "$1_events",
      "transforms.outbox.table.expand.json.payload": true,
      ...(options.additionalFields && {
        "transforms.outbox.table.fields.additional.placement":
          options.additionalFields.join(","),
      }),
    };
  }

  /**
   * Generate complete Kafka Connect configuration with SMT
   */
  static generateFullConfig(
    connectorOptions: DebeziumConnectorOptions,
    routerOptions?: DebeziumOutboxRouteOptions,
  ): object {
    const connectorConfig = this.generateConnectorConfig(connectorOptions);
    const routerConfig = this.generateOutboxRouterConfig(routerOptions);

    return {
      ...connectorConfig,
      config: {
        ...(connectorConfig as { config: object }).config,
        ...routerConfig,
      },
    };
  }

  /**
   * Generate SQL to create replication slot and publication
   */
  static generateSetupSQL(options: DebeziumConnectorOptions): string {
    const slotName = options.slotName ?? `${options.connectorName}_slot`;
    const publicationName = options.publicationName ?? `${options.connectorName}_publication`;
    const tableName = `${options.schemaName ?? "public"}.${options.tableName ?? "outbox"}`;

    return `
-- Create publication for outbox table
CREATE PUBLICATION ${publicationName} FOR TABLE ${tableName};

-- Create replication slot (required for Debezium)
SELECT pg_create_logical_replication_slot('${slotName}', 'pgoutput');

-- Grant replication privileges to user
ALTER USER ${options.dbUser} WITH REPLICATION;

-- Verify setup
SELECT * FROM pg_replication_slots WHERE slot_name = '${slotName}';
SELECT * FROM pg_publication WHERE pubname = '${publicationName}';
`.trim();
  }
}
