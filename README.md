# Pitman

[![CI](https://github.com/bixihq/pitman/actions/workflows/ci.yml/badge.svg)](https://github.com/bixihq/pitman/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/bixihq/pitman)](https://github.com/bixihq/pitman/releases/latest)

**Project-native HTTP client for VS Code.** API collections live inside project in plain JSON files which can be committed, reviewed, and shared like any other code.

No account. No cloud.

---

## Why Pitman

Most HTTP clients store requests in the cloud or in a proprietary binary format. Pitman stores everything in a `.http/` folder next to existing code:

- **Commit requests with code.** Collections are readable JSON. Can be `diff`ed, reviewed in PRs, rolled back with git.
- **Keep secrets local.** Private environment files (tokens, API keys) are `.gitignor`ed by default.
- **No account required.** Not even to get started.

---

## Getting started

> Pre-built `.vsix` binaries are available on the [Releases](https://github.com/bixihq/pitman/releases) page. Download the latest `.vsix` and install it via **Extensions panel → ··· → Install from VSIX…** or:
>
> ```sh
>  code --install-extension pitman-<version>.vsix
>  ```

Then, click the **Pitman icon** in the Activity Bar, or open the Command Palette and run **Pitman: Open**.

Pitman creates a `.http/` directory in workspace and opens the request editor. If no workspace folder is open, it falls back to VS Code's global storage and points out where.

The default collection ships with one request — send it to confirm everything is working.

---

## The request editor

The editor is split into two panes.

### Left pane — request editor

| Tab     | What to edit                                      |
| ------- | ------------------------------------------------- |
| Params  | Query parameters                                  |
| Headers | Request headers                                   |
| Auth    | None / Bearer Token / Basic / API Key             |
| Body    | None / JSON / Text / Form URL-encoded / Multipart |
| Docs    | Freeform markdown notes for the request           |

### Right pane — response viewer

The response panel appears after the first request is sent and can be closed at any time.

| Tab     | Meaning                                                                                                   |
| ------- | --------------------------------------------------------------------------------------------------------- |
| Preview | Smart preview: JSON with syntax highlighting, HTML in a sandboxed iframe, XML formatted, plain text as-is |
| Raw     | Exact response body                                                                                       |
| Headers | Request headers sent and response headers received, in separate sections                                  |
| Timing  | Status, duration, size, content-type — plus chain step timings when chaining is used                      |
| Tests   | Assertion results (coming soon)                                                                           |
| History | 10 most recent entries for this request                                                                   |

### Sending a request

Select a collection, a request, and an environment. Edit the method and URL. Click **Send**.

Variables in URLs, headers, params, auth fields, and bodies are resolved from the active environment before the request is sent.

### Managing requests

| Button   | What it does                                      |
| -------- | ------------------------------------------------- |
| **New**  | Create a blank request in the active collection   |
| **Dup**  | Duplicate the active request                      |
| **Del**  | Delete the active request (requires confirmation) |
| **Save** | Save edits to the collection file                 |

An orange **●** dot appears next to the request name when there are unsaved changes. Switching requests or collections while dirty asks for confirmation first.

### Body types

| Type             | Notes                                                                                                        |
| ---------------- | ------------------------------------------------------------------------------------------------------------ |
| JSON             | Textarea with one-click pretty-print and inline validation                                                   |
| Text             | Plain textarea                                                                                               |
| Form URL-encoded | Key / value table                                                                                            |
| Multipart        | Mixed text and file fields. File paths are stored; contents are read at send time and never written to disk. |

---

## Collections

Collections are JSON files in `.http/collections/`. Each collection has its own set of associated environments.

```json
{
  "name": "Example API",
  "environments": ["local", "staging"],
  "requests": [...]
}
```

### Collection Manager

Open with the **Manage** button next to the Collection dropdown.

- Create, rename, duplicate, or delete collections
- Open the raw JSON file directly in VS Code
- Renaming moves the file to a new slug (`Example API` → `example-api.json`)
- Deleting is permanent and requires confirmation

---

## Environments

Environments hold the variables that are substituted into requests — base URLs, API keys, feature flags. Each environment is scoped to the collection it was created in.

### Public and private variables

Each logical environment is backed by two optional files:

| File                     | Committed? | Purpose                               |
| ------------------------ | ---------- | ------------------------------------- |
| `local.env.json`         | Yes        | Shared variables safe to commit       |
| `local.private.env.json` | No         | Secrets — tokens, passwords, API keys |

When both files exist, private variables are merged on top of public ones. Conflicts resolve in favour of private. The environment dropdown shows one entry (`local`) — the split is transparent.

### Using variables

Use `{{variableName}}` anywhere in a URL, header, param, auth field, or body:

```text
{{baseUrl}}/orders/{{orderId}}
```

With `baseUrl = https://api.example.com/api/v1` and `orderId = 42` this resolves to:

```text
https://api.example.com/api/v1/orders/42
```

### Environment Manager

Open with the **Manage** button next to the Environment dropdown.

- Create, rename, or delete environments
- Edit public variables in a plain key/value table
- Edit private variables in a masked key/value table
- Remove an environment from a collection without deleting the files
- Associate an existing environment with a collection
- Open either environment file directly in VS Code
- Private env files are created automatically when saved in private variables

### TLS and localhost

Set `verifyTls` to `false` in Settings (or directly in `settings.json`) when working against a server with a self-signed certificate. TLS control is per-request and does not affect the rest of VS Code.

---

## Request chaining

Pitman can run one request automatically as a dependency of another. Values extracted from the upstream response — body fields, headers, cookies — are substituted into the dependent request before it is sent.

This is useful whenever one request needs session data, a token, or any other value that only exists after a previous request has run.

### Syntax

Use `{{req(Name).accessor}}` anywhere that `{{variableName}}` is accepted — URLs, headers, params, auth fields, bodies.

| Expression                                             | What it extracts                                  |
| ------------------------------------------------------ | ------------------------------------------------- |
| `{{req(Login).body.session}}`                          | Top-level field from a JSON response body         |
| `{{req(Login).body.players.0.id}}`                     | Nested / array path (dot notation, zero-indexed)  |
| `{{req(Login).cookie(session)}}`                       | Named cookie value from `Set-Cookie`, URL-decoded |
| `{{req(Login).header(x-request-id)}}`                  | Any response header                               |
| `{{req(Login).header(set-cookie).match(token=[^;]+)}}` | First regex match on a header value               |
| `{{req(Login).status}}`                                | HTTP status code as a string                      |

### How it works

When **Send** is clicked, Pitman:

1. Scans all fields of the current request for `{{req(...)...}}` expressions.
2. Runs each referenced upstream request (recursively resolving its own dependencies first).
3. Caches each upstream response — if two requests in the same chain both depend on Login, Login runs once.
4. Substitutes the extracted values into the current request's fields.
5. Sends the current request with the fully resolved values.

Upstream responses are never written to disk or to the environment. They exist only for the duration of that Send operation.

### Example

A `Project` request that depends on `Login`:

#### Body

```json
{
  "session": "{{req(Login).body.session}}"
}
```

#### Headers

```text
Cookie: {{req(Login).cookie(session)}}
```

Clicking Send runs `Login` first, extracts `session` from the response body and `session` from the `Set-Cookie` header, substitutes both into `Project`, then sends it.

### Transitive chains

If `Task` depends on `Project` which depends on `Login`, all three run in the correct order automatically. Circular dependencies are detected before any request is sent and reported as a clear error.

### Chain vs environment variables

|                           | Chain expressions                           | Environment variables                     |
| ------------------------- | ------------------------------------------- | ----------------------------------------- |
| Stored on disk            | No                                          | Yes (`.env.json`)                         |
| Available across sessions | No                                          | Yes                                       |
| Refreshed every Send      | Yes                                         | No                                        |
| Good for                  | Session tokens, one-time codes, dynamic IDs | Base URLs, static API keys, shared config |

---

## Activity Bar sidebar

The Pitman icon in the Activity Bar opens a lightweight navigator showing:

- Collections and their requests
- Environments
- Recent request history

Clicking a request opens the editor and selects that collection, request, and the first associated environment. Clicking an environment selects it in the active editor.

---

## History

Every sent request is recorded in `.http/history/history.jsonl`. The file is gitignored.

Open the **History** panel from the toolbar button to:

- Browse all past requests, newest first
- Filter by HTTP status class (2xx / 3xx / 4xx / 5xx) or URL text
- Inspect request headers, response headers, status, timing, and a body preview
- Re-run any entry
- Clear history (requires confirmation)

The **History** tab in the response panel shows the 10 most recent entries for the currently selected request.

### What is stored and what is redacted

| Data                                | Stored?                                                     |
| ----------------------------------- | ----------------------------------------------------------- |
| Request method and resolved URL     | Yes                                                         |
| Request headers                     | Yes, with sensitive headers replaced by `[redacted]`        |
| Response status and headers         | Yes, with sensitive headers replaced by `[redacted]`        |
| Response body                       | First `historyBodyPreviewLimit` characters (default 20 000) |
| Multipart file contents             | No — only the file path                                     |
| Chain step responses                | No — upstream responses are ephemeral                       |
| Private environment variable values | No — resolved at send time only                             |

Sensitive headers are configured in `settings.json` under `redactHeaders`. Default list: `authorization`, `cookie`, `set-cookie`, `x-api-key`.

---

## Settings

Click **⚙** in the toolbar. Changes are saved to `.http/settings.json`.

| Setting                   | Default     | Description                                             |
| ------------------------- | ----------- | ------------------------------------------------------- |
| `defaultCollection`       | `"default"` | Collection selected when the editor opens               |
| `defaultEnvironment`      | `"local"`   | Environment selected when the editor opens              |
| `timeoutMs`               | `30000`     | Request timeout in milliseconds                         |
| `followRedirects`         | `true`      | Follow HTTP 3xx redirects automatically                 |
| `verifyTls`               | `true`      | Verify TLS certificates (`false` for self-signed certs) |
| `historyBodyPreviewLimit` | `20000`     | Maximum characters of response body stored in history   |
| `redactHeaders`           | see above   | Header names stored as `[redacted]` in history          |

Unknown keys already present in `settings.json` are preserved when saving through the UI.

---

## `.http` directory structure

```text
.http/
  collections/
    default.json            # Committed

  environments/
    .gitignore              # Ignores *.private.env.json automatically
    local.env.json          # Committed — shared base URL, feature flags
    local.private.env.json  # Gitignored — tokens, passwords, secrets

  history/
    .gitignore              # Ignores everything in history/
    history.jsonl           # Gitignored — local request log

  settings.json             # Committed — project-level Pitman config
```

Pitman writes its own `.gitignore` files inside `.http/`. No need to touch the root `.gitignore`.

---

## Development

### Prerequisites

Checkout this repository, then:

```sh
npm install
```

### Run in development

```sh
npm run watch        # esbuild watch and tsc type-check in parallel
```

Press **F5** in VS Code to launch the Extension Development Host with the extension loaded. Open any project folder, then click the Pitman icon or run **Pitman: Open** from the Command Palette.

Extension-host logs appear in **View → Output → Pitman**.

### Build and install a VSIX

This flow is used when needed to test the packaged extension as a real install rather than in the development host.

**One-time build:**

```sh
npm run package      # production bundle
npm run vsix         # produces pitman-<version>.vsix
```

**Install the VSIX:**

```sh
code --install-extension pitman-<version>.vsix
```

Or via the UI: **Extensions panel → ··· menu → Install from VSIX…** → select the file → reload VS Code.

#### Iterate on a change (no git tag)

```sh
npm run bump     # bump patch version, no git tag
npm run package
npm run vsix
code --install-extension pitman-<version>.vsix --force
```

#### Release a version (with git tag)

```sh
npm run release  # bump patch version and creates a git tag
npm run package
npm run vsix
code --install-extension pitman-<version>.vsix --force
```

### Tests

```sh
npm test
```

Requires VS Code to be installed — the test runner launches a real extension host. The suite covers:

- Pure logic: `slugify`, `uniqueRequestId`, `resolveVariables`, `isSensitiveHeader`, `redactHeaders`, `generateHistoryId`
- Collection CRUD (create, rename, duplicate, delete)
- Request CRUD (create, save, duplicate, delete)
- Environment CRUD with public/private file splitting and merge semantics
- Settings persistence and unknown-key preservation
- History append, newest-first load, and clear
- Chain expression parsing, value extraction, dependency collection, cycle detection
