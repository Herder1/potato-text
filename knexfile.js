const path = require("node:path");

function connectionConfig() {
  const connectionString = String(process.env.DATABASE_URL || "").trim();
  if (!connectionString) {
    throw new Error("DATABASE_URL is required for PostgreSQL migrations");
  }

  return {
    connectionString,
    ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : false,
  };
}

function environmentConfig() {
  return {
    client: "pg",
    connection: connectionConfig,
    pool: {
      min: Number(process.env.DATABASE_POOL_MIN || 0),
      max: Number(process.env.DATABASE_POOL_MAX || 5),
    },
    migrations: {
      directory: path.resolve(__dirname, "database/migrations"),
      tableName: "knex_migrations",
    },
  };
}

module.exports = {
  development: environmentConfig(),
  test: environmentConfig(),
  production: environmentConfig(),
};
