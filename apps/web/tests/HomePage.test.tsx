import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HomePage } from '../src/pages/HomePage';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('HomePage', () => {
  it('renders the foundation placeholder and API status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          jsonResponse(200, { status: 'ok', service: 'api', uptimeSeconds: 1, timestamp: '' }),
        ),
      ),
    );
    render(<HomePage />);

    expect(screen.getByRole('heading', { name: 'Cadentor' })).toBeDefined();
    expect(screen.getByText('System Foundation Ready')).toBeDefined();
    expect(await screen.findByText('API online')).toBeDefined();
  });

  it('shows the API error message when the API is unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('fetch failed'))),
    );
    render(<HomePage />);

    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'API unavailable: Unable to reach the API',
    );
  });
});
