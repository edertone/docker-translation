# Translation Microservice Specification

The Translation Microservice is a containerized service that provides a centralized, versioned source of truth for software translations. It exposes an API that allows clients to retrieve localized text in multiple formats for different platforms (e.g. Android, iOS, Web, backend systems).

Its primary goal is to ensure translations are **consistent, versioned, and decoupled from application releases**, while allowing safe evolution without breaking existing consumers.

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

<docker_volume>/library-name/version/section/locale.yaml

Where:

- **library-name**: A logical grouping of translations for a product or domain (e.g. `users`, `billing`, `notifications`).
- **version**: Semantic version of the translation contract (e.g. `1.0.0`, `2.1.0`).
  - Versions are **immutable once published**
  - Breaking changes require a major version bump
  - Each version represents a stable contract
- **section**: A functional grouping inside a library (e.g. `login`, `profile`, `checkout`).
- **locale.yaml**: A YAML file containing translations for a single locale (e.g. `ca_ES.yaml`, `en_US.yaml`).

Examples:

- users/1.0.0/login/en_US.yaml
- users/1.0.0/login/es_ES.yaml

---

## 4. Canonical Translation Format

### 4.1 Key format

Keys are **flat strings (recommended)** using dot notation:

```yaml
login: "Login"
sign.in: "Sign in"
```

### 4.2 Character encoding

All files MUST be UTF-8 encoded (without BOM recommended)
Unicode characters are fully supported

### 4.3 Placeholders

Must use ICU MessageFormat syntax:

```yaml
hello.username: "Hello {name}"
user.unread: "{count, plural, one {1 message} other {{count} messages}}"
```

### 4.4 Rules

Keys must be stable across versions unless version is bumped
Missing translations behaviour will depend on microservice setup (error, find next language based on a priority or print a predefined text)
Placeholders must be consistent across all locales

## 5. API Specification

### 5.1 Base URL

/api/v1

(API version is independent from translation library versions)

### 5.2 Retrieve translations

GET /api/v1/{library}/{version}/{section}/{format}/{locale}.{format-extension}

Query parameters:

format (required): output format (json, properties, android, ios, icu, gettext)

Example:

GET /api/v1/users/1.0.0/login/android/en_US.json

### 5.3 Response behavior

Responses are lazy cached. if previously requested and cached, data is directly returned. If not cached:

- Load YAML source files
- Validate schema
- Transform to requested format
- Store into cache
- Return response

## 6. Caching Strategy

- In memory cache, with disk storage to avoid losing performance between container reboots
- Cached values never expire, cause the source data is versioned and inmutable.
- Agressive setup so browsers only will download the resources the first time.

## 7. Validation Rules

Before serving any translation (only if the requested value is not already cached):

- YAML syntax validation
- Required keys validation
- Placeholder consistency validation across locales
- Missing translation detection

## 8. Versioning Rules

Uses Semantic Versioning (MAJOR.MINOR.PATCH):

- MAJOR: Breaking changes (removed keys, renamed keys, changed placeholders)
- MINOR: Added translations, Non-breaking extensions
- PATCH: Fixes in wording only (no structural change)

## 9. Error Handling

- 404: Library/version/section/locale not found
- 422: Invalid YAML or validation failure
- 400: Invalid request parameters
- 500: Internal transformation failure

## 10. Observability

The service logs:

- Request latency metrics
- Cache hit/miss ratio
- Number of generated artifacts
- Validation failures
- Missing translation reports
