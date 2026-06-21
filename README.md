# Translation Microservice Specification

The Translation Microservice is a containerized service that provides a centralized, versioned source of truth for software translations. It exposes an API that allows clients to retrieve localized text in multiple formats for different platforms (e.g. Android, iOS, Web, backend systems).

Its primary goal is to provide an independent lifecycle for translations. While translation sets are developed and versioned independently, applications bind to specific, immutable versions to guarantee absolute runtime determinism.

---

## 1. Core Principles

- **Single Source of Truth**: All translations are stored in a canonical format.
- **Versioned Contracts**: Translation sets are immutable once published.
- **Format Agnostic Output**: Translations can be transformed into multiple runtime formats.
- **Library-oriented**: Translations can be organized in multiple independent libraries.
- **Deterministic Output**: Same input always produces identical output.

---

## 2. Features

- Stores all translations in a structured, versioned repository.
- Uses YAML as the canonical source format.
- Supports multiple libraries (domain-based grouping of translations).
- Supports semantic versioning per library.
- Allows runtime conversion to multiple output formats:
  - Android (XML / Compose / properties)
  - iOS (.strings / xcstrings)
  - JSON
  - ICU MessageFormat bundles
  - Gettext (PO/MO)
- Provides caching of generated artifacts to improve performance.
- Allows adding new translation versions without affecting existing consumers.
- Provides validation of translation structure and completeness.

---

## 3. Source Translation Storage Model

Translations are stored in a Docker volume using the following structure:

<docker_volume>/library-name/version/config.yaml
<docker_volume>/library-name/version/section/locale.yaml

Where:

- **config.yaml**: A mandatory configuration file defining library-version specific behaviors (like fallback strategies).
- **library-name**: A logical grouping of translations for a product or domain (e.g. `users`, `billing`, `notifications`).
- **version**: Semantic version of the translation contract (e.g. `1.0.0`, `2.1.0`).
  - Versions are **immutable once published**
  - Breaking changes require a major version bump
  - Each version represents a stable contract
- **section**: A functional grouping inside a library (e.g. `login`, `profile`, `checkout`).
- **locale.yaml**: A YAML file containing translations for a single locale (e.g. `ca-ES.yaml`, `en-US.yaml`).

Examples:

- users/1.0.0/config.yaml
- users/1.0.0/login/en-US.yaml
- users/1.0.0/login/es-ES.yaml

---

## 4. Canonical Translation Format

### 4.1 Key format

Keys are **flat strings (recommended)** using dot notation:

```yaml
login: "Login"
sign.in: "Sign in"
```

### 4.2 Character encoding

All files MUST be UTF-8 encoded (without BOM recommended).
Unicode characters are fully supported.

### 4.3 Placeholders

Must use ICU MessageFormat syntax:

```yaml
hello.username: "Hello {name}"
user.unread: "{count, plural, one {1 message} other {{count} messages}}"
```

### 4.4 Rules

- Keys must be stable across versions unless the major version is bumped.
- Placeholders must be consistent across all locales.

---

## 5. Missing Translations & Fallback Strategy

The microservice will combine missing locales by using a chain of translation priority. The behavior for handling missing translations is defined by the `config.yaml` file located at the root of each **versioned** directory.

### 5.1 Configuration Format (`config.yaml`)

The `config.yaml` file and its properties are **mandatory**. If the file is missing or malformed, the microservice will refuse to load the version.

```yaml
locale_priority: # The first item acts as the primary master list of keys. Next ones are the fallback order used to compile the final keys
  - "en-US"
  - "es-ES"
  - "ca-ES" 
on_missing_translation: "error" # Options: error, return_key, return_empty, fallback_by_priority
```

### 5.2 Behavior Modes (`on_missing_translation`)

To determine if a key is missing, the microservice compares the requested locale against the master list of keys defined by the first locale in the locale_priority list.

- **`error`**: The ingestion phase will fail completely if any locale is missing keys present in the primary locale (the first item in locale_priority). The version will refuse to load.
- **`fallback_by_priority`**: The missing value is replaced by traversing down the locale_priority list and using the first available value it finds.
- **`return_key`**: The missing value is replaced with the raw key name (e.g., `"login.title"`).
- **`return_empty`**: The missing value is replaced with an empty string `""`.

---

## 6. API Specification

### 6.1 Base URL

`/api/v1`

(API version is independent from translation library versions)

### 6.2 Retrieve translations

`GET /api/v1/{library}/{version}/{section}/{format}/{locale}.{format-extension}`

- **library**: The library name
- **version**: A valid semver value
- **section**: The section name
- **format**: output format (json, properties, android, ios, icu, gettext)
- **locale**: The language to obtain: `en-US`, `es-ES` ...
- **format-extension**: The file extension as expected by the requested format (Must be correctly defined or an error will happen)

**Example:**

`GET /api/v1/users/1.0.0/login/android/en-US.xml`

### 6.3 Response behavior

Responses are lazy-cached. If previously requested and cached, data is directly returned. If not cached:

- Load YAML source files
- Transform to requested format (applying fallback strategies if necessary)
- Store into cache
- Return response

---

## 7. Caching Strategy

- In-memory cache, with disk storage to avoid losing performance between container reboots.
- Cached values never expire, because the source data is versioned and immutable.
- API responses include aggressive HTTP Cache-Control headers (e.g., `Cache-Control: public, max-age=31536000, immutable`) to leverage browser and CDN caching.

---

## 8. Validation & Lifecycle Rules

To ensure high availability and prevent runtime crashes, **validation is strictly separated from retrieval.**

**Startup / Ingestion Phase:**

When the container starts (or when a new version directory is added to the volume), the service parses all YAML files and performs:

- YAML 1.2 strict syntax validation (preventing boolean casting of strings like 'no').
- Key format validation (ensuring flat dot-notation).
- Placeholder consistency validation across all locales in a library.
- **Completeness Validation**: If `on_missing_translation` is set to `error`, validates that all locales contain 100% of the keys present in the primary locale (the first item in `locale_priority`).

*If validation fails, the service logs a CRITICAL error and refuses to load the bad version into memory.*

**Request Phase (Runtime):**

- No validation is performed on read.
- The requested translation is fetched, transformed, and cached instantly.

---

## 9. Versioning Rules

Uses Semantic Versioning (MAJOR.MINOR.PATCH):

- **MAJOR**: Breaking changes (removed keys, renamed keys, changed placeholders)
- **MINOR**: Added translations, Non-breaking extensions
- **PATCH**: Fixes in wording only (no structural change)

---

## 10. Error Handling

- **404 Not Found**: Library/version/section/locale does not exist.
- **400 Bad Request**: Unsupported format or extension combination.
- **500 Internal Server Error**: Internal transformation failure (e.g., corrupted internal cache).

*(Note: Data validation errors are caught during CI/CD or container boot, not at request time).*

---

## 11. Observability

The service logs:

- Request latency metrics
- Cache hit/miss ratio
- Number of generated artifacts
- Validation failures during ingestion
- Missing translation reports (Warnings logged during ingestion if fallback modes are utilized)