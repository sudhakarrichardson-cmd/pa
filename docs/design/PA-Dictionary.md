# PA Dictionary — the route learning loop

Migration 024 + `services/pa-web/src/dictionary.js`, wired at one point
in `src/router.js`. The same learning loop as the VegiBot dictionary,
adapted to the front door: VegiBot's entries map a phrase to one of the
store's own procedures; **PA's entries map a phrase to a route** —
`{ route, category, item template }`.

## Invariants

- **An entry never names a destination app.** Which store or office
  serves a routed request is decided live, as always: registry +
  the user's registered pincode + best quote.
- **An entry can only decide where to ask.** Prices, stock, slots and
  case facts come live from the app at request time, and nothing is
  ordered until the user confirms. A wrong or stale entry wastes one
  turn; it cannot produce a wrong invoice.
- **The router is the only writer.** The ai-helper proposes a match;
  the dictionary module validates it against the route allowlist and
  saves it. Nothing is coded, registered or executed from a proposal.
- **Degrade-safe.** Every dictionary store method swallows its errors:
  with migration 025 not yet applied (or the DB down), the router
  behaves exactly as before. `PA_DICTIONARY_ENABLED=false` turns the
  loop off entirely.

## Flow

Only for a **registered consumer user at the idle stage**, and only
for a message the deterministic rule parser returns as `unknown`
(registration answers, YES/NO confirmations, slot picks and employee
chats never pass through the dictionary):

1. **Lookup** on the normalized pattern (quantities/dates masked to
   `#`, punctuation stripped, case folded). Hit → the entry's route
   becomes the request. Active and probationary entries both fire —
   every PA route is self-confirming.
2. **Miss → ai-helper match.** The helper receives the text plus the
   route *signatures only* (never the dictionary table) and must
   answer strictly `{ intent, entities, confidence }`:
   - `>= 0.85` — route it; learn the phrase as **probationary**.
   - `0.60–0.85` — ask one clarifying question ("Did you mean: …?");
     route + learn only on YES. NO leaves a proposal.
   - `< 0.60` or no answer — save a **proposal** for owner review;
     the router's existing fallbacks (loose `understand()`, then
     "did not understand" + `pa.request_log`) continue unchanged.

## Promotion and demotion — PA's confirm step is the signal

- **Clean hit** = the user confirms the routed request and it is
  placed (order / service request). For lawyer queries the hit counts
  when the info is delivered — for a case question, the info *is* the
  answer, and the following NO only means "don't send a request".
- **3 clean hits** promote a probationary entry to `active`.
- A **cancel at the confirmation** demotes a *learned* entry to
  `pending_review` (hit count reset) for the owner to judge.
  Manual (seed) entries are never auto-demoted.

## Routes (the allowlist)

| intent | meaning | request produced |
|---|---|---|
| `order` | order products | category `vegetables` \| `cloth`, items with live quantities |
| `service_query` | lawyer info / consultation | category `legal` |
| `book` | appointment | category `appointment` |
| `order_status` | last order status | the status answer |

Entries store item **templates** (`[{name, unit}]`, no quantities);
quantities are re-read from the live message when an entry fires.

## Governance

- Stop any learned behavior without a deploy:
  `update pa.dictionary_entry set status='disabled' where pattern='…';`
- Review what users asked that PA could not route:
  `select * from pa.dictionary_proposal where status='pending_review';`
- Seed entries (migration 025, `source='manual'`, active) cover
  Telugu item words the rule parser cannot see (`ullipaya`,
  `tamata`, `pachimirchi`, `bangaladumpa`, …). Add more the same way.

## Deploy

1. Apply `database/migrations/025_pa_dictionary.sql`.
2. Restart pa-web (no new env required; `AI_HELPER_URL` is the same
   one the router's escalation already uses — the match step needs
   the helper to answer the strict `{intent, entities, confidence}`
   contract when given `signatures`; if it cannot, matches return
   null and only dictionary lookups + proposals run).
3. Tests: `node tests/pa-dictionary.test.js` (15 checks) +
   `node tests/pa-messaging.test.js` + `bash tests/run.sh`.

## Known limits (v1, deliberate)

- Normalization masks digits only — PA has no Telugu number-word
  tables, so "rendu kilolu ullipaya" and "ullipaya" are different
  patterns until each is learned.
- `shouldHandle` (the employee/consumer split on the shared Telegram
  bot) still keys off the rule parser: a *linked employee* typing a
  learned phrase stays with the employee handler. Unlinked consumer
  chats — the normal PA case — are unaffected.
