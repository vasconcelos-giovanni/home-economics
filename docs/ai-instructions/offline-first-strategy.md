# Offline-First Strategy
Guidelines for managing the local database and PWA lifecycle.

## Database Schema (Dexie.js)
- The database should be initialized in a client-only Nuxt plugin (`plugins/db.client.ts`).
- Tables must be strictly versioned using Dexie's `db.version()`.
- Define indexes for frequently queried fields:
  - Transactions: `id, money_pot_id, tag_id, date`
  - Money Pots: `id, bank_account_id`

## Data Handling Requisites
- Store money values strictly as integers (e.g., R$ 10,50 -> 1050).
- Cross-entity queries (e.g., getting a Bank Account color for a specific Transaction) must be resolved in the composable layer since IndexedDB lacks native JOINs.
- Always use Dexie transactions (`db.transaction`) when updating a Money Pot balance simultaneously with creating a new Monetary Transaction to guarantee data integrity.

## PWA & Synchronization
- Service Worker must be configured via `@vite-pwa/nuxt` to cache all static assets, enabling the app to load instantly without a network.
- As the app manages profiles (e.g., actual vs. projected wage), separate profiles using a `profile_id` on every major table or use separate Dexie databases per profile to avoid data leakage between scenarios.