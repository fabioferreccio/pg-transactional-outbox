import { describe, it, expect } from "vitest";
import { DebeziumConfig } from "../../src/adapters/cdc/debezium-config";

describe("DebeziumConfig", () => {
  const baseOptions = {
    connectorName: "my-outbox-connector",
    dbHost: "localhost",
    dbPort: 5432,
    dbName: "mydb",
    dbUser: "myuser",
    dbPassword: "mypassword",
  };

  describe("generateConnectorConfig", () => {
    it("should generate valid connector configuration", () => {
      const config = DebeziumConfig.generateConnectorConfig(baseOptions);

      expect(config).toHaveProperty("name", "my-outbox-connector");
      expect(config).toHaveProperty("config");

      const inner = (config as { config: Record<string, unknown> }).config;
      expect(inner["connector.class"]).toBe(
        "io.debezium.connector.postgresql.PostgresConnector",
      );
      expect(inner["database.hostname"]).toBe("localhost");
      expect(inner["database.port"]).toBe(5432);
      expect(inner["table.include.list"]).toBe("public.outbox");
    });

    it("should use custom table and schema", () => {
      const config = DebeziumConfig.generateConnectorConfig({
        ...baseOptions,
        tableName: "events",
        schemaName: "app",
      });

      const inner = (config as { config: Record<string, unknown> }).config;
      expect(inner["table.include.list"]).toBe("app.events");
    });

    it("should generate custom slot and publication names", () => {
      const config = DebeziumConfig.generateConnectorConfig({
        ...baseOptions,
        slotName: "custom_slot",
        publicationName: "custom_pub",
      });

      const inner = (config as { config: Record<string, unknown> }).config;
      expect(inner["slot.name"]).toBe("custom_slot");
      expect(inner["publication.name"]).toBe("custom_pub");
    });
  });

  describe("generateOutboxRouterConfig", () => {
    it("should generate SMT configuration with defaults", () => {
      const config = DebeziumConfig.generateOutboxRouterConfig();

      expect(config).toHaveProperty("transforms", "outbox");
      expect(config).toHaveProperty(
        "transforms.outbox.type",
        "io.debezium.transforms.outbox.EventRouter",
      );
      expect(config).toHaveProperty(
        "transforms.outbox.table.field.event.type",
        "event_type",
      );
    });

    it("should allow custom routing field", () => {
      const config = DebeziumConfig.generateOutboxRouterConfig({
        routeByField: "aggregate_type",
      });

      expect(config).toHaveProperty(
        "transforms.outbox.table.field.event.type",
        "aggregate_type",
      );
    });

    it("should include additional fields when specified", () => {
      const config = DebeziumConfig.generateOutboxRouterConfig({
        additionalFields: ["metadata", "owner"],
      });

      expect(config).toHaveProperty(
        "transforms.outbox.table.fields.additional.placement",
        "metadata,owner",
      );
    });
  });

  describe("generateFullConfig", () => {
    it("should merge connector and router configs", () => {
      const config = DebeziumConfig.generateFullConfig(baseOptions, {
        routeByField: "event_type",
      });

      expect(config).toHaveProperty("name");
      expect(config).toHaveProperty("config");

      const inner = (config as { config: Record<string, unknown> }).config;
      expect(inner["connector.class"]).toBeDefined();
      expect(inner["transforms"]).toBe("outbox");
    });
  });

  describe("generateSetupSQL", () => {
    it("should generate valid SQL statements", () => {
      const sql = DebeziumConfig.generateSetupSQL(baseOptions);

      expect(sql).toContain("CREATE PUBLICATION");
      expect(sql).toContain("pg_create_logical_replication_slot");
      expect(sql).toContain("ALTER USER myuser WITH REPLICATION");
      expect(sql).toContain("my-outbox-connector_slot");
    });
  });
});
