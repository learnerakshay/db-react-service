const DEFAULT_API_URL = 'http://localhost:4000';

function parseApiUrl(raw: string | undefined): string {
  const value = raw?.trim() ? raw.trim() : DEFAULT_API_URL;
  if (!URL.canParse(value)) {
    throw new Error('API_URL must be an absolute URL');
  }
  return value.replace(/\/+$/, '');
}

/** The only module in the web app that reads `import.meta.env`. */
export const config = {
  apiUrl: parseApiUrl(import.meta.env.API_URL),
} as const;
