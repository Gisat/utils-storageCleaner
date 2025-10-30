import { describe, it, expect } from 'vitest';
import { validateProjectStructure } from '../src/services/structureValidator';

function run(root: string, prefixes: string[]) {
  return validateProjectStructure(root, prefixes).issues.map(i => i.code).sort();
}

describe('structureValidator', () => {
  it('passes valid structure (app directory with dev/prod + version)', () => {
    const issues = run('WorldCereal_GST-10/', [
      'WorldCereal_GST-10/',
      'WorldCereal_GST-10/app-esaWorldCereal/',
      'WorldCereal_GST-10/app-esaWorldCereal/dev/',
      'WorldCereal_GST-10/app-esaWorldCereal/prod/',
      'WorldCereal_GST-10/app-esaWorldCereal/prod/v1/',
      'WorldCereal_GST-10/project/'
    ]);
    expect(issues).toEqual([]);
  });

  it('allows empty app directory (no dev/prod)', () => {
    const issues = run('WorldCereal_GST-10/', [
      'WorldCereal_GST-10/',
      'WorldCereal_GST-10/app-empty/'
    ]);
    expect(issues).toEqual([]);
  });

  it('flags invalid extra subdirectory in app directory', () => {
    const issues = run('WorldCereal_GST-10/', [
      'WorldCereal_GST-10/',
      'WorldCereal_GST-10/app-esaWorldCereal/',
      'WorldCereal_GST-10/app-esaWorldCereal/dev/',
      'WorldCereal_GST-10/app-esaWorldCereal/other/'
    ]);
    expect(issues).toContain('INVALID_APP_CHILD');
  });

  it('flags non-version child under prod', () => {
    const issues = run('WorldCereal_GST-10/', [
      'WorldCereal_GST-10/',
      'WorldCereal_GST-10/app-esaWorldCereal/',
      'WorldCereal_GST-10/app-esaWorldCereal/dev/',
      'WorldCereal_GST-10/app-esaWorldCereal/prod/',
      'WorldCereal_GST-10/app-esaWorldCereal/prod/notAVersion/',
    ]);
    expect(issues).toContain('INVALID_PROD_CHILD');
  });

  it('flags invalid data dir name', () => {
    const issues = run('WorldCereal_GST-10/', [
      'WorldCereal_GST-10/',
      'WorldCereal_GST-10/other/'
    ]);
    expect(issues).toContain('INVALID_DATA_DIR_NAME');
  });

  it('flags no data dirs', () => {
    const issues = run('WorldCereal_GST-10/', [
      'WorldCereal_GST-10/'
    ]);
    expect(issues).toContain('NO_DATA_DIRS');
  });
});
