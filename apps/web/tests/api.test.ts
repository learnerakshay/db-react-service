import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiClientError, apiGet } from '../src/lib/api';

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(response: Response) {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(response)),
  );
}

describe('apiGet', () => {
  it('maps the shared error body into ApiClientError', async () => {
    stubFetch(
      new Response(
        JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Missing', requestId: 'r-1' } }),
        {
          status: 404,
        },
      ),
    );

    const err = await apiGet('/x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiClientError);
    expect(err).toMatchObject({
      status: 404,
      code: 'NOT_FOUND',
      message: 'Missing',
      requestId: 'r-1',
    });
  });

  it('flags non-JSON responses as INVALID_RESPONSE', async () => {
    stubFetch(new Response('<html>', { status: 502 }));
    await expect(apiGet('/x')).rejects.toMatchObject({ code: 'INVALID_RESPONSE', status: 502 });
  });

  it('flags error bodies that do not match the contract', async () => {
    stubFetch(new Response(JSON.stringify({ oops: true }), { status: 500 }));
    await expect(apiGet('/x')).rejects.toMatchObject({ code: 'INVALID_RESPONSE', status: 500 });
  });
});
