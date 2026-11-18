# PA service questions — "which shops?", "which shop?" (2026-11-17)

## The incident that prompted this

The owner asked the bot (mid PA testing): *"do you any shops in the
list"*. The reply listed **business-survey visits** (Sri Lakshmi
General Stores, Jwalamuki, Vijay Textile…) — none of them registered
with PA. Two faults:

1. The bot is shared: `telegram.js` splits linked (employee) chats by
   intent, and a service-discovery question matched no PA intent, so
   it fell through to the employee assistant, which answered from the
   only list it has — survey visits.
2. PA had no way to answer the question at all. The registry was only
   ever consulted silently while placing an order.

## The design rule

Users ask the same question in any word order, mixed with orders:

1. *"can you list all vegetable shops where I can shop"*
2. *"I want to order vegetable and do you have any shops available"*
3. *"I need 1 kg tomato, in which shop are you planning to order it"*

A keyword parser cannot cover this space, so **understanding goes to
the ai-helper; facts never do**:

- The helper receives the text + route signatures and returns only
  `{ intent, entities, confidence }`. It never names a shop.
- PA answers from `pa.app_registry` (active apps for the user's
  registered pincode) or from the live session (the pending quote's
  shop). Survey/visit data is never a source for PA answers.

## Addendum (same night): the deterministic net

The owner's first live test of this build — *"in shop are you
odering it"*, *"what is teh shop name you will order this item"*,
asked mid-cart — still failed: the live ai-helper returned no
`which_shop` match (its answering of the new signatures is not yet
verified live), and no seed pattern matched a full sentence. The
helper stays the long-tail mechanism, but questions this common
cannot depend on it. So `parseMetaQuestion` (router.js) now runs
FIRST in every meta path — idle, collecting, quote, and the
shared-bot split:

- A shop/store mention, minus the visit/survey veto, in a clear
  shape resolves deterministically: list words (list / registered /
  available / near) or plural "shops" + a discovery word →
  `list_services`; singular shop + a question shape → `which_shop`.
  Typos don't matter — the net keys off structure, not spelling of
  the verb ("odering" is never matched; it doesn't need to be).
- It works with the dictionary disabled and the helper down.
- At idle, a net hit is still learned into the dictionary
  (probationary, confidence 1) so the learning loop sees every
  understood phrasing, whichever net caught it.

Regression tests replay the owner's exact transcript in a PLAIN
world — no dictionary store, no helper — at cart, quote and idle.

## The two new routes (dictionary.js allowlist)

| Route | Entities | PA's answer |
|---|---|---|
| `list_services` | optional `category` | Registered apps for the user's pincode, grouped by category (Vegetables / Cloth / Legal help / Appointments); honest "none registered yet" when empty |
| `which_shop` | — | Stage-aware: at a quote → the pending shop's name + the quote re-shown; while collecting → "not picked yet — at DONE I compare and show the best"; at idle → "no order in progress" |

## Stage behaviour

- **Idle** — phrases the rule parser returns as `unknown` flow through
  the existing dictionary loop: lookup → helper match (≥0.85 route +
  learn, 0.60–0.85 one clarifying question, below → **proposal saved
  for the development team's review**). Example 3 at idle resolves to
  the order (the item wins); the arriving quote names the shop, which
  answers the question.
- **Compound (example 2)** — a `list_services` match whose text also
  expresses ordering (*order / want / need / buy*) for an ordering
  category answers the question AND opens the cart in the same reply:
  "Send me the vegetables items and I will get the prices."
- **Collecting / quote stages** — before item add/remove handling, a
  meta check (`resolveMeta`: dictionary lookup, then helper, meta
  routes only, ≥0.85, learned on the spot) answers the question and
  re-shows the cart/quote untouched. At the quote stage this runs
  before the YES/NO gate, so "in which shop…" no longer gets
  "Please reply YES or NO".

## The shared-bot split (shouldHandle)

- A narrow keyword bridge, `looksLikeServicesQuestion`: the text must
  mention shop(s)/store(s)/service(s), must NOT mention
  visit/survey/dashboard, and must carry a discovery word
  (registered / list / available / any / all / what / which / where).
  The owner's exact phrase — "do you any shops in the list" — passes;
  "how many shops did we visit" is vetoed and stays with the employee
  assistant.
- Any phrase the route dictionary has learned also routes to PA
  (one indexed DB lookup on the split path — no AI call there).

## Learning & review

Unchanged pipeline, now covering these routes too: confident helper
matches are learned probationary and promoted after 3 clean hits
(a services answer counts its hit on delivery, like a case query);
mid-confidence asks one clarifying question; everything else lands
in `pa.dictionary_proposal` as `pending_review` for the development
team to approve into manual entries. Migration 026 seeds the
canonical short forms ("list shops", "which shop", …) as manual
active entries.

## Deploy

Apply migration 026 and restart pa-web (no other migration, no code
config). Degrade-safe throughout: if the live ai-helper does not yet
answer the two new signatures, matches return null, lookups and seeds
still work, and unrecognized phrasings become proposals.
