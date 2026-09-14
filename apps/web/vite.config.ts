import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Single root .env for the whole repo. Only API_URL (and VITE_*) reach the
  // browser bundle — never widen this to secrets.
  envDir: '../..',
  envPrefix: ['VITE_', 'API_URL'],
  server: { port: 5173, strictPort: true },
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.{ts,tsx}'],
  },
});
