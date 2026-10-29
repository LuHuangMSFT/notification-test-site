# Site-as-app Notification Lab

A live, **manifest-free** website for comparing notifications in an ordinary tab
and Edge's **Install this site as an app** window.

**Site:** https://luhuangmsft.github.io/notification-test-site/

| Path | Implementation | Needs an open site document? |
|---|---|---|
| Tab / app window | Page JavaScript calls `new Notification()`, immediately or after a timer | Yes |
| Service worker (simple) | Page `postMessage()` -> SW `message` event -> `showNotification()` | Yes, to trigger it and receive confirmation; the notification can outlive the page |
| Real Web Push (optional advanced) | GitHub Actions -> browser push service -> SW `push` event -> `showNotification()` | No |

This is a diagnostic sample, not a Dynamics replica. **The two primary tests
need no push subscription, credentials, GitHub account, or notification server.**
The simple worker test is explicitly page-triggered, not simulated network push.
No worker is registered on initial page load, and no web app
manifest is supplied. The worker has no offline cache or fetch interception.

## Test it

1. Open the live site in Edge and allow notifications. If permission is blocked,
   change the site's Notifications permission through its address-bar site settings.
2. Before using the worker test, install through **Settings and more > More tools > Apps >
   Install this site as an app**. This tests installation of a plain website.
3. Use **Send tab notification now**, or schedule one and minimize the app.
   The document must remain open. Closing it destroys its timers; background
   throttling, sleeping tabs, or OS suspension can delay them.
4. Click **Send service-worker notification**. The site registers and activates
   its worker automatically, sends it a message, and waits for confirmation that
   the worker's `showNotification()` completed. No subscription setup is needed.
5. Check Windows banners and Notification Center separately, then download the
   diagnostic report. Repeat in an ordinary tab and in the installed app.

The simple worker test must be triggered while the page is open. It creates a
browser-managed notification that can outlive the page; it does **not** prove
incoming delivery after closing the app or quitting the browser. There is no
worker timer pretending to be reliable background push.

## Optional: real Web Push

The existing network-push setup is retained under the collapsed **Optional: real
Web Push (advanced)** section. Skip it for the primary tests above.

1. Open that section and subscribe in the target browser profile, then download the private
   subscription JSON. As the repository owner, save it using PowerShell:

   ```powershell
   Get-Content .\notification-test-subscription.json -Raw |
     gh secret set WEB_PUSH_SUBSCRIPTION --repo LuHuangMSFT/notification-test-site
   ```

   GitHub CLI must be signed into an account with permission to manage this
   repository's secrets. Alternatively, paste the file into a secret named
   `WEB_PUSH_SUBSCRIPTION` under **Settings > Secrets and variables > Actions**.
   **Never commit the file or put subscription JSON in workflow inputs.**
2. Open **Actions > Send Web Push > Run workflow** on `main`. Choose a delay
   from 0 to 300 seconds, a synthetic title/body, and optional persistent-reminder
   behavior. Close this site's tabs and app windows before the send step fires.
   Workflow queue time is separate from the requested delay.
3. Observe the OS notification, then reopen the site and inspect its event log.
   `push-received` and `push-show-resolved` are persisted by the worker even with
   no page open. Check Notification Center and transient banners independently.

Only repository writers can dispatch the sender. Public visitors can test page
and simple worker notifications and subscribe locally, but cannot send from this repository's
Actions workflow. There is **one target subscription** in the secret: replace
it to target a different browser/profile/device. Tabs and app windows in the same
profile and project scope normally share it.

## Collect customer diagnostics

After reproducing a problem, click **Download diagnostic report**. Send
`notification-test-diagnostics.json`, the approximate test time, whether the test
used a tab or installed app, and whether a banner and/or Notification Center
entry appeared. Export before clearing browser data or uninstalling. For push,
reopen the site in the same profile after delivery, then export; include the
sender's Actions run URL so the message ID can be correlated.

The report includes the lab version, browser/OS user agent, secure context,
permission, display mode, focus/visibility, online hint, worker/controller states,
subscription presence (not credentials), pending timers, and the latest 500
timestamped page/worker events. Context IDs distinguish documents and worker
lifetimes; notification IDs link timer/request/display events and the sender.
Failures include the operation, error name/message, and sanitized stack when
available. Registration, activation, subscription, permission changes, runtime
errors, and unhandled rejections are recorded.

For DevTools, enable **Preserve log** and Info/Warning/Error, and filter Console
for **Notification Lab**. Live page events appear in the page console; worker
events appear in its own console under **Application > Service workers > Inspect**.
The page's **Print saved diagnostics to console** button replays saved events from
both contexts into the page console, including background events after reopening.
Leave worker DevTools closed while testing worker suspension/background delivery,
because inspecting it can keep it alive.

If IndexedDB fails, the page displays a storage warning and retains a bounded
in-memory log for export while that document remains open. Notifications still
run; persistence is not claimed. A storage timeout is reported after 3 seconds
per operation; after a storage failure, further I/O is skipped until reload or a
successful log clear. If the page cannot load its JavaScript at all, collect the native
DevTools Console/Network errors instead; the in-page exporter cannot run.

**Never send `notification-test-subscription.json` as diagnostics.** It contains
private delivery credentials. Diagnostic reports do not collect subscription
endpoints/keys, strip page query strings/fragments, and redact URLs and key-like
values from captured errors. They still include browser details and synthetic
notification titles: review them before sharing. Reports stay local until the
customer explicitly downloads/shares them; nothing is uploaded automatically.

## What the evidence means

- `tab-requested`: the document is about to call the Notification API.
- `tab-created`: the Notification constructor returned successfully.
- `tab-show`: the browser emitted the document notification's show event.
- `worker-requested`: the page is about to send its request to the worker.
- `worker-received`: the worker received the page's message, not a push event.
- `worker-display-requested` / `worker-show-resolved`: the worker called
  `showNotification()` / its promise resolved.
- `worker-acknowledged`: the page received the worker's completion response.
  A missing response is reported as an error after 15 seconds, not as success.
- Sender HTTP success: the browser's push service accepted the encrypted message.
- `push-received`: the service worker handled an actual push event.
- `push-display-requested`: the worker is about to call `showNotification()`.
- `push-show-resolved`: `registration.showNotification()` resolved.
- Windows Notification Center / banner: must be inspected separately. Neither
  API resolution nor push-service acceptance proves OS presentation.

No `push-received` event alone cannot distinguish an unsent push from a push
transport/browser failure or an expired local log; compare the sender run.
The website cannot read Windows Do Not Disturb, OS notification settings, or
enterprise policy state. The online field is only the browser's connectivity
hint, not proof it can reach the push service.

Installed sites can use `minimal-ui`, not just `standalone`. A normal tab can
also use an installed app's native notification collection; window type alone
does not determine Windows routing.

An open tab is not required for push, but a working browser/OS push integration
is. Fully quitting the browser, disabled background operation, revoked
permission, expired subscriptions, Do Not Disturb, or OS notification settings
may delay or suppress delivery. Push messages expire after 300 seconds.

## Deployment and secrets

GitHub Pages serves **only `site/`**. The private optional push sender runs in Actions.
The primary notification tests do not depend on push configuration or secrets.

- `site/config.json`: repository name and **public** VAPID key.
- `VAPID_PRIVATE_KEY`: repository Actions secret; never published.
- `WEB_PUSH_SUBSCRIPTION`: repository Actions secret; entered by the owner for the
  chosen test browser. It contains a sensitive endpoint and encryption keys.

For a new repository/fork, update `repository` in `site/config.json` and clear its
public key. The primary tests can be deployed without configuring push keys.
Only for optional real push, run `npm ci` followed by `npm run configure` while GitHub CLI is
authenticated as its owner. This generates a VAPID pair, uploads the private key
directly through stdin to `gh secret set`, and writes only the public key to the
site. Enable Pages with **GitHub Actions** as the source, then commit and push.
Do not rotate keys without re-subscribing test browsers.

The sender accepts standard HTTPS FCM, WNS, and Mozilla push endpoints. Other
providers are explicitly rejected; add a reviewed provider allowlist entry if
needed. Inputs are passed as environment variables, never interpolated into a
shell command. Sender errors do not print subscription endpoints or key material.
Workflow inputs and run logs are public: use synthetic titles and bodies only.

## Local development

Requires Node.js 22+:

```powershell
npm ci
npm start
# Open http://localhost:8769/notification-test-site/
```

Localhost is a secure context. Its subscription is different from the HTTPS
GitHub Pages subscription.

```powershell
npm test
$env:PLAYWRIGHT_CHANNEL = "msedge" # use an existing Edge installation on Windows
npm run test:browser
```

CI installs full Playwright Chromium and runs the same browser suite in its new
headless mode before deploying. The separate headless shell reports notification
permission as denied even after an automation grant, so it is not used here.
Unit tests cover push payloads, endpoint validation, encryption, worker display
and failure handling, click routing, and the absence of a manifest. Browser tests
exercise the actual page Notification API, document timers, page-to-worker messaging,
worker notifications without a subscription, worker activation/upgrades,
IndexedDB persistence, console/report capture, and injected failure/redaction cases.
Automated headless checks do **not** establish native
Windows presentation or real push-service delivery; use the live procedure above.

For native Windows Edge checks, use an unsigned-in test profile inside Edge's
normal user-data directory. A custom `--user-data-dir` can disable Edge's native
notification bridge and create a false failure.

## Privacy and cleanup

There is no analytics or custom subscription-collection backend. The site stores
at most 500 diagnostic events in this browser profile's IndexedDB. Log exports
contain page URL, browser version, and synthetic event details, not subscription
credentials. GitHub serves the page and processes Actions secrets; the browser's
push provider receives push messages when the owner sends them.

Close test notifications and clear the local event log when finished. If you
used optional real push, unsubscribe in its advanced section and remove the
`WEB_PUSH_SUBSCRIPTION` secret. Uninstall the test
app and remove only the disposable profile if one was created. Older document
notifications can outlive their page; dismiss those individually in Notification
Center, not with its global Clear all command.
