/**
 * Retry Policy Value Object
 *
 * Exponential backoff with jitter for resilient retries.
 */

export interface RetryPolicyConfig {
  maxRetries: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
  jitterFactor: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicyConfig = {
  maxRetries: 5,
  baseBackoffMs: 100,
  maxBackoffMs: 30000,
  jitterFactor: 0.1,
};

/**
 * Calculate exponential backoff with jitter
 */
export function calculateBackoff(
  attempt: number,
  config: RetryPolicyConfig = DEFAULT_RETRY_POLICY,
): number {
  const exponential = Math.min(
    config.maxBackoffMs,
    config.baseBackoffMs * Math.pow(2, attempt),
  );
  const jitter = Math.random() * exponential * config.jitterFactor;
  return Math.floor(exponential + jitter);
}

/**
 * Determine if retry should be attempted
 */
export function shouldRetry(
  retryCount: number,
  config: RetryPolicyConfig = DEFAULT_RETRY_POLICY,
): boolean {
  return retryCount < config.maxRetries;
}

/**
 * Create retry policy from partial config
 */
export function createRetryPolicy(
  overrides: Partial<RetryPolicyConfig> = {},
): RetryPolicyConfig {
  return { ...DEFAULT_RETRY_POLICY, ...overrides };
}
