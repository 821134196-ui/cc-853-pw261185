'use strict';

const { Client } = require('pg');

const host = process.env.PGHOST || '127.0.0.1';
const port = Number(process.env.PGPORT || 55432);
const adminUser = process.env.PGADMINUSER || 'postgres';
const adminDatabase = process.env.PGADMINDATABASE || 'postgres';
const role = process.env.PGUSER || 'locklab';
const password = process.env.PGPASSWORD || 'locklab';
const database = process.env.PGDATABASE || 'locklab';

async function main() {
  const admin = new Client({ host, port, user: adminUser, database: adminDatabase });
  await admin.connect();

  const roleResult = await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
  if (roleResult.rowCount === 0) {
    await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`);
    console.log(`Created role ${role}`);
  } else {
    await admin.query(`ALTER ROLE ${role} LOGIN PASSWORD '${password}'`);
  }
  // The bootstrap cluster is user-local and bound to localhost. SUPERUSER lets
  // the bench shorten deadlock_timeout per reproducible run. External DBs may
  // use a least-privilege role; Lab falls back to the server's GUC then.
  await admin.query(`ALTER ROLE ${role} SUPERUSER`).catch((error) => {
    console.warn(`Could not make ${role} superuser (continuing with fallback): ${error.message}`);
  });
  await admin.query(`GRANT pg_monitor TO ${role}`).catch((error) => {
    console.warn(`Could not GRANT pg_monitor (continuing): ${error.message}`);
  });

  const dbResult = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [database]);
  if (dbResult.rowCount === 0) {
    await admin.query(`CREATE DATABASE ${database} OWNER ${role}`);
    console.log(`Created database ${database}`);
  }

  await admin.end();

  const app = new Client({ host, port, user: adminUser, database });
  await app.connect();
  await app.query(`GRANT ALL ON SCHEMA public TO ${role}`);
  await app.end();

  const check = new Client({ host, port, user: role, password, database });
  await check.connect();
  await check.query('SELECT 1');
  await check.end();
  console.log(`Verified login as ${role} to ${database} at ${host}:${port}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
