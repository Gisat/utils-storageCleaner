# Storage Compliance Reporter

A TypeScript CLI for:
- Scanning S3 storage for compliance with required metadata and directory structure.
- Reporting missing or invalid metadata, structure violations, and expiration policy issues.
- Sending Google Chat notifications for all warnings and policy violations.


## Features

- Recursive scan of S3 prefixes, validating per-directory `metadata.json`.
- Reports missing required metadata at project root.
- Enforces expiration hierarchy: child expiration must be ≤ ancestor expiration.
- Validates directory structure and naming conventions.
- All warnings and policy violations are reported in the CLI and (optionally) sent to Google Chat.
- Machine-readable JSON output for integration.
- Modular services & utilities with unit tests (Vitest).


## Directory & Metadata Rules

```
project/
  app/
    dev/
      metadata.json
      file.txt
      file.20240101.txt
    prod/
      v1/
      v2/
```

`metadata.json` fields (all optional except those you enforce operationally):

| Field           | Type      | Purpose |
|-----------------|-----------|---------|
| expiration      | ISO date  | When this prefix becomes eligible for deletion. |
| projectManager  | string    | Contact email. |
| productOwner    | string    | Contact email. |
| archive         | boolean   | Future toggle for alternate retention. |
| description     | string    | Human-readable description. |


Expiration applies to the prefix where the file resides. Hierarchy constraint: If a child directory provides its own `metadata.json`, its `expiration` must be less than or equal to (≤) the expiration of every ancestor that also defines one. A warning is emitted (and optionally a Chat notification) if a child sets a later expiration date than its ancestor. Only project root directories are required to have a `metadata.json`; descendants may omit one entirely. Missing descendant metadata does not generate a warning.


## Required Project FS Structure

Each project `<Name>_GST-<N>/` must follow these rules (validated automatically):
- Data directories directly under the project root must be either:
   - `app-*` (one or many application data directories)
   - `project/` (single shared project-wide data directory)
- An `app-*` directory may include zero, one, or both of `dev/` and `prod/`. No other immediate subdirectories are allowed.
- If `prod/` exists under an `app-*` directory, only version directories named `v<integer>/` (e.g. `v1/`, `v2/`) may be its direct children.
- `dev/` directories have no enforced internal structure; free-form.
- Version directories (`vN/`) have no enforced internal structure; free-form.
- The `project/` directory (if present) has no enforced internal structure.

Example (excerpt):
```
WorldCereal_GST-10/
   metadata.json
   app-esaWorldCereal/
      metadata.json
      dev/
         ...
      prod/
         v1/
   project/
```

Violations produce warnings with codes such as: `NO_DATA_DIRS`, `INVALID_DATA_DIR_NAME`, `INVALID_APP_CHILD`, `INVALID_PROD_CHILD`.

## CLI Usage

### Scan Report
```
storage-tool scan:report [--project <name>] [--no-gchat] [--json] [--log-level <level>]
```
- `--project <name>`: Project directory (e.g. WorldCereal_GST-10). If omitted, all discovered project directories (`*_GST-<N>`) are scanned.
- `--no-gchat`: Disable Google Chat notifications for this run.
- `--json`: Output results as machine-readable JSON.
- `--log-level <level>`: Override logging level (`error|warn|info|debug|trace`).

The CLI scans the specified (or all) projects, validates structure and metadata, and reports all warnings and policy violations. If `GCHAT_WEBHOOK_URL` is set, all warnings are also sent to Google Chat unless `--no-gchat` is used.

Example:
```bash
storage-tool scan:report --project WorldCereal_GST-10 --json
```

### Promote Release
```
storage-tool promote:release --project <name> --app <app-name> [--dry-run] [--public]
```
- `--project <name>`: Project directory (required).
- `--app <app-name>`: Application directory name (required).
- `--dry-run`: Simulate promotion, do not actually copy files.
- `--public`: Set ACL to public-read for promoted files.

Promotes the latest dev version to prod for the specified project/app. Use `--dry-run` to preview changes.

Example:
```bash
storage-tool promote:release --project WorldCereal_GST-10 --app app-esaWorldCereal --dry-run
```

### Retention Cleanup
```
storage-tool retention:cleanup [--project <name>] [--app <app-name>] [--prod-retention <x>] [--dev-retention <y>] [--dry-run]
```
- `--project <name>`: Project directory (e.g. WorldCereal_GST-10). If omitted, runs for all projects.
- `--app <app-name>`: Application directory name (e.g. app-esaWorldCereal, fe-frontend, utils-storageCleaner, or any prefix in APP_PREFIXES). If omitted, runs for all apps in all projects.
- `--prod-retention <x>`: Number of prod v<number> folders to keep (default: 3).
- `--dev-retention <y>`: Number of dev file.YYYYMMDD.ext files to keep (default: 5).
- `--dry-run`: Simulate deletion, do not actually delete files.

This command enforces retention policies for prod/dev versions. If `--project` or `--app` is omitted, retention is enforced for all discovered projects/apps.

Example:
```bash
storage-tool retention:cleanup --project WorldCereal_GST-10 --app app-esaWorldCereal --prod-retention 3 --dev-retention 5 --dry-run
storage-tool retention:cleanup --project WorldCereal_GST-10 --prod-retention 2 --dry-run
storage-tool retention:cleanup --dry-run
```
All results are grouped by project/app in the output.

### Environment Variables


| Variable              | Required | Description |
|-----------------------|----------|-------------|
| AWS_REGION            | yes      | Region (required even for many S3-compatible endpoints; use a placeholder like `us-east-1` if provider ignores it). |
| S3_BUCKET             | yes      | Target bucket name. |
| S3_ENDPOINT           | no       | Custom S3-compatible endpoint (e.g. `https://minio.local:9000`). |
| S3_FORCE_PATH_STYLE   | no       | `true` to force path-style URLs (needed for MinIO/Ceph). |
| S3_ACCESS_KEY_ID      | no       | Explicit access key (falls back to `AWS_ACCESS_KEY_ID`). |
| S3_SECRET_ACCESS_KEY  | no       | Explicit secret key (falls back to `AWS_SECRET_ACCESS_KEY`). |
| S3_SESSION_TOKEN      | no       | Session token (falls back to `AWS_SESSION_TOKEN`). |
| LOG_LEVEL             | no       | `error|warn|info|debug|trace` (default `info`). |
| GCHAT_WEBHOOK_URL     | no       | Google Chat incoming webhook URL for notifications. |
| GCHAT_TIMEOUT_MS      | no       | HTTP timeout for webhook POST (default 4000ms). |
| S3_PAGE_SIZE          | no       | Number of S3 objects to fetch per batch when scanning (default 1000). |
| APP_PREFIXES          | no       | Comma-separated list of allowed app directory prefixes (default: app-,fe-,utils-). |
| S3_SKIP_STARTUP_CHECK | no       | Set to `1` to skip S3 connectivity check at startup. |
| BASIC_AUTH_USER       | no       | Username for REST API basic authentication (default: `admin`). |
| BASIC_AUTH_PASS       | no       | Password for REST API basic authentication (default: `password`). |
### REST API Authentication

All REST API endpoints require HTTP Basic authentication. Set the username and password via environment variables:

```
BASIC_AUTH_USER=myuser
BASIC_AUTH_PASS=mypassword
```

Requests must include an `Authorization: Basic ...` header. Example using curl:

```
curl -u myuser:mypassword http://localhost:3000/scan:report
```

If you do not set `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY`, the AWS SDK default credential chain is used (environment, shared credentials file, IAM role, etc.). For MinIO or other S3-compatible storage, set `S3_ENDPOINT` and `S3_FORCE_PATH_STYLE=true`, plus credentials.

You may place them in a `.env` file for local use. If `GCHAT_WEBHOOK_URL` is set, all warnings and policy violations will send a notification unless `--no-gchat` is used.


### Warn Message Formatting (Google Chat)

All `logger.warn` messages trigger Google Chat notifications when `GCHAT_WEBHOOK_URL` is set. The raw warning text is transformed into a structured, multi‑line message using pattern matching. Unmatched warnings fall back to a generic template.

Patterns (simplified):

| Pattern | Example Raw Warn | Chat Title | Extracted Fields |
|---------|------------------|-----------|------------------|
| `Project directory '([^']+)' has no metadata.json` | `Project directory 'Foo_GST-1/' has no metadata.json (scanned project root).` | ⚠️ Missing Project Metadata | Project name |
| `Expiration violation: prefix '([^']+)' expiration (\S+) is later than ancestor '([^']+)' \((\S+)\)` | `Expiration violation: prefix 'Foo_GST-1/app/dev/' expiration 2025-12-31T...` | ⛔ Expiration Policy Violation | Child prefix, child expiry, ancestor prefix, ancestor expiry |
| `Structure issue \(([^)]+)\): (.+)` | `Structure issue (INVALID_PROD_CHILD): Non-version directory "tmp/" under "Foo_GST-1/app/prod/"...` | 📁 Structure Check Warning | Issue code, details |
| `Provided project name '([^']+)' does not match pattern` | `Provided project name 'BadProject' does not match pattern ^.+_GST-\d+$.` | ⚠️ Invalid Project Name | Name |
| `Directory '([^']+)' does not match project pattern` | `Directory 'misc/' does not match project pattern ^.+_GST-\d+$/; ignoring.` | ℹ️ Ignored Directory | Directory name |
| (fallback) | Any other warn | ⚠️ Warning | Original message |

Location of logic: `src/logger.ts` (`formatWarnForChat`). To extend support, add a new regex case and return a formatted string.

Example formatted output for an expiration violation:
```
⛔ Expiration Policy Violation
Child Prefix: Foo_GST-1/app/dev/
Child Expiration: 2025-12-31T00:00:00.000Z
Ancestor Prefix: Foo_GST-1/
Ancestor Expiration: 2025-10-01T00:00:00.000Z
Remediation: Adjust child expiration (must be <= ancestor) or update ancestor metadata.
```

Webhook failures are logged with `console.error` (not `warn`) to avoid recursive notification attempts.



## CLI Usage


## CLI Usage

### Scan Report
```
storage-tool scan:report [--project <name>] [--no-gchat] [--json] [--log-level <level>]
```
- `--project <name>`: Project directory (e.g. WorldCereal_GST-10). If omitted, all discovered project directories (`*_GST-<N>`) are scanned.
- `--no-gchat`: Disable Google Chat notifications for this run.
- `--json`: Output results as machine-readable JSON.
- `--log-level <level>`: Override logging level (`error|warn|info|debug|trace`).

The CLI scans the specified (or all) projects, validates structure and metadata, and reports all warnings and policy violations. If `GCHAT_WEBHOOK_URL` is set, all warnings are also sent to Google Chat unless `--no-gchat` is used.

Example:
```bash
storage-tool scan:report --project WorldCereal_GST-10 --json
```

### Promote Release
```
storage-tool promote:release --project <name> --app <app-name> [--dry-run] [--public]
```
- `--project <name>`: Project directory (required).
- `--app <app-name>`: Application directory name (required).
- `--dry-run`: Simulate promotion, do not actually copy files.
- `--public`: Set ACL to public-read for promoted files.

Promotes the latest dev version to prod for the specified project/app. Use `--dry-run` to preview changes.

Example:
```bash
storage-tool promote:release --project WorldCereal_GST-10 --app app-esaWorldCereal --dry-run
```

### Retention Cleanup
```
storage-tool retention:cleanup [--project <name>] [--app <app-name>] [--prod-retention <x>] [--dev-retention <y>] [--dry-run]
```
- `--project <name>`: Project directory (e.g. WorldCereal_GST-10). If omitted, runs for all projects.
- `--app <app-name>`: Application directory name (e.g. app-esaWorldCereal, fe-frontend, utils-storageCleaner, or any prefix in APP_PREFIXES). If omitted, runs for all apps in all projects.
- `--prod-retention <x>`: Number of prod v<number> folders to keep (default: 3).
- `--dev-retention <y>`: Number of dev file.YYYYMMDD.ext files to keep (default: 5).
- `--dry-run`: Simulate deletion, do not actually delete files.

This command enforces retention policies for prod/dev versions. If `--project` or `--app` is omitted, retention is enforced for all discovered projects/apps.

Example:
```bash
storage-tool retention:cleanup --project WorldCereal_GST-10 --app app-esaWorldCereal --prod-retention 3 --dev-retention 5 --dry-run
storage-tool retention:cleanup --project WorldCereal_GST-10 --prod-retention 2 --dry-run
storage-tool retention:cleanup --dry-run
```
All results are grouped by project/app in the output.

### Environment Variables

| Variable              | Required | Description |
|-----------------------|----------|-------------|
| AWS_REGION            | yes      | Region (required even for many S3-compatible endpoints; use a placeholder like `us-east-1` if provider ignores it). |
| S3_BUCKET             | yes      | Target bucket name. |
| S3_ENDPOINT           | no       | Custom S3-compatible endpoint (e.g. `https://minio.local:9000`). |
| S3_FORCE_PATH_STYLE   | no       | `true` to force path-style URLs (needed for MinIO/Ceph). |
| S3_ACCESS_KEY_ID      | no       | Explicit access key (falls back to `AWS_ACCESS_KEY_ID`). |
| S3_SECRET_ACCESS_KEY  | no       | Explicit secret key (falls back to `AWS_SECRET_ACCESS_KEY`). |
| S3_SESSION_TOKEN      | no       | Session token (falls back to `AWS_SESSION_TOKEN`). |
| LOG_LEVEL             | no       | `error|warn|info|debug|trace` (default `info`). |
| GCHAT_WEBHOOK_URL     | no       | Google Chat incoming webhook URL for notifications. |
| GCHAT_TIMEOUT_MS      | no       | HTTP timeout for webhook POST (default 4000ms). |
| S3_PAGE_SIZE          | no       | Number of S3 objects to fetch per batch when scanning (default 1000). |
| APP_PREFIXES          | no       | Comma-separated list of allowed app directory prefixes (default: app-,fe-,utils-). |
| S3_SKIP_STARTUP_CHECK | no       | Set to `1` to skip S3 connectivity check at startup. |

If you do not set `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY`, the AWS SDK default credential chain is used (environment, shared credentials file, IAM role, etc.). For MinIO or other S3-compatible storage, set `S3_ENDPOINT` and `S3_FORCE_PATH_STYLE=true`, plus credentials.

You may place them in a `.env` file for local use. If `GCHAT_WEBHOOK_URL` is set, all warnings and policy violations will send a notification unless `--no-gchat` is used.

### REST API Usage

POST `/retention:cleanup`
```json
{
   "project": "WorldCereal_GST-10",
   "app": "app-esaWorldCereal",
   "app": "fe-frontend",
   "app": "utils-storageCleaner",
   "prodRetention": 3,
   "devRetention": 5,
   "dryRun": true
}
```
Returns a JSON report of deleted prod versions and dev files (or what would be deleted in dry-run).

#### Global Retention Cleanup via API
To run retention cleanup for the whole bucket, omit `project` and `app` in the request body:
```json
{
    "prodRetention": 3,
    "devRetention": 5,
    "dryRun": true
}
```
This will enforce retention for all discovered project/app pairs and return grouped results.


## Testing

We use Vitest.

```bash
npm test
```

Watch mode:

```bash
npm run test:watch
```

All test files reside under the top-level `tests/` directory (e.g. `tests/myFeature.test.ts`). Avoid placing tests inside `src/`.


## Building & Publishing

Build output:

```bash
npm run build
```

Resulting CLI entry: `dist/cli.js` (exports as `storage-tool` via `bin` in `package.json`).

To link locally:

```bash
npm link
storage-tool scan:report
```


## Extension Ideas

- Configurable retention tiers & "archive" handling.
- Parallel prefix scanning with controlled concurrency.
- Integration with IaC pipeline (GitHub Actions job producing compliance report artifact).


## Troubleshooting

| Symptom | Cause | Resolution |
|---------|-------|------------|
| No warnings reported | All metadata and structure valid | No action needed. |
| Warnings not sent to Chat | `GCHAT_WEBHOOK_URL` not set or webhook error | Set the variable and check webhook URL. |
| Slow scan | Large bucket listing | Specify a single project via `--project`; future concurrency tuning. |


## License

ISC

---

Feedback / improvements welcome via issues or PRs.