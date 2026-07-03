# GSC → Slack SEO Alert Automation

Automated monitoring of Google Search Console (GSC) performance for multiple SEO
projects, with alerts posted to Slack when clicks, impressions, CTR, or average
position move beyond configured thresholds.

**Stack:** Google Apps Script · Google Sheets (config + log DB) · GSC Search
Analytics API · Slack Incoming Webhooks. No Zapier.

---

## 1. What's in this folder

| File | Purpose |
|------|---------|
| `Code.gs` | Full Apps Script (all functions). |
| `appsscript.json` | Manifest with the required OAuth scopes. |
| `README.md` | This setup + operations guide. |

---

## 2. How it works

- Compares the **last 7 complete days** (excluding the most recent 3, because GSC
  data lags) against the **previous 7-day period**.
- Pulls `clicks`, `impressions`, `ctr`, and `average position` per property.
- Applies per-project thresholds and global noise guards.
- Sends one clean Slack message per project when something crosses a threshold,
  and logs **every** alert (including errors) to the `Alert Log` sheet.
- Also checks **top pages by clicks** and lists the 5 worst decliners.

---

## 3. Google Sheet setup

1. Create a new Google Sheet (this becomes your config + log database).
2. **Extensions → Apps Script**. Delete the starter `Code.gs` and paste in the
   contents of `Code.gs` from this folder.
3. Click the manifest (⚙️ **Project Settings → “Show appsscript.json”**), then
   replace it with the contents of `appsscript.json` from this folder.
4. Back in the editor, select `setupSheets` from the function dropdown and click
   **Run**. Approve the permissions prompt (see §6).
5. This creates three tabs:

**Projects** — one row per property to monitor:

| Column | Example | Notes |
|--------|---------|-------|
| Project Name | Quincy's Air | Shown in Slack. |
| GSC Property URL | `https://quincysair.com/` or `sc-domain:quincysair.com` | Must match GSC exactly. |
| Slack Webhook URL | `https://hooks.slack.com/services/...` | Per-project channel. |
| Status | `active` | Only `active` rows are checked. |
| Click Drop Threshold % | 30 | Alert if clicks fall ≥ this %. |
| Impression Drop Threshold % | 30 | Alert if impressions fall ≥ this %. |
| CTR Drop Threshold % | 25 | Alert if CTR falls ≥ this %. |
| Position Worsening Threshold | 3 | Alert if avg position rises by ≥ this. |
| Check Type | `both` | `summary`, `pages`, or `both`. |
| Notes | free text | Optional. |

**Alert Log** — append-only history (timestamp, metrics, change %, `Slack Sent`,
notes). Errors are logged here too, with `Slack Sent = No`.

**Settings** — global knobs:

| Setting | Default |
|---------|---------|
| Data Delay Days | 3 |
| Comparison Window Days | 7 |
| Minimum Clicks Before Alert | 10 |
| Minimum Impressions Before Alert | 100 |
| Enable Page Level Alerts | yes |
| Enable Query Level Alerts | no |

Blank threshold cells fall back to safe defaults, so the script never crashes on
an empty field.

---

## 4. Slack webhook setup

1. Go to <https://api.slack.com/apps> → **Create New App → From scratch**.
2. Name it (e.g. “GSC Alerts”) and pick your workspace.
3. **Incoming Webhooks → toggle On → Add New Webhook to Workspace**.
4. Choose the channel for that client and **Allow**.
5. Copy the webhook URL (`https://hooks.slack.com/services/...`).
6. Paste it into the **Slack Webhook URL** column for that project.
   Use a separate webhook/channel per client so alerts route correctly.

---

## 5. Enabling the Google Search Console API

1. In the Apps Script editor: **Project Settings → “Show appsscript.json”** and
   confirm the three OAuth scopes are present (they are in the provided manifest).
2. The script calls the GSC Search Analytics REST API directly with your
   authorized OAuth token — no separate Cloud project or API key is required for
   the default (Apps Script–managed) setup. On first run you'll be asked to
   authorize; approve it.
3. If your org uses a **standard GCP project**, also enable the **Google Search
   Console API** in that project's API Library.

**Required OAuth scopes** (already in `appsscript.json`):

- `https://www.googleapis.com/auth/webmasters.readonly`
- `https://www.googleapis.com/auth/script.external_request`
- `https://www.googleapis.com/auth/spreadsheets`

---

## 6. Authorizing the script

1. Run `setupSheets` (or `runGscSlackAlerts`) once from the editor.
2. Click **Review permissions → choose your Google account → Allow**.
3. The account you authorize with **must have at least Restricted/Full access to
   every GSC property** listed in the Projects sheet. If it doesn't, that project
   returns a 403 and is logged as an error (Slack Sent = No).

---

## 7. Testing manually

1. Fill in at least one real project row (property URL + Slack webhook, Status =
   `active`).
2. In the editor, select `runGscSlackAlerts` → **Run**.
3. Check:
   - **Executions** panel for errors.
   - The **Alert Log** tab for a new row.
   - Your Slack channel for a message (only if a threshold was crossed).
4. To force a test alert, temporarily set a threshold very low (e.g. Click Drop
   Threshold % = 1) on a property with real traffic, run, then set it back.

---

## 8. Scheduling daily alerts

Run `createDailyTrigger` once from the editor. It installs a time-based trigger
that runs `runGscSlackAlerts` every day around 9am (script timezone). Re-running
it replaces the old trigger, so it won't create duplicates. You can also manage
triggers under the ⏰ **Triggers** icon in the editor.

---

## 9. Adding more clients later

1. Add a new row to the **Projects** tab.
2. Fill in Project Name, GSC Property URL, Slack Webhook URL, and set Status =
   `active`.
3. Set thresholds (or leave blank to use defaults) and Check Type.
4. Make sure the authorized Google account has GSC access to the new property.
5. Done — the next daily run (or a manual `runGscSlackAlerts`) picks it up. No
   code changes needed.

---

## 10. Recommended default thresholds

Tuned to catch real SEO movement without daily noise:

| Metric | Conservative (fewer alerts) | Balanced (recommended) | Sensitive (more alerts) |
|--------|------|------|------|
| Click Drop % | 40 | **30** | 20 |
| Impression Drop % | 40 | **30** | 20 |
| CTR Drop % | 30 | **25** | 15 |
| Position Worsening | 5 | **3** | 2 |
| Min Clicks Before Alert | 25 | **10** | 5 |
| Min Impressions Before Alert | 250 | **100** | 50 |
| Page Drop % (fixed in code) | — | **25** | — |

Larger sites generate more variance, so lean conservative for high-traffic
properties and sensitive for smaller ones.

---

## 11. Alert rules summary

An alert fires when **any** of these are true (subject to the noise guards):

- Clicks dropped ≥ the project's Click Drop Threshold.
- Impressions dropped ≥ the Impression Drop Threshold.
- CTR dropped ≥ the CTR Drop Threshold.
- Average position worsened by ≥ the Position Worsening Threshold.
- **Opportunity:** impressions up ≥ 10% but clicks flat or down.
- A key page lost > 25% of clicks or impressions.

**Noise guards:** no alert if previous clicks < Min Clicks *and* previous
impressions < Min Impressions; individual metric rules also respect their
minimums; and no duplicate alert is sent for the same project + date range
(tracked via the Alert Log).

---

## 12. Error handling

Every failure mode is caught and written to the **Alert Log** with
`Slack Sent = No`:

- Invalid / missing GSC Property URL.
- No GSC data returned (logged as `No Data`).
- Missing Slack webhook (logged; alert still recorded).
- GSC API errors, including **403 unauthorized** and **404 not found**.
- Slack webhook failures (non-200 response).
- Empty thresholds (fall back to defaults).
- Broken/missing sheet structure (setup errors logged as `SYSTEM`).

One project failing never stops the others.

---

## 13. Troubleshooting checklist

- **No Slack message?** Check the Alert Log — a row with `Slack Sent = No` shows
  the reason. If there's no row at all, nothing crossed a threshold.
- **403 in the log?** The authorized Google account lacks access to that GSC
  property. Add it in Search Console.
- **404 in the log?** The GSC Property URL doesn't match. Use the exact form from
  GSC — `https://example.com/` (URL-prefix) or `sc-domain:example.com` (domain).
- **`No Data`?** The property may be new, or the window falls outside available
  data. Increase Data Delay Days.
- **Slack failed (non-200)?** The webhook is wrong/revoked. Recreate it (§4).
- **Too many alerts?** Raise thresholds or the minimums (§10).
- **No alerts ever?** Lower a threshold on a real-traffic property to confirm the
  pipeline, then restore it.
- **Permissions error on run?** Re-authorize: run any function and click **Review
  permissions**, and confirm all three scopes in `appsscript.json`.
- **Duplicate alerts?** Shouldn't happen — dedupe is keyed on project + date
  range in the Alert Log. Don't delete Alert Log rows for the current window.

---

## 14. Note on query-level alerts

`Enable Query Level Alerts` defaults to `no`. The pipeline is summary + page
level today; query-level monitoring can be layered on using the same
`queryGsc_` helper with `dimensions: ['query']` if needed later.
