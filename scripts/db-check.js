'use strict';

const { Client } = require('pg');
const config = require('../server/config');

(async () => {
  const client = new Client({ ...config.pg, application_name: 'locklab-doctor' });
  try {
    await client.connect();
    const result = await client.query('SELECT current_database() AS db, current_user AS usr, version() AS version');
    const row = result.rows[0];
    console.log(`[ok] SQL connection: ${row.usr} @ ${row.db}`);
    process.exit(0);
  } catch (error) {
    console.log(`[missing] SQL connection failed: ${error.message}`);
    process.exit(1);
  } finally {
    await client?.end().catch(() => {});
  }
})();
