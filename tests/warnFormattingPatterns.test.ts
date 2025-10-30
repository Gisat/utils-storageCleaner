
import { describe, it, expect } from 'vitest';
import { formatWarnForChat } from '../src/logger';

describe('warn formatting patterns', () => {
  it('formats missing metadata root warning', () => {
    const text = formatWarnForChat("Project directory 'WorldCereal_GST-10/' has no metadata.json (scanned project root).");
    expect(text).toMatch(/⚠️ Project Metadata Warning/);
    expect(text).toMatch(/Project: WorldCereal_GST-10\//);
    expect(text).toMatch(/Issue: metadata\.json not found at project root/);
    expect(text).toMatch(/Action: Create metadata\.json with an 'expiration' property/);
    expect(text).toMatch(/Reference: README > Directory & Metadata Rules/);
  });

  it('formats expiration violation warning', () => {
    const text = formatWarnForChat("Expiration violation: prefix 'WorldCereal_GST-10/app/dev/' expiration 2025-12-31T00:00:00.000Z is later than ancestor 'WorldCereal_GST-10/' (2025-10-01T00:00:00.000Z). Child must be <= ancestor.");
    expect(text).toMatch(/⛔ Expiration Policy Violation/);
    expect(text).toMatch(/Child Prefix: WorldCereal_GST-10\/app\/dev\//);
  });

  it('formats structure issue warning', () => {
    const text = formatWarnForChat('Structure issue (INVALID_PROD_CHILD): Non-version directory "temp/" under "WorldCereal_GST-10/app/prod/". Only vN/ directories allowed.');
    expect(text).toMatch(/📁 Structure Check Warning/);
    expect(text).not.toMatch(/Code:/);
    expect(text).toMatch(/Project: WorldCereal_GST-10/);
    expect(text).toMatch(/Issue: Non-version directory "temp\/" under "WorldCereal_GST-10\/app\/prod\/". Only vN\/ directories allowed\./);
    expect(text).toMatch(/Action: Align project directories to required pattern/);
    expect(text).toMatch(/Reference: README > Required Project FS Structure/);
  });

  it('formats invalid project name warning', () => {
    const text = formatWarnForChat("Provided project name 'BadProject' does not match pattern ^.+_GST-\d+$.");
    expect(text).toMatch(/⚠️ Invalid Project Name/);
    expect(text).toMatch(/Name: BadProject/);
  });

  it('formats ignored directory warning', () => {
    const text = formatWarnForChat("Directory 'misc/' does not match project pattern ^.+_GST-\d+$/; ignoring.");
    expect(text).toMatch(/ℹ️ Ignored Directory/);
    expect(text).toMatch(/Directory: misc\//);
  });

  it('formats generic warning fallback', () => {
    const text = formatWarnForChat('Some other random warning that has no pattern match.');
    expect(text).toMatch(/⚠️ Warning/);
    expect(text).toMatch(/Some other random warning/);
  });
});
