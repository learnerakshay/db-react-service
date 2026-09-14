import { existsSync } from 'node:fs';
import { defineConfig } from 'prisma/config';

// The Prisma CLI does not read .env on its own. Load it when present;
// real environment variables always take precedence.
if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    // `prisma generate` does not need a database, so a missing URL must not
    // block install. Migration commands fail clearly without it.
    url: process.env.DATABASE_URL ?? '',
  },
});
