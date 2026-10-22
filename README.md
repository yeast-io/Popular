# Popular Movie AI Studio

Popular Movie AI Studio is a contract-first TypeScript monorepo. It contains a Fastify API, a Vue/Vite web app, validated configuration, remote infrastructure connectors, operational logging, email/password authentication backed by Redis sessions, and a cached TMDB weekly-trending experience.

## Workspace

```text
apps/
  api/src/
    config/                 environment parsing and validation
    infrastructure/
      health/ http/ logging/
      mongodb/ redis/ minio/
    modules/health/         liveness and readiness routes
  web/src/                  Vue application and web configuration
  docs/                     standalone static documentation linked to .archify
packages/
  contract/src/             runtime TypeBox schemas and derived TS types
```

HTTP DTOs belong in `packages/contract`. Mongoose types remain private to the API. Routes must call services, services must call stores, and future business modules should not import another module's Mongoose schema.

## Local commands

```bash
corepack pnpm install
cp .env.example .env
corepack pnpm dev
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
```

MongoDB, Redis and MinIO are remote dependencies. Fill in their values in `.env`; startup deliberately fails if required configuration is missing, a connection cannot be established, or the configured MinIO bucket does not exist. The application does not create a bucket because a typo must not silently create a second storage location.

## Static documentation

Run `pnpm docs:dev` and open http://127.0.0.1:5175. This standalone site has English and Simplified Chinese navigation and links to each `.archify/<project>/index.html`. It runs independently of the API and main web app, without login or environment page flags.

`pnpm docs:build` generates `apps/docs/dist`, which can be served by any static host. Rebuild after changing `.archify`. Only projects with an `index.html` are included; source snapshots under `evidence`, hidden files and symlinks are excluded. Existing diagram pages retain their own language controls. The main application's Docs navigation and `/api/v1/docs` endpoints have been removed.

## Code style

ESLint Stylistic owns JavaScript, TypeScript and Vue script formatting: two-space indentation, single quotes, semicolons and blank lines between class methods. TypeScript/Vue correctness checks, constructor layout and the project's schema/type boundaries remain enabled. The former custom callback formatter has been removed because it conflicted with Stylistic fixes.

```bash
pnpm lint       # Check code quality and formatting
pnpm lint:fix   # Apply supported automatic fixes
pnpm check      # Rule tests, lint and workspace type checks
```

Stylistic reports multiple statements on one line; this rule requires manual line breaks when no automatic fix is available. Constructor signatures longer than 120 characters (including indentation and `constructor(...) {`, excluding the body) expand to one parameter per line. Short multiline signatures automatically merge onto one line when safe; signatures containing comments or multiline parameter expressions retain their layout. Inline or multiline bodies are preserved. The final parameter has no trailing comma. Format fixes must converge: running `pnpm lint:fix` again should produce no further changes.

On Node 24, the current Vitest DOM environment may collide with Node's experimental Web Storage API. Run the web tests with the DOM implementation instead:

```bash
NODE_OPTIONS=--no-experimental-webstorage pnpm --filter @movie-hub/web test
```

## Health endpoints

- `GET /api/v1/health/live` reports process liveness and does not query dependencies.
- `GET /api/v1/health/ready` probes MongoDB, Redis and MinIO concurrently; it returns `503` when any dependency is down.

The API emits Apache Combined access lines to stdout after each response. Structured application errors go to stderr, with a full stack and request ID, while the client receives the shared sanitized error protocol.

## Authentication endpoints

- `POST /api/v1/auth/register` creates an email/password account and session.
- `POST /api/v1/auth/login` creates a new session.
- `GET /api/v1/auth/me` returns the current user.
- `POST /api/v1/auth/logout` revokes the current session.

Sessions are stored in Redis and referenced by an `HttpOnly`, `SameSite=Lax` cookie. Set `SESSION_TOKEN_PEPPER` to at least 32 random characters and enable `SESSION_COOKIE_SECURE` behind HTTPS.

## Weekly trending movies

Set `TMDB_READ_ACCESS_TOKEN`, then populate the first cached pages before serving the site:

```bash
corepack pnpm --filter @movie-hub/api build
corepack pnpm --filter @movie-hub/api sync:trending
```

- `GET /api/v1/movies/trending?page=1` reads only the last successfully published MongoDB result set.
- `POST /api/v1/movies/trending/load-more` accepts `{ "page": 1 }` and may fetch page 2 from TMDB when it is not cached.
- Movie rows are upserted before the ordered result set is published, so a failed refresh leaves the previous page available.
- Redis locks prevent duplicate manual syncs and duplicate on-demand page refreshes.

## Movie discovery flow

- `GET /api/v1/movies/search?query=...&page=1` searches TMDB and caches returned movie summaries.
- `GET /api/v1/movies/:tmdbId` returns persisted movie metadata, directors, and the first 20 billed cast members. Missing or seven-day-old details are refreshed from TMDB.
- `PUT /api/v1/me/movies/:tmdbId/status` marks a movie as `watched`, `interested`, or `not_interested`.
- `DELETE /api/v1/me/movies/:tmdbId/status` clears the saved status.
- `GET /api/v1/me/movies` returns the authenticated user's movie list and supports status filtering.

The web app implements search with 300 ms debounce and stale-request cancellation, optimistic status updates with rollback, a personal movie list, and logout. Google OAuth, password changes, and persistent scheduler leasing remain outside the implemented boundary.

## Movie locale migration

Existing single-language movie data is treated as `zh-CN`. Build the API, inspect the migration plan, and then run it:

```bash
corepack pnpm --filter @movie-hub/api build
corepack pnpm --filter @movie-hub/api migrate:movie-locales -- --dry-run
corepack pnpm --filter @movie-hub/api migrate:movie-locales
```

The migration moves localized fields into `movie_localizations`, retains language-independent fields in `movies`, and validates that user movie-state associations are unchanged. It uses insert-only localization upserts, so rerunning it is a no-op and cannot replace localization data subsequently written by the application. An invalid legacy movie or conflicting localization index aborts before legacy movie rows are modified.

Movie metadata is stored separately from people and movie credits. To deliberately rebuild only the movie catalog while retaining accounts and user movie states:

```bash
corepack pnpm --filter @movie-hub/api build
corepack pnpm --filter @movie-hub/api reset:movies
corepack pnpm --filter @movie-hub/api sync:trending
```
