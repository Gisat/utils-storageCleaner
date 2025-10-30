/* filepath: src/utils/validate.ts (alternate block comment) */
import { isEmail } from "./email";

export interface Metadata {
  expiration?: string;        // ISO date (UTC)
  projectManager?: string;
  productOwner?: string;
  archive?: boolean;
  description?: string;
  [k: string]: any;
}

export interface ValidationIssue {
  field: string;
  message: string;
  severity: "error" | "warn";
}

const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?Z)?$/;

/**
 * Validate a metadata.json object according to our rules.
 * Returns a list of validation issues (empty if valid).
 */
export function validateMetadata(meta: Metadata): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (meta.expiration) {
    if (!ISO_DATE_REGEX.test(meta.expiration)) {
      issues.push({
        field: "expiration",
        message: "expiration must be an ISO 8601 date (YYYY-MM-DD or full UTC timestamp)",
        severity: "error",
      });
    } else {
      const d = new Date(meta.expiration);
      if (isNaN(d.getTime())) {
        issues.push({
          field: "expiration",
            message: "expiration is not a parseable date",
            severity: "error",
        });
      }
    }
  }

  if (meta.projectManager && !isEmail(meta.projectManager)) {
    issues.push({
      field: "projectManager",
      message: "projectManager must be a valid email",
      severity: "warn",
    });
  }

  if (meta.productOwner && !isEmail(meta.productOwner)) {
    issues.push({
      field: "productOwner",
      message: "productOwner must be a valid email",
      severity: "warn",
    });
  }

  if (meta.archive !== undefined && typeof meta.archive !== "boolean") {
    issues.push({
      field: "archive",
      message: "archive must be boolean if present",
      severity: "error",
    });
  }

  if (meta.description && typeof meta.description !== "string") {
    issues.push({
      field: "description",
      message: "description must be a string if present",
      severity: "warn",
    });
  }

  return issues;
}

/**
 * Convenience: throws if any error-level issues exist.
 */
export function assertValidMetadata(meta: Metadata): void {
  const issues = validateMetadata(meta);
  const errors = issues.filter(i => i.severity === "error");
  if (errors.length) {
    const msg = errors.map(e => `${e.field}: ${e.message}`).join("; ");
    throw new Error(`Invalid metadata: ${msg}`);
  }
}