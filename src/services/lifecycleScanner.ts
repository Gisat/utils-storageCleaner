/* filepath: src/services/lifecycleScanner.ts */
import { getS3Client, streamAllKeys, listRootProjectFolders } from "./s3Client";
import { loadMetadata, isExpired, METADATA_FILENAME } from "./metadata";
import { logger } from "../logger";
import { validateProjectStructure } from "./structureValidator";

export interface PrefixState {
  prefix: string;
  hasMetadata: boolean;
  metadataExpired: boolean;
  metadataLoaded: boolean;
  expirationDate?: Date | null; // parsed expiration for hierarchy validation
}

// Accept options for notification control
export async function scanForExpiredMetadata(rootPrefix: string, opts?: { noGchat?: boolean }): Promise<PrefixState[]> {
  // Normalize root prefix (if non-empty) to always end with '/'; empty means bucket root.
  const normalizedRoot = rootPrefix
    ? rootPrefix.endsWith("/")
      ? rootPrefix
      : `${rootPrefix}/`
    : "";
  const results: PrefixState[] = [];
  const seen = new Set<string>();
  logger.debug(`[scan] START: root='${normalizedRoot}' (orig='${rootPrefix}')`);
  const start = Date.now();
  // Only require and use streamAllKeys when actually scanning
  let objCount = 0;
  await streamAllKeys(normalizedRoot, async (objs: { key: string; size: number; lastModified?: Date }[]) => {
    logger.debug(`[scan] Processing batch of ${objs.length} objects...`);
    for (const { key } of objs) {
      objCount++;
      const lastSlash = key.lastIndexOf("/");
      if (lastSlash < 0) continue;
      const dir = key.substring(0, lastSlash + 1);
      // Only scan up to app- level: project/app-*/
      // rootPrefix = project/; dir = project/app-*/ or deeper
      const rel = dir.startsWith(normalizedRoot) ? dir.slice(normalizedRoot.length) : dir;
      const segs = rel.split("/").filter(Boolean);
      // Only allow: project/ (0 segs), project/app-*/ (1 seg)
      if (segs.length > 1) continue;
      if (seen.has(dir)) continue;
      seen.add(dir);
      logger.debug(`[scan] Scanning directory: '${dir}'`);
      try {
        const loaded = await loadMetadata(dir);
        if (loaded) {
          const expired = isExpired(loaded.meta);
          const expStr = loaded.meta.expiration || null;
          const expDate = expStr ? new Date(expStr) : null;
          results.push({
            prefix: dir,
            hasMetadata: true,
            metadataExpired: expired,
            metadataLoaded: true,
            expirationDate: expDate && !isNaN(expDate.getTime()) ? expDate : null,
          });
          logger.debug(`[scan] Found metadata: prefix='${dir}' expired=${expired}`);
        } else {
          results.push({
            prefix: dir,
            hasMetadata: false,
            metadataExpired: false,
            metadataLoaded: false,
            expirationDate: null,
          });
          logger.debug(`[scan] No metadata found for prefix='${dir}'`);
        }
      } catch (e: any) {
        logger.debug(`[scan] Error loading metadata for '${dir}': ${e?.message || e}`);
        results.push({
          prefix: dir,
          hasMetadata: false,
          metadataExpired: false,
          metadataLoaded: false,
        });
      }
    }
    logger.debug(`[scan] Batch processed. Total objects seen so far: ${objCount}`);
  });

  const ms = Date.now() - start;
  logger.debug(`[scan] DONE: root='${normalizedRoot}' scannedPrefixes=${results.length} totalObjects=${objCount} durationMs=${ms}`);

  // Post-process: Identify top-level project directories that have no metadata.json
  // Definition (heuristic): A "top-level" directory is one that has no ancestor directory
  // (other than the rootPrefix) present in the scanned set. If it lacks metadata, warn once.
  logger.debug(`[scan] Starting post-processing for root='${normalizedRoot}'`);
  try {
    const prefixMap = new Map<string, PrefixState>();
    for (const r of results) prefixMap.set(r.prefix, r);
    // If scanning a specific project root and it lacks metadata, warn (only project root is required).
    if (normalizedRoot) {
      const rootEntry = prefixMap.get(normalizedRoot);
      if (!rootEntry) {
        // No objects directly under the root directory were encountered; cannot determine metadata presence.
        // We rely on object listing to include metadata.json if present. Skip synthetic warning in this case.
      } else if (!rootEntry.hasMetadata) {
        const msg = `Project directory '${normalizedRoot}' has no ${METADATA_FILENAME} (scanned project root).`;
        logger.warn(msg, undefined, opts);
      }
      // Structure validation: only attempt if we have at least one prefix under this project.
      const allPrefixes = results.map(r => r.prefix);
      if (allPrefixes.some(p => p.startsWith(normalizedRoot) && p !== normalizedRoot)) {
        validateProjectStructure(normalizedRoot, allPrefixes, opts);
      }
    }
    // Child expiration validation: any child prefix with a later expiration than an ancestor is invalid.
    // Build ancestor chain map for quick lookup.
    const metas = results.filter(r => r.hasMetadata && r.expirationDate);
    // Sort prefixes by length to ensure ancestors processed before children.
    metas.sort((a, b) => a.prefix.length - b.prefix.length);
    const expirationByPrefix = new Map<string, Date>();
    for (const m of metas) {
      expirationByPrefix.set(m.prefix, m.expirationDate!);
    }
    for (const m of metas) {
      // Walk ancestor prefixes (strip trailing slash and progressively remove segments).
      const ancestors: string[] = [];
      const trimmed = m.prefix.endsWith("/") ? m.prefix.slice(0, -1) : m.prefix;
      const parts = trimmed.split("/").filter(Boolean);
      for (let i = parts.length - 1; i > 0; i--) {
        const anc = parts.slice(0, i).join("/") + "/";
        ancestors.push(anc);
      }
      let violatedAncestor: { anc: string; ancDate: Date } | null = null;
      for (const anc of ancestors) {
        const ancDate = expirationByPrefix.get(anc);
        if (ancDate && m.expirationDate && m.expirationDate.getTime() > ancDate.getTime()) {
          violatedAncestor = { anc, ancDate };
          break;
        }
      }
      if (violatedAncestor) {
        const msg = `Expiration violation: prefix '${m.prefix}' expiration ${m.expirationDate!.toISOString()} is later than ancestor '${violatedAncestor.anc}' (${violatedAncestor.ancDate.toISOString()}). Child must be <= ancestor.`;
        logger.warn(msg, undefined, opts);
      }
    }
  } catch (e: any) {
    logger.debug(`lifecycleScanner: post-process warning generation failed: ${e?.message || e}`);
  }
  return results;
}

/**
 * Heuristic: A project directory name ends with pattern _GST-<number> (e.g., WorldCereal_GST-10).
 */
const PROJECT_DIR_REGEX = /^.+_GST-\d+$/;
function isProjectDirName(name: string): boolean {
  return PROJECT_DIR_REGEX.test(name);
}

/**
 * Scan bucket root (or provided root) and return distinct top-level project directory prefixes.
 * We perform a shallow listing collecting unique first-level directory prefixes matching isProjectDirName.
 */
export async function discoverProjectPrefixes(bucketRoot = ""): Promise<string[]> {
  logger.debug(`[discover] Using delimiter to list root project folders...`);
  const prefixes = await listRootProjectFolders();
  // Optionally filter to only valid project names
  const projectPrefixes = prefixes.filter(p => isProjectDirName(p.replace(/\/$/, "")));
  logger.debug(`[discover] Filtered to ${projectPrefixes.length} valid project directories.`);
  return projectPrefixes.sort();
}

/**
 * Scan either a single project (if projectName provided) or all discovered projects at bucket root.
 * Returns aggregated PrefixState entries; also triggers warnings for missing top-level metadata (handled internally by scanForExpiredMetadata).
 */
export async function scanProjects({ projectName, bucketRoot = "", noGchat = false }: { projectName?: string; bucketRoot?: string; noGchat?: boolean; }): Promise<PrefixState[]> {
  const results: PrefixState[] = [];
  if (projectName) {
    if (!isProjectDirName(projectName)) {
      logger.warn(`Provided project name '${projectName}' does not match pattern ${PROJECT_DIR_REGEX.source}.`, undefined, { noGchat });
    }
    const prefix = bucketRoot ? `${bucketRoot}${projectName}` : projectName;
    const projectPrefix = prefix.endsWith("/") ? prefix : `${prefix}/`;
    const loaded = await loadMetadata(projectPrefix);
    if (!loaded) {
      logger.warn(`Project directory '${projectPrefix}' has no ${METADATA_FILENAME}.`, undefined, { noGchat });
      results.push({
        prefix: projectPrefix,
        hasMetadata: false,
        metadataExpired: false,
        metadataLoaded: false,
        expirationDate: null,
      });
    } else {
      const expired = isExpired(loaded.meta);
      const expStr = loaded.meta.expiration || null;
      const expDate = expStr ? new Date(expStr) : null;
      results.push({
        prefix: projectPrefix,
        hasMetadata: true,
        metadataExpired: expired,
        metadataLoaded: true,
        expirationDate: expDate && !isNaN(expDate.getTime()) ? expDate : null,
      });
    }
    return results;
  }
  // No project specified: discover all projects and check each for metadata
  const projectPrefixes = await discoverProjectPrefixes(bucketRoot);
  for (const p of projectPrefixes) {
    const loaded = await loadMetadata(p);
    if (!loaded) {
      logger.warn(`Project directory '${p}' has no ${METADATA_FILENAME}.`, undefined, { noGchat });
      results.push({
        prefix: p,
        hasMetadata: false,
        metadataExpired: false,
        metadataLoaded: false,
        expirationDate: null,
      });
    } else {
      const expired = isExpired(loaded.meta);
      const expStr = loaded.meta.expiration || null;
      const expDate = expStr ? new Date(expStr) : null;
      results.push({
        prefix: p,
        hasMetadata: true,
        metadataExpired: expired,
        metadataLoaded: true,
        expirationDate: expDate && !isNaN(expDate.getTime()) ? expDate : null,
      });
    }
  }
  if (!projectPrefixes.length) {
    logger.warn(`No project directories discovered under bucket root '${bucketRoot || '/'}'.`, undefined, { noGchat });
  }
  return results;
}