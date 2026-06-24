# Translation Microservice Specification

## 1. Overview

A containerized microservice providing a centralized translation source of truth. Distributed as a standalone Docker container, it is ready to be deployed via Docker Compose or orchestrated environments (Kubernetes, ECS).

The service provides "working drafts" for active translation editing through a built-in UI, and allows freezing deterministic, immutable published releases for production runtime. It exposes an API that retrieves localized text in multiple native formats (Android, iOS, Web, backend) and user-defined custom templates.

**Core principles:**

- **Technology Stack:** Java 21, Spring Boot 3.2+, fully containerized.
- **Canonical YAML storage:** Single source of truth backed by a distributed file system or object store.
- **Draft & Release states:** Actively edit draft branches (e.g., `main`); freeze deterministic releases (e.g., `1.0.0`) for production.
- **Platform-agnostic output:** Native formats (including plurals mapping) plus custom Handlebars templates.
- **File-based Generation:** Artifacts are generated on demand, cached safely using atomic operations, and served rapidly.

---

## 2. Storage Structure

Translations, templates, and internally generated files are stored in a centralized storage volume (e.g., AWS EFS, Kubernetes `ReadWriteMany` PV, or S3-compatible backend) to prevent split-brain issues across multiple container replicas.

The structure isolates `drafts` (working states) from `releases` (frozen versions), and maintains a `.generated` directory for compiled artifacts.

```text
<storage>/library-name/drafts/main/config.yaml
<storage>/library-name/drafts/main/custom-format.hbs
<storage>/library-name/drafts/main/login/en-US.yaml
<storage>/library-name/releases/1.0.0/...
<storage>/library-name/releases/1.0.0/.generated/...
<storage>/library-name/drafts/1.0.x/...  # Hotfix branches
```

**Library and section naming:** Lowercase letters, digits, and hyphens only. Must begin and end with a letter or digit.

---

## 3. Versioning

Follows Semantic Versioning (MAJOR.MINOR.PATCH). Releases are **immutable once frozen**.

| Change type | Bump |
| --- | --- |
| Removed/renamed keys, modified templates | MAJOR |
| New keys, new section, new locale, or custom format | MINOR |
| Wording fixes or pluralization tweaks only | PATCH |

### 3.1 Workflow

1. **Active Development:** Edits via the UI typically happen on the `drafts/main` branch. Requests targeting a draft branch are **dynamically generated** on API calls to reflect immediate updates.
2. **Freezing Releases:** A specific endpoint freezes a valid draft state into an immutable release version (e.g., `1.0.0`). Once frozen, releases are static.
3. **Hotfixing (Branching):** If `1.0.0` is in production but `main` has already moved to `2.0.0`, developers can branch `releases/1.0.0` into a new draft `drafts/1.0.x`, apply the fix, and freeze as `1.0.1`.
4. **Artifact Storage:** When a release is requested, the service checks the internal `.generated/` path. If missing, it generates the file using **atomic write operations** (writing to `.tmp` and renaming) to prevent race conditions, then serves it.

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

**Example Template (`env-format.hbs`):**

```handlebars
# Generated translations for {{library}} - {{locale}}
# Section: {{section}}

{{#each translations}}
{{key}}="{{value}}"
{{/each}}
```

---

## 5. Library Configuration (`config.yaml`)

Required at the root of every library branch/release. A missing or malformed file causes the draft to be rejected at freeze time.

```yaml
base_locale: "en-US" # Primary locale — defines the master key set  
on_missing_translation: "fallback"

# Optional custom formats bindings
custom_formats:
  - name: "env"               # The {format} used in the API URL
    extension: ".env"         # The {extension} used in the API URL
    template: "env-format.hbs" # The Handlebars template at the root of the version
```

**`on_missing_translation` modes:**

| Mode | Behavior |
| --- | --- |
| `error` | Reject the entire library at upload time if any locale in any section is missing keys defined by the primary locale |
| `fallback` | Replace missing value with the key match from base_locale |
| `return_key` | Replace missing value with the raw key name (e.g. `"login"`) |
| `return_empty` | Replace missing value with `""` |

The base_locale field defines the master key set. Non-primary locales must not contain keys absent from it — orphan keys will cause the version to be rejected at freeze time.

---

## 6. Validation

To prevent workflow gridlock while ensuring production stability, validation rules are split into two phases:

**Phase 1:** File-Level (Runs on Save/Edit API Calls)

- YAML 1.2 strict syntax (prevents boolean casting of `no`, `true`).
- Hyphenated, alphanumeric lowercase key format.
- Valid ICU MessageFormat syntax (plurals/variables).

**Phase 2:** Cross-File / Integrity (Runs strictly on Freeze/Publish)

- Placeholder consistency across locales (e.g., `es-ES` must contain the same variables as `en-US`).
- No orphan keys in non-primary locales (keys not present in `base_locale`).
- Template files referenced in `config.yaml` exist and compile successfully.
- If `on_missing_translation: error` is set, verifies 100% key completeness across all locales.

---

## 7. API

### 7.1 Base URL & Authentication

`/api/v1`
The API requires standard OIDC / JWT `Authorization: Bearer <TOKEN>` to track user identity for audit logs. Service accounts can use Long-Lived Personal Access Tokens.

---

### 7.2 Dashboard UI & CRUD API

```sh
GET /api/v1/dashboard
```

Returns a fully featured web UI (HTML/JS/CSS). The Dashboard allows administrators to:

- Create new libraries.
- Create and manage sections within libraries.
- Add, edit, and remove translation locales and keys.
- Edit `config.yaml` and Handlebars templates.
- **Publish (freeze)** library versions.
- Delete existing libraries or sections.

**Management APIs:**
The UI interacts with the following backend APIs to modify working drafts. Requests utilize `ETag` headers to implement optimistic locking, preventing concurrent edit overwrites (`412 Precondition Failed`).

- `POST /api/v1/lib/{library}/branches/{branch}` (Create new branch from release or main)
- `PUT /api/v1/lib/{library}/drafts/{branch}/{section}/{locale}` (Update translations, requires `If-Match: "etag-hash"`)
- `PUT /api/v1/lib/{library}/drafts/{branch}/config` (Update config/templates)

---

### 7.3 Freeze Library Version (Publish)

```sh
POST /api/v1/lib/{library}/freeze
Content-Type: application/json
```

**Payload:** `{"source_branch": "main", "version": "1.0.0"}`

Validates the draft state (Phase 2 Validation). If successful, clones the draft into the immutable `version` release. Returns `422 UNPROCESSABLE_ENTITY` with a validation report if it fails.

*(Optional: `DELETE /api/v1/lib/{library}/releases/{version}` soft-deletes/deprecates a broken release.)*

---

### 7.4 Retrieve Translations

`{ref}` can be an explicit frozen version (e.g., `1.0.0`) or a draft branch (e.g., `drafts/main`).

**A) Single Section Request:**
Returns the natively formatted file for the requested section.

```sh
GET /api/v1/lib/{library}/{ref}/{format}/{locale}/{section}.{extension}
```

**Supported formats and extensions:**

| `format` | Valid `extension` | Output Handled |
| --- | --- | --- |
| `android` | `.xml` | Translates ICU plurals to `<plurals>` |
| `ios` | `.strings`, `.xcstrings` | Generates associated `.stringsdict` for plurals |
| `json` | `.json` | Raw ICU strings |
| `gettext` | `.po` | Standard Gettext mapping |
| *(custom)* | *(custom)* | Dynamically resolved via `config.yaml` |

**B) Multi-Section or Full Library Request:**
When requesting multiple sections OR the entire library, the extension **MUST be `.json`**.

```sh
GET /api/v1/lib/{library}/{ref}/{format}/{locale}/{section1},{section2}.json
GET /api/v1/lib/{library}/{ref}/{format}/{locale}.json
```

Requesting any other extension (e.g., `.xml`, `.strings`) for multiple sections will return a `400 BAD_REQUEST`.

**JSON Response Structure:**
The response encapsulates each requested section, mapping the section name to its rendered string in the requested `{format}`.

```json
{
  "login": "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<resources>\n<string name=\"sign-in\">Sign in</string>\n</resources>",
  "checkout": "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<resources>\n<string name=\"pay\">Pay</string>\n</resources>"
}
```

---

### 7.5 File Generation, Storage & Caching

- **For Frozen Releases (`1.0.0`):**
   Artifacts are checked against `.generated/`. Missing files are generated using **atomic writes** (`temp-write` -> `rename`) to prevent race conditions during high concurrency.
   Responses include aggressive caching: `Cache-Control: public, max-age=31536000, immutable`.

- **For Active Drafts (`drafts/main`):**
   Dynamically computed to ensure the absolute latest edits are served. To prevent CPU exhaustion (DDoS) from heavy requests, the service returns `ETag` headers based on the draft's current commit/hash state, allowing clients to receive `304 Not Modified` without triggering Handlebars compilation.

---

### 7.6 Error Responses

Standard JSON error bodies:

```json
{
  "error": "ERROR_CODE",
  "message": "Human-readable description."
}
```

| HTTP Code | `error` value | Meaning |
| --- | --- | --- |
| `400` | `BAD_REQUEST` | Malformed request or unsupported format/extension. |
| `401` | `UNAUTHORIZED` | Missing or invalid authentication. |
| `404` | `NOT_FOUND` | Library, ref, section, or locale not found. |
| `409` | `CONFLICT` | Attempted to freeze to a version string that already exists. |
| `412` | `PRECONDITION_FAILED` | ETag mismatch during a PUT request (concurrent edit blocked). |
| `422` | `UNPROCESSABLE_ENTITY` | Integrity validation failures during a freeze operation. |
| `500` | `INTERNAL_ERROR` | Internal transformation failure (e.g., I/O write error, Handlebars error). |

---

## 8. Observability

**Logging & Auditing:**

- Application logs via SLF4J/Logback.
- **Audit Logs:** All modifications (Keys, Locales, Freeze operations) are logged with the authenticated User's Identity (extracted from JWT) and a timestamp (e.g., `User auth0|123 modified 'login-btn' in drafts/main at 2024-05-10T14:30:00Z`).

**Metrics & Health:**
Exposed via Spring Boot Actuator (`/actuator`):

- `/actuator/prometheus`: Disk-based generation metrics, request latency, concurrent edit conflicts (`412`s), JVM memory.
- `/actuator/health/liveness` & `readiness`: Standard health probes for Kubernetes/ECS integration.
