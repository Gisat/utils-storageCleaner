/* filepath: src/services/projectDiscovery.ts */
import { streamAllKeys } from "./s3Client";

/**
 * Discover top-level project names by listing all object keys (within optional root)
 * and collecting the first path segment before the first '/'.
 *
 * NOTE:
 *  - This is a heuristic; if the bucket contains unrelated objects at root,
 *    they'll appear as "projects".
 *  - To scope discovery, call with a non-empty root prefix externally (e.g. pass root to streamAllKeys).
 */
export async function discoverProjects(rootPrefix = ""): Promise<string[]> {
  const set = new Set<string>();
  await streamAllKeys(rootPrefix, async objs => {
    for (const { key } of objs) {
      if (!key.startsWith(rootPrefix)) continue;
      const rel = rootPrefix ? key.substring(rootPrefix.length) : key;
      const first = rel.split("/")[0];
      if (first) set.add(first);
    }
  });
  return Array.from(set).sort();
}