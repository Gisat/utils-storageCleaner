// Notification logic is now handled at the end of the run, so we do not mock or assert notification calls here.
process.env.NODE_ENV = 'test';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { discoverProjectPrefixes, scanProjects } from '../src/services/lifecycleScanner';
import * as s3Client from '../src/services/s3Client';
import * as metadata from '../src/services/metadata';
import { logger } from '../src/logger';

// Common fake listing for bucket root containing two project dirs and files inside.
const rootKeys = [
  { key: 'WorldCereal_GST-10/metadata.json', size: 1 },
  { key: 'WorldCereal_GST-10/app-esaWorldCereal/dev/vectors/a.json', size: 2 },
  { key: 'Another_GST-11/file.txt', size: 2 }, // missing metadata.json for this project
  { key: 'Unrelated/readme.txt', size: 1 },
];

describe('project discovery & scan', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    logger.setLevel('trace');
  });

  it('discovers project prefixes matching pattern', async () => {
    // Mock only the expected projects
    vi.spyOn(s3Client, 'listRootProjectFolders').mockResolvedValue(['Another_GST-11/', 'WorldCereal_GST-10/']);
    const projects = await discoverProjectPrefixes('');
    expect(projects).toEqual(['Another_GST-11/', 'WorldCereal_GST-10/']);
  });

  it('scanProjects(all) warns for project without metadata', async () => {
    const warnings: string[] = [];
    vi.spyOn(logger, 'warn').mockImplementation((msg: any) => warnings.push(String(msg)));
    // Mock only the expected projects and their keys
    vi.spyOn(s3Client, 'listRootProjectFolders').mockResolvedValue(['Another_GST-11/', 'WorldCereal_GST-10/']);
    const mockKeys = [
      { key: 'WorldCereal_GST-10/metadata.json', size: 1 },
      { key: 'Another_GST-11/file.txt', size: 2 },
    ];
    vi.spyOn(s3Client, 'streamAllKeys').mockImplementation(async (prefix, onBatch) => {
      if (prefix === 'WorldCereal_GST-10/') {
        await onBatch(mockKeys.filter(k => k.key.startsWith('WorldCereal_GST-10/')));
      } else if (prefix === 'Another_GST-11/') {
        await onBatch(mockKeys.filter(k => k.key.startsWith('Another_GST-11/')));
      }
    });
    vi.spyOn(metadata, 'loadMetadata').mockImplementation(async (prefix: string) => {
      if (prefix === 'WorldCereal_GST-10/') {
        return { meta: { expiration: new Date(Date.now() + 86400000).toISOString() }, issues: [] as any };
      }
      return null;
    });

    const states = await scanProjects({});
    expect(states.length).toBeGreaterThan(0);
    // Expect a warning referring to project directory missing metadata
    const missingWarn = warnings.find(w => /Another_GST-11\/.*no metadata\.json/.test(w));
    expect(missingWarn).toBeTruthy();
  });

  it('scanProjects(single) only scans one project and does not warn about others', async () => {
    const warnings: string[] = [];
    vi.spyOn(logger, 'warn').mockImplementation((msg: any) => warnings.push(String(msg)));
    vi.spyOn(s3Client, 'streamAllKeys').mockImplementation(async (prefix, onBatch) => {
      if (prefix === 'WorldCereal_GST-10') {
        await onBatch(rootKeys.filter(k => k.key.startsWith('WorldCereal_GST-10/')));
      }
    });
    vi.spyOn(metadata, 'loadMetadata').mockImplementation(async (prefix: string) => {
      if (prefix === 'WorldCereal_GST-10/') {
        return { meta: { expiration: new Date(Date.now() + 86400000).toISOString() }, issues: [] as any };
      }
      return null;
    });
    await scanProjects({ projectName: 'WorldCereal_GST-10' });
    // Should not contain warning about Another_GST-11 because we didn't scan it.
    const otherWarn = warnings.find(w => /Another_GST-11/.test(w));
    expect(otherWarn).toBeUndefined();
  });

  it('scanProjects(single invalid name) emits invalid pattern warning', async () => {
    const warnings: string[] = [];
    vi.spyOn(logger, 'warn').mockImplementation((msg: any) => warnings.push(String(msg)));
    vi.spyOn(s3Client, 'streamAllKeys').mockImplementation(async () => { /* no keys */ });
    await scanProjects({ projectName: 'NotAProject' });
    const patternWarn = warnings.find(w => /does not match pattern/.test(w));
    expect(patternWarn).toBeTruthy();
  });
});