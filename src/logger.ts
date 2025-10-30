/* filepath: src/logger.ts */
export type LogLevel = "error" | "warn" | "info" | "debug" | "trace";

const LEVEL_ORDER: LogLevel[] = ["error", "warn", "info", "debug", "trace"];
// Optional explicit in-process override (takes precedence over env)
let runtimeOverride: LogLevel | undefined;

function sanitizeLevel(v: string | undefined): LogLevel | undefined {
  if (!v) return undefined;
  const lower = v.toLowerCase();
  if (LEVEL_ORDER.includes(lower as LogLevel)) {
    return lower as LogLevel;
  }
  return undefined;
}

/**
 * Resolve the active log level:
 *  1. runtime override (set via logger.setLevel)
 *  2. process.env.LOG_LEVEL (dynamic, picks up .env changes)
 *  3. default "info"
 */
function currentLevel(): LogLevel {
  return runtimeOverride || sanitizeLevel(process.env.LOG_LEVEL) || "info";
}

function enabled(level: LogLevel): boolean {
  return LEVEL_ORDER.indexOf(level) <= LEVEL_ORDER.indexOf(currentLevel());
}

function format(level: LogLevel, msg: any, meta?: Record<string, any>) {
  const time = new Date().toISOString();
  if (meta && Object.keys(meta).length) {
    return `${time} ${level.toUpperCase()} ${msg} | ${JSON.stringify(meta)}`;
  }
  return `${time} ${level.toUpperCase()} ${msg}`;
}

async function sendWarnNotification(msg: string, opts?: { noGchat?: boolean }) {
  // No-op: all Google Chat notifications are now sent only as summary from CLI
  return;
}

export function formatWarnForChat(raw: string): string {
  // Known patterns & transformations
  // 1. Missing metadata root scan (unified format)
  const metaMissingMatch = raw.match(/^Project directory '(.*?)' has no metadata\.json \(scanned project root\)\.$/);
// Export for test usage
  if (metaMissingMatch) {
    const prefix = metaMissingMatch[1];
    return [
      '⚠️ Project Metadata Warning',
      `Project: ${prefix}`,
      'Issue: metadata.json not found at project root (required).',
      "Action: Create metadata.json with an 'expiration' property.",
      'Reference: README > Directory & Metadata Rules'
    ].join('\n');
  }
  // 2. Expiration violation
  const expViolation = raw.match(/^Expiration violation: prefix '(.*?)' expiration (.*?) is later than ancestor '(.*?)' \((.*?)\)\. Child must be <= ancestor\.$/);
  if (expViolation) {
    const [, child, childDate, ancestor, ancestorDate] = expViolation;
    return [
      '⛔ Expiration Policy Violation',
      `Child Prefix: ${child}`,
      `Child Expiration: ${childDate}`,
      `Ancestor Prefix: ${ancestor}`,
      `Ancestor Expiration: ${ancestorDate}`,
      'Rule: Child expiration must be earlier or equal to ancestor expiration.',
      'Action: Adjust metadata expiration hierarchy.',
      'Ref: README > Directory & Metadata Rules'
    ].join('\n');
  }
  // 3. Structure issue codes (unified format)
  const structureIssue = raw.match(/^Structure issue \((.*?)\): (.*)$/);
  if (structureIssue) {
    const [, , detail] = structureIssue;
    // Try to extract the project from [project=...] at the end of the detail
    let project = '';
    const projectMatch = detail.match(/\[project=([^\]]+)\]$/);
    let cleanDetail = detail;
    if (projectMatch) {
      project = projectMatch[1];
      cleanDetail = detail.replace(/ \[project=[^\]]+\]$/, '');
    } else {
      // fallback: try to extract from quoted path or _GST-\d+ pattern
      const pathMatch = detail.match(/['"]([^'"/]+_GST-\d+)[/'"]/);
      if (pathMatch) {
        project = pathMatch[1];
      } else {
        const fallback = detail.match(/([A-Za-z0-9_-]+_GST-\d+)/);
        if (fallback) project = fallback[1];
      }
    }
    return [
      '📁 Structure Check Warning',
      `Project: ${project || 'Unknown'}`,
      `Issue: ${cleanDetail}`,
      'Action: Align project directories to required pattern.',
      'Reference: README > Required Project FS Structure'
    ].join('\n');
  }
  // 4. Invalid project name pattern
  const invalidProjectName = raw.match(/^Provided project name '(.*?)' does not match pattern (.*)\.$/);
  if (invalidProjectName) {
    const [, name, pattern] = invalidProjectName;
    return [
      '⚠️ Invalid Project Name',
      `Name: ${name}`,
      `Required Pattern: ${pattern}`,
      'Action: Rename project to match required naming convention (_GST-<number>).'
    ].join('\n');
  }
  // 5. Non-project directory warning (more flexible: with or without trailing slash/semicolon)
  const nonProjectDir = raw.match(/^Directory '(.*?)' does not match project pattern (.+?)(?:\/|); ignoring\.?$/);
  if (nonProjectDir) {
    const [, dir, pattern] = nonProjectDir;
    return [
      'ℹ️ Ignored Directory',
      `Directory: ${dir}`,
      `Reason: Name does not match project pattern ${pattern}`,
      'No action required unless this should be a project.'
    ].join('\n');
  }
  // 6. Storage Cleaner Alert (unified format)
  const storageAlert = raw.match(/^⚠️ Storage Cleaner Alert\nProject directory: ([^\n]+)\nIssue: (.*?)\nContext: (.*?)\nAction: (.*?)\nDocs: (.*)$/s);
  if (storageAlert) {
    const [, project, issue, context, action, docs] = storageAlert;
    return [
      '⚠️ Project Metadata Warning',
      `Project: ${project}`,
      `Issue: ${issue} (Context: ${context})`,
      `Action: ${action}`,
      `Reference: ${docs}`
    ].join('\n');
  }
  // Fallback generic warning
  return [
    '⚠️ Warning',
    raw,
    'Ref: Consult logs for more details.'
  ].join('\n');
}

export const logger = {
  setLevel(level: LogLevel) {
    runtimeOverride = level;
  },
  clearRuntimeLevel() {
    runtimeOverride = undefined;
  },
  level(): LogLevel {
    return currentLevel();
  },
  error(msg: any, meta?: Record<string, any>) {
    if (enabled("error")) console.error(format("error", msg, meta));
  },
  warn(msg: any, meta?: Record<string, any>, opts?: { noGchat?: boolean }) {
    if (enabled("warn")) {
      const formatted = format("warn", msg, meta);
      console.warn(formatted);
      // No notification: summary only sent from CLI
    }
  },
  info(msg: any, meta?: Record<string, any>) {
    if (enabled("info")) console.log(format("info", msg, meta));
  },
  debug(msg: any, meta?: Record<string, any>) {
    if (enabled("debug")) console.log(format("debug", msg, meta));
  },
  trace(msg: any, meta?: Record<string, any>) {
    if (enabled("trace")) console.log(format("trace", msg, meta));
  },
};