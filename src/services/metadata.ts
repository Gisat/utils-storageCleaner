/* filepath: src/services/metadata.ts */
import { getObjectString } from "./s3Client";
import { Metadata, validateMetadata } from "../utils/validate";

export const METADATA_FILENAME = "metadata.json";

/**
 * Attempt to load a metadata.json under a prefix (prefix must end with '/').
 * Returns null if not present or unreadable JSON.
 */
export async function loadMetadata(
  prefix: string
): Promise<{ meta: Metadata; issues: ReturnType<typeof validateMetadata> } | null> {
  const key = `${prefix}${METADATA_FILENAME}`;
  try {
    const raw = await getObjectString(key);
    const meta = JSON.parse(raw);
    const issues = validateMetadata(meta);
    return { meta, issues };
  } catch {
    return null;
  }
}

/**
 * Extract expiration as Date (UTC) or null.
 */
export function getExpiration(meta: Metadata | null): Date | null {
  if (!meta?.expiration) return null;
  const d = new Date(meta.expiration);
  return isNaN(d.getTime()) ? null : d;
}

export function isExpired(meta: Metadata | null, now = new Date()): boolean {
  const exp = getExpiration(meta);
  if (!exp) return false;
  return exp.getTime() <= now.getTime();
}