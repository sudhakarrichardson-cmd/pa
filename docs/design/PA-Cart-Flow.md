# PA cart flow — collect first, quote once, add-or-confirm

Owner-directed change (2026-11-17) to the mediated ordering flow in
`services/pa-web/src/router.js`. Replaces the single-shot
request → quote → YES/NO flow for the ordering categories
(`vegetables`, `cloth`). Lawyer queries and Scheduler bookings are
unchanged — there is nothing to collect there.

## Stages

1. **Collecting** (`session.stage = 'collecting'`). The first item
   message opens a cart; PA replies with the list so far and asks for
   more. **No app is contacted while collecting.** Further item
   messages merge into the cart (same item + unit → quantities add).
   A message from a different category is held back politely — one
   cart, one category, because two stores cannot share one invoice.
2. **Quote.** DONE / "that's all" / YES at the collecting stage runs
   one `check_availability` round for the whole list across the apps
   serving the user's pincode; the best quote is shown itemized, as
   before.
3. **Add-or-confirm** (`awaiting_confirm`, order quotes). The quote
   prompt now offers a third option: send more items. An add is
   merged and the whole list is re-checked with the **winning store
   only** (re-running the full comparison for one item could switch
   stores mid-order). An item the store does not have is named and
   left out; the rest of the quote stands. YES places the order —
   `place_order` is called only here, with the final list, under the
   same `pa_request_id` issued at the quote.
4. **Cancel** works at both stages (NO / cancel) and orders nothing.

## Details

- Item resolution inside an open cart/quote: rule parser →
  dictionary lookup → **contextual parse**: the category is already
  known, so an item-shaped phrase ("1 kg dragon fruit") counts as an
  item of that category even when the name is new to the word lists;
  the store's answer decides availability. At idle (no context) an
  unknown item name still goes through the dictionary / not-understood
  path as before.
- A status question mid-cart is answered and the cart is kept.
- `shouldHandle` treats `collecting` (and `awaiting_dict_clarify`)
  as in-flow stages, so replies from a linked employee chat stay with
  the PA router mid-cart.
- The dictionary signal is unchanged: the entry that opened the cart
  rides in the cart and into the pending quote, so YES-at-confirm
  still counts its clean hit and NO still demotes it.

## Tests

`tests/pa-cart.test.js` (7 flows, including the live case that
prompted this: tomato quote, then "add brinjal 1kg"), plus the
updated `tests/pa-messaging.test.js` and `tests/pa-dictionary.test.js`
journeys and `tests/run.sh`. Deploy: pull + restart pa-web — no
migration, no new env.
