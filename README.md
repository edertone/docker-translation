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

**Library naming:** Library names must match `[a-z0-9][a-z0-9-]*` — lowercase letters, digits, and hyphens only. Must begin with a letter or digit.

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
| New keys added | MINOR |
| Wording fixes only | PATCH |

---

## 4. Translation Format

### 4.1 Keys

Flat dot-notation strings stored as **top-level YAML keys** (no nesting):

```yaml
login: "Login"
sign.in: "Sign in"
```

### 4.2 Placeholders

Use ICU MessageFormat syntax. Placeholders must be consistent across all locales for a given key:

```yaml
hello.username: "Hello {name}"
user.unread: "{count, plural, one {# message} other {# messages}}"
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
| `fallback_by_priority` | Replace missing value with the first match down the priority list |
| `return_key` | Replace missing value with the raw key name (e.g. `"login.title"`) |
| `return_empty` | Replace missing value with `""` |

The **first entry** in `locale_priority` is the primary locale. Its keys define the master key set. Non-primary locales must not contain keys absent from the primary locale — orphan keys will cause the version to be rejected at upload time.

---

## 6. Validation

Runs at **container startup** (for all already-stored library versions) and on each **upload API call** (for the incoming version only). A failed check logs a CRITICAL error and prevents the version from loading. **No validation occurs at request time.**

| Check | Always | Only when `on_missing_translation: error` |
| --- | --- | --- |
| YAML 1.2 strict syntax (prevents boolean casting of `no`, `true`) | ✓ | |
| Flat dot-notation key format | ✓ | |
| Placeholder consistency across locales | ✓ | |
| No orphan keys in non-primary locales | ✓ | |
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

Uploads one or more versioned libraries to the service. The request body must include a `file` field containing a `.zip` archive. The zip must mirror the storage structure defined in [Section 2](#2-storage-structure)

A zip may contain multiple library versions. Each library+version is validated and stored as an independent unit but if one fails, all the zip file fails and nothing is imported.

If all libraries can be imported, a standard 200 response is given.

If the request itself is malformed (missing `file` field, invalid zip), a `400 Bad Request` is returned using the [standard error response](#77-error-responses).

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
| `android` | `.xml`, `.kt`, `.properties` | `.kt` targets Jetpack Compose (type-safe string accessors) |
| `ios` | `.strings`, `.xcstrings` | |
| `json` | `.json` | |
| `icu` | `.json` | |
| `gettext` | `.po` | |

---

### 7.4 Catalog

Returns a human-readable HTML page listing all stored libraries, their published versions, and for each version: the available sections and supported locales. It also gives information about missing keys or inconsistent state.

```sh
GET /api/v1/catalog
```

**Response:** `Content-Type: text/html`, `200 OK`

---

### 7.5 Health & Readiness

Used by orchestrators (Kubernetes, ECS, etc.) to determine whether the service is ready to handle traffic. The endpoint becomes available immediately at container start; its status reflects the current startup validation phase.

```sh
GET /api/v1/health
```

| Status | HTTP Code | Condition |
| --- | --- | --- |
| `ok` | `200 OK` | Startup validation complete — service is ready |
| `starting` | `503 Service Unavailable` | Startup validation still in progress |
| `error` | `503 Service Unavailable` | A critical failure occurred during startup |

---

### 7.6 Caching & Response

Responses are **lazily cached in-memory and on disk** within the container. On first request:

1. Load YAML sources for the requested library/version/section
2. Apply fallback strategy if needed
3. Cache the transformed result and return

The cache is persisted to disk but requires no external docker volume. It will be reloaded lazily into memory from disk after container restarts. Because source data is immutable, cached entries never expire. HTTP responses include aggressive headers to leverage browser and CDN caching:

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
| `404` | `NOT_FOUND` | Library, version, section, or locale not found |
| `500` | `INTERNAL_ERROR` | Internal transformation failure |

---

## 8. Observability

The service emits:

- Request latency metrics
- Cache hit/miss ratio
- Artifact generation count
- Validation failures (ingestion)
- Missing translation warnings (when any fallback mode is active)
