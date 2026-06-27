# Translation Microservice Specification

## 1. Overview

A containerized microservice providing a centralized translation source of truth. Distributed as a standalone Docker container, it is ready to be deployed via Docker Compose or orchestrated environments (Kubernetes, ECS).

The service provides "working drafts" for active translation editing through a built-in UI, and allows freezing deterministic, immutable published releases for production runtime. It exposes an API that retrieves localized text in multiple native formats (Android, iOS, Web, backend) and user-defined formats via custom templates.

**Core principles:**

- **Canonical YAML storage:** Single source of truth saved into the container file system.
- **Draft & Release states:** Actively edit draft branches (e.g., `main`); freeze deterministic releases (e.g., `1.0.0`) for production.
- **Platform-agnostic output:** Native formats (including plurals mapping) plus custom Handlebars templates.
- **File-based Generation:** Artifacts are generated on demand, cached safely using atomic file system operations, and served rapidly.

---

## 2. Storage Structure

Translations, templates, and internally generated files are stored in a centralized storage root that can be mounted into a docker volume or AWS EFS, Kubernetes `ReadWriteMany` PV to prevent split-brain issues across multiple container replicas. The absolute path to this storage root must be injected into the Spring Boot application via an environment variable (e.g., TRANSLATION_STORAGE_ROOT), defaulting to ./storage for local development.

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

**Library, branch and section naming:** Lowercase letters, digits, and hyphens only. Must begin and end with a letter or digit.
**Locale naming:** Lower case for the language, and Upper case for the country

When a draft is frozen, **all files** — YAML translations, `config.yaml`, and all template files — are cloned into the release directory. After freezing, the release is immutable; only `.generated/` artifacts are ever written to it.

---

## 3. Versioning

Follows Semantic Versioning (MAJOR.MINOR.PATCH). Releases are **immutable once frozen** and cannot be deleted. Version strings must use the strict `MAJOR.MINOR.PATCH` format with non-negative integers. The `v` prefix and partial versions (e.g., `1.0`) are not accepted.

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

Keys must be declared with underscores as word separator characters (`sign_in`, `login_button`).
**Duplicate keys are allowed** as long as they reside in *different* sections.

### 4.2 Placeholders & Plurals

Uses ICU MessageFormat syntax. Standard variables and **Plurals** are explicitly supported and mapped to native equivalents at generation time (e.g., Android `<plurals>` and iOS `.xcstrings`).

```yaml
hello_username: "Hello {name}"
cart_count: "{count, plural, =0 {Cart is empty} one {1 item in cart} other {{count} items in cart}}"
```

### 4.3 Custom Formats via Templates

To support arbitrary application requirements, custom formats can be defined using Handlebars (`.hbs`) templates. Templates define the generation of a single section file. The microservice injects the following JSON data model into the template:

```json
{
  "library": "users",
  "version": "1.0.0",
  "locale": "en-US",
  "sections": [
    { 
      "name": "login", 
      "translations": [
        { "key": "sign_in", "value": "Sign in" }
      ] 
    }
  ]
}
```

> **Note on `version`:** For frozen releases, `version` is the semver string (e.g., `"1.0.0"`). For draft branches, `version` is the branch name (e.g., `"main"`, `"1.0.x"`).

**Example Template (`env-format.hbs`):**

```handlebars
# Generated translations for {{library}} - {{locale}}

{{#each sections}}
# Section: {{name}}
{{#each translations}}
{{../name}}_{{key}}="{{value}}"
{{/each}}
{{/each}}
```

### 4.4 Available Handlebars Helpers

The following helpers are available to all templates in addition to the standard Handlebars built-ins (`{{#each}}`, `{{#if}}`, `{{#unless}}`, `{{#with}}`).

| Helper | Signature | Description |
| --- | --- | --- |
| `upper` | `{{upper value}}` | Converts a string to `UPPERCASE` |
| `lower` | `{{lower value}}` | Converts a string to `lowercase` |

Inside `{{#each translations}}` blocks, standard Handlebars data variables are available: `{{@index}}`, `{{@first}}`, `{{@last}}`.

---

## 5. Library Configuration (`config.yaml`)

Required at the root of every library branch. It is created always as part of a new branch, and will be initialized with default values for mandatory settings. A missing or malformed `config.yaml` will cause freezes to be rejected.

```yaml
base_locale: "en-US"        # Primary locale — defines the master key set
on_missing_translation: "error"

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
    extension: "env"         # The {extension} used in the API URL
    template: "env-format.hbs" # The Handlebars template at the root of the version
```

**`on_missing_translation` modes:**

| Mode | Behavior |
| --- | --- |
| `error` | Reject the library at freeze time if any locale in any section is missing keys defined by `base_locale`. Phase 1 saves emit a non-blocking completeness warning in the API response when this mode is active, alerting editors before freeze. |
| `fallback` | 1. Traverse `fallback_chains` if the locale is mapped. 2. If unmapped or the chain is exhausted, implicitly drop the region code (e.g., `es-AR` → `es`). 3. If still missing, use the value from `base_locale`. |
| `return_key` | Replace missing value with the raw key name (e.g. `"login"`). |
| `return_empty` | Replace missing value with `"" (Preserving plurals if necessary)`. |

---

## 6. Validation

To prevent workflow gridlock while ensuring production stability, validation rules are split into two phases:

**Phase 1:** File-Level (Runs on Save/Edit API Calls)

- YAML 1.2 strict syntax (prevents boolean casting of `no`, `true`).
- Underscore-separated, alphanumeric lowercase key format.
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

None of the microservice endpoints require authentication. This microservice is meant to be used internally, so authentication is delegated to the infrastructure where this container will live.

---

### 7.3 Dashboard

```sh
GET /dashboard
```

Serves the admin web UI. Supports: creating and deleting libraries, branches, sections, and locales; editing translations, `config.yaml`, and Handlebars templates; publishing (freezing) releases.

---

### 7.4 Management API

| Method | Path | Request body | Success | Notes |
| -------- | ------ | ------------- | --------- | ------- |
| `GET` | `/api/v1/manage` | — | `200` `["users","products"]` | List libraries |
| `POST` | `/api/v1/manage/{library}` | `{"base_locale","on_missing_translation"}` | `201` `{"library","branch"}` | Creates library with main branch + `drafts/main/config.yaml` |
| `GET` | `/api/v1/manage/{library}` | — | `200` `{"library","drafts":[],"releases":[]}` | Library overview |
| `GET` | `/api/v1/manage/{library}/releases` | — | `200` `["1.0.0","1.1.0"]` | List frozen releases |
| `DELETE` | `/api/v1/manage/{library}` | — | `204` | Deletes library and all drafts; releases retained |
| `POST` | `/api/v1/manage/{library}/branches/{branch}` | `{"source"}` | `201` `{"library","branch","source"}` | `source` may be a draft name or release version; clones all files |
| `GET` | `/api/v1/manage/{library}/drafts/{branch}` | — | `200` `{"sections":{},"templates":[],"has_config":true}` | Branch overview |
| `DELETE` | `/api/v1/manage/{library}/drafts/{branch}` | — | `204` | — |
| `GET` | `/api/v1/manage/{library}/drafts/{branch}/config` | — | `200` YAML | Raw `config.yaml` |
| `PUT` | `/api/v1/manage/{library}/drafts/{branch}/config` | YAML body | `204` | Phase 1 validation before save |
| `GET` | `/api/v1/manage/{library}/drafts/{branch}/templates/{template}` | — | `200` text | Raw `.hbs` content |
| `PUT` | `/api/v1/manage/{library}/drafts/{branch}/templates/{template}` | text body | `204` | Phase 1 compile check before save |
| `DELETE` | `/api/v1/manage/{library}/drafts/{branch}/templates/{template}` | — | `204` | `config.yaml` refs → Phase 2 failure at freeze |
| `POST` | `/api/v1/manage/{library}/drafts/{branch}/{section}` | — | `201` `{"section","branch"}` | Create section |
| `DELETE` | `/api/v1/manage/{library}/drafts/{branch}/{section}` | — | `204` | Frozen data retained |
| `POST` | `/api/v1/manage/{library}/drafts/{branch}/{section}/{locale}` | optional YAML | `201` | `{locale}` must be a valid formatted locale; Phase 1 runs if body provided |
| `GET` | `/api/v1/manage/{library}/drafts/{branch}/{section}/{locale}` | — | `200` YAML | Raw translation file |
| `PUT` | `/api/v1/manage/{library}/drafts/{branch}/{section}/{locale}` | YAML body | `204` / `200+warnings` | Phase 1; returns `200` with `warnings` body if `on_missing_translation: error` and keys are missing |
| `DELETE` | `/api/v1/manage/{library}/drafts/{branch}/{section}/{locale}` | — | `204` | Frozen data retained |
| `GET` | `/api/v1/manage/stream` | — | SSE | Broadcasts save events to all connected clients |

**Locale warning response body** (`200 OK`):

```json
{
  "warnings": [{
    "code": "INCOMPLETE_LOCALE",
    "locale": "es-ES",
    "section": "login",
    "missing_keys": ["sign_out", "forgot_password"],
    "message": "2 key(s) present in base locale 'en-US' are missing. Freeze will fail until resolved."
  }]
}
```

**SSE event shape:**

```json
{ "library": "my-app", "branch": "main", "section": "login", "locale": "es-ES", "change": "updated|created|deleted", "timestamp": "2024-05-10T14:30:00Z" }
```

**Concurrency management:**

- Active sessions are notified of file changes in real time via SSE (`GET /api/v1/manage/stream`).
- GET endpoints return an ETag header (e.g., a hash of the file contents).
- PUT endpoints require an If-Match: ETag header.
- If the backend detects the file has changed since the user loaded it, it returns 412 Precondition Failed. The UI can then fetch the latest changes and alert the user, completely preventing data loss.

---

### 7.5 Freeze Library Version (Publish)

```sh
POST /api/v1/manage/{library}/freeze
{"source_branch": "main", "version": "1.0.0"}
```

Runs Phase 2 validation then clones the draft into an immutable release.

| Outcome | Status | Body |
| --------- | -------- | ------ |
| Success | `201` | `{"library","version"}` |
| Version already exists | `409` | Standard error |
| Validation failure | `422` | `{"error","message","validation_errors":[...]}` |

**Validation error codes:**

| Code | Description |
| ------ | ------------- |
| `MISSING_CONFIG` | `config.yaml` absent from source branch |
| `MISSING_KEY` | Key from `base_locale` absent in another locale (`on_missing_translation: error` only) |
| `ORPHAN_KEY` | Key in non-primary locale has no counterpart in `base_locale` |
| `PLACEHOLDER_MISMATCH` | ICU variables differ from the `base_locale` equivalent |
| `BROKEN_FALLBACK_CHAIN` | A `fallback_chains` target locale does not exist in the library |
| `MISSING_TEMPLATE` | Template referenced in `config.yaml` not found in branch |
| `TEMPLATE_COMPILE_ERROR` | Referenced template fails Handlebars compilation |

---

### 7.6 Retrieve Translations

When the user requests several sections or libraries at once, all the keys will be merged into the same file.

**A) Single Section Request:**

```sh
GET /api/v1/translations/{library}/releases/{version}/{format}/{locale}/{section}.{extension}
GET /api/v1/translations/{library}/drafts/{branch}/{format}/{locale}/{section}.{extension}
```

**B) Multi-Section or Full Library Request:**

```sh
GET /api/v1/translations/{library}/releases/{version}/bulk?targets=section1,section2&format={format}&locale={locale}&extension={extension}
GET /api/v1/translations/{library}/releases/{version}/{format}/{locale}.{extension}
GET /api/v1/translations/{library}/drafts/{branch}/bulk?targets=section1,section2&format={format}&locale={locale}&extension={extension}
GET /api/v1/translations/{library}/drafts/{branch}/{format}/{locale}.{extension}
```

When requesting multiple sections as a single file for native formats, all translation keys will be modified to append "section_" before key names. This is to prevent collisions when multiple sections are requested by a single api call. Hyphens in section names will be converted to underscores when constructing the key prefix.

**C) Multi-Library request:**

```sh
GET /api/v1/translations/bulk?targets=library1:version,library2:version,library3:branch&format={format}&locale={locale}&extension={extension}
```

When requesting multiple libraries as a single file for native formats, all translation keys will be modified to append "libraryname_section_" before key names. This is to prevent collisions when multiple libraries are requested by a single api call. Hyphens in library and section names will be converted to underscores when constructing the key prefix.

#### 7.6.1 Supported formats

| `format` | `extension` | Notes |
| ---------- | ------------- | ------- |
| `android` | `xml` | ICU plurals → `<plurals>` |
| `ios` | `xcstrings` | Plurals handled natively |
| `json` | `json` | Raw ICU strings |
| `gettext` | `po` | Standard Gettext |
| *(custom)* | *(custom)* | Resolved via `custom_formats` in `config.yaml` |

---

### 7.7 File Generation, Storage & Caching

**For Frozen Releases:**
Artifacts are checked against `.generated/`. Missing files are generated using **atomic writes** (`temp-write` → `rename`) to prevent race conditions during high concurrency.
Response headers: `Cache-Control: public, max-age=31536000, immutable`.

**For Active Drafts:**
Dynamically computed on every request to ensure the absolute latest edits are served.
Response headers: `Cache-Control: no-store`.

- Handlebars template execution must be strictly bounded (e.g., maximum 2000ms execution time, 5MB max output size limit) to prevent malicious or poorly written templates from causing JVM Out-Of-Memory (OOM) crashes or CPU starvation.

---

### 7.8 Error Responses

All errors return `{"error": "ERROR_CODE", "message": "Human-readable description."}`.

| HTTP Code | `error` value | Meaning |
| --- | --- | --- |
| `400` | `BAD_REQUEST` | Malformed request, invalid version format, or unsupported format/extension combination. |
| `404` | `NOT_FOUND` | Library, branch, version, section, or locale not found. |
| `409` | `CONFLICT` | Attempted to freeze to a version string that already exists. |
| `422` | `UNPROCESSABLE_ENTITY` | Integrity validation failures during a freeze operation. [See 7.5](#75-freeze-library-version-publish) for the full validation error structure. |
| `500` | `INTERNAL_ERROR` | Internal transformation failure (e.g., I/O write error, Handlebars rendering error). |
| `412` | `PRECONDITION_FAILED` | File modified by another user since last retrieved. UI must resolve the conflict. |

---

## 8. Observability

**Logging & Auditing:**

- Application logs via SLF4J/Logback.

**Metrics & Health:**
Exposed via Spring Boot Actuator (`/actuator`):

- `/actuator/prometheus`: Disk-based generation metrics, request latency, JVM memory.
- `/actuator/health/liveness` & `readiness`: Standard health probes for Kubernetes/ECS integration.

## 9. Technology Stack

- **Dashboard UI:** Serves the admin web UI as a Single Page Application (SPA) built with Angular 22. It must use Angular's idiomatic HttpClient and RxJS Observables to communicate with the REST endpoints, and EventSource for the SSE stream. The UI should be styled using Angular Material and use signals for visual reactivity.
- **Backend:** Java 21, Spring Boot 3.2+, Gradle, fully containerized. For YAML parsing jackson-dataformat-yaml, handlebars.java for template compilation and ibm.icu4j for ICU MessageFormat/Plural validation.
- **Containerization:** Multi-stage Dockerfile using eclipse-temurin:21-jdk-alpine for the build step and eclipse-temurin:21-jre-alpine for the runtime step. The container exposes port 8080 and defines a VOLUME for the storage root. Ready to use as a service on docker compose.
- **Testing:** JUnit 5 integration tests using @SpringBootTest for all possible use cases, including Phase 1 and Phase 2 validation, and use MockMvc to test the API endpoints.
