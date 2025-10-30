vi.mock('../src/services/notification', () => ({
  sendGoogleChatMessage: vi.fn(),
  notifyMissingMetadata: vi.fn(),
  notifyExpirationViolation: vi.fn(),
}));
process.env.NODE_ENV = 'test';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as s3Client from '../src/services/s3Client';
import * as metadata from '../src/services/metadata';
import * as lifecycle from '../src/services/lifecycleScanner';
import { logger as realLogger } from '../src/logger';

// Helper to create ISO dates
function iso(daysFromNow: number) {
  const d = new Date(Date.now() + daysFromNow * 24 * 60 * 60 * 1000);
  return d.toISOString();
}

describe('expiration hierarchy violation warnings', () => {
  const warnings: string[] = [];

  beforeEach(() => {
    warnings.length = 0;
    vi.restoreAllMocks();
    realLogger.setLevel('trace');
    vi.spyOn(realLogger, 'warn').mockImplementation(msg => { warnings.push(String(msg)); });
  });

  it('warns when child expiration is after parent expiration', async () => {
    const parentExpiration = iso(5);
    const childExpiration = iso(30); // later than parent -> violation

    const keys = [
      { key: 'root/myproj_GST-123/metadata.json', size: 120 },
      { key: 'root/myproj_GST-123/child/metadata.json', size: 140 }
    ];

    // Mock S3 streaming (single batch)
    vi.spyOn(s3Client, 'streamAllKeys').mockImplementation(async (_prefix, onBatch) => {
      await onBatch(keys);
    });

    // Mock metadata loading for parent and child directories
    vi.spyOn(metadata, 'loadMetadata').mockImplementation(async (prefix: string) => {
      if (prefix === 'root/myproj_GST-123/') {
        return { meta: { expiration: parentExpiration }, issues: [] as any };
      }
      if (prefix === 'root/myproj_GST-123/child/') {
        return { meta: { expiration: childExpiration }, issues: [] as any };
      }
      return null;
    });

    // Use actual isExpired logic
    await lifecycle.scanForExpiredMetadata('root/myproj_GST-123');

    const violation = warnings.find(w => /Expiration violation: prefix 'root\/myproj_GST-123\/child\//.test(w));
    expect(violation).toBeTruthy();
  });
});
