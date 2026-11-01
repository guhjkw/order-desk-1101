# Order Desk: working prototype

A working prototype of an order-processing SaaS for German B2B companies, built for an Upwork post that asked for "software similar to orderbase.ai". It is a prototype of the client's own product, not a clone of anyone's interface.

The prototype handles orders sent by e-mail text, PDF or Excel:
- reads each order;
- checks it against that company's own products, customers, prices, units and public-holiday calendar;
- lets staff fix and approve it on one screen;
- builds the Microsoft Dynamics 365 Business Central requests that create the sales order, and never creates it twice.

Live: https://guhjkw.github.io/order-desk-1101/

**All data is invented:** both companies, all customers, people, article numbers, VAT IDs and orders. Business Central requests are built exactly as API v2.0 expects, and a simulated sandbox in the page answers them, so nothing is sent anywhere.

## Try it
Open the live link, or open `index.html` straight from disk (the sample data is embedded for that case). Things to try:
- **M-1044.** It has a typo (100-280). Pick the suggested 100-820, confirm the two description matches, approve.
- **M-1041, then M-1045.** Approve M-1041. Then release its forwarded copy M-1045 ("not a duplicate") and approve it. The Business Central lookup finds the first sales order and creates nothing.
- **Rules.** Raise the price tolerance to 10%, and M-1042's price warning disappears. Switch the federal state to see that state's holidays.
- **New order.** Paste your own order e-mail, or click Insert an example.
- **Add a company.** Click Fill in an example company, change a column mapping, create it, then send it an order.
- **Running costs.** Change orders, pages, companies and model.

## Files
```
order-desk-1101/
  index.html              built page (python3 build.py), one file, no framework, no CDN
  index.src.html          page source: interface only, all logic comes from the engine
  build.py                embeds data/sample.json and the last test summary into index.html
  src/orderEngine.js      the engine: reading, matching, checks, Business Central requests, onboarding
  data/sample.json        invented companies, products, customers, orders, examples, prices
  tests/verify.js         node tests against src/orderEngine.js
  tests/test-output.txt   the saved passing run
  tests/browser-check.py  Playwright: drives the real page over http and off disk
  tests/browser-output.txt
  tests/screenshots/
```

## Run the tests
```
node tests/verify.js          # 65 passed, 0 failed
python3 build.py              # refuses to build unless the saved node run is green
python3 tests/browser-check.py   # 47 passed, 0 failed (needs: pip install playwright && playwright install chromium)
```
The page and the node tests load the same `src/orderEngine.js`. What you click is what is tested.

## How the logic works
| Step | Function | What it does |
|---|---|---|
| Read | `extract` | Reads tables from a PDF page or an Excel sheet. It finds the header row under the title rows and maps columns by German and English names. For plain text it uses four line patterns (quantity-unit-code, code-quantity, quantity-unit-description, description-quantity-unit). Each field keeps a pointer back into the document, which drives the highlighting. |
| Header | `readHeader` | Finds the customer, the order number, the order date, the delivery date (dd.mm.yyyy, dd.mm., ISO or "KW 46") and the stated total. The customer is found by customer number, VAT ID or sender domain. |
| Match | `matchLine` | Matches by article number, then the customer's own numbers, then EAN. Typos get suggestions by edit distance (a swap of two characters counts as one step). Descriptions are scored with German compound words and size conflicts (M8 is not M10). |
| Price | `agreedPrice` | Uses the customer's special price, otherwise the list price less the customer's discount. |
| Check | `process` | Covers unknown customer, missing order number or date, a date in the past, public holidays (all 16 states), weekends, unknown or discontinued articles (with successor), units and pack sizes, minimum order, price outside tolerance, a stated total that does not add up, and duplicates. Each problem carries its own fix buttons. |
| Order of arrival | `processInbox` | Runs the inbox in arrival order, so a forwarded copy is caught as a duplicate of the first. |
| Business Central | `bcRequests`, `externalDocNo` | Builds the requests in order: token (client credentials), look up the external document number, create the salesOrders header, then one salesOrderLines request per line. Without a customer order number the intake id is used, so the lookup still stops a second order. |
| Ask the customer | `clarification` | Writes a German Rückfrage from the order's own problems. |
| Onboarding | `importCatalog`, `importCustomers`, `newTenant` | Imports CSV with any delimiter, guesses the columns (you can override them), and skips or reports bad rows with the reason. It also validates the company form (federal state, GUIDs, limits). |
| Costs and price | `monthlyCost`, `pricing` | Running cost per month and per company, and milestone prices from hours times rate. |

Rules per company (`settings`): price tolerance, the auto-send confidence threshold and the duplicate window. Change them on the Rules page; the inbox is re-checked at once.

## Extend it
- **New check:** add an `issue(...)` in `process` with `fixes`, add a test in `tests/verify.js`, and the page shows it with its buttons.
- **New unit:** add it to `UNIT_WORDS` and `UNIT_RE`.
- **Real reading:** replace `extract` with an AI model call that returns the same fields through a strict JSON schema, and keep the source pointers. Everything after reading stays as it is.
- **Real Business Central:** send the requests from `bcRequests` from a server with the token from the company's Entra app registration, keeping the secret in a vault.

## What the delivered version adds
Multi-company accounts and sign-in (Microsoft Entra ID), EU hosting and storage, an inbound address per company, AI reading for e-mails, PDFs (including scans) and Excel, a real Business Central connection on the client's sandbox, then production, queues and retries, an audit log, retention and deletion rules, AV contract (Art. 28 GDPR) and TOMs, subscriptions (Stripe, German VAT) and a learning loop for each customer's article numbers. Milestones and prices are on the Proposal page.

## Honest scope
Built from an Upwork post. No real client data, and no prior Business Central client project is claimed. The engine and its passing tests are real; the reading step here is rule-based, and the product uses an AI model for it. The link will be taken down about 30 days after it is sent.

Built by Taiwo, Pathfinder Automation Solutions.
