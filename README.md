# Clinic Queue: doctor clinic SaaS

Multi-tenant clinic software for small and mid-size clinics. Patients book next-day serial tokens on WhatsApp. Reception manages WhatsApp, phone and walk-in patients in one queue. Doctors work through their own list, write visit notes, set follow-ups and publish reports that patients open through a secure, expiring link.

Stack: React + Vite + TypeScript + Tailwind (static frontend), Node.js + Fastify + Zod + PostgreSQL (API). No PHP, no VPS-only features, no paid AI dependency.

Deployment steps, including the external Meta/WhatsApp and Hostinger setup, are in [DEPLOYMENT.md](DEPLOYMENT.md).

## What is included

| Module | Where |
| --- | --- |
| Public website (EN/HI) | [apps/web/src/pages/LandingPage.tsx](apps/web/src/pages/LandingPage.tsx) |
| Signup, login, logout, password change | [apps/api/src/auth](apps/api/src/auth) |
| Clinic onboarding and settings | [apps/api/src/modules/clinic](apps/api/src/modules/clinic) |
| Owner dashboard, staff logins (owner resets passwords) | [apps/web/src/pages/owner](apps/web/src/pages/owner) |
| Doctors, weekly schedules, clinic holidays | [apps/api/src/modules/doctors](apps/api/src/modules/doctors) |
| Token queue, atomic allocation, check-in, call next, no-show, cancel | [apps/api/src/modules/tokens](apps/api/src/modules/tokens) |
| Receptionist dashboard (queue, booking, patients, follow-ups, messages) | [apps/web/src/pages/reception](apps/web/src/pages/reception) |
| Patient records and history | [apps/api/src/modules/patients](apps/api/src/modules/patients) |
| Doctor workspace: visit notes, follow-ups, report upload and publish | [apps/web/src/pages/doctor](apps/web/src/pages/doctor), [apps/api/src/modules/visits](apps/api/src/modules/visits), [apps/api/src/modules/reports](apps/api/src/modules/reports) |
| Medicine-based follow-ups: the reminder date is the medicine end minus a clinic lead time, sent automatically on the due date | [apps/api/src/modules/visits/service.ts](apps/api/src/modules/visits/service.ts) |
| Daily diary: the day's patients with medicine, next visit, fee and payment; totals by payment method | [apps/api/src/modules/diary](apps/api/src/modules/diary), [apps/web/src/pages/shared/DiaryPage.tsx](apps/web/src/pages/shared/DiaryPage.tsx) |
| WhatsApp bot: language choice (9 Indian languages), welcome, name, age, number confirmation, booking day (up to 7 days ahead), doctor choice and token; click-to-chat booking link; STATUS and CANCEL | [apps/api/src/modules/whatsapp](apps/api/src/modules/whatsapp) |
| WhatsApp adapters: mock and Meta Cloud API | [apps/api/src/modules/messaging/adapters.ts](apps/api/src/modules/messaging/adapters.ts) |
| Outbox, retries, notification quotas | [apps/api/src/modules/messaging](apps/api/src/modules/messaging) |
| One plan with everything included, billed monthly or on a 6-month commitment; the clinic chooses which languages it offers | [apps/api/src/modules/clinic/service.ts](apps/api/src/modules/clinic/service.ts), [apps/web/src/pages/owner/SettingsPage.tsx](apps/web/src/pages/owner/SettingsPage.tsx) |
| Audit log (owner view) | [apps/api/src/modules/audit](apps/api/src/modules/audit) |
| Migrations | [apps/api/migrations](apps/api/migrations) |

## Engineering guarantees and where they live

- **Atomic token allocation.** Each doctor-day row holds a capacity and two counters. Each booking advances them with one conditional `UPDATE ... WHERE active_count < capacity`, so concurrent bookings cannot oversell or reuse a number. A partial unique index blocks a second live token for the same patient on the same day. Covered by a 30-way concurrent booking test. See [apps/api/src/modules/tokens/service.ts](apps/api/src/modules/tokens/service.ts).
- **Duplicate webhook protection.** Each Meta message id is recorded in a primary-keyed table in the same transaction that processes it. A retry is acknowledged without being processed again. Outbound notifications are de-duplicated with `dedupe_key` unique constraints.
- **Clinic data isolation.** Every tenant table carries `clinic_id`, and every query filters on the caller's clinic. Cross-clinic access returns 404. Doctors are limited to their own queue and visits. Tested in [apps/api/test/integration/auth-tenancy.test.ts](apps/api/test/integration/auth-tenancy.test.ts).
- **Secure report access.** Files are checked by their magic bytes, not the declared type. They are stored in PostgreSQL and served with `Content-Disposition`, `nosniff`, `no-store` and a sandboxed CSP. Patient links are random 256-bit secrets stored only as SHA-256 hashes, expire after 72 hours by default, have a use limit, and are revoked when a report is published again.
- **Low-cost messaging.** Replies inside a patient's open conversation do not count against quota. Business-initiated notifications (token confirmation, report ready, follow-up reminder) reserve one unit from a monthly per-clinic quota atomically. Exhausted quota is reported to the user, not silently dropped.
- **Privacy.** Phone numbers and message bodies are encrypted with AES-256-GCM. Lookups use an HMAC blind index, so plain numbers are not stored. Staff see masked numbers (`+91******3210`) except on the patient record. Logs redact cookies, passwords and phone fields, and strip report link tokens. Audit metadata holds identifiers and status only.
- **Auth.** Session cookies are HttpOnly, SameSite=Lax and Secure in production. Only the hash of the session secret is stored. Passwords use scrypt. Login is rate-limited and locks after five failures. Sessions are revoked on logout, password change, deactivation and owner reset. State-changing requests from unknown origins are rejected.

## Repository layout

```
apps/
  api/        Fastify API, migrations, outbox worker, tests
    migrations/   SQL migrations, applied in order by `npm run migrate`
    src/          config, db, auth, modules/*, server entry
    test/unit/    pure-logic tests (no database needed)
    test/integration/  full API tests against a real PostgreSQL
  web/        React SPA (Vite), bilingual UI, Vitest tests
    public/.htaccess  SPA routing and security headers for Hostinger/Apache
```

## Requirements

- Node.js 22.9 or newer (tested on Node 24.21)
- PostgreSQL 13 or newer (tested on PostgreSQL 18.4)
- npm 10 or newer (npm workspaces)

## Run it locally

```bash
npm install

# 1. Create a database and an environment file
createdb clinic_dev                      # or use any PostgreSQL client
cp apps/api/.env.example apps/api/.env   # then set DATABASE_URL and DATA_ENCRYPTION_KEY
cp apps/web/.env.example apps/web/.env.local  # optional; empty works with the dev proxy

# 2. Apply migrations
npm run migrate -w @clinic/api

# 3. Start the API (port 4000) and the web app (port 5173) in two terminals
npm run dev:api
npm run dev:web
```

Open http://localhost:5173 and create an owner account. The first screen asks for the clinic name, the doctor's name, the days and hours the doctor sees patients, and the booking cut-off time. One click creates all of it. Later, **Settings** holds the doctor's schedule, holidays, reception logins and the audit log. Try the WhatsApp bot from **WhatsApp messages → WhatsApp simulator** (on by default with the mock provider). Type `BOOK`, pick a doctor, send a name and a token is issued.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev:api` | API with reload (`tsx`) on :4000 |
| `npm run dev:web` | Vite dev server on :5173, proxies `/api` to :4000 |
| `npm run build` | Compiles the API to `apps/api/dist` and builds the static web app to `apps/web/dist` |
| `npm run typecheck` | Type-checks both apps |
| `npm test` | Runs API unit and integration tests, then web tests |
| `npm run migrate -w @clinic/api` | Applies pending migrations (dev) |
| `npm run migrate:prod -w @clinic/api` | Applies pending migrations from the compiled build |

## Tests

```bash
npm test                                         # unit + web always run; API integration needs a database
TEST_DATABASE_URL=postgres://user:pass@localhost:5432/clinic_test npm test
```

**Integration tests drop and recreate the `public` schema of `TEST_DATABASE_URL`.** Point them only at a disposable database, never at a production or shared one. Without the variable those suites are skipped, not failed.

Current results on this machine (PostgreSQL 18.4, Node 24.21):

- API: 127 passing (38 unit, 89 integration). Includes PayU hash checks, tampered and repeated callbacks, and failed payments. Includes the 30-way concurrent booking test, duplicate webhook replay, webhook signature checks, quota exhaustion under concurrency, outbox retry and give-up, report upload validation, link expiry, use limits and revocation, and cross-clinic isolation.
- Web: 19 passing (clinic language menu, language switching with English fallback, routing and roles, Hindi/English dictionary parity, error messages, date handling, the one-screen setup form, the daily diary, render smoke tests for the owner, reception and doctor screens).
- Builds: `tsc` for the API and `vite build` for the web app both succeed. The web bundle is about 112 kB gzipped.
- End to end through the Vite proxy: signup, clinic and schedule setup, staff login, walk-in token, queue read, logout, and rejection of a cross-origin write.

## Known limits and external work

- **Meta/WhatsApp is not verified live.** The Cloud API adapter is implemented and unit-tested against the documented request shape, but it has not been exercised with a real WhatsApp number. Meta app setup, business verification, number registration and template approval are manual steps; see [DEPLOYMENT.md](DEPLOYMENT.md).
- **Hostinger is not verified live.** The frontend is a static build with the `.htaccess` rewrite. The API must run on a Node host that can reach PostgreSQL over TLS.
- **Visual and responsive QA was not done in a real browser.** The screens are type-checked, built and render-tested in jsdom, but they still need a manual pass on phones and in Hindi (font rendering and line breaks).
- **Billing is set by hand.** There is no billing system yet. The platform records each clinic's billing term and end date in the database (`UPDATE clinics SET billing_term = 'six_months', subscription_ends_at = '2027-04-30' WHERE slug = '...';`). Every clinic gets the same features; the only choice is 1 month or 6 months. Prices are not in the app yet.
- **Nine languages, uneven coverage.** English and Hindi are complete. Marathi, Gujarati, Bengali, Tamil, Telugu, Kannada and Punjabi cover the core screens and the whole WhatsApp booking conversation; anything else shows in English, so no screen is blank. All copy except Hindi was written by the developer. Have a native speaker review each language before launch, and translate the rest of the app and the reminder messages.
- **Hindi copy is written by the developer.** Have a native speaker review the patient-facing messages in [apps/api/src/modules/messaging/templates.ts](apps/api/src/modules/messaging/templates.ts) and the UI strings before launch.
- **Reports are stored in PostgreSQL** (up to 5 MB each by default). This suits small clinics. Move to object storage before scale.
- **No self-service password reset.** Owners reset staff passwords from the staff screen. Owner accounts have no reset yet.
- **No billing.** Monthly notification quotas are a column on `clinics` (`monthly_message_quota`), set by whoever runs the platform.
- **Online payments use PayU's hosted page.** Staff create a payment link from the diary and send it to the patient. The patient pays on PayU's page, and the amount is recorded when PayU's signed result arrives. Card and bank details never reach this app. Sending the link is manual (copy it into WhatsApp); there is no automatic payment-link message, and refunds are done in the PayU dashboard. Callbacks need the API on a public HTTPS address (`PUBLIC_API_URL`), so online payment cannot be tested end to end on `localhost`.
- **Manual payments are recorded, not collected.** Cash, UPI, card and other payments that happen at the desk are entered by hand. Automatic follow-up reminders count against the monthly quota, and a reminder that finds the quota used up is not sent.
- **Encryption key rotation is not implemented.** Keep `DATA_ENCRYPTION_KEY` safe and never change it without a re-encryption plan.
- **Privacy law.** The app stores patient health-related records and phone numbers. Check your obligations (for example under India's Digital Personal Data Protection Act, 2023) before going live, including consent, retention, and patient access and deletion requests. Only a patient-data export and deletion flow is missing; the rest of the data model supports it.
- **Message Quality and template rules** are set by Meta. Business-initiated notifications must use approved templates. The bot's replies assume the patient wrote first within 24 hours.
