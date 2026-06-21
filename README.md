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

Translations are stored in a Docker volume:

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

Required at the root of each versioned library. A missing or malformed file causes the version to be rejected at load time.

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
| `error` | Reject the version at load time if any locale is missing keys from the primary locale |
| `fallback_by_priority` | Replace missing value with the first match down the priority list |
| `return_key` | Replace missing value with the raw key name (e.g. `"login.title"`) |
| `return_empty` | Replace missing value with `""` |

The **first entry** in `locale_priority` is the primary locale. Its keys define the master key set. Non-primary locales must not contain keys absent from the primary locale (orphan keys will cause error).

---

## 6. Validation

Runs at container start and whenever a new version is detected to ensure high availability and prevent runtime crashes. A failed check logs a CRITICAL error and prevents the version from loading. **No validation occurs at request time.**

| Check | Always | Only when `on_missing_translation: error` |
| --- | --- | --- |
| YAML 1.2 strict syntax (prevents boolean casting of 'no', 'true') | ✓ | |
| Flat dot-notation key format | ✓ | |
| Placeholder consistency across locales | ✓ | |
| No orphan keys in non-primary locales | ✓ | |
| 100% key completeness across all locales | | ✓ |

---

## 7. API

### 7.1 Base URL

`/api/v1` *(independent from library versions)*

### 7.2 Retrieve Translations

```sh
# Get the translations (with the required format) for a specific locale from a section of a library version
GET /api/v1/{library}/{version}/{format}/{locale}/{section}.{extension}

# Get the translations (with the required format) for a specific locale from N sections of a library version
GET /api/v1/{library}/{version}/{format}/{locale}/{section1+...+sectionN}.{extension}

# Get the translations (with the required format) for a specific locale from a whole library version
GET /api/v1/{library}/{version}/{format}/{locale}.{extension}
```

**Examples:**

```sh

# Get an android XML file with all the english translations from the login section of the users library v1.0.0
`GET /api/v1/users/1.0.0/android/en-US/login.xml`

# Get an android XML file with all the english translations from the login and checkout sections of the users library v1.0.0
`GET /api/v1/users/1.0.0/android/en-US/login+checkout.xml`

# Get an android XML file with all the english translations from all the sections of the users library v1.0.0
`GET /api/v1/users/1.0.0/android/en-US.xml`
```

**Supported formats and extensions:**

| `format` | Valid `ext` |
| --- | --- |
| `android` | `.xml`, `.kt (for Compose)`, `.properties` |
| `ios` | `.strings`, `.xcstrings` |
| `json` | `.json` |
| `icu` | `.json` |
| `gettext` | `.po`, `.mo` |

### 7.3 Caching & Response

Responses are lazy-cached (in-memory, persisted to disk to avoid losing performance between container reboots). On first request:

1. Load YAML sources
2. Apply fallback strategy if needed
3. Cache result and return

Because source data is immutable, cached entries never expire. HTTP responses include aggressive headers to leverage browser and CDN caching:

```text
Cache-Control: public, max-age=31536000, immutable
```

### 7.4 Error Codes

| Code | Meaning |
| --- | --- |
| `404` | Library, version, section, or locale not found |
| `400` | Unsupported format/extension combination |
| `500` | Internal transformation failure |

---

## 8. Observability

The service emits:

- Request latency metrics
- Cache hit/miss ratio
- Artifact generation count
- Validation failures (ingestion)
- Missing translation warnings (when any fallback mode is active)
