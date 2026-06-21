# Initial idea
I want to make an offline-first PWA with Nuxt, Zod Vuetify and Dexie.js for managing my personal bills.

## Functional requisites

- CRUD for:
    - bills (name, value, paid value);
    - investiments (name, suggested value, invested value);
    - great incomes (wage, allowance from dad etc.) (name, value);
    - tags (food, transport etc) with a color picker;
    - bank accounts their money pots (name, value, color etc. - account number and this kind of data must be optional) with the same tag above;
    - monetary transactions with the same tag above.
- Dashboard with:
    - Debt;
    - Invested value;
    - Balance (monthly and in general)
    - Unallocated funds;

## Non-functional requisites

- Colors for differentiating banck accounts. E.g.: Nu account is purple (chosen with a color picker), BB is yellow etc..
- Possibility of defining calculation strategy (monthly and weekly, with ease to add new kinds of time periods);
- Possibility to choose to which back/money pot each bill/investiment relates to. The banks itself must be kind of a wrapper for money pot; there will be always at least one money pot since a back creation.
- Money values stored as integers;
- Profiles, so I can have, e.g., the real financial program of the month and another profile with what I would whether my wage increased.