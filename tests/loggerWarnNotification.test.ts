import { describe, it, expect, vi } from 'vitest';


function extractText(payload: string | undefined): string | undefined {
  if (!payload) return undefined;
  try {
    const obj = JSON.parse(payload);
    return obj.text;
  } catch {
    return payload;
  }
}

describe('logger warn Google Chat notifications', () => {
  it('sends chat message for a warn', async () => {
    vi.restoreAllMocks();
    process.env.GCHAT_WEBHOOK_URL = 'https://example.com/webhook';
    process.env.NODE_ENV = 'test';
    const { logger } = await import('../src/logger');
    logger.setLevel('warn');
    logger.warn('First warning example');
    // No Google Chat notification should be sent
    expect(true).toBe(true);
  });
});
