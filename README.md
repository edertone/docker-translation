# Translation Microservice Specification

## 1. Overview

A containerized microservice providing a centralized, versioned translation source of truth. Applications bind to specific, immutable translation versions for runtime determinism. It exposes an API that allows clients to retrieve localized text in multiple formats for different platforms (e.g. Android, iOS, Web, backend systems).

**Core principles:**

- Canonical YAML storage — single source of truth
- Immutable published versions — guaranteed determinism
- Platform-agnostic output — Android, iOS, Web, backend formats
- Library-scoped — independent lifecycle per domain

---

## 2. Storage Structure

Translations are uploaded and stored in a Docker volume:

```text
<docker_volume>/library-name/version/config.yaml
<docker_volume>/library-name/version/section/locale.yaml
```

| Segment | Description | Example |
| --- | --- | --- |
| `library-name` | Domain grouping | `users`, `billing` |
| `version` | Semantic version | `1.0.0`, `2.1.0` |
| `section` | Functional grouping within a library | `login`, `checkout` |
| `locale.yaml` | Translations for a single locale | `en-US.yaml` |

**Library and section naming:** Lowercase letters, digits, and hyphens only. Must begin and end with a letter or digit.

**Example layout:**

```text
users/1.0.0/config.yaml
users/1.0.0/login/en-US.yaml
users/1.0.0/login/es-ES.yaml
```

---

## 3. Versioning

Follows Semantic Versioning (MAJOR.MINOR.PATCH). Versions are **immutable once published**.

| Change type | Bump |
| --- | --- |
| Removed/renamed keys, changed placeholders | MAJOR |
| New keys, new section or new locale added | MINOR |
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

---

## 5. Library Configuration (`config.yaml`)

Required at the root of each versioned library. A missing or malformed file causes the version to be rejected at upload time.

```yaml
locale_priority:
  - "en-US"   # Primary locale — defines the master key set
  - "es-ES"
  - "ca-ES"
on_missing_translation: "fallback_by_priority"
```

**`on_missing_translation` modes:**

| Mode | Behavior |
| --- | --- |
| `error` | Reject the entire library at upload time if any locale in any section is missing keys defined by the primary locale |
| `fallback_by_priority` | Replace missing value with the first match down the priority list (at GET request time). It traverses the locale_priority array from index 0 to N. The first locale containing the key is used. |
| `return_key` | Replace missing value with the raw key name (e.g. `"login"`) |
| `return_empty` | Replace missing value with `""` |

The **first entry** in `locale_priority` is the primary locale. Its keys define the master key set. Non-primary locales must not contain keys absent from the primary locale — orphan keys will cause the version to be rejected at upload time.

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
| 100% key completeness across all locales and sections | | ✓ |
| No duplicate keys are allowed across different sections within the same library | ✓ | |

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
# Android XML — English translations from the login section of users v1.0.0
GET /api/v1/lib/users/1.0.0/android/en-US/login.xml

# Android XML — English translations from the login and checkout sections of users v1.0.0
GET /api/v1/lib/users/1.0.0/android/en-US/login,checkout.xml

# Android XML — all English translations from every section of users v1.0.0
GET /api/v1/lib/users/1.0.0/android/en-US.xml
```

**Supported formats and extensions:**

| `format` | Valid `extension` | Notes |
| --- | --- | --- |
| `android` | `.xml` | |
| `ios` | `.strings`, `.xcstrings` | |
| `json` | `.json` | |
| `gettext` | `.po` | |

---

### 7.4 Catalog

Returns a human-readable HTML page listing all stored libraries, their published versions, and for each version: the available sections and supported locales. It also gives information about missing keys based on fallback_by_priority policy.

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

Responses are **lazily cached in-memory and on disk** within the container. On first request:

1. If multiple sections are requested at once, sort them alphabetically to prevent redundant cache values
2. Load YAML sources for the requested library/version/section
3. Apply fallback strategy if needed
4. Cache the transformed result and return

- The cache is persisted to disk on an external docker volume (exclusively dedicated for cache storage). It will be reloaded lazily into memory from disk after container restarts.
- Source data is immutable, cached entries never expire. A maximum cache size is defined as a docker environment variable, with a default value of 10GB with an LRU (Least Recently Used) eviction policy for the disk cache.
- HTTP responses include aggressive headers to leverage browser and CDN caching:

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
| `400` | `UNSUPPORTED_FORMAT` | Unsupported format/extension combination |
| `401` | `UNAUTHORIZED` | Missing or invalid Bearer token on upload request |
| `404` | `NOT_FOUND` | Library, version, section, or locale not found |
| `409` | `CONFLICT` | Uploaded a library version that already existed |
| `422` | `UNPROCESSABLE_ENTITY` | Translation validation failures |
| `500` | `INTERNAL_ERROR` | Internal transformation failure |
| `503` | `SERVICE_UNAVAILABLE` | Library exists but is marked UNAVAILABLE due to corruption/validation failure |

---

## 8. Observability

The service emits logs to stdout and stderr:

- Artifact generation count
- Validation failures (ingestion)
- Missing translation warnings (when any fallback mode is active)
- Errors

The service emits Prometheus metrics at the /metrics endpoint:

- Cache hit/miss ratio
- Request latency metrics
