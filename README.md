# Translation Microservice Specification

## 1. Overview

A containerized microservice providing a centralized, versioned translation source of truth. Applications bind to specific, immutable translation versions for runtime determinism. It exposes an API that allows clients to retrieve localized text in multiple formats for different platforms (e.g. Android, iOS, Web, backend systems).

**Core principles:**

- Canonical YAML storage — single source of truth
- Immutable published versions — guaranteed determinism
- Platform-agnostic output — Android, iOS, Web, backend native formats, plus custom user-defined formats via templates
- Library-scoped — independent lifecycle per domain

---

## 2. Storage Structure

Translations and custom templates are uploaded and stored in a Docker volume. Templates must live at the root of the library version to prevent folder name collisions with translation sections.

```text
<docker_volume>/library-name/version/config.yaml
<docker_volume>/library-name/version/custom-format.hbs
<docker_volume>/library-name/version/section/locale.yaml
```

| Segment | Description | Example |
| --- | --- | --- |
| `library-name` | Domain grouping | `users`, `billing` |
| `version` | Semantic version | `1.0.0`, `2.1.0` |
| `section` | Functional grouping within a library | `login`, `checkout` |
| `locale.yaml` | Translations for a single locale | `en-US.yaml` |
| `*.hbs` | Optional Handlebars templates for custom formats | `env-format.hbs` |

**Library and section naming:** Lowercase letters, digits, and hyphens only. Must begin and end with a letter or digit.

**Example layout:**

```text
users/1.0.0/config.yaml
users/1.0.0/env-format.hbs
users/1.0.0/login/en-US.yaml
users/1.0.0/login/es-ES.yaml
```

---

## 3. Versioning

Follows Semantic Versioning (MAJOR.MINOR.PATCH). Versions are **immutable once published**.

| Change type | Bump |
| --- | --- |
| Removed/renamed keys, changed placeholders, modified templates | MAJOR |
| New keys, new section, new locale, or new custom format added | MINOR |
| Wording fixes only | PATCH |

---

## 4. Translation Format

### 4.1 Keys

Keys must be declared with hyphens as word separator characters:

```yaml
login: "Login"
sign-in: "Sign in"
```

### 4.2 Placeholders

Use ICU MessageFormat syntax, but restricted **only to simple variable placeholders**. Complex logic (such as plurals or select statements) is explicitly not allowed. Placeholders must be consistent across all locales for a given key:

```yaml
hello-username: "Hello {name}"
cart-count: "You have {count} items in your cart."
```

### 4.3 Encoding

All files must be UTF-8 encoded (without BOM recommended, with full Unicode support).

### 4.4 Custom Formats via Templates

To support arbitrary application requirements, custom formats can be defined using Handlebars (`.hbs`) templates. The microservice resolves fallbacks, flattens the requested sections, and injects the following JSON data model into the template at request time:

```json
{
  "library": "users",
  "version": "1.0.0",
  "locale": "en-US",
  "sections": ["login", "checkout"],
  "translations": [
    { "key": "login", "value": "Login" },
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

Required at the root of each versioned library. A missing or malformed file causes the version to be rejected at upload time.

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

Runs at **container startup** (for all already-stored library versions) and on each **upload API call** (for the incoming versions only). A failed check logs a CRITICAL error, logs the problem and marks the library version as UNAVAILABLE in memory. **No validation occurs at request time.**

| Check | Always | Only when `on_missing_translation: error` |
| --- | --- | --- |
| YAML 1.2 strict syntax (prevents boolean casting of `no`, `true`) | ✓ | |
| hyphens and alphanumeric lowercase key format | ✓ | |
| No complex ICU logic (plurals, select) in placeholders (only simple variables allowed) | ✓ | |
| Placeholder consistency across locales | ✓ | |
| No orphan keys in non-primary locales | ✓ | |
| No duplicate keys are allowed across different sections within the same library version | ✓ | |
| Template files referenced in `config.yaml` exist at the library root | ✓ | |
| Template syntax compilation (valid Handlebars logic) | ✓ | |
| Custom format names do not collide with native formats (`android`, `ios`, `json`, `gettext`) | ✓ | |
| 100% key completeness across all locales and sections | | ✓ |

---

## 7. API

### 7.1 Base URL

`/api/v1` *(independent from library versions)*

---

### 7.2 Upload Library Version

```sh
POST /api/v1/upload
Content-Type: multipart/form-data
```

- Uploads one or more versioned libraries to the service. The request body must include a `file` field containing a `.zip` archive. The zip must mirror the storage structure defined in [Section 2](#2-storage-structure)
- A zip may contain multiple library versions. All zip contents are validated before being stored. If a single library fails validation, nothing is imported and a `422 UNPROCESSABLE_ENTITY` is returned using the [standard error response](#77-error-responses).
- Trying to upload a library with a version that already exists will cause an upload failure.
- If all libraries can be imported, a standard 200 response is given: `{"status": "success", "imported_libraries": ["users/1.0.0"]}`
- If the request itself is malformed (missing `file` field, invalid zip), a `400 Bad Request` is returned using the [standard error response](#77-error-responses).
- Upload requests are authenticated with `Authorization: Bearer <STATIC_TOKEN>`

---

### 7.3 Retrieve Translations

```sh
# Get translations for a specific locale from a single section
GET /api/v1/lib/{library}/{version}/{format}/{locale}/{section}.{extension}

# Get translations for a specific locale from multiple sections
GET /api/v1/lib/{library}/{version}/{format}/{locale}/{section1},{section2},...,{sectionN}.{extension}

# Get translations for a specific locale from an entire library version
GET /api/v1/lib/{library}/{version}/{format}/{locale}.{extension}
```

Note: Merging sections will generate a single file with all the combined keys from the original sections.

**Examples:**

```sh
# Native Android XML — English translations from the login section of users v1.0.0
GET /api/v1/lib/users/1.0.0/android/en-US/login.xml

# Native Android XML — login and checkout sections
GET /api/v1/lib/users/1.0.0/android/en-US/login,checkout.xml

# Custom 'env' format (defined in config.yaml) — login and checkout sections
GET /api/v1/lib/users/1.0.0/env/en-US/login,checkout.env
```

**Supported formats and extensions:**

| `format` | Valid `extension` | Notes |
| --- | --- | --- |
| `android` | `.xml` | |
| `ios` | `.strings`, `.xcstrings` | |
| `json` | `.json` | |
| `gettext` | `.po` | |
| *(custom)* | *(custom)* | Dynamically resolved from `custom_formats` block in `config.yaml` |

---

### 7.4 Catalog

Returns a human-readable HTML page listing all stored libraries, their published versions, and for each version: the available sections, supported locales, and supported custom formats. It also gives information about missing keys (regardless of on_missing_translation setting).

```sh
GET /api/v1/catalog
```

**Response:** `Content-Type: text/html`, `200 OK`

---

### 7.5 Health & Readiness

Used by orchestrators (Kubernetes, ECS, etc.) to determine whether the service is ready to handle traffic. The endpoints become available immediately at container start; their status reflects the current startup validation phase.

```sh
GET /api/v1/health/live # always returns 200 immediately
GET /api/v1/health/ready # returns 503 until startup validation is done. Then returns 200 OK, even if some libraries failed validation and were marked UNAVAILABLE.
```

---

### 7.6 Caching & Response

Responses are **lazily cached in-memory** within the container. On first request:

1. If multiple sections are requested at once, sort them alphabetically to prevent redundant cache values
2. Load YAML sources for the requested library/version/section
3. Apply fallback strategy if needed
4. Compile native output OR process custom Handlebars template
5. Cache the transformed result and return

- Source data is immutable, cached entries never expire. HTTP responses include aggressive headers to leverage browser and CDN caching:

```text
Cache-Control: public, max-age=31536000, immutable
```

---

### 7.7 Error Responses

All error responses use a consistent JSON body:

```json
{
  "error": "ERROR_CODE",
  "message": "A human-readable description of the error."
}
```

| HTTP Code | `error` value | Meaning |
| --- | --- | --- |
| `400` | `BAD_REQUEST` | Malformed request (e.g. missing file field, invalid zip) |
| `400` | `UNSUPPORTED_FORMAT` | Unsupported format/extension combination (not a native format, and not defined in `config.yaml`) |
| `401` | `UNAUTHORIZED` | Missing or invalid Bearer token on upload request |
| `404` | `NOT_FOUND` | Library, version, section, or locale not found |
| `409` | `CONFLICT` | Uploaded a library version that already existed |
| `422` | `UNPROCESSABLE_ENTITY` | Translation or template validation failures |
| `500` | `INTERNAL_ERROR` | Internal transformation failure (e.g. Handlebars rendering error) |
| `503` | `SERVICE_UNAVAILABLE` | Library exists but is marked UNAVAILABLE due to corruption/validation failure |

---

## 8. Observability

The service emits logs to stdout and stderr:

- Validation failures (ingestion)
- Missing translation warnings (when any fallback mode is active)
- Errors

The service emits Prometheus metrics at the /metrics endpoint:

- Cache hit/miss ratio
- Request latency metrics
