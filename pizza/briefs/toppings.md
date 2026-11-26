# Brief: extra and added toppings on a pizza

Read [../README.md](../README.md), [../contract.md](../contract.md) (the menu file, `PizzaRecipe`, `validateRecipe`, `recipeKey`, the ticket text rules), decision D18 in [../decisions.md](../decisions.md), and the pizza sections of `docs/architecture/frontend.md`.

The owner described how the counter takes a pizza order, and it is more than removing an ingredient:

- The customer does not want the onions: tap the ingredient once, it reads `NO ONIONS`. (Built.)
- The customer wants extra cheese: tap the ingredient again, it reads `EXTRA CHEESE`. A third tap puts it back to normal.
- The customer wants something that is not on that pizza: an Add button at the bottom of the ingredients (a `+` and the word "Add") opens the shop's list of toppings; choosing one puts it on the pizza (or on that half), and it can be taken off again.

This works the same on a whole pizza, on each half of a half and half, on each pizza inside a deal, and when a line or a quick button is opened again.

## Outcome

1. **The menu file lists the shop's toppings.** A new optional top-level `toppings` list (`{ id, name }` each, same id and text rules as the other entries, at most 60). A menu without it still loads, and then there is no Add button. The sample menu (`tests/fixtures/pizza-sample-menu.json`) gains a made-up list of about eight, including one that is already an ingredient of a sample pizza.
2. **The recipe records it.** A whole pizza or a half carries, beside its removals, the ingredients made extra and the toppings added. Decide the smallest change to `PizzaRecipe` that keeps every stored `v: 1` recipe valid and meaning the same (new optional fields; an absent field is an empty list). `validateRecipe` normalises them (sorted, no duplicates) and refuses: an extra of an ingredient that pizza does not have; an ingredient both removed and extra; an added topping the menu does not list; a topping added that is already an ingredient of that pizza (the cashier wanted extra, say so). `recipeKey`, and so cart-line identity, the server check, the 20 KB cap, quick buttons and the sent-line edit all follow from the normalised recipe; check each still holds.
3. **The identical-halves rule** compares the whole half, extras and added toppings included.
4. **A plain pizza with only an extra or an added topping now has a recipe** (as one with a removal does today).
5. **Tickets and screens say it.** `ticketLines` prints, under the pizza or the half they belong to and after the `NO` lines, `EXTRA <names>` and `ADD <names>`, each wrapped like the `NO` line. So the kitchen ticket, the kitchen display, receipts, the cart, the sheet's "Prints as" box and the deal summary all show it. Update the contract's examples.
6. **The sheet.** An ingredient chip cycles normal, `NO`, `EXTRA`, normal; each state reads in words and has its own look (never colour alone), and a screen reader hears the state. After the chips of a pizza or half, an Add control (48 px, a plus and "Add") opens the toppings list as a compact grid; a tap adds the topping and it shows as a chip reading `ADD <name>` with a way to take it off; a topping already on that pizza is not offered. The list fits the collapsed layout (the chips stay visible at 1180 x 820 with both halves chosen and two toppings added to each).
7. **Price.** The owner's rule: an extra of an ingredient or an added topping costs one topping price, the same for every size; on one half of a half and half it costs half that price. The price is in the menu file (`toppings.price`, one amount; the shop's is 2.00, the sample uses a made-up amount) and the owner can change it later from a prices screen (another change builds that screen; here the price only has to live in one place that screen can update).
   - Decision D2 stands: a line's price is FloCafe's own, the variant plus its add-ons, and the recipe never changes it. So toppings are charged as two add-ons the menu load creates, `ad-topping` (the topping price) and `ad-topping-half` (half of it, rounded to the cent; say how you round an odd cent), in a group linked to the pizza products, the half-and-half product and the deals. The quantity of each on a line is derived from the recipe: whole-pizza extras and added toppings count on `ad-topping`, those on a half count on `ad-topping-half`.
   - The server makes them agree: on create, append, edit and replacement, a pizza or deal line whose topping add-on quantities do not equal what its recipe derives is refused with a message a cashier can act on (reuse the recipe check's place in `main/pizza/order-recipe.ts`), so a browser can neither forget the charge nor invent one. A cashier cannot add or remove these two add-ons by hand in upstream's add-on window.
   - The sheet shows the charge as it goes: each extra or added chip reads its price, the price lines list "2 toppings" and "1 half topping" with amounts, and the total is the cart's. Tickets and receipts show the add-on lines as FloCafe prints add-ons; check they read sensibly beside the `EXTRA` and `ADD` lines and say what you see.
   - A deal's pizzas are charged the same way on the deal line. Quick buttons, "Customize 1", a sent-line edit and a menu reload that changes the topping price must each leave the add-on quantities equal to the recipe; test each.

## Not in this change

The screen where the owner changes prices, "light" amounts, crust choices, a build-your-own pizza, toppings on anything that is not a pizza.

## Tests

- Script: the parser (toppings accepted, limits, a menu without them); `validateRecipe` (each refusal, normalising, an old recipe with no new fields unchanged, `recipeKey` differs when an extra or an added topping differs and is equal when only the order differs); `ticketLines` at 42 and 48 columns for a whole pizza, a half and half with different extras per half, and a deal pizza; the sheet reducer (the three-state cycle, add and take off a topping, identical halves that differ only by an extra are allowed); the server check through the order route (accepted, stored normalised, refused cases answer 400 with the message); the charge (a whole pizza with one extra and one added topping costs two topping prices more, a half and half with one on each half costs two half prices more, a line whose add-on quantities disagree with its recipe is refused, tax is charged on the total as for any add-on).
- Playwright `frontend/e2e/pizza-toppings.spec.ts` (chromium; `loadSampleMenu` / `clearPizzaMenu`): a second tap on an ingredient reads EXTRA and a third puts it back; Add opens the list, a topping is added to one half only, taken off, and added again; the "Prints as" lines, then the cart line's lines; a deal pizza gets an extra; the order paid in cash stores the recipe and the menu price; a line reopened from the cart shows the same chips; a menu with no `toppings` has no Add control; keyboard only; every new control at least 48 px at 1180 x 820; screenshots of the sheet with an extra and an added topping on each half, opened and checked.

## Report

Branch and commit; red then green; the recipe shape you chose and why old recipes are unaffected; the Playwright result per case; screenshot paths; every upstream file edited with line counts; new strings; how an odd cent on a half is rounded; and how the add-on lines read on a ticket and a receipt.
