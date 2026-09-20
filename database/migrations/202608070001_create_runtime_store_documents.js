exports.up = async function up(knex) {
  await knex.schema.createTable("runtime_migration_runs", (table) => {
    table.uuid("id").primary();
    table.text("status").notNullable();
    table.text("source_root").notNullable();
    table.jsonb("manifest").notNullable().defaultTo(knex.raw("'[]'::jsonb"));
    table.text("error_message");
    table.timestamp("started_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp("completed_at", { useTz: true });
  });

  await knex.schema.createTable("runtime_store_documents", (table) => {
    table.text("store_key").primary();
    table.text("source_path").notNullable();
    table.jsonb("payload").notNullable();
    table.string("source_sha256", 64).notNullable();
    table.bigInteger("source_bytes").notNullable();
    table.integer("record_count").notNullable();
    table.uuid("migration_run_id").notNullable().references("id").inTable("runtime_migration_runs");
    table.timestamp("source_modified_at", { useTz: true }).notNullable();
    table.timestamp("imported_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp("updated_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.createTable("runtime_store_document_history", (table) => {
    table.bigIncrements("id").primary();
    table.text("store_key").notNullable();
    table.text("source_path").notNullable();
    table.jsonb("payload").notNullable();
    table.string("source_sha256", 64).notNullable();
    table.bigInteger("source_bytes").notNullable();
    table.integer("record_count").notNullable();
    table.uuid("migration_run_id").notNullable();
    table.timestamp("source_modified_at", { useTz: true }).notNullable();
    table.timestamp("imported_at", { useTz: true }).notNullable();
    table.timestamp("archived_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.index(["store_key", "archived_at"], "runtime_store_history_lookup");
  });

  await knex.raw(`
    ALTER TABLE runtime_store_documents
    ADD CONSTRAINT runtime_store_documents_sha256_format
    CHECK (source_sha256 ~ '^[0-9a-f]{64}$')
  `);
  await knex.raw(`
    ALTER TABLE runtime_store_document_history
    ADD CONSTRAINT runtime_store_history_sha256_format
    CHECK (source_sha256 ~ '^[0-9a-f]{64}$')
  `);
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists("runtime_store_document_history");
  await knex.schema.dropTableIfExists("runtime_store_documents");
  await knex.schema.dropTableIfExists("runtime_migration_runs");
};
