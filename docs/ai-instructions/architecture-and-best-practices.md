# Architecture & Best Practices
Technical guidelines for the Nuxt 3 PWA using Vuetify, Zod, and Dexie.js.

## Directory Structure
- `composables/`: For encapsulated business logic and Dexie.js database interactions.
- `utils/`: For pure functions (e.g., currency formatters, date manipulators).
- `schemas/`: For Zod validation schemas (shared between forms and local database validation).
- `stores/`: Pinia stores for global UI state (e.g., active profile, theme). Persistent data must stay in Dexie.

## State Management Requisites
- Pinia should NOT be used to cache database records. Dexie.js is the single source of truth for financial data.
- Pinia handles temporary UI states, such as "is the add transaction modal open?" or "which bank account color is currently selected?".
- Use Nuxt `useState` only for SSR-to-client hydration (if applicable, though this is primarily an offline-first SPA).

## UI Requisites (Vuetify)
- Use Vuetify's SCSS variables to handle the color picking feature for Bank Accounts and Tags, but strictly prioritize Vuetify classes in the code.
- Forms must use `vee-validate` combined with the Zod schemas from the `schemas/` directory for robust validation before hitting the local database.
- Money values are stored as integers (cents) in the database but must be formatted using a global Vue filter or composable before rendering in Vuetify components.
- Everything must be responsive, so this app goal is to be used in mobile and desktop screens, with a mobile-first approach, so use the Vuetify classes for achieving it (e.g.: `m-md-auto`).