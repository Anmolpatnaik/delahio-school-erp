# AI Collaboration & Engineering Log (`AI_LOG.md`)

I operated in a strict **read-only / mentor mode** with the AI assistant throughout this project. Rather than allowing the AI to automatically write, overwrite, or edit application files, I required it to act as an architectural advisor and code reviewer—providing exact file paths, line numbers, and root-cause explanations while I manually typed, reviewed, and verified every single change in the codebase.

Below are 5 key engineering moments from the session, detailing how AI assistance was leveraged, where it provided incomplete or broken solutions, and how I diagnosed and resolved the resulting issues.

---

## Moment 1: Initial System Triage & Root Cause Investigation (`TRIAGE.md`)
- **What I asked:** I prompted the AI to perform a comprehensive, read-only analysis of the starter codebase across `server/index.js`, `src/core/currencyMath.js`, `src/modules/02-fee-desk/FeeDesk.jsx`, and `src/modules/03-ledger-reports/DaybookLedger.jsx`. I instructed it to produce a detailed reproduction playbook and root-cause analysis for all 9 complaints and accounting rules in `TRIAGE.md`.
- **What the AI said:** The AI mapped out the system architecture and identified primary failure points, including the incorrect fee formula in `currencyMath.js`, missing in-memory state mutations in `server/index.js`, client-side string concatenation bugs, and CSS table-width blowout (`w-[2680px]`).
- **What I did:** I accepted the architectural roadmap but rigorously audited the generated triage documentation against `server/seedData.json`. During my review, I caught an inconsistency in receipt number calculations: the AI initially estimated receipt generation would start at `RCPT-2026-0882`, but inspection of `server/index.js` showed `issued = state.daybookLedger.length + 881`. Because the seed data already contained 6 transactions, the next issued receipt was deterministically `RCPT-2026-0887`. I adjusted the triage documentation and test assertions to reflect the true seed state before proceeding.

---

## Moment 2: Dues Math Refactor & The Blank Screen Crash Catch (Complaints #2, #6 & Rule 3)
- **What I asked:** "Give me a step-by-step manual implementation checklist to fix Complaint #2 (Discrepant Due Amounts), Complaint #6 (Overpayments & Credit Balances), and Accounting Rule 3 (Two Decimal Places). How to fix `calculateStudentDues()` to follow `round2(tuition * (1 - scholarshipPct / 100) + lateFine - paidAmount)`, format currency with 2 decimals, and remove the local `duesFor()` helper."
- **What the AI said:** The AI provided the corrected math formula for `src/core/currencyMath.js` using `Number.EPSILON` to prevent floating-point drift, updated `formatINR()` to use `minimumFractionDigits: 2, maximumFractionDigits: 2`, and told me to delete the local `duesFor()` function in `FeeDesk.jsx`.
- **What I did (AI Error & Catch):** I modified the math core and deleted `duesFor()` as instructed. However, upon saving and loading the app, Vite rendered an entirely blank white screen with a critical runtime error in the browser DevTools console: `Uncaught ReferenceError: duesFor is not defined`. The AI had instructed me to delete `duesFor()`, but failed to identify 4 active call sites in `FeeDesk.jsx` (lines 54, 66, 67, and 339) calculating `visibleRows`, `pendingBook`, and `defaulters`. Additionally, there was a prop typo `onPaymentSucess` (missing 'c') passed to `FeeDesk`. I rejected the incomplete removal, manually searched the file with `Select-String`, replaced all 4 stale `duesFor(student)` calls with `calculateStudentDues(student)`, corrected the prop to `onPaymentSuccess`, and verified in Chrome that Riya Agarwal (`STU-2025-013`, −₹2,500.00) and Karthik Subramaniam (`STU-2025-028`, −₹2,500.00) properly rendered with violet `Credit ₹2,500.00` styling rather than defaulter red.

---

## Moment 3: Payment State Persistence & Cross-Module Sync (Complaint #3 & Rule 5)
- **What I asked:** "Give me a step-by-step manual implementation checklist to fix Complaint #3 (Payment Disappearing on Refresh) and Rule 5 (Exam eligibility updates when dues reach zero and survives refresh), plus Cross-Module State Sync so Student Master and Daybook update immediately without page reload."
- **What the AI said:** It instructed me to update `POST /api/fees/pay` in `server/index.js` to mutate `student.paidAmount`, prepend to `student.paymentHistory`, recalculate `student.examBlocked = remainingDues > 0`, and return `{ success: true, receipt: entry, student }`. On the client, it advised adding a `handlePaymentSuccess` callback in `src/App.jsx` to update root state and pass it to `FeeDesk.jsx`.
- **What I did:** I manually implemented the server mutations and root state handler. To verify, I used Chrome DevTools Network tab and simulated payment collections on Diya Nair (`STU-2025-002`, ₹10,500.00 due). Upon recording a full payment, I immediately switched tabs to Student Master and Daybook without reloading: Diya's status flipped from "Blocked" to "Eligible", dues cleared to ₹0.00, and a new row appeared in the Daybook. I then executed a hard refresh (`Ctrl + F5`) and verified via `GET /api/bootstrap` that the exam unblock and payment history survived reload.

---

## Moment 4: Full-Stack RBAC & Cash + UPI Arithmetic (Complaints #4, #5 & #8)
- **What I asked:** "Give me a manual checklist to enforce RBAC on server and client (Complaint #4), fix scoped Select All (Complaint #5), and fix the Split Cash + UPI arithmetic bug (Complaint #8)."
- **What the AI said:** It provided server-side role validation for discounts and waivers (`403 Forbidden`), client-side input hiding in `FeeDesk.jsx` based on `can(role, ...)`, a scoped `toggleAll()` using `visibleRows`, and a fix for the drawer balance preview.
- **What I did (AI Error & Catch):** While reviewing the AI's suggestions, I caught two bugs:
  1. The AI initially suggested checking `can(role, 'waivefine')` with a lowercase `f`. Because permissions in `src/core/permissions.js` are strictly camelCase (`waiveFine`), the waiver checkbox would have remained hidden even for authorized roles (`ADMIN` and `ACCOUNTANT`).
  2. The AI initially placed `roleCan()` inside `parseAmount()` in `server/index.js`, creating a JavaScript scope closure that would throw `ReferenceError: roleCan is not defined` when called by route handlers.
  I corrected the casing to `waiveFine`, placed `PERMISSIONS` and `roleCan` at top-level module scope in `server/index.js`, and tested with `curl`:
  ```bash
  curl -s -X POST http://localhost:3000/api/fees/pay -H "Content-Type: application/json" -d "{\"studentId\":\"STU-2025-001\",\"discount\":500,\"role\":\"RECEPTIONIST\"}"
  ```
  The endpoint returned `403 Forbidden` (`{"success":false,"error":"Your role cannot apply discounts."}`), confirming server-side RBAC enforcement. I also tested entering Cash `5000` + UPI `5000` on Diya Nair in the drawer to confirm the balance preview evaluated to numeric `₹10,000.00` instead of string-concatenated `₹050005000`.

---

## Moment 5: Mandatory Waiver Reason & Fee Desk 1366×768 Redesign (Complaints #7 & #9)
- **What I asked:** "Give me a step-by-step implementation guide to require a written reason for fine waivers (Complaint #7), deduplicate audit logs, and redesign Fee Desk into a responsive master-detail view fitting 1366×768 with zero horizontal scroll (Complaint #9)."
- **What the AI said:** It guided me to enforce a non-empty `body.reason` on `POST /api/fees/waive-fine` (returning `400 Bad Request` if empty), embed the reason into `appendAudit('FEE_WAIVE', ...)`, remove duplicate client-side `recordAudit()` calls, replace the 16-column table with a 7-column list with `truncate max-w-[220px]`, and wrap the drawer payment history in `max-h-44 overflow-y-auto`.
- **What I did:** I implemented the backend waiver validation and redesigned `FeeDesk.jsx`. I verified the solution across multiple test cases at `1366×768` resolution in Chrome:
  1. **Empty Waiver Validation:** Sent a waiver request without reason via `curl`; verified the server responded with HTTP `400` (`"A written reason is required to waive a late fine."`). In the UI, verified the "Waive fine" button remained disabled until text was entered in "Reason for fine waiver *".
  2. **Audit Deduplication:** Waived a fine with reason `"Principal approval"`; opened the Activity drawer and confirmed exactly one `FEE_WAIVE` audit entry was created instead of two.
  3. **Viewport & Extreme Data Stress Test:** Selected Venkatanarasimharajuvaripeta Subramanium (`STU-2025-007`). Confirmed his 38-character name truncated cleanly with an ellipsis without breaking column alignment, his 15 payment receipts scrolled neatly within the `max-h-44` container, and the primary action buttons remained pinned and visible within the 768px height with zero horizontal scrolling across the application.
