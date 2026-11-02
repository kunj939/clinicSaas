# Deployment guide

Target layout:

| Piece | Host | Address (example) |
| --- | --- | --- |
| Static React app | Hostinger Premium (hPanel file manager or FTP) | `https://app.example.com` |
| Node.js API and outbox worker | Managed Node.js hosting (Hostinger Node.js app or similar) | `https://api.example.com` |
| PostgreSQL 13+ | Managed PostgreSQL with TLS | private connection string |
| WhatsApp messages | Meta WhatsApp Cloud API | Meta webhook calls `https://api.example.com/api/webhooks/whatsapp` |

Keep the app and API on **sibling subdomains of the same domain** (`app.example.com`, `api.example.com`). Session cookies are `SameSite=Lax`, which works between sibling subdomains. Cookies would not work if the two sites used different registrable domains.

Steps marked **EXTERNAL** need accounts or actions that only you can complete.

---

## 0. Secrets (do this first)

Generate the field-encryption key once and store it in your host's secret manager:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

This is `DATA_ENCRYPTION_KEY`. Phone numbers and message bodies are encrypted with it. **If you lose it, stored phone numbers become unreadable. If you change it, existing data cannot be decrypted.** Keep a sealed backup in your password manager. Rotation is not implemented.

Also generate and store:

- `WHATSAPP_VERIFY_TOKEN`: any long random string you choose. You enter the same value in Meta.

---

## 1. PostgreSQL (EXTERNAL: create the database)

1. Create a database (for example `clinic_prod`) and a user with ownership of that database only.
2. Note the connection string. It must allow TLS, usually `?sslmode=require` or `DATABASE_SSL=true`.
3. Enable automated daily backups and point-in-time recovery if your provider offers them. Test one restore before go-live.

---

## 2. Build the API

From a clean checkout on your machine or the host's build step:

```bash
npm ci                              # installs all workspaces (Node 22.9+)
npm run build -w @clinic/api        # compiles to apps/api/dist
```

The deployable API is `apps/api`: `dist/`, `migrations/`, `package.json`, plus `node_modules` for production dependencies. Keep `migrations/` with the build; migrations are read from `apps/api/migrations` at runtime.

### Production environment variables (API)

| Variable | Required | Notes |
| --- | --- | --- |
| `NODE_ENV` | yes | `production` |
| `PORT` | host-provided | the host usually sets this; the server reads `PORT` |
| `HOST` | no | default `0.0.0.0` |
| `TRUST_PROXY` | yes | `true` when behind the host's load balancer (secure cookies and rate limits use the client IP) |
| `DATABASE_URL` | yes | the TLS connection string from step 1 |
| `DATABASE_SSL` | yes | `true` for managed PostgreSQL |
| `DATABASE_SSL_REJECT_UNAUTHORIZED` | no | keep `true`; set `false` only if your provider's certificate chain cannot be verified |
| `DATABASE_POOL_MAX` | no | default 10 |
| `DATA_ENCRYPTION_KEY` | yes | from step 0 |
| `APP_ORIGINS` | yes | `https://app.example.com` (no `localhost`; startup fails otherwise) |
| `PUBLIC_API_URL` | yes | `https://api.example.com` (must be https in production) |
| `PUBLIC_APP_URL` | yes | `https://app.example.com` |
| `COOKIE_DOMAIN` | no | leave empty so the cookie is host-only |
| `MESSAGING_PROVIDER` | yes | `mock` until step 5 is finished, then `meta` |
| `SIMULATOR_ENABLED` | no | `false` in production (default is off in production) |
| `WORKER_ENABLED` | no | `true` (runs the outbox sender inside the API process) |
| `DEFAULT_COUNTRY_CODE` | no | `91` for India |
| `REPORT_LINK_TTL_HOURS` | no | default 72 |
| `REPORT_LINK_MAX_USES` | no | default 10 |
| `MAX_REPORT_BYTES` | no | default 5 MB |
| `RATE_LIMIT_AUTH_PER_MINUTE` | no | default 10 per IP for login and signup |
| `LOG_LEVEL` | no | default `info` in production |
| `PAYU_MERCHANT_KEY` | no | PayU merchant key. Leave empty to keep online payments off |
| `PAYU_MERCHANT_SALT` | no | PayU salt. Required together with the key. Secret |
| `PAYU_ENV` | no | `test` (default) or `production`. Use `production` only after PayU approves the live account |

### PayU online payments (EXTERNAL: PayU account)

1. In the PayU dashboard, note the **merchant key** and **salt** for the test environment first. The salt is shown only as a secret; copy it into the server's secret store, not into a file in the repository or a chat.
2. Set `PAYU_MERCHANT_KEY`, `PAYU_MERCHANT_SALT` and `PAYU_ENV=test` on the API host. Restart the API.
3. Staff open **Diary**, enter the fee and create a payment link. The patient opens the link, and PayU's hosted page takes the payment. PayU sends the result to `PUBLIC_API_URL/api/payments/payu/callback`, so this step only works once the API is reachable over https.
4. Test one small payment in test mode. Check that the diary shows the amount as paid by "Online (PayU)".
5. Only then change to the live key and salt with `PAYU_ENV=production`. Live payments need the account's KYC to be approved, which the clinic already has.

The server refuses to start in production if `APP_ORIGINS` contains `localhost`, if `PUBLIC_API_URL` is not https, or if `MESSAGING_PROVIDER=meta` is set without the three WhatsApp secrets.

### Run migrations

Run once per release, before starting the new version:

```bash
DATABASE_URL=... DATABASE_SSL=true DATA_ENCRYPTION_KEY=... npm run migrate:prod -w @clinic/api
```

Migrations are forward-only and each runs in a transaction. Concurrent runs are serialised by an advisory lock. Take a database backup before each release.

### Start the API

```bash
npm run start -w @clinic/api        # node dist/server.js
```

Set the host's start command to `node dist/server.js` (working directory `apps/api`), and its Node version to 22.9 or newer. Configure the health check to `GET /api/health`, which returns `{"status":"ok", ...}` after a database round trip.

The process handles `SIGTERM` by stopping the outbox worker, draining requests, and closing the pool. Running two API instances is safe: the outbox claims rows with `FOR UPDATE SKIP LOCKED`, and webhooks are de-duplicated.

---

## 3. Build the frontend (for Hostinger)

Set the API origin at build time. There is no trailing slash:

```bash
VITE_API_BASE_URL=https://api.example.com npm run build -w @clinic/web
```

The static site is `apps/web/dist/`. It contains `index.html`, `assets/`, `favicon.svg` and **`.htaccess`**. The `.htaccess` file rewrites unknown paths to `index.html`, so deep links such as `/app/reception` work after a refresh. It also sends basic security headers.

### Upload to Hostinger (EXTERNAL)

1. In hPanel, create the subdomain `app.example.com` and point it at a folder such as `public_html/app`.
2. Upload **everything inside `dist/`** to that folder, including the hidden `.htaccess`. File managers often hide dotfiles; enable "show hidden files" or use FTP/SFTP.
3. Enable SSL for the subdomain (Let's Encrypt in hPanel).
4. Open `https://app.example.com`. The landing page should load and the Hindi/English switch should work.

Redeploy by uploading the new `dist/` contents over the old ones. Clear your browser cache if an old bundle is served.

---

## 4. Connect the frontend and the API (EXTERNAL: DNS)

1. Create `api.example.com` pointing at the Node host. Enable SSL there.
2. Confirm the API is reachable: `curl https://api.example.com/api/health`.
3. In the browser, sign up on `https://app.example.com`. The API should set an `HttpOnly`, `Secure`, `SameSite=Lax` cookie named `dc_session` for `api.example.com`.

If login fails with a CORS or origin error, check that `APP_ORIGINS` exactly matches `https://app.example.com` (scheme and no trailing slash).

---

## 5. WhatsApp via Meta (EXTERNAL: required before real patients can book)

Until these steps are done, use `MESSAGING_PROVIDER=mock` and the staff simulator. Nothing is sent to real phones.

1. **Meta Business account and app.** In the Meta for Developers portal, create an app of type *Business* and add the **WhatsApp** product. Complete business verification in Meta Business Manager if the account is not yet verified.
2. **Phone number per clinic.** Register each clinic's WhatsApp number in the app's WhatsApp settings. A number cannot be on the consumer WhatsApp app at the same time. Copy each number's **phone number ID** (numeric). Enter it in the clinic's settings under *WhatsApp phone number ID*. Each ID can belong to only one clinic.
3. **Permanent access token.** In Business Manager, create a *system user* with access to the WhatsApp Business Account and assign the `whatsapp_business_messaging` and `whatsapp_business_management` permissions. Generate a **permanent** token for the app. Set it as `WHATSAPP_ACCESS_TOKEN`. Do not use a temporary test token in production.
4. **App secret.** In the app's *Settings → Basic*, copy the **App secret** into `WHATSAPP_APP_SECRET`. Incoming webhooks are rejected unless their `X-Hub-Signature-256` matches it.
5. **Webhook.** In the app's *WhatsApp → Configuration*, set the callback URL to `https://api.example.com/api/webhooks/whatsapp`, and the verify token to the value of `WHATSAPP_VERIFY_TOKEN`. Click *Verify and save*, then subscribe to the **messages** field.
6. **Notification template.** Business-initiated messages (token confirmations, report-ready and follow-up reminders) fall outside the 24-hour customer service window, so Meta requires an approved template. Create a **Utility** template with a single body variable, for example:

   ```
   Name:     clinic_notice
   Category: UTILITY
   Language: en (add hi as a separate template if you want Hindi notifications)
   Body:     {{1}}
   ```

   Wait for approval. Set `WHATSAPP_NOTIFICATION_TEMPLATE=clinic_notice` and `WHATSAPP_TEMPLATE_LANGUAGE=en`. The app sends the whole message text in `{{1}}`, with line breaks flattened, which is why the body is a bare variable. Approval rules for templates change over time; check them in Meta's current documentation when you submit.

7. **Switch the provider.** Set `MESSAGING_PROVIDER=meta` and `SIMULATOR_ENABLED=false`, then restart the API.
8. **Test with your own number.** Send `BOOK` from a phone, pick a doctor, send a name, and check that the confirmation arrives. Then check **WhatsApp messages** in the app: status should move from *Queued* to *Sent*. If a message stays in *Queued* or shows *Failed*, the error text under it shows the provider status and code (never the message body).

Costs: replies inside a customer's 24-hour window and business-initiated messages are billed by Meta. Check current pricing for your country before you choose quotas. The app's monthly notification quota (`clinics.monthly_message_quota`, default 300) limits the business-initiated messages each clinic can send.

**Not verified in this repository:** the Meta adapter has not been run against the live Cloud API. Expect to adjust the template parameters or the template name in the first live test.

---

## 6. Go-live checklist

- [ ] `DATA_ENCRYPTION_KEY` generated, stored in the secret manager, and backed up.
- [ ] Database has TLS, backups, and a tested restore.
- [ ] `NODE_ENV=production`, `SIMULATOR_ENABLED=false`, `TRUST_PROXY=true`.
- [ ] `APP_ORIGINS`, `PUBLIC_API_URL`, `PUBLIC_APP_URL` use the final https domains.
- [ ] Migrations applied; `GET /api/health` returns ok.
- [ ] Frontend loads over https; deep links work after refresh (`.htaccess` uploaded).
- [ ] Owner signup completes; clinic created; each doctor has a schedule; holidays added.
- [ ] Reception and doctor logins created and tested; temporary passwords changed.
- [ ] Meta steps in section 5 done with a real test number; notification template approved.
- [ ] Hindi copy reviewed by a native speaker (templates in `apps/api/src/modules/messaging/templates.ts`).
- [ ] Patient-facing privacy notice and consent process in place (legal review recommended; see README).
- [ ] Monthly quota set per clinic to match the agreed plan.
- [ ] Error monitoring or log shipping configured for the API host (logs redact tokens and phone numbers).

---

## 7. Operations

- **Quotas:** `UPDATE clinics SET monthly_message_quota = 500 WHERE slug = '...'`. Usage per month is in `clinic_message_usage`.
- **Stuck messages:** `SELECT template_key, status, attempts, last_error, created_at FROM outbound_messages WHERE status <> 'sent' ORDER BY created_at DESC;`. Messages retry with exponential backoff up to six attempts, then show as *Failed*.
- **Retention:** webhook de-duplication records are deleted after 30 days, and expired sessions after a day, by the worker's hourly housekeeping. Audit logs are kept until you delete them. Set a retention policy that matches your legal obligations.
- **Rollback:** deploy the previous API build and frontend bundle. Migrations are not reversed automatically; keep backups before each release.

---

## 8. Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| Login works but the next page redirects to login | Cookie not sent. Check that the API is `https` and the frontend is on a sibling subdomain; check `APP_ORIGINS`. |
| `403 bad_origin` on every save | `APP_ORIGINS` does not exactly match the frontend origin. |
| WhatsApp webhook returns `401 bad_signature` | `WHATSAPP_APP_SECRET` is wrong or was rotated. Re-copy it from Meta. |
| WhatsApp webhook returns `unrouted` in the response | The clinic's *WhatsApp phone number ID* does not match the number Meta is sending from. |
| Patient receives nothing after booking | Check *WhatsApp messages*. "Quota used up" or "No phone" is shown on the booking screen as well. |
| Report link returns "invalid or expired" | Links expire after `REPORT_LINK_TTL_HOURS`, or after `REPORT_LINK_MAX_USES` downloads, or once a newer link was issued. Publish the report again. |
| Hindi text looks broken on Windows | Ensure the browser uses "Nirmala UI" or "Noto Sans Devanagari"; the app's font stack includes both. |
