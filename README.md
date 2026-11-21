# BazaarBridge — Multi-Dealer E-Commerce Marketplace & Hybrid Inventory Platform

BazaarBridge connects shoppers with verified local and regional dealers using:
- **Aiven PostgreSQL** as the authoritative system of record (`bigint` paise money, `reserve_offer` concurrency protection, `processed_events` idempotency, transactional `outbox_events`).
- **Aiven Kafka** (`bazaar.core.events` and `bazaar.fulfilment.events`, 2 partitions each, `SASL_SSL`/`SSL`) for reliable asynchronous event processing.
- **Aiven OpenSearch** (`offers` index with typo tolerance and `external_gte` revision control, always rechecked against live PostgreSQL truth).
- **React 19 + Tailwind CSS v4 + Express (`server.ts`)** running unified on port `3000`.

See [`docs/README.md`](./docs/README.md) for complete setup, test commands, API reference, Built vs Simulated matrix, and deployment instructions.

## Quick Start

1. Copy `.env.example` to `.env` (or configure Secrets in AI Studio) with your **Aiven PostgreSQL**, **Aiven Kafka**, and **Aiven OpenSearch** credentials plus `JWT_SECRET`, `OTP_HASH_SECRET`, and `SEED_ADMIN_PASSWORD`.
2. Run migrations and seed data:
   ```bash
   npm run db:migrate
   npm run db:seed
   ```
3. Run unit tests:
   ```bash
   npm run test:unit
   ```
4. Run integration tests (requires configured Aiven services):
   ```bash
   npm run test:integration
   ```
5. Start the application:
   ```bash
   npm run dev
   ```
6. Run secret scan before committing:
   ```bash
   bash scripts/check-secrets.sh
   ```
