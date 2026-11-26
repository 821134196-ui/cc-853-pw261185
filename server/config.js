'use strict';

const path = require('node:path');

const rootDir = path.resolve(__dirname, '..');

function positiveInt(value, fallback, min, max) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

const pg = process.env.DATABASE_URL
  ? { connectionString: process.env.DATABASE_URL }
  : {
      host: process.env.PGHOST || '127.0.0.1',
      port: positiveInt(process.env.PGPORT, 55432, 1, 65535),
      user: process.env.PGUSER || 'locklab',
      password: process.env.PGPASSWORD || 'locklab',
      database: process.env.PGDATABASE || 'locklab',
    };

module.exports = {
  rootDir,
  publicDir: path.join(rootDir, 'public'),
  port: positiveInt(process.env.PORT, 3210, 1, 65535),
  host: process.env.HOST || '127.0.0.1',
  pg: {
    ...pg,
    application_name: process.env.PG_APP_NAME || 'locklab-server',
    connectionTimeoutMillis: positiveInt(process.env.PG_CONNECT_TIMEOUT_MS, 3000, 100, 60000),
  },
  diagnosticAppPrefix: 'locklab-%',
  diagnosticAppNames: ['locklab-diag', 'locklab-admin', 'locklab-server'],
  budget: {
    defaultMs: positiveInt(process.env.DIAG_BUDGET_MS, 250, 1, 10000),
    minMs: 2,
    maxMs: 5000,
  },
};
