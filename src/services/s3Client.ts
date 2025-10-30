// List only root-level project folders using delimiter

/**
 * Lists only the immediate subfolders ("project folders") at the root of the bucket using delimiter.
 * Returns an array of prefix strings (e.g., ["ProjectA_GST-1/", "ProjectB_GST-2/"])
 */
export async function listRootProjectFolders(): Promise<string[]> {
  const s3 = getS3Client();
  const cfg = getConfig();
  const delimiter = "/";
  const res: ListObjectsV2CommandOutput = await s3.send(
    new ListObjectsV2Command({
      Bucket: cfg.S3_BUCKET,
      Delimiter: delimiter,
      Prefix: "",
      MaxKeys: 1000, // S3 max for delimiter listing
    })
  );
  const prefixes = res.CommonPrefixes?.map((cp) => cp.Prefix as string) ?? [];
  logger.debug(`[s3Client] Discovered root project folders: ${prefixes.join(", ")}`);
  return prefixes;
}
// Fetch an S3 object as a string
export async function getObjectString(key: string): Promise<string> {
  const s3 = getS3Client();
  const cfg = getConfig();
  const res = await s3.send(
    new GetObjectCommand({
      Bucket: cfg.S3_BUCKET,
      Key: key,
    })
  );
  const body = res.Body as Readable;
  const chunks: Buffer[] = [];
  for await (const chunk of body) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf-8");
}
// Minimal S3 connectivity check for CLI startup
export async function testS3Connectivity(): Promise<void> {
  const s3 = getS3Client();
  const cfg = getConfig();
  const timeoutMs = process.env.S3_STARTUP_TIMEOUT_MS
    ? parseInt(process.env.S3_STARTUP_TIMEOUT_MS, 10)
    : 5000;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await s3.send(
      new HeadBucketCommand({
        Bucket: cfg.S3_BUCKET,
      }),
      { abortSignal: controller.signal }
    );
    logger.debug("s3Client: HeadBucket successful");
    return;
  } catch (err: any) {
    const code = err?.name || err?.Code || err?.code;
    const status = err?.$metadata?.httpStatusCode;
    logger.debug(
      `s3Client: HeadBucket failed code=${code} status=${status} attempting fallback list`
    );
    if (status === 404) {
      throw new Error(
        `Bucket '${cfg.S3_BUCKET}' not found (HTTP 404) during startup connectivity check`
      );
    }
    if (controller.signal.aborted) {
      throw new Error(
        `HeadBucket aborted after ${timeoutMs}ms (possible network/endpoint issue)`
      );
    }
    // Fallback: a zero-key list (MaxKeys=0 is allowed)
    try {
      await s3.send(
        new ListObjectsV2Command({
          Bucket: cfg.S3_BUCKET,
          MaxKeys: 0,
        }),
        { abortSignal: controller.signal }
      );
      logger.debug("s3Client: fallback ListObjectsV2 succeeded");
    } catch (listErr: any) {
      const lcode = listErr?.name || listErr?.Code || listErr?.code;
      const lstatus = listErr?.$metadata?.httpStatusCode;
      if (controller.signal.aborted) {
        throw new Error(
          `Fallback ListObjects aborted after ${timeoutMs}ms (network/endpoint issue)`
        );
      }
      throw new Error(
        `S3 connectivity failed (HeadBucket + fallback list). Head code=${code} status=${status} List code=${lcode} status=${lstatus}`
      );
    }
  } finally {
    clearTimeout(timer);
  }
  logger.debug("s3Client: connectivity verified via fallback list");
}
/* filepath: src/services/s3Client.ts */
import {
  S3Client,
  ListObjectsV2Command,
  CopyObjectCommand,
  DeleteObjectsCommand,
  HeadObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  HeadBucketCommand,
} from "@aws-sdk/client-s3";
import { Readable } from "stream";
import { loadConfig } from "../config";
import { logger } from "../logger";



// Utility functions for config/client/pagesize
function getConfig() {
  return loadConfig();
}
let s3ClientSingleton: S3Client | null = null;
function getS3Client() {
  if (s3ClientSingleton) return s3ClientSingleton;
  const cfg = getConfig();
  function parseBool(v: string | undefined): boolean | undefined {
    if (v == null) return undefined;
    return /^(1|true|yes|on)$/i.test(v);
  }
  const forcePathStyle = parseBool(cfg.S3_FORCE_PATH_STYLE);
  const clientOptions: Record<string, any> = {
    region: cfg.AWS_REGION,
  };
  if (cfg.S3_ENDPOINT) {
    clientOptions.endpoint = cfg.S3_ENDPOINT;
    logger.debug(`s3Client: using custom endpoint ${cfg.S3_ENDPOINT}`);
  }
  if (forcePathStyle !== undefined) {
    clientOptions.forcePathStyle = forcePathStyle;
    logger.debug(`s3Client: forcePathStyle=${forcePathStyle}`);
  }
  if (cfg.S3_ACCESS_KEY_ID && cfg.S3_SECRET_ACCESS_KEY) {
    clientOptions.credentials = {
      accessKeyId: cfg.S3_ACCESS_KEY_ID,
      secretAccessKey: cfg.S3_SECRET_ACCESS_KEY,
      ...(cfg.S3_SESSION_TOKEN ? { sessionToken: cfg.S3_SESSION_TOKEN } : {}),
    };
    logger.debug("s3Client: using explicit credentials (access key id present)");
  }
  s3ClientSingleton = new S3Client(clientOptions);
  return s3ClientSingleton;
}
function getPageSize() {
  const DEFAULT_PAGE_SIZE = 1000;
  const ENV_PAGE_SIZE = process.env.S3_PAGE_SIZE ? parseInt(process.env.S3_PAGE_SIZE, 10) : undefined;
  const pageSize = ENV_PAGE_SIZE && ENV_PAGE_SIZE > 0 ? ENV_PAGE_SIZE : DEFAULT_PAGE_SIZE;
  logger.debug(`s3Client: S3_PAGE_SIZE=${pageSize}`);
  return pageSize;
}


// Streams all S3 keys under a prefix, calling onPage for each page of objects
import type { ListObjectsV2CommandOutput } from "@aws-sdk/client-s3";

export async function streamAllKeys(
  prefix: string,
  onPage: (objs: { key: string; size: number; lastModified?: Date }[]) => Promise<void>,
  opts?: { useDelimiter?: boolean }
): Promise<void> {
  const s3 = getS3Client();
  const cfg = getConfig();
  const pageSize = getPageSize();
  let ContinuationToken: string | undefined = undefined;
  // If scanning the project root (no sub-prefix), use delimiter to only list immediate children (e.g., app-*/)
  let useDelimiter: boolean;
  if (typeof opts?.useDelimiter === 'boolean') {
    useDelimiter = opts.useDelimiter;
  } else {
    useDelimiter = !prefix || /[^/]+\/$/.test(prefix); // project root or top-level
  }
  do {
    const params: any = {
      Bucket: cfg.S3_BUCKET,
      Prefix: prefix,
      MaxKeys: pageSize,
      ContinuationToken,
    };
    if (useDelimiter) params.Delimiter = "/";
    const res: ListObjectsV2CommandOutput = await s3.send(new ListObjectsV2Command(params));
    // If using delimiter, process only CommonPrefixes ("directories")
    if (useDelimiter && res.CommonPrefixes) {
      const objs = res.CommonPrefixes.map((cp: any) => ({
        key: cp.Prefix as string,
        size: 0,
        lastModified: undefined,
      }));
      if (objs.length > 0) {
        await onPage(objs);
      }
    } else {
      const objs =
        res.Contents?.map((obj: any) => ({
          key: obj.Key as string,
          size: obj.Size ?? 0,
          lastModified: obj.LastModified,
        })) ?? [];
      if (objs.length > 0) {
        await onPage(objs);
      }
    }
    ContinuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (ContinuationToken);
}

// Export getS3Client for direct use if needed (e.g., for tests)
export { getS3Client };