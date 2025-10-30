// promotionExecutor.ts
// Promote dev data to production release (prod/vN)
import { streamAllKeys, getS3Client } from "./s3Client";
import { logger } from "../logger";
import { CopyObjectCommand } from "@aws-sdk/client-s3";

export async function promoteDevToProd({ project, app, dryRun = false, aclPublic = false }: { project: string; app: string; dryRun?: boolean; aclPublic?: boolean }): Promise<{ targetPrefix: string, plannedCopies: Array<{ from: string, to: string }> }> {
  const s3 = getS3Client();
  const devPrefix = `${project}/${app}/dev/`;
  const prodPrefix = `${project}/${app}/prod/`;
  // 1. Find all prod/vN/ directories
  const versionDirs: number[] = [];
  await streamAllKeys(prodPrefix, async (objs) => {
    for (const obj of objs) {
      const rel = obj.key.substring(prodPrefix.length);
      const match = rel.match(/^(v\d+)\//);
      if (match) {
        const num = parseInt(match[1].slice(1), 10);
        if (!isNaN(num)) versionDirs.push(num);
      }
    }
  });
  const nextVersion = versionDirs.length ? Math.max(...versionDirs) + 1 : 1;
  const targetPrefix = `${prodPrefix}v${nextVersion}/`;
  // 2. List all objects under dev
  const plannedCopies: Array<{ from: string, to: string }> = [];
  const { S3_BUCKET } = require("../config").loadConfig();
  // Matches files like file.20240101.txt (dot, 8 digits, dot, extension), but NOT file.txt
  const dateSuffixRegex = /^(.+)\.[0-9]{8}\.[^/]+$/;
  // List all files under devPrefix (no delimiter logic for subfolders)
  await require("./s3Client").streamAllKeys(devPrefix, async (objs: any[]) => {
    for (const obj of objs) {
      if (!obj.key.startsWith(devPrefix)) continue;
      if (obj.key.endsWith("/")) continue; // skip directories
      const rel = obj.key.substring(devPrefix.length);
      // Skip files with .YYYYMMDD. pattern before extension
      if (dateSuffixRegex.test(rel)) {
        logger.info(`[SKIP] Not promoting dated file: ${obj.key}`);
        continue;
      }
      const targetKey = `${targetPrefix}${rel}`;
      plannedCopies.push({ from: obj.key, to: targetKey });
      if (!dryRun) {
        await s3.send(new CopyObjectCommand({
          Bucket: S3_BUCKET,
          CopySource: `/${S3_BUCKET}/${obj.key}`,
          Key: targetKey,
          ...(aclPublic ? { ACL: "public-read" } : {}),
        }));
        logger.info(`Promoted: ${obj.key} -> ${targetKey}${aclPublic ? " [public-read]" : ""}`);
      }
    }
  }, { useDelimiter: false });
  return { targetPrefix, plannedCopies };
}
