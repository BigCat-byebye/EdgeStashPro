# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

EdgeStash is a single-file Cloudflare Worker that implements a full-featured cloud drive (网盘). The entire application — backend logic, routing, and four embedded HTML pages — lives in `worker.js` (~6600 lines).

## Deployment

No build step. Deploy by pasting `worker.js` into the Cloudflare Dashboard Worker editor, or via `wrangler deploy` with a manually created `wrangler.toml`.

Required Cloudflare bindings:
- `R2_BUCKET` — file storage
- `KV_STORE` — directory cache, user accounts, OTP state
- `D1_DB` — search index, favorites, recent items, share links, stats

Required environment variable: `ADMIN_PASSWORD` (also used as the JWT signing secret — changing it invalidates all sessions).

## Architecture

All code is in `worker.js`, organized in this order:

1. **Utilities** — JWT, TOTP/OTP, SHA-256 hashing, path normalization, ZIP generation, MIME types
2. **Auth** — `handleLogin`, `handleLogout`, `verifyAuth`, `requireAdmin`
3. **File handlers** — list, upload, delete, rename, copy/move, batch ops, batch ZIP download
4. **Share handlers** — create, view, download (with optional password)
5. **Admin handlers** — stats, share management, user management
6. **D1 handlers** — search index rebuild, favorites, recent visits, schema init
7. **Embedded HTML pages** — `FIXED_LOGIN_PAGE`, `FIXED_INDEX_PAGE`, `FIXED_ADMIN_PAGE`, `FIXED_SHARE_PAGE` as template literal strings
8. **`fetch` export** — single entry point that routes all requests

## Key Behaviors

- Directory listings are KV-cached under `cache:dir:<path>`; cache is invalidated on any write operation.
- The D1 search index must be manually rebuilt via the admin "刷新" button or `?refresh=1`.
- Legacy KV-based share data is lazily migrated to D1 on first admin access.
- Frontend dependencies (PicoCSS, marked, mammoth) are loaded from CDN only in `FIXED_INDEX_PAGE`. QR codes are generated natively via Canvas.
