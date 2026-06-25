# Translation Microservice Specification

## 1. Overview

A containerized microservice providing a centralized translation source of truth. Distributed as a standalone Docker container, it is ready to be deployed via Docker Compose or orchestrated environments (Kubernetes, ECS).

The service provides "working drafts" for active translation editing through a built-in UI, and allows freezing deterministic, immutable published releases for production runtime. It exposes an API that retrieves localized text in multiple native formats (Android, iOS, Web, backend) and user made formats defined via custom templates.

**Core principles:**

- **Technology Stack:** Java 21, Spring Boot 3.2+, fully containerized.
- **Canonical YAML storage:** Single source of truth saved into the container file system.
- **Draft & Release states:** Actively edit draft branches (e.g., `main`); freeze deterministic releases (e.g., `1.0.0`) for production.
- **Platform-agnostic output:** Native formats (including plurals mapping) plus custom Handlebars templates.
- **File-based Generation:** Artifacts are generated on demand, cached safely using atomic operations, and served rapidly.

---

## 2. Storage Structure

Translations, templates, and internally generated files are stored in a centralized storage root that can be mounted into a docker volume or AWS EFS, Kubernetes `ReadWriteMany` PV to prevent split-brain issues across multiple container replicas.

The structure isolates `drafts` (working states) from `releases` (frozen versions), and maintains a `.generated` directory for compiled artifacts.

```text
<storage>/library-name/drafts/main/config.yaml
<storage>/library-name/drafts/main/custom-format.hbs
<storage>/library-name/drafts/main/login/en-US.yaml
<storage>/library-name/releases/1.0.0/config.yaml
<storage>/library-name/releases/1.0.0/custom-format.hbs
<storage>/library-name/releases/1.0.0/login/en-US.yaml
<storage>/library-name/releases/1.0.0/.generated/...
<storage>/library-name/drafts/1.0.x/...  # Hotfix branches
```

When a draft is frozen, **all files** — YAML translations, `config.yaml`, and all template files — are cloned into the release directory. After freezing, the release is immutable; only `.generated/` artifacts are ever written to it.

**Library, branch and section naming:** Lowercase letters, digits, and hyphens only. Must begin and end with a letter or digit.

---

## 3. Versioning

Follows Semantic Versioning (MAJOR.MINOR.PATCH). Releases are **immutable once frozen**. Version strings must use the strict `MAJOR.MINOR.PATCH` format with non-negative integers. The `v` prefix and partial versions (e.g., `1.0`) are not accepted.

| Change type | Bump |
| --- | --- |
| Removed/renamed keys, modified templates | MAJOR |
| New keys, new section, new locale, or custom format | MINOR |
| Wording fixes or pluralization tweaks only | PATCH |

### 3.1 Workflow

1. **Active Development:** Edits via the UI typically happen on the `main` branch. Requests targeting a draft branch are **dynamically generated** on API calls to reflect immediate updates.
2. **Freezing Releases:** A specific endpoint freezes a valid draft state into an immutable release version (e.g., `1.0.0`). Once frozen, releases are static. The source draft branch is **not deleted** after a successful freeze — it remains editable and continues to serve dynamic requests independently.
3. **Hotfixing (Branching):** If `1.0.0` is in production but `main` has already moved to `2.0.0`, developers can branch `releases/1.0.0` into a new draft `drafts/1.0.x`, apply the fix, and freeze as `1.0.1`.
4. **Artifact Storage:** When a release is requested, the service checks the internal `.generated/` path. If missing, it generates the file using **atomic write operations** (writing to a `.tmp-hash` file and renaming) to prevent race conditions, then serves it.

---

## 4. Translation Format

### 4.1 Keys

Keys must be declared with hyphens as word separator characters (`sign-in`, `login-button`).
**Duplicate keys are allowed** as long as they reside in *different* sections.

### 4.2 Placeholders & Plurals

Uses ICU MessageFormat syntax. Standard variables and **Plurals** are explicitly supported and mapped to native equivalents at generation time (e.g., Android `<plurals>` and iOS `.stringsdict` / `.xcstrings`).

```yaml
hello-username: "Hello {name}"
cart-count: "{count, plural, =0 {Cart is empty} one {1 item in cart} other {{count} items in cart}}"
```

### 4.3 Custom Formats via Templates

To support arbitrary application requirements, custom formats can be defined using Handlebars (`.hbs`) templates. The microservice injects the following JSON data model into the template:

```json
{
  "library": "users",
  "version": "1.0.0",
  "locale": "en-US",
  "section": "login",
  "translations": [
    { "key": "sign-in", "value": "Sign in" }
  ]
}
```

> **Note on `version`:** For frozen releases, `version` is the semver string (e.g., `"1.0.0"`). For draft branches, `version` is the branch name (e.g., `"main"`, `"1.0.x"`).

**Example Template (`env-format.hbs`):**

```handlebars
# Generated translations for {{library}} - {{locale}}
# Section: {{section}}

{{#each translations}}
{{key}}="{{value}}"
{{/each}}
```

### 4.4 Available Handlebars Helpers

The following helpers are available to all templates in addition to the standard Handlebars built-ins (`{{#each}}`, `{{#if}}`, `{{#unless}}`, `{{#with}}`).

| Helper | Signature | Description |
| --- | --- | --- |
| `upper` | `{{upper value}}` | Converts a string to `UPPERCASE` |
| `lower` | `{{lower value}}` | Converts a string to `lowercase` |
| `camelCase` | `{{camelCase value}}` | Converts `hyphen-key` → `hyphenKey` |
| `snakeCase` | `{{snakeCase value}}` | Converts `hyphen-key` → `hyphen_key` |
| `escapeJavaProperties` | `{{escapeJavaProperties value}}` | Escapes characters invalid in Java `.properties` files |

Inside `{{#each translations}}` blocks, standard Handlebars data variables are available: `{{@index}}`, `{{@first}}`, `{{@last}}`.

---

## 5. Library Configuration (`config.yaml`)

Required at the root of every library branch **before freezing**. A branch may be created and edited without a `config.yaml`, but a missing or malformed file causes the freeze to be rejected. The `POST /api/v1/manage/{library}` endpoint initializes a branch with a valid `config.yaml`.

```yaml
base_locale: "en-US"        # Primary locale — defines the master key set
on_missing_translation: "fallback"

# Optional hierarchical fallback chains.
# Only meaningful when on_missing_translation is "fallback".
# Ignored (with a Phase 1 warning) if any other mode is configured.
fallback_chains:
  "es-AR": "es-ES"          # If a key is missing in es-AR, look in es-ES
  "es-MX": "es-ES"
  "fr-CA": "fr-FR"
  "en-GB": "en-US"

# Optional custom formats bindings
custom_formats:
  - name: "env"               # The {format} used in the API URL
    extension: ".env"         # The {extension} used in the API URL
    template: "env-format.hbs" # The Handlebars template at the root of the version
```

**`on_missing_translation` modes:**

| Mode | Behavior |
| --- | --- |
| `error` | Reject the library at freeze time if any locale in any section is missing keys defined by `base_locale`. Phase 1 saves emit a non-blocking completeness warning in the API response when this mode is active, alerting editors before freeze. |
| `fallback` | 1. Traverse `fallback_chains` if the locale is mapped. 2. If unmapped or the chain is exhausted, implicitly drop the BCP-47 region code (e.g., `es-AR` → `es`). 3. If still missing, use the value from `base_locale`. |
| `return_key` | Replace missing value with the raw key name (e.g. `"login"`). |
| `return_empty` | Replace missing value with `""`. |

---

## 6. Validation

To prevent workflow gridlock while ensuring production stability, validation rules are split into two phases:

**Phase 1:** File-Level (Runs on Save/Edit API Calls)

- YAML 1.2 strict syntax (prevents boolean casting of `no`, `true`).
- Hyphenated, alphanumeric lowercase key format.
- Valid ICU MessageFormat syntax (plurals/variables).
- `config.yaml` structural validation (e.g., ensuring `fallback_chains` contains no circular references, such as `es-ES` → `es-AR` → `es-ES`).
- **Handlebars template compile check:** `.hbs` files are parsed and compiled at save time. Syntax errors are rejected with a `400 BAD_REQUEST` before writing to disk.

**Phase 2:** Cross-File / Integrity (Runs strictly on Freeze/Publish)

- Placeholder consistency across locales (e.g., `es-ES` must contain the same ICU variables as `en-US` for every key present in both).
- No orphan keys in non-primary locales (keys not present in `base_locale`).
- Locales referenced in `fallback_chains` must exist within the library.
- Template files referenced in `config.yaml` exist and compile successfully.
- `config.yaml` is present at the branch root.
- If `on_missing_translation: error` is set, verifies 100% key completeness across all locales.

---

## 7. API

### 7.1 Base URL

`/api/v1`

---

### 7.2 Authentication

All management and draft-read endpoints require:

```text
Authorization: Bearer <TOKEN>
```

**Translation retrieval authentication:**

- **Frozen release endpoints** (`/api/v1/translations/{library}/releases/...`) are **unauthenticated by default**, enabling direct CDN integration and zero-credential access for production clients.
- **Draft branch endpoints** (`/api/v1/translations/{library}/drafts/...`) require a valid `Authorization: Bearer` token to prevent accidental exposure of unreleased content.

---

### 7.3 Dashboard UI

```sh
GET /dashboard
```

Returns a fully featured web UI (HTML/JS/CSS). The Dashboard allows administrators to:

- Create new libraries.
- Create and manage sections within libraries.
- Add, edit, and remove translation locales and keys.
- Edit `config.yaml` (including mapping `fallback_chains`) and Handlebars templates.
- **Publish (freeze)** library versions.
- Delete existing draft libraries, branches, or sections.

---

### 7.4 Management API

All endpoints in this section require authentication [see 7.2](#72-authentication).

To handle concurrent edits from multiple UI instances, the service uses a **Last-Write-Wins** model paired with Real-time Notifications. The backend does not block concurrent saves, but instead notifies active users when underlying files change via SSE, shifting merge/conflict resolution to the user. Upon loading, the Dashboard UI establishes an SSE connection to `GET /api/v1/manage/stream` [see Live Change Stream](#live-change-stream).

---

#### List all libraries

```sh
GET /api/v1/manage
```

Response `200 OK`:

```json
["users", "products", "checkout"]
```

---

#### Create a library

```sh
POST /api/v1/manage/{library}
Content-Type: application/json
```

Body:

```json
{
  "base_locale": "en-US",
  "on_missing_translation": "fallback"
}
```

Creates the library and initializes `drafts/main/config.yaml` with the provided values. Returns `201 Created`:

```json
{ "library": "users", "branch": "main" }
```

---

#### Get library overview

```sh
GET /api/v1/manage/{library}
```

Response `200 OK`:

```json
{
  "library": "users",
  "drafts": ["main", "1.0.x"],
  "releases": ["1.0.0", "1.1.0"]
}
```

---

#### List frozen releases

```sh
GET /api/v1/manage/{library}/releases
```

Response `200 OK`:

```json
["1.0.0", "1.1.0", "2.0.0"]
```

---

#### Delete a library

```sh
DELETE /api/v1/manage/{library}
```

Deletes all draft branches for the library. Frozen releases are **retained** and remain accessible via the translation retrieval API. Returns `204 No Content`.

---

#### Create a branch

```sh
POST /api/v1/manage/{library}/branches/{branch}
Content-Type: application/json
```

Body:

```json
{ "source": "main" }
```

`source` may be a draft branch name (e.g., `"main"`) or a frozen release version string (e.g., `"1.0.0"`). All files from the source are cloned into the new branch. Returns `201 Created`:

```json
{ "library": "users", "branch": "1.0.x", "source": "1.0.0" }
```

---

#### Inspect a draft branch

```sh
GET /api/v1/manage/{library}/drafts/{branch}
```

Response `200 OK`:

```json
{
  "sections": {
    "login": ["en-US", "es-ES", "fr-FR"],
    "profile": ["en-US", "es-ES"]
  },
  "templates": ["env-format.hbs"],
  "has_config": true
}
```

---

#### Delete a draft branch

```sh
DELETE /api/v1/manage/{library}/drafts/{branch}
```

Permanently removes the branch and all its contents. Returns `204 No Content`.

---

#### Read config

```sh
GET /api/v1/manage/{library}/drafts/{branch}/config
```

Returns `200 OK` with `Content-Type: application/yaml` and the raw `config.yaml` content.

---

#### Update config

```sh
PUT /api/v1/manage/{library}/drafts/{branch}/config
Content-Type: application/yaml
```

Body: complete replacement `config.yaml` content. Phase 1 structural validation runs before saving. Returns `204 No Content`.

---

#### Read a template

```sh
GET /api/v1/manage/{library}/drafts/{branch}/templates/{template}
```

Returns `200 OK` with `Content-Type: text/plain` and the raw `.hbs` content.

---

#### Create or update a template

```sh
PUT /api/v1/manage/{library}/drafts/{branch}/templates/{template}
Content-Type: text/plain
```

Body: Handlebars template content. Phase 1 compile check runs before saving. Returns `204 No Content`.

---

#### Delete a template

```sh
DELETE /api/v1/manage/{library}/drafts/{branch}/templates/{template}
```

Returns `204 No Content`. If `config.yaml` references the deleted template, Phase 2 validation will fail at freeze time.

---

#### Create a section

```sh
POST /api/v1/manage/{library}/drafts/{branch}/{section}
```

No body required. Returns `201 Created`:

```json
{ "section": "checkout", "branch": "main" }
```

---

#### Delete a section

```sh
DELETE /api/v1/manage/{library}/drafts/{branch}/{section}
```

Deletes the section from the draft. Frozen data is retained and remains accessible. Returns `204 No Content`.

---

#### Add a locale to a section

```sh
POST /api/v1/manage/{library}/drafts/{branch}/{section}/{locale}
Content-Type: application/yaml
```

`{locale}` must be a valid IETF BCP 47 language tag (e.g., `en-US`, `fr-FR`). The body is optional: if provided, it is treated as the initial YAML translation content and Phase 1 validation runs before saving. Returns `201 Created`.

---

#### Read translations for a locale

```sh
GET /api/v1/manage/{library}/drafts/{branch}/{section}/{locale}
```

Returns `200 OK` with `Content-Type: application/yaml` and the raw YAML translation file content.

---

#### Update translations for a locale

```sh
PUT /api/v1/manage/{library}/drafts/{branch}/{section}/{locale}
Content-Type: application/yaml
```

Body: complete replacement YAML content for the locale file. Phase 1 validation runs before saving.

When `on_missing_translation: error` is configured, the response includes a non-blocking `warnings` array if keys are missing relative to `base_locale`. Returns `204 No Content` when no warnings apply, or `200 OK` with the warnings body:

```json
{
  "warnings": [
    {
      "code": "INCOMPLETE_LOCALE",
      "locale": "es-ES",
      "section": "login",
      "missing_keys": ["sign-out", "forgot-password"],
      "message": "2 key(s) present in base locale 'en-US' are missing. Freeze will fail until resolved."
    }
  ]
}
```

---

#### Remove a locale from a section

```sh
DELETE /api/v1/manage/{library}/drafts/{branch}/{section}/{locale}
```

Returns `204 No Content`. Frozen data is retained and remains accessible.

---

#### Live Change Stream

```sh
GET /api/v1/manage/stream
Authorization: Bearer <TOKEN>
```

Establishes a persistent SSE connection. Broadcasts an event to all connected authenticated clients whenever any draft file is successfully saved:

```json
{
  "library": "my-app",
  "branch": "main",
  "section": "login",
  "locale": "es-ES",
  "updatedBy": "admin@example.com",
  "timestamp": "2024-05-10T14:30:00Z"
}
```

---

### 7.5 Freeze Library Version (Publish)

```sh
POST /api/v1/manage/{library}/freeze
Content-Type: application/json
```

**Payload:** `{ "source_branch": "main", "version": "1.0.0" }`

Attempting to freeze to an already-existing version returns `409 CONFLICT`. Runs Phase 2 Validation against the source branch. On success, clones the draft into the immutable release. Returns `201 Created`:

```json
{ "library": "users", "version": "1.0.0" }
```

On validation failure, returns `422 UNPROCESSABLE_ENTITY` with a structured report:

```json
{
  "error": "UNPROCESSABLE_ENTITY",
  "message": "Freeze validation failed with 2 error(s).",
  "validation_errors": [
    {
      "code": "MISSING_KEY",
      "section": "login",
      "locale": "es-ES",
      "key": "sign-in",
      "message": "Key 'sign-in' defined in base locale 'en-US' is missing in 'es-ES'."
    },
    {
      "code": "BROKEN_FALLBACK_CHAIN",
      "locale": "es-AR",
      "message": "Fallback chain target 'es-MX' does not exist in any section of the library."
    }
  ]
}
```

**Validation error codes:**

| Code | Description |
| --- | --- |
| `MISSING_CONFIG` | `config.yaml` is absent from the source branch |
| `MISSING_KEY` | A key present in `base_locale` is absent in another locale (only applies with `on_missing_translation: error`) |
| `ORPHAN_KEY` | A key exists in a non-primary locale but not in `base_locale` |
| `PLACEHOLDER_MISMATCH` | A locale's value for a key contains different ICU variables than the `base_locale` equivalent |
| `BROKEN_FALLBACK_CHAIN` | A locale referenced in `fallback_chains` does not exist in the library |
| `MISSING_TEMPLATE` | A template file referenced in `config.yaml` does not exist in the branch |
| `TEMPLATE_COMPILE_ERROR` | A template referenced in `config.yaml` fails Handlebars compilation |

---

### 7.6 Retrieve Translations

To avoid URL path-segment ambiguity (draft branch names such as `main` would conflict with a generic `{ref}` parameter), the retrieval API uses two explicit URL prefixes: `releases/{version}` for frozen versions and `drafts/{branch}` for active branches.

**Draft endpoints require authentication. Release endpoints are unauthenticated.**

---

**A) Single Section Request:**

Returns the natively formatted file for the requested section.

```sh
GET /api/v1/translations/{library}/releases/{version}/{format}/{locale}/{section}.{extension}
GET /api/v1/translations/{library}/drafts/{branch}/{format}/{locale}/{section}.{extension}
```

**Supported formats and extensions:**

| `format` | Valid `extension` | Output Handled |
| --- | --- | --- |
| `android` | `.xml` | Translates ICU plurals to `<plurals>` |
| `ios` | `.strings`, `.xcstrings` | Generates associated `.stringsdict` for plurals |
| `json` | `.json` | Raw ICU strings |
| `gettext` | `.po` | Standard Gettext mapping |
| *(custom)* | *(custom)* | Dynamically resolved via `config.yaml` `custom_formats` |

**B) Multi-Section or Full Library Request:**

When requesting multiple sections or the entire library, the extension **MUST be `.zip`**.

```sh
# Multiple specific sections
GET /api/v1/translations/{library}/releases/{version}/{format}/{locale}/{section1},{section2}.zip
GET /api/v1/translations/{library}/drafts/{branch}/{format}/{locale}/{section1},{section2}.zip

# Full library (all sections)
GET /api/v1/translations/{library}/releases/{version}/{format}/{locale}.zip
GET /api/v1/translations/{library}/drafts/{branch}/{format}/{locale}.zip
```

The returned zip contains one file per requested section in the requested `{format}`. Requesting any other extension (e.g., `.xml`, `.strings`) for multiple sections returns `400 BAD_REQUEST`.

---

### 7.7 File Generation, Storage & Caching

**For Frozen Releases:**
Artifacts are checked against `.generated/`. Missing files are generated using **atomic writes** (`temp-write` → `rename`) to prevent race conditions during high concurrency.
Response headers: `Cache-Control: public, max-age=31536000, immutable`.

**For Active Drafts:**
Dynamically computed on every request to ensure the absolute latest edits are served.
Response headers: `Cache-Control: no-store`.

---

### 7.8 Error Responses

Standard JSON error bodies:

```json
{
  "error": "ERROR_CODE",
  "message": "Human-readable description."
}
```

| HTTP Code | `error` value | Meaning |
| --- | --- | --- |
| `400` | `BAD_REQUEST` | Malformed request, invalid version format, or unsupported format/extension combination. |
| `401` | `UNAUTHORIZED` | Missing or invalid authentication token. |
| `403` | `FORBIDDEN` | Authenticated user or PAT lacks permission for the requested operation. |
| `404` | `NOT_FOUND` | Library, branch, version, section, or locale not found. |
| `409` | `CONFLICT` | Attempted to freeze to a version string that already exists. |
| `422` | `UNPROCESSABLE_ENTITY` | Integrity validation failures during a freeze operation. [See 7.5](#75-freeze-library-version-publish) for the full validation error structure. |
| `500` | `INTERNAL_ERROR` | Internal transformation failure (e.g., I/O write error, Handlebars rendering error). |

---

## 8. Observability

**Logging & Auditing:**

- Application logs via SLF4J/Logback.

**Metrics & Health:**
Exposed via Spring Boot Actuator (`/actuator`):

- `/actuator/prometheus`: Disk-based generation metrics, request latency, JVM memory.
- `/actuator/health/liveness` & `readiness`: Standard health probes for Kubernetes/ECS integration.
