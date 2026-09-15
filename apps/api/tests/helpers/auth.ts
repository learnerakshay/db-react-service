import { loadConfig, type AppConfig } from '../../src/config/index.js';
import { hashOperatorToken } from '../../src/modules/auth/operators.js';

export const OPERATOR_TOKEN = 'test-operator-token-0123456789abcdef';
export const ADMIN_TOKEN = 'test-admin-token-0123456789abcdef0';

/** OPERATOR_TOKENS value for tests: "ops" (OPERATOR) and "admin" (ADMIN). */
export const TEST_OPERATOR_TOKENS = [
  `ops:OPERATOR:${hashOperatorToken(OPERATOR_TOKEN)}`,
  `admin:ADMIN:${hashOperatorToken(ADMIN_TOKEN)}`,
].join(',');

export const OPERATOR_HEADERS = { authorization: `Bearer ${OPERATOR_TOKEN}` } as const;
export const ADMIN_HEADERS = { authorization: `Bearer ${ADMIN_TOKEN}` } as const;

/** Test config with operator credentials configured. */
export function authConfig(env: Record<string, string> = {}): AppConfig {
  return loadConfig({ NODE_ENV: 'test', OPERATOR_TOKENS: TEST_OPERATOR_TOKENS, ...env });
}
