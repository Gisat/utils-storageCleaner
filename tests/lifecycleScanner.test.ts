// Notification logic is now handled at the end of the run, so we do not mock or assert notification calls here.
process.env.NODE_ENV = 'test';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as lifecycle from '../src/services/lifecycleScanner';
import * as metadata from '../src/services/metadata';
import * as s3Client from '../src/services/s3Client';
import { logger as realLogger } from '../src/logger';

// We will monkey-patch streamAllKeys and loadMetadata to control behavior.

describe('scanForExpiredMetadata project root metadata rule', () => {
  const warnings: string[] = [];
  const infos: string[] = [];
  const debugs: string[] = [];
  const traces: string[] = [];

  beforeEach(() => {
    warnings.length = 0;
    infos.length = 0;
    debugs.length = 0;
    traces.length = 0;
    // Monkey patch logger methods locally (affects imported module usage)
    realLogger.setLevel('trace');
    vi.spyOn(realLogger, 'warn').mockImplementation(msg => { warnings.push(String(msg)); });
    vi.spyOn(realLogger, 'info').mockImplementation(msg => { infos.push(String(msg)); });
    vi.spyOn(realLogger, 'debug').mockImplementation(msg => { debugs.push(String(msg)); });
    vi.spyOn(realLogger, 'trace').mockImplementation(msg => { traces.push(String(msg)); });
  });

  it('emits warning only for project root missing metadata (child metadata present)', async () => {
    // Fake keys across two prefixes: projectA/ (no metadata) and projectA/sub/ (has metadata)
    const keys = [
      { key: 'root/projectA/file1.txt', size: 10 },
      { key: 'root/projectA/sub/file2.txt', size: 20 },
      { key: 'root/projectA/sub/metadata.json', size: 50 }
    ];

    // streamAllKeys replacement: single batch
    const streamSpy = vi.spyOn(s3Client, 'streamAllKeys').mockImplementation(async (_prefix, onBatch) => {
      await onBatch(keys);
    });

    // loadMetadata: only return metadata for projectA/sub/
    const loadSpy = vi.spyOn(metadata, 'loadMetadata').mockImplementation(async prefix => {
      if (prefix === 'root/projectA/sub/') {
        return { meta: { expiration: new Date(Date.now() + 86400000).toISOString() }, issues: [] as any };
      }
      return null;
    });

  // Scan the specific project root; this should yield a warning that projectA has no metadata.json
  await lifecycle.scanForExpiredMetadata('root/projectA'); // intentionally omit trailing slash

  // Expect a warning mentioning project root only, not child missing metadata
  // Actual warning format: Project directory 'root/projectA/' has no metadata.json (scanned project root).
  const rootWarn = warnings.find(w => /Project directory 'root\/projectA\/' has no metadata\.json \(scanned project root\)\./.test(w));
  expect(rootWarn).toBeTruthy();
  const childWarn = warnings.find(w => /sub\/.*no metadata\.json/.test(w));
  expect(childWarn).toBeUndefined();

    // Restore spies
    streamSpy.mockRestore();
    loadSpy.mockRestore();
  });
});