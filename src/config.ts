/* filepath: src/config.ts */
import * as dotenv from "dotenv";
import fs from "fs";
import path from "path";

dotenv.config();

export interface Config {
  AWS_REGION: string;
  S3_BUCKET: string;

  // Optional non-AWS / custom S3 compatibility
  S3_ENDPOINT?: string;              // e.g. https://minio.local:9000
  S3_FORCE_PATH_STYLE?: string;      // "true"/"false" (true for MinIO, Ceph, etc.)
  S3_ACCESS_KEY_ID?: string;         // Explicit credentials (fallback to AWS_ACCESS_KEY_ID)
  S3_SECRET_ACCESS_KEY?: string;     // Explicit credentials (fallback to AWS_SECRET_ACCESS_KEY)
  S3_SESSION_TOKEN?: string;         // Optional session token

  [key: string]: string | undefined;
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export function loadConfig(): Config {
  return {
    AWS_REGION: requireEnv("AWS_REGION"),
    S3_BUCKET: requireEnv("S3_BUCKET"),

    // Non-AWS / override support (all optional)
    S3_ENDPOINT: process.env.S3_ENDPOINT,
    S3_FORCE_PATH_STYLE: process.env.S3_FORCE_PATH_STYLE,
    // Allow either custom S3_* vars or standard AWS_* names
    S3_ACCESS_KEY_ID:
      process.env.S3_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID,
    S3_SECRET_ACCESS_KEY:
      process.env.S3_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY,
    S3_SESSION_TOKEN:
      process.env.S3_SESSION_TOKEN || process.env.AWS_SESSION_TOKEN,
  };
}

export function loadJsonFile<T = any>(filePath: string): T {
  const abs = path.isAbsolute(filePath)
    ? filePath
    : path.join(process.cwd(), filePath);
  if (!fs.existsSync(abs)) {
    throw new Error(`Config file not found: ${abs}`);
  }
  return JSON.parse(fs.readFileSync(abs, "utf-8"));
}