# Site-as-app Notification Lab

A live, **manifest-free** website for comparing notifications in an ordinary tab
and Edge's **Install this site as an app** window.

**Site:** https://luhuangmsft.github.io/notification-test-site/

| Path | Implementation | Needs an open site document? |
|---|---|---|
| Tab / app window | Page JavaScript calls `new Notification()`, immediately or after a timer | Yes |
| Real Web Push | GitHub Actions -> browser push service -> SW `push` event -> `showNotification()` | No |

This is a diagnostic sample, not a Dynamics replica. The push button subscribes
the browser; it does **not** substitute a page-triggered `showNotification()` for
network push. No worker is registered on initial page load, and no web app
manifest is supplied. The worker has no offline cache or fetch interception.

## Test it

1. Open the live site in Edge and allow notifications. If permission is blocked,
   change the site's Notifications permission through its address-bar site settings.
2. Before subscribing, install through **Settings and more > More tools > Apps >
   Install this site as an app**. This tests installation of a plain website.
3. Use **Send tab notification now**, or schedule one and minimize the app.
   The document must remain open. Closing it destroys its timers; background
   throttling, sleeping tabs, or OS suspension can delay them.
4. Subscribe to push in that browser profile, then download the private
   subscription JSON. As the repository owner, save it using PowerShell:

   ```powershell
   Get-Content .\notification-test-subscription.json -Raw |
     gh secret set WEB_PUSH_SUBSCRIPTION --repo LuHuangMSFT/notification-test-site
   ```

   GitHub CLI must be signed into an account with permission to manage this
   repository's secrets. Alternatively, paste the file into a secret named
   `WEB_PUSH_SUBSCRIPTION` under **Settings > Secrets and variables > Actions**.
   **Never commit the file or put subscription JSON in workflow inputs.**
5. Open **Actions > Send Web Push > Run workflow** on `main`. Choose a delay
   from 0 to 300 seconds, a synthetic title/body, and optional persistent-reminder
   behavior. Close this site's tabs and app windows before the send step fires.
   Workflow queue time is separate from the requested delay.
6. Observe the OS notification, then reopen the site and inspect its event log.
   `push-received` and `push-show-resolved` are persisted by the worker even with
   no page open. Check Notification Center and transient banners independently.

Only repository writers can dispatch the sender. Public visitors can test page
notifications and subscribe locally, but cannot send from this repository's
Actions workflow. There is **one target subscription** in the secret: replace
it to target a different browser/profile/device. Tabs and app windows in the same
profile and project scope normally share it.

## What the evidence means

- `tab-requested`: the document called the Notification API.
- `tab-show`: the browser emitted the document notification's show event.
- Sender HTTP success: the browser's push service accepted the encrypted message.
- `push-received`: the service worker handled an actual push event.
- `push-show-resolved`: `registration.showNotification()` resolved.
- Windows Notification Center / banner: must be inspected separately. Neither
  API resolution nor push-service acceptance proves OS presentation.

Installed sites can use `minimal-ui`, not just `standalone`. A normal tab can
also use an installed app's native notification collection; window type alone
does not determine Windows routing.

An open tab is not required for push, but a working browser/OS push integration
is. Fully quitting the browser, disabled background operation, revoked
permission, expired subscriptions, Do Not Disturb, or OS notification settings
may delay or suppress delivery. Push messages expire after 300 seconds.

## Deployment and secrets

GitHub Pages serves **only `site/`**. The private sender runs in Actions.

- `site/config.json`: repository name and **public** VAPID key.
- `VAPID_PRIVATE_KEY`: repository Actions secret; never published.
- `WEB_PUSH_SUBSCRIPTION`: repository Actions secret; entered by the owner for the
  chosen test browser. It contains a sensitive endpoint and encryption keys.

For a new repository/fork, update `repository` in `site/config.json`, clear its
public key, and run `npm ci` followed by `npm run configure` while GitHub CLI is
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

CI installs Playwright Chromium and runs the same browser suite before deploying.
Unit tests cover push payloads, endpoint validation, encryption, worker display
and failure handling, click routing, and the absence of a manifest. Browser tests
exercise the actual page Notification API, document timers, worker activation,
and IndexedDB persistence. Automated headless checks do **not** establish native
Windows presentation or real push-service delivery; use the live procedure above.

For native Windows Edge checks, use an unsigned-in test profile inside Edge's
normal user-data directory. A custom `--user-data-dir` can disable Edge's native
notification bridge and create a false failure.

## Privacy and cleanup

There is no analytics or custom subscription-collection backend. The site stores
at most 100 diagnostic events in this browser profile's IndexedDB. Log exports
contain page URL, browser version, and synthetic event details, not subscription
credentials. GitHub serves the page and processes Actions secrets; the browser's
push provider receives push messages when the owner sends them.

Unsubscribe in the site, remove the `WEB_PUSH_SUBSCRIPTION` secret, close test
notifications, and clear the local event log when finished. Uninstall the test
app and remove only the disposable profile if one was created. Older document
notifications can outlive their page; dismiss those individually in Notification
Center, not with its global Clear all command.
