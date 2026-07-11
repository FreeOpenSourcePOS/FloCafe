# FloCafe QA & CI/CD Strategy Review
*Date: July 2026*
*Context: Reviewing the strategy to prevent recurring bugs in `main` (schema assumption errors and visual layout regressions).*

---

## 1. The Initial Problem & Proposal

**The Problem:**
1. **API Schema Assumptions:** Backend PRs were being merged that assumed database columns existed without testing them, resulting in instant 500 errors in production (e.g., querying an `is_active` column that didn't exist).
2. **Visual Layout Regressions:** Backend-focused contributors pushing CSS layout changes (like switching flexbox to grid) that passed compilation but caused UI components to clip or become unusable on the POS screen.

**The Initial Proposal:**
1. **Stricter TDD Enforcement:** A repo rule requiring a `supertest` for every new route.
2. **Frontend E2E & Visual Regression:** Introducing Playwright to the Next.js frontend, spinning up a headless Chromium instance to test critical paths and use visual regression testing (screenshots) to catch CSS regressions.

---

## 2. Iteration 1: The Expert Analysis

After auditing the current infrastructure (Electron + Express + SQLite + Next.js static export), the initial feedback was:

*   **TDD Enforcement:** A "repo rule" (honor system) is insufficient. It should be automated via a **Route Coverage CI Gate**. Furthermore, to directly address Problem #1, a **Schema Audit Test** was proposed: parsing compiled SQL queries and checking them against the SQLite schema.
*   **Playwright Integration:** The tool choice was correct, but the architecture needed to respect the stack. Playwright needs to build the static export and run against `dev-server.js` (which mocks Electron and runs the Express backend), rather than `next dev`.
*   **Visual Regression:** Initially accepted as a good idea for the layout issues.

---

## 3. Iteration 2: The "Early-Stage Codebase" Pivot

A critical concern was raised: **The application is in a very early stage and changes constantly.**

**Decision:** Visual screenshot regression testing was **REJECTED** for this phase.
**Why it's a bad fit:** In a rapidly changing UI, every PR that touches layout *intentionally* changes the screenshots. The workflow devolves into constantly running `npx playwright test --update-snapshots` and reviewers rubber-stamping the changes. It becomes busywork with a terrible friction-to-value ratio.

**The Pivot:** **Layout Integrity Tests (Property-based)**
Instead of pixel comparisons, Playwright should assert on the *properties* of the layout that actually matter and survive CSS refactors:
*   **Overflow/Clipping:** Assert that `scrollWidth <= clientWidth` on critical panels.
*   **Visibility & Clickability:** Assert that buttons are visible, have dimensions > 0, and aren't covered by modals.
*   **Touch Targets:** Assert that interactive elements on the POS are at least 44x44px.

---

## 4. Iteration 3: The SQL Parsing Reality Check

To implement the "Schema Audit Test" (parsing SQL queries to check against the DB schema), a subagent was dispatched to review the actual SQL patterns in the codebase.

**The Findings:**
The plan to use regex to parse SQL out of the compiled `dist/` files was **fundamentally broken** for this codebase.

**Why it's not a good fit (Codebase Reality):**

1.  **`SELECT *` Dominates:**
    Almost every route uses `SELECT * FROM tablename`. A regex parser cannot extract specific column expectations from `SELECT *`; it only knows the table name.
    *Example (`main/routes/orders.ts`):*
    ```typescript
    let query = 'SELECT * FROM orders WHERE 1=1';
    ```

2.  **Dynamic Query Building (String Concatenation):**
    Queries are built incrementally using raw string concatenation based on request parameters. A static parser reading the file would see fragments of strings, not a complete SQL statement.
    *Example (`main/routes/orders.ts`):*
    ```typescript
    if (req.query.status) {
      query += ' AND status = ?';
    }
    ```

3.  **Complex JOINs with Aliases:**
    When explicit columns *are* used, they rely heavily on table aliases, requiring a parser to resolve the alias to the table contextually.
    *Example (`main/routes/reports.ts`):*
    ```sql
    SELECT oi.product_id, oi.product_name, SUM(oi.quantity) as total_quantity
    FROM order_items oi JOIN orders o ON oi.order_id = o.id
    ```

4.  **Correlated Subqueries & SQLite Functions:**
    Queries use complex nested structures and specific SQLite JSON functions that defy simple regex extraction.
    *Example (`main/routes/customers.ts`):*
    ```sql
    SELECT c.*,
      COALESCE((SELECT COUNT(*) FROM orders o WHERE o.customer_id = c.id), 0) as visits_count
    FROM customers c
    ```
    *Example (`main/routes/reports.ts`):*
    ```sql
    GROUP BY json_extract(payment_details, '$.method')
    ```

5.  **SQL Outside of Routes:**
    Significant SQL exists in service files (e.g., `main/services/cloud-sync.ts` is 40KB of heavy SQL), not just in the `routes/` directory.

---

## 5. The Finalized QA/CI Action Plan

Given the constraints and realities of the codebase, the plan was finalized into these components:

### Phase 1: Backend Safety Net
1.  **Route Coverage CI Gate:** A script (`scripts/check-route-coverage.ts`) that verifies every route module in `main/routes/` is imported by at least one test file.
    *   *Status:* 11 out of 22 routes currently have zero coverage. These will be added to an allowlist initially to prevent *new* uncovered routes, and backfilled over time.
2.  **Schema Integrity Test:** Instead of parsing SQL, this test (`tests/schema-integrity.test.ts`) initializes a fresh DB (running all migrations) and verifies that the migrations actually produce the exact expected tables and columns.
    *   *The real fix for Problem #1:* The combination of ensuring all routes have tests (Route Coverage Gate) + those tests hitting real SQLite (existing Integration Tests) + ensuring migrations are sound (Schema Integrity Test) catches the schema assumption bugs at runtime.

### Phase 2: Playwright Functional E2E
*   Integrate Playwright in `frontend/`.
*   Use `dev-server.js` in the `webServer` config.
*   Focus strictly on **5 critical user journeys** (Auth, POS Order, Checkout, Order Management, KDS) using `data-testid` attributes.

### Phase 3: Layout Integrity Tests
*   Implement property-based assertions (overflow, visibility, touch target size) instead of visual screenshot regressions.

---

## 6. Future Architectural Consideration: The Database Layer

The SQL audit revealed a broader architectural issue. The current approach of using raw string concatenation for dynamic queries across the entire routing and service layer is brittle and impossible to statically analyze.

**Why this is a problem:**
*   **Testing:** We cannot statically verify if a query is valid against the schema without running it.
*   **Maintainability:** String concatenation (`query += " AND status = ?"`) is prone to spacing errors and makes queries hard to read.
*   **Security:** While parameterized inputs (`?`) are currently used, manual string building always carries a higher risk of accidental SQL injection if a developer concatenates a variable by mistake.

**Recommendation for Future Refactoring:**
The team needs to consider migrating from raw `better-sqlite3` string queries to a query builder or a lightweight ORM.
*   **Query Builder (e.g., Kysely, Knex):** This provides type safety and programmatic query construction. Kysely, in particular, generates TypeScript types from your schema, which would turn "column mismatch" errors into **compile-time TypeScript errors**, completely solving Problem #1 without needing complex CI gates.
*   **Lightweight ORM (e.g., Drizzle ORM):** Offers similar type-safety benefits with a slightly higher abstraction layer.

*This documentation should serve as the starting point when the team is ready to tackle the database access pattern overhaul.*
