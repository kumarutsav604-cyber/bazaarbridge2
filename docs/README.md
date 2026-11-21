# BazaarBridge Implementation & Operations Guide

## 1. Architecture Summary
- **Backend (`server.ts`, `/backend/src`)**: Node.js + Express serving `/api/*` and Vite SPA on port `3000`.
- **PostgreSQL (`/backend/src/db/schema.sql`)**: Authoritative ledger for catalog, dealers, multi-location inventory (`hub`, `warehouse`, `holding`, `quarantine`), atomic 10-minute `reservations`, split `fulfilment_groups`, `stock_transfers`, `outbox_events`, `processed_events`, and `refunds`.
- **Kafka (`/backend/src/events/`)**: Transactional outbox publisher and idempotent consumer groups (`inventory-finalizer`, `search-sync`, `fulfilment-pipeline`, `notifier`, `cancellation-handler`, `refund-credit`, `alert-watcher`).
- **OpenSearch (`/backend/src/search/index.ts`)**: `offers` index with typo-tolerant `fuzziness: "AUTO"` and `external_gte` revision synchronization (`offer_state_versions.revision`), rechecked against PostgreSQL before returning search results.

## 2. Environment Variables (`.env.example`)
| Variable | Required | Purpose |
|---|---|---|
| `PG_URI` | Core | Aiven PostgreSQL connection URI |
| `KAFKA_BROKERS` | Core | Comma-separated Aiven Kafka broker host:port |
| `KAFKA_SASL_USERNAME` / `KAFKA_SASL_PASSWORD` / `KAFKA_CA_CERT` | Core | Kafka SASL/SSL or mTLS credentials |
| `OPENSEARCH_URL` | Core | Aiven OpenSearch HTTPS endpoint (with credentials or `OPENSEARCH_USER`/`OPENSEARCH_PASS`) |
| `JWT_SECRET` | Core | JWT signing secret (`>= 16` chars recommended) |
| `OTP_HASH_SECRET` | Core | Dedicated HMAC secret for `otp_hash` & `otp_proof` |
| `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` | Seed | Admin credentials for seeding (`/admin-login` is never prefilled) |
| `GEMINI_API_KEY` | Optional | Enables Gemini structured filter extraction in Shopping Assistant |
| `FEATURE_FLAGS` | Optional | Comma-separated feature flags |

## 3. Commands
```bash
# Install dependencies
npm install

# Apply PostgreSQL schema & triggers
npm run db:migrate

# Seed catalog (40 products), dealers, Bangalore/Mysuru locations, and sample price history
npm run db:seed

# Run pure domain unit tests (fees, eta, comparison scoring, OTP HMAC, state machines)
npm run test:unit

# Run live integration test suite (requires Aiven PG + Kafka + OpenSearch)
npm run test:integration

# Build frontend & typecheck
npm run build
npm run lint

# Run secret safety check
bash scripts/check-secrets.sh
```

## 4. API Endpoints
- `GET /api/health` — Live readiness and Postgres/Kafka/OpenSearch connectivity + feature flags
- `POST /api/auth/login`, `GET /api/auth/me` — JWT authentication (`12h`)
- `GET /api/products`, `GET /api/products/:id`, `GET /api/products/:id/offers?category=...`
- `GET /api/products/:id/price-history`, `GET /api/products/:id/related`, `GET /api/products/compare`
- `GET /api/outside-bangalore` — Returns `{ section_a, section_b }`
- `GET /api/search`, `GET /api/search/filters`
- `GET /api/cart`, `POST /api/cart/items`, `DELETE /api/cart/items/:cartItemId`, `POST /api/cart/reserve`, `POST /api/cart/release`
- `POST /api/cart/items/:id/save-for-later`, `POST /api/cart/items/:id/restore`
- `POST /api/check-pin`, `POST /api/orders`, `GET /api/orders`, `GET /api/orders/:id`, `POST /api/orders/:id/items/:orderItemId/cancel`
- `POST /api/simulator/fire-event` (Admin), `POST /api/admin/refunds/:id/credit` (Admin), `POST /api/admin/hubs/:id/status` (Admin), `GET /api/admin/live-proof` (Admin)
- `GET /api/notifications`, `POST /api/notifications/:id/read`, `POST /api/wishlist/toggle`, `GET /api/wishlist`, `GET /api/recently-viewed`, `GET/POST/DELETE /api/addresses`, `POST /api/coupons/validate`, `POST /api/alerts/subscribe`, `POST /api/shopping-assistant`

## 5. Built vs Simulated Matrix
| Capability | Implementation Status | Source of Truth / Labelling |
|---|---|---|
| Product catalog, dealer offers, 5-category offer ranking | **Built (Real)** | PostgreSQL + SQL ranking queries |
| Typo-tolerant product search & revision sync | **Built (Real)** | OpenSearch (`external_gte`) + PostgreSQL recheck |
| 10-minute atomic inventory reservation & concurrency guard | **Built (Real)** | PostgreSQL `reserve_offer()` + `SERIALIZABLE`/`FOR UPDATE` |
| Transactional Outbox + Kafka consumer pipeline | **Built (Real)** | `outbox_events` -> Kafka -> `processed_events` |
| Order placement, group splitting, item-level Path A cancel & transfer T1–T4 | **Built (Real)** | PostgreSQL transactions + Kafka handlers |
| Payment gateway & Refund gateway payout | **Simulated** | Labelled `SIMULATED SANDBOX GATEWAY`; PG ledger & caps are real |
| Fulfilment stages, rider dispatch & hub status events | **Simulated / Triggered** | Driven via Admin Simulator console into real Kafka pipeline |
| Delivery OTP verification & Demo OTP | **Built crypto + SAMPLE demo UX** | `otp_proof = HMAC(secret, "hash:" + code)`; raw OTP never in outbox/Kafka/logs |
| Seeded dealers, hubs, stock quantities, fees, 30d price history | **Sample Data** | Labelled `SAMPLE` in UI and API payloads |
| Auxiliary operations screens (Picker/Rider/Reviews/Support) | **Simulated Preview** | Wrapped in `<SimulatedWrapper>` with `FEATURE_SIM_SCREENS` |

## 6. Default Feature Flags
`FEATURE_WISHLIST`, `FEATURE_RECENTLY_VIEWED`, `FEATURE_COUPONS`, `FEATURE_SAVE_LATER`, `FEATURE_COMPARE`, `FEATURE_ALERTS`, `FEATURE_ADDRESSES`, `FEATURE_ASSISTANT`, `FEATURE_SIM_SCREENS` (all enabled by default; overridable via `FEATURE_FLAGS` env var).

## 7. Not Attempted (Deliberately Out of Scope)
- Real payment card / UPI gateway integration or real bank payouts.
- Real-time GPS rider coordinate streaming or live courier map tracking.
- SMS / Email / Push notification delivery providers (in-app notifications table only).
- Post-delivery return pickup / reverse-logistics Path B inspection workflow.
- Full multi-dealer self-serve seller onboarding portal.
