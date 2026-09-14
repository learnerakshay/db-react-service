#!/usr/bin/env node
// Local development PostgreSQL without Docker or a system install.
// Runs a real PostgreSQL server (embedded-postgres binaries) bound to localhost,
// with data persisted in .local/postgres (git-ignored). Stop with Ctrl+C.
//
//   npm run db:local
//   DATABASE_URL=postgresql://USER:PASSWORD@localhost:54329/cadentor_dev
//   (user "postgres", password from LOCAL_DB_PASSWORD, default "postgres")
//
// Local development only. Production and CI use a managed PostgreSQL via DATABASE_URL.

import EmbeddedPostgres from 'embedded-postgres';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const databaseDir = resolve('.local/postgres');
const port = Number(process.env.LOCAL_DB_PORT ?? 54329);
const user = 'postgres';
const password = process.env.LOCAL_DB_PASSWORD ?? 'postgres';
const database = 'cadentor_dev';

const pg = new EmbeddedPostgres({
  databaseDir,
  user,
  password,
  port,
  persistent: true,
  postgresFlags: ['-c', 'listen_addresses=localhost'],
  onLog: () => {},
});

if (!existsSync(resolve(databaseDir, 'PG_VERSION'))) {
  await pg.initialise();
}
await pg.start();

const client = pg.getPgClient();
await client.connect();
const { rowCount } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [database]);
await client.end();
if (rowCount === 0) {
  await pg.createDatabase(database);
}

console.log(`Local PostgreSQL running on localhost:${port}, database "${database}".`);
console.log(
  'DATABASE_URL=postgresql://' + user + ':<LOCAL_DB_PASSWORD>@localhost:' + port + '/' + database,
);

const stop = async () => {
  await pg.stop();
  process.exit(0);
};
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
