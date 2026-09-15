import type {
  ApiErrorBody,
  DependencyStatus,
  HealthResponse,
  ReadinessResponse,
} from '@cadentor/shared';
import express, { type Express } from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config/index.js';
import { ProviderError } from '../src/lib/errors.js';
import { createLogger } from '../src/lib/logger.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import { requestLogger } from '../src/middleware/request-logger.js';

const logger = createLogger('silent');
const servers: Server[] = [];

async function serve(app: Express): Promise<string> {
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => {
      resolve(s);
    });
  });
  servers.push(server);
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((err) => {
            if (err) reject(err);
            else resolve();
          });
        }),
    ),
  );
});

function buildApp(database: DependencyStatus = 'not_configured', jobs?: DependencyStatus): Express {
  return createApp({
    config: loadConfig({ NODE_ENV: 'test', WEB_URL: 'http://localhost:5173' }),
    logger,
    checkDatabase: () => Promise.resolve(database),
    ...(jobs === undefined ? {} : { checkJobs: () => jobs }),
  });
}

describe('GET /health', () => {
  it('returns ok without touching dependencies', async () => {
    const url = await serve(buildApp('down'));
    const res = await fetch(`${url}/health`);
    const body = (await res.json()) as HealthResponse;

    expect(res.status).toBe(200);
    expect(body.status).toBe('ok');
    expect(body.service).toBe('cadentor-reactivation-api');
  });

  it('assigns a request id, or echoes a safe incoming one', async () => {
    const url = await serve(buildApp());

    const generated = await fetch(`${url}/health`);
    expect(generated.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);

    const echoed = await fetch(`${url}/health`, { headers: { 'x-request-id': 'trace-abc-12345' } });
    expect(echoed.headers.get('x-request-id')).toBe('trace-abc-12345');

    const unsafe = await fetch(`${url}/health`, { headers: { 'x-request-id': 'bad id <script>' } });
    expect(unsafe.headers.get('x-request-id')).not.toBe('bad id <script>');
  });

  it('sets security headers and hides the framework', async () => {
    const url = await serve(buildApp());
    const res = await fetch(`${url}/health`);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-powered-by')).toBeNull();
  });
});

describe('GET /ready', () => {
  it.each([
    ['up', 200, 'ready'],
    ['down', 503, 'not_ready'],
    ['not_configured', 503, 'not_ready'],
  ] as const)('database %s -> %i %s', async (database, status, readiness) => {
    const url = await serve(buildApp(database));
    const res = await fetch(`${url}/ready`);
    const body = (await res.json()) as ReadinessResponse;

    expect(res.status).toBe(status);
    expect(body.status).toBe(readiness);
    expect(body.checks.database).toBe(database);
  });

  it.each([
    [undefined, 200, 'not_configured'],
    ['up', 200, 'up'],
    ['down', 503, 'down'],
  ] as const)('job queue %s -> %i', async (jobs, status, reported) => {
    const url = await serve(buildApp('up', jobs));
    const res = await fetch(`${url}/ready`);
    const body = (await res.json()) as ReadinessResponse;
    expect(res.status).toBe(status);
    expect(body.checks.jobs).toBe(reported);
    expect(JSON.stringify(body)).not.toMatch(/postgres|token|password/i);
  });
});

describe('CORS', () => {
  it('allows only the configured origin', async () => {
    const url = await serve(buildApp());
    const allowed = await fetch(`${url}/health`, { headers: { origin: 'http://localhost:5173' } });
    expect(allowed.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');

    const denied = await fetch(`${url}/health`, { headers: { origin: 'https://evil.example' } });
    expect(denied.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('error responses', () => {
  it('returns NOT_FOUND in the shared error shape', async () => {
    const url = await serve(buildApp());
    const res = await fetch(`${url}/nope`);
    const body = (await res.json()) as ApiErrorBody;

    expect(res.status).toBe(404);
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.requestId).toBe(res.headers.get('x-request-id'));
  });

  it('rejects malformed JSON as VALIDATION_ERROR', async () => {
    const url = await serve(buildApp());
    const res = await fetch(`${url}/health`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"broken":',
    });
    const body = (await res.json()) as ApiErrorBody;

    expect(res.status).toBe(400);
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects bodies over the size limit', async () => {
    const url = await serve(buildApp());
    const res = await fetch(`${url}/health`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: 'x'.repeat(200_000) }),
    });
    const body = (await res.json()) as ApiErrorBody;

    expect(res.status).toBe(413);
    expect(body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('never leaks internal error messages', async () => {
    const app = express();
    app.use(requestLogger(logger));
    app.get('/unexpected', () => {
      throw new Error('database login failed for password hunter2');
    });
    app.get('/provider', () => {
      throw new ProviderError('sms', 'vendor said: invalid token abc123');
    });
    app.use(errorHandler);
    const url = await serve(app);

    const unexpected = await fetch(`${url}/unexpected`);
    const unexpectedText = await unexpected.text();
    expect(unexpected.status).toBe(500);
    expect((JSON.parse(unexpectedText) as ApiErrorBody).error.code).toBe('INTERNAL_ERROR');
    expect(unexpectedText).not.toContain('hunter2');
    expect(unexpectedText).not.toContain('stack');

    const provider = await fetch(`${url}/provider`);
    const providerText = await provider.text();
    expect(provider.status).toBe(502);
    expect((JSON.parse(providerText) as ApiErrorBody).error.code).toBe('PROVIDER_ERROR');
    expect(providerText).not.toContain('abc123');
  });
});
