exports.up = async function up(knex) {
  await knex.schema.alterTable("runtime_store_documents", (table) => {
    table.binary("source_blob");
    table.boolean("payload_contains_null").notNullable().defaultTo(false);
  });
  await knex.schema.alterTable("runtime_store_document_history", (table) => {
    table.binary("source_blob");
    table.boolean("payload_contains_null").notNullable().defaultTo(false);
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable("runtime_store_document_history", (table) => {
    table.dropColumn("payload_contains_null");
    table.dropColumn("source_blob");
  });
  await knex.schema.alterTable("runtime_store_documents", (table) => {
    table.dropColumn("payload_contains_null");
    table.dropColumn("source_blob");
  });
};
