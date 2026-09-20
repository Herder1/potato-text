exports.up = async function up(knex) {
  await knex.schema.createTable("object_storage_files", (table) => {
    table.text("object_key").primary();
    table.text("provider").notNullable();
    table.text("storage_backend").notNullable().defaultTo("");
    table.text("remote_id").notNullable();
    table.text("download_url").notNullable();
    table.text("share_url").notNullable().defaultTo("");
    table.text("delete_url").notNullable().defaultTo("");
    table.text("original_file_name").notNullable();
    table.text("mime_type").notNullable().defaultTo("application/octet-stream");
    table.bigInteger("size_bytes").notNullable();
    table.string("sha256", 64).notNullable();
    table.text("status").notNullable().defaultTo("active");
    table.jsonb("metadata").notNullable().defaultTo(knex.raw("'{}'::jsonb"));
    table.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp("updated_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp("deleted_at", { useTz: true });

    table.unique(["provider", "remote_id"], { indexName: "object_storage_remote_unique" });
    table.index(["status", "updated_at"], "object_storage_status_lookup");
  });

  await knex.raw(`
    ALTER TABLE object_storage_files
    ADD CONSTRAINT object_storage_files_sha256_format
    CHECK (sha256 ~ '^[0-9a-f]{64}$')
  `);
  await knex.raw(`
    ALTER TABLE object_storage_files
    ADD CONSTRAINT object_storage_files_status_valid
    CHECK (status IN ('active', 'deleted'))
  `);
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists("object_storage_files");
};
