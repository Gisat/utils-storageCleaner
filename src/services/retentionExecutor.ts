// Read allowed app prefixes from environment variable (comma-separated), fallback to default
const APP_PREFIXES: string[] = (process.env.APP_PREFIXES?.split(',').map(p => p.trim()).filter(Boolean)) || ['app-', 'fe-', 'utils-'];
import { streamAllKeys } from "./s3Client";
import { logger } from "../logger";
import { DeleteObjectCommand } from "@aws-sdk/client-s3";


export type RetentionResult = {
  deletedProdVersions: number[];
  deletedDevFiles: string[];
};

export type GlobalRetentionResult = {
  mode: "global";
  results: RetentionResult[];
};

export async function enforceRetention({ project, app, prodRetention = 3, devRetention = 5, dryRun = false }: { project?: string; app?: string; prodRetention?: number; devRetention?: number; dryRun?: boolean }): Promise<RetentionResult | GlobalRetentionResult> {
  const s3 = require("./s3Client").getS3Client();
  const { S3_BUCKET } = require("../config").loadConfig();
  // If no project/app, run retention for all projects/apps in the bucket
  if (!project || !app) {
    // Discover all project/app pairs using delimiter listing for root and app folders
    const discovered: Array<{ project: string, app: string }> = [];
    // 1. List root project folders
    await streamAllKeys("", async (projectObjs: any[]) => {
      for (const projObj of projectObjs) {
        const projectPrefix = projObj.key; // e.g. "WorldCereal_GST-10/"
        // 2. For each project, list app folders
        await streamAllKeys(projectPrefix, async (appObjs: any[]) => {
          for (const appObj of appObjs) {
            const appPrefix = appObj.key; // e.g. "WorldCereal_GST-10/app-esaWorldCereal/"
            // Only consider folders with allowed prefixes (skip "project/" and others)
            const appMatch = appPrefix.match(new RegExp(`^([^/]+)\/(${APP_PREFIXES.map(p=>p.replace(/[-/]/g,'\\$&')+'[^/]+').join('|')})\/$`));
            if (appMatch) {
              discovered.push({ project: appMatch[1], app: appMatch[2] });
            }
          }
        }, { useDelimiter: true });
      }
    }, { useDelimiter: true });
    // Run retention for each discovered project/app
    const results = [];
    for (const entry of discovered) {
      // Always pass project/app so recursion does not trigger global mode
      const result = await enforceRetention({ project: entry.project, app: entry.app, prodRetention, devRetention, dryRun });
      // Only push if result is RetentionResult (not GlobalRetentionResult)
      if ('deletedProdVersions' in result && 'deletedDevFiles' in result) {
        results.push(result);
      }
    }
    return { mode: "global", results };
  }

  // --- Single project/app retention logic ---
  const prodPrefix = `${project}/${app}/prod/`;
  const devPrefix = `${project}/${app}/dev/`;
  // --- PROD: Keep only latest prodRetention v<number> folders ---
  const versionDirs: { key: string, version: number }[] = [];
  await streamAllKeys(prodPrefix, async (objs: any[]) => {
    for (const obj of objs) {
      const rel = obj.key.substring(prodPrefix.length);
      const match = rel.match(/^(v\d+)\//);
      if (match) {
        const num = parseInt(match[1].slice(1), 10);
        if (!isNaN(num)) versionDirs.push({ key: obj.key, version: num });
      }
    }
  }, { useDelimiter: true });
  // Group by version dir
  const uniqueVersions = Array.from(new Set(versionDirs.map(v => v.version))).sort((a, b) => b - a);
  const keepVersions = uniqueVersions.slice(0, prodRetention);
  const deleteVersions = uniqueVersions.slice(prodRetention);
  // Delete all objects in old version dirs
  for (const v of deleteVersions) {
    const versionPrefix = `${prodPrefix}v${v}`;
    // Recursively delete all objects under v<number> (including subfolders and direct files)
    await streamAllKeys(versionPrefix, async (objs: any[]) => {
      for (const obj of objs) {
        if (!dryRun) {
          await s3.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: obj.key }));
          logger.info(`Deleted prod backup: ${obj.key}`);
        } else {
          logger.info(`[DRY RUN] Would delete prod backup: ${obj.key}`);
        }
      }
    });
  }
  // --- DEV: Keep only latest devRetention file.YYYYMMDD.ext files ---
  const datedFiles: { key: string, date: string }[] = [];
  const dateRegex = /^(.+)\.(\d{8})\.[^/]+$/;
  await streamAllKeys(devPrefix, async (objs: any[]) => {
    for (const obj of objs) {
      const rel = obj.key.substring(devPrefix.length);
      const match = rel.match(dateRegex);
      if (match) {
        datedFiles.push({ key: obj.key, date: match[2] });
      }
    }
  });
  // Sort by date descending
  datedFiles.sort((a, b) => b.date.localeCompare(a.date));
  const keepFiles = datedFiles.slice(0, devRetention).map(f => f.key);
  const deleteFiles = datedFiles.slice(devRetention).map(f => f.key);
  for (const key of deleteFiles) {
    if (!dryRun) {
      await s3.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: key }));
      logger.info(`Deleted dev backup: ${key}`);
    } else {
      logger.info(`[DRY RUN] Would delete dev backup: ${key}`);
    }
  }
  return { deletedProdVersions: deleteVersions, deletedDevFiles: deleteFiles };
}
