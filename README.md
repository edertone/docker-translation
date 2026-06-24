# Translation Microservice Specification

## 1. Overview

A containerized microservice providing a centralized translation source of truth. Distributed as a standalone Docker container, it is ready to be deployed via Docker Compose anywhere.

The service provides a live "working" state for active translation editing through a built-in UI, and allows freezing deterministic, immutable published versions for production runtime. It exposes an API that retrieves localized text in multiple native formats (Android, iOS, Web, backend) and user-defined custom templates.

**Core principles:**

- **Technology Stack:** Java 21, Spring Boot 3.2+, fully containerized.
- **Canonical YAML storage:** Single source of truth.
- **Live & Frozen states:** Actively edit the latest state; freeze deterministic versions for production.
- **Platform-agnostic output:** Native formats plus custom Handlebars templates.
- **File-based Generation:** Artifacts are generated on demand and stored on disk (basic caching).

---

## 2. Storage Structure

Translations, templates, and internally generated files are stored in a Docker volume. The structure isolates the `latest` working state from `frozen` versions, and maintains a `.generated` directory for compiled artifacts.

```text
<docker_volume>/library-name/latest/config.yaml
<docker_volume>/library-name/latest/custom-format.hbs
<docker_volume>/library-name/latest/section/locale.yaml
<docker_volume>/library-name/1.0.0/...
<docker_volume>/library-name/1.0.0/.generated/...
<docker_volume>/library-name/2.0.0/...
```

**Library and section naming:** Lowercase letters, digits, and hyphens only. Must begin and end with a letter or digit.
**Example layout:**

```text
users/latest/config.yaml
users/latest/env-format.hbs
users/latest/login/en-US.yaml
users/latest/login/es-ES.yaml
```

---

## 3. Versioning

Follows Semantic Versioning (MAJOR.MINOR.PATCH). Versions are **immutable once frozen**.

| Change type | Bump |
| --- | --- |
| Removed/renamed keys, changed placeholders, modified templates | MAJOR |
| New keys, new section, new locale, or new custom format added | MINOR |
| Wording fixes only | PATCH |

### 3.1 Workflow

1. **Active Development (`latest`):** All edits via the Dashboard happen on the `latest` state. Requests targeting the `latest` identifier are **always regenerated** on every API call to immediately reflect updates.
2. **Freezing Versions:** A specific endpoint freezes the `latest` state (if valid) into an immutable semantic version (e.g., `1.0.0`). Once frozen, these versions are static.
3. **Artifact Storage:** When a frozen version is requested, the service checks the internal `/generated/` path. If the requested file exists, it is served directly. If not, it is generated, saved to the path, and served.

---

## 4. Translation Format

### 4.1 Keys

Keys must be declared with hyphens as word separator characters (`sign-in`, `login-button`).
**Duplicate keys are allowed** as long as they reside in *different* sections.

### 4.2 Placeholders

Use ICU MessageFormat syntax, but restricted **only to simple variable placeholders**. Complex logic (such as plurals or select statements) is explicitly not allowed. Placeholders must be consistent across all locales for a given key:

```yaml
hello-username: "Hello {name}"
cart-count: "You have {count} items in your cart."
```

### 4.3 Custom Formats via Templates

To support arbitrary application requirements, custom formats can be defined using Handlebars (`.hbs`) templates. The microservice injects the following JSON data model into the template:

```json
{
  "library": "users",
  "version": "1.0.0",
  "locale": "en-US",
  "sections": ["login"],
  "translations": [
    { "key": "sign-in", "value": "Sign in" }
  ]
}
```

**Example Template (`env-format.hbs`):**

```handlebars
# Generated translations for {{library}} - {{locale}}
# Sections: {{join sections ", "}}

{{#each translations}}
{{key}}="{{value}}"
{{/each}}
```

---

## 5. Library Configuration (`config.yaml`)

Required at the root of the library version. A missing or malformed file causes the version to be rejected at freeze time.

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

The base_locale field defines the master key set. Non-primary locales must not contain keys absent from it — orphan keys will cause the version to be rejected at upload time.

---

## 6. Validation

Validation runs when saving edits via the Dashboard, and critically when **freezing** a version. If a frozen version fails validation, the freeze operation is aborted. **No validation occurs at request time.**

| Check | Always | Only when `on_missing_translation: error` |
| --- | --- | --- |
| YAML 1.2 strict syntax (prevents boolean casting of `no`, `true`) | ✓ | |
| hyphens and alphanumeric lowercase key format | ✓ | |
| No complex ICU logic (plurals, select) in placeholders (only simple variables allowed) | ✓ | |
| Placeholder consistency across locales | ✓ | |
| No orphan keys in non-primary locales | ✓ | |
| Template files referenced in `config.yaml` exist at the library root | ✓ | |
| Template syntax compilation (valid Handlebars logic) | ✓ | |
| Custom format names do not collide with native formats (`android`, `ios`, `json`, `gettext`) | ✓ | |
| 100% key completeness across all locales and sections | | ✓ |

---

## 7. API

### 7.1 Base URL & Authentication

`/api/v1`
API write/freeze requests are authenticated with `Authorization: Bearer <STATIC_TOKEN>`.

---

### 7.2 Dashboard & Management UI

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

---

### 7.3 Freeze Library Version

```sh
POST /api/v1/lib/{library}/freeze
Content-Type: application/json
```
**Payload:** `{"version": "1.0.0"}`
Validates the latest working state. If validation passes, copies the latest state into the `version` directory. Returns `422 UNPROCESSABLE_ENTITY` if validation (`strict_validation` or base constraints) fails.

---

### 7.4 Retrieve Translations

`{version_or_latest}` can be an explicit frozen version (e.g., `1.0.0`) or the literal string `latest`.

**A) Single Section Request:**
Returns the natively formatted file for the requested section.

```sh
GET /api/v1/lib/{library}/{version_or_latest}/{format}/{locale}/{section}.{extension}
```

**Supported formats and extensions:**

| `format` | Valid `extension` | Notes |
| --- | --- | --- |
| `android` | `.xml` | |
| `ios` | `.strings`, `.xcstrings` | |
| `json` | `.json` | |
| `gettext` | `.po` | |
| *(custom)* | *(custom)* | Dynamically resolved from `custom_formats` block in `config.yaml` |

*Example:* `GET /api/v1/lib/users/latest/android/en-US/login.xml`

**B) Multi-Section or Full Library Request:**
When requesting multiple sections OR the entire library, the extension **MUST be `.json`**.

```sh
GET /api/v1/lib/{library}/{version_or_latest}/{format}/{locale}/{section1},{section2}.json
GET /api/v1/lib/{library}/{version_or_latest}/{format}/{locale}.json
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

### 7.5 File Generation & Storage

To guarantee efficiency and predictability, the service relies on disk-based file storage rather than in-memory caching. More efficient caching mechanisms like a CDN can be used to further improve performance:

- **For Frozen Versions (`1.0.0`, etc.):**
   Upon receiving a request, the service checks the internal docker volume `.generated/` path. If the requested compiled artifact exists, it is streamed directly. If missing, the service generates the artifact, saves it to the path, and streams it. Since frozen versions are immutable, these generated files never expire. HTTP responses include aggressive headers to leverage browser and CDN caching:

```text
Cache-Control: public, max-age=31536000, immutable
```

- **For Active Work (`latest`):**
   Files requested for the `latest` version bypass the generation storage. They are computed dynamically on the fly on every request, ensuring developers always see the absolute latest edits made in the Dashboard.

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
| `400` | `BAD_REQUEST` | Malformed request |
| `400` | `UNSUPPORTED_FORMAT` | Unsupported format/extension combination. |
| `401` | `UNAUTHORIZED` | Missing or invalid Bearer token. |
| `404` | `NOT_FOUND` | Library, version, section, or locale not found. |
| `409` | `CONFLICT` | Attempted to freeze to a version string that already exists. |
| `422` | `UNPROCESSABLE_ENTITY` | Validation failures during a freeze operation. |
| `500` | `INTERNAL_ERROR` | Internal transformation failure (e.g., I/O write error, Handlebars error). |

---

## 8. Observability

**Logging:**

- Standard output logs via Spring Boot's SLF4J/Logback integration.
- Warns on missing translation fallbacks; errors on I/O generation failures.

**Metrics & Health:**

Exposed via Spring Boot Actuator (/actuator):

- `/actuator/prometheus`: Disk-based generation metrics, request latency, JVM memory, and garbage collection metrics.
- `/actuator/health/liveness` & `/actuator/health/readiness`: Standard health probes for orchestrators (Kubernetes, ECS).
