# Pizza POS wireframes: notes

Open `index.html`. The top bar switches screen (1 to 6) and variant (A or B); `All` shows every frame on one page, and `index.html#3B` opens a frame directly. Every mock is drawn at 1180 × 820 and shrinks to fit the window.

`index.html` is self-contained. `build.py` and `style.css` are its source: the build reads names and prices from `tests/fixtures/pizza-sample-menu.json`, so the mocks cannot drift from the sample menu. Rebuild with `python3 build.py [path to the menu file]`.

Each frame was rendered in headless Chrome at 1240px and one at 700px wide, and checked by eye. Nothing was tested on a real iPad.

## Recommendation per screen

### 1. POS home: A

A puts Small, Medium and Large on every pizza tile, so any plain pizza is one tap and there is no size setting to leave on the wrong value. B's sticky size is faster for "three larges" but a wrong size is the costliest mistake a pizza order can carry, and B hides line actions until a line is tapped. One thing to take from B: when an order grows past three or four lines, fold the action row away on every line except the last one touched, because A's always-open rows fill the cart quickly.

### 2. Pizza sheet: A

A shows both halves side by side with cook, cut, dips, note and quantity on one screen, and a large half and half with no olives on one half is 5 taps against B's 6. B keeps the order visible and has bigger targets, but only one half is open at a time, so a removal can land on the wrong half unnoticed. A's "Prints as" box does the job the visible order does in B.

### 3. Deal configurator: A

B is quicker for the 3-pizza deal (11 taps against 13) and shows everything at once, but it cannot hold the 6-pizza Party Pack without a second row or sideways scrolling, and its columns are too narrow to show both halves. A is the same layout for every deal, each tab is the sheet from screen 2 so staff learn one thing and the code has one pizza editor, and the "Still missing" box works for any number of choices. If the shop sells almost nothing but the 3-pizza deal, B is worth a second look.

### 4. Quick buttons: A, with the favourites strip from B

A's page shows eleven buttons with their full contents and price and costs one extra tap (the category button). B's dock is one tap from anywhere but takes about 330px from the pizza grid on every order, whether or not a quick button is used. The useful part of B is narrower: after a phone lookup, show that customer's two or three favourites as a single row above the pizza grid, since that is the moment they matter. For saving, A's dialog: it is used rarely, and it has room for a preview and named colours.

### 5. Small-items popup: B

Both take the same number of taps. B keeps the order on screen, shows what it already holds on each tile (which stops the same drink going in twice), and each tap is an ordinary add to the cart, the same behaviour as the product grid today. A needs a pending list that is thrown away on close. B's risk is a stray tap becoming a real line; the minus on the tile and the highlighted new line in the order are the guard.

### 6. Kitchen ticket: one variant

Drawn at 48 columns from the contract's examples: bold heading with the quantity, removals as upper-case `NO` lines under the pizza or half they belong to, `1ST:` and `2ND:` for halves, cook and cut on one line after them, numbered pizzas in a deal, then `WINGS:`.

## Questions for the shop's owner

1. **Which size sells most?** The pizza sheet has to open on some size. If one size is most orders, it should be pre-selected and the tap counts above hold; otherwise the sheet opens with no size and Add stays off until one is chosen.
2. **Pasta inside a deal.** "Large Pizza Combo" includes a pasta and "Pasta Night" includes three, and Baked Pasta comes as Lasagna or Spaghetti. The menu file does not ask which, so the configurator has no pasta step and the kitchen ticket would not say. Does the kitchen need to be told?
3. **Wings in a deal.** One flavour for all twelve, or can they be split (six hot, six sweet chili)? The mocks assume one flavour.
4. **Dips and notes on a deal pizza.** A deal's pizzas carry removals, cook and cut, but no dips or note of their own. Is one note for the whole deal enough, with dips added as separate items?
5. **How many pizzas are on the real menu?** Home A shows nine without scrolling in three columns, twelve in four narrower ones. More than about fifteen changes the choice.
6. **Who may save, change and delete shop-wide quick buttons?** Any staff member, or only someone with a manager PIN? Customer favourites could stay open to everyone.
7. **Is "1st half / 2nd half" how the kitchen talks?** The ticket prints `1ST:` and `2ND:`. If cooks say left and right, the screens can say that while the ticket text stays as the contract defines it.
8. **Should drinks print on the kitchen ticket?** They are drawn as plain lines. Some shops keep cold drinks off the kitchen copy.

## Notes for the build

- **Same pizza on both halves.** The contract rejects two identical halves and asks the cashier to choose a whole pizza. The sheet should leave the first half's pizza available in the second half (it is allowed when the removals differ) and switch Add off, with that message, while the halves are identical.
- **"Customize 1" on drinks and sides.** It is offered only on pizza lines in the mocks. A 2x Wings line where one order is hot and one sweet chili would need the same split; today staff would lower the quantity and add a second line.
- **Colour is never the only cue.** Removed ingredients show `NO` plus a strike-through, missing deal choices show `!`, dashes and words, and the selected swatch has a tick and a name.
- **Contrast.** Text colours were chosen from Tailwind's 700 shades on 50 tints and FloCafe's brand blue, which pass AA at these sizes by calculation. They were not run through an automated checker.
- **Touch targets.** Every control in the mocks is at least 48px in both directions. FloCafe's own cart uses 28px buttons, so the pizza cart lines are a deliberate departure.

## Not drawn

- Dark mode. The colours are variables on `:root`, light values only.
- Whole-pizza state of the sheet. It is the half-and-half layout with the two columns merged into one wide column.
- The deal configurator showing the six-pizza Party Pack in full; only its pops step is drawn.
- The confirmation step for deleting a quick button, the phone lookup itself, and the delivery address entry.
- The free-text note on a ticket. FloCafe prints it through its existing special-instructions line.
- The 42-column ticket. The pizza lines shown are short enough to print unchanged at 42; only the padded header lines would be narrower.
