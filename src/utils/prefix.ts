/* filepath: src/utils/prefix.ts */
/**
 * Helpers for working with logical S3-style prefixes / paths.
 */

export interface PathParts {
  project: string;
  app?: string;
  environment?: "dev" | "prod";
  version?: string;   // v1, v2, ...
  rest: string[];
}

/**
 * Ensure consistent formatting (no leading slash, single separators, trailing slash for non-empty).
 */
export function normalizePrefix(input: string): string {
  let p = input.trim();
  if (p.startsWith("/")) p = p.slice(1);
  p = p.replace(/\/{2,}/g, "/");
  if (p && !p.endsWith("/")) p += "/";
  return p;
}

export function splitSegments(key: string): string[] {
  return key.split("/").filter(Boolean);
}

/**
 * Parse a path/prefix into structured parts.
 * Recognizes:
 *   project/
 *   project/app/
 *   project/app/dev/
 *   project/app/prod/
 *   project/app/prod/vN/
 */
export function parsePath(keyOrPrefix: string): PathParts | null {
  const segs = splitSegments(keyOrPrefix);
  if (!segs.length) return null;
  const [project, app, maybeEnv, maybeVersion, ...tail] = segs;

  if (!project) return null;

  let environment: "dev" | "prod" | undefined;
  let version: string | undefined;
  let rest: string[] = [];

  if (maybeEnv === "dev" || maybeEnv === "prod") {
    environment = maybeEnv;
    if (environment === "prod" && maybeVersion && /^v\d+$/.test(maybeVersion)) {
      version = maybeVersion;
      rest = tail;
    } else {
      rest = [maybeVersion, ...tail].filter(Boolean);
    }
  } else {
    rest = [maybeEnv, maybeVersion, ...tail].filter(Boolean);
  }

  return {
    project,
    app,
    environment,
    version,
    rest,
  };
}

export function buildProdVersionPrefix(project: string, app: string, version: number): string {
  return normalizePrefix(`${project}/${app}/prod/v${version}`);
}

export function buildDevPrefix(project: string, app: string): string {
  return normalizePrefix(`${project}/${app}/dev`);
}

/**
 * Determine if a key's filename ends with a date suffix: -YYYYMMDD(.ext)
 */
export function isDateSuffixedFile(key: string): boolean {
  const base = key.split("/").pop();
  if (!base) return false;
  return /-\d{8}(\.[A-Za-z0-9._-]+)?$/.test(base);
}

/**
 * Hidden if any path segment begins with '.'.
 */
export function isHidden(key: string): boolean {
  return key.split("/").some(seg => seg.startsWith("."));
}