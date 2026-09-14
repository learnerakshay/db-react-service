import EmbeddedPostgres from 'embedded-postgres';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

const repoRoot = resolve(import.meta.dirname, '../../..');

/**
 * Test database strategy:
 * - TEST_DATABASE_URL set (CI): use it. Its database name must contain "test"
 *   because tests truncate every table.
 * - Otherwise start a throwaway embedded PostgreSQL in a temp directory.
 * Either way, apply all migrations with `prisma migrate deploy` first.
 */
export default async function setup(project: TestProject) {
  let databaseUrl = process.env.TEST_DATABASE_URL ?? '';
  let server: EmbeddedPostgres | undefined;
  let dataDir: string | undefined;

  if (databaseUrl === '') {
    dataDir = await mkdtemp(join(tmpdir(), 'cadentor-test-pg-'));
    const port = await freePort();
    server = new EmbeddedPostgres({
      databaseDir: dataDir,
      user: 'postgres',
      password: 'postgres',
      port,
      persistent: false,
      postgresFlags: ['-c', 'listen_addresses=localhost', '-c', 'fsync=off'],
      onLog: () => undefined,
    });
    await server.initialise();
    await server.start();
    await server.createDatabase('cadentor_test');

    const url = new URL('postgresql://localhost');
    url.username = 'postgres';
    url.password = 'postgres';
    url.port = String(port);
    url.pathname = '/cadentor_test';
    databaseUrl = url.toString();
  }

  if (!new URL(databaseUrl).pathname.includes('test')) {
    throw new Error(
      'TEST_DATABASE_URL must name a dedicated test database (name containing "test")',
    );
  }

  execFileSync(
    process.execPath,
    [join(repoRoot, 'node_modules/prisma/build/index.js'), 'migrate', 'deploy'],
    {
      cwd: repoRoot,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'pipe',
    },
  );

  project.provide('databaseUrl', databaseUrl);

  return async () => {
    await server?.stop();
    if (dataDir !== undefined) await rm(dataDir, { recursive: true, force: true });
  };
}

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => {
        resolvePort(port);
      });
    });
  });
}
