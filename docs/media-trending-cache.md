# Movie and TV homepage caches

Both weekly trending homepages use Redis cache-aside lists scoped by media type and resolved locale. `MEDIA_TRENDING_CACHE_TTL_SECONDS=900` sets the default 15-minute lifetime. Expiry deletes the list; the next first-page request fetches TMDB. No scheduled warming or `sync:trending` command is needed.

Redis holds ordered IDs, fetched time, generation, pagination progress and expiry. MongoDB keeps existing movie/TV content and localization records and continues the current summary upsert behavior. Summaries are saved before Redis publication. User states are applied per request, never shared in Redis.

All pages in a generation share a fixed expiry. Loading more does not renew it. Expired versions return `MEDIA_TRENDING_EXPIRED`; the web UI offers a retry from the first page. Overlapping source pages are deduplicated in source order and overflow IDs are retained for subsequent pages. Distributed locks and ownership-checked publication prevent duplicate refreshes and late publication after a lease expires.

Expired lists are not served on TMDB failure. Existing content remains in MongoDB, and a later request can retry. Redis failures do not fall back to the obsolete MongoDB list cache. Errors retain causes and stages. Set `VERBOSE=true` to enable diagnostic stages (also subject to `LOG_LEVEL`); errors remain logged when verbose mode is off.

The old MongoDB trending state/result records are no longer read or updated. No historical collections or records are deleted by this change. Movie search result caching remains separate and unchanged.

The catalog reset command remains a separate destructive maintenance operation; it is not part of deploying this change.
