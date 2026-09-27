# Pella Render Recorder v20.22

Wispbyte-focused build with Render-optimized Playwright Chromium headless-shell installation to reduce disk usage.

## Wispbyte
Use Node.js 22.

Startup command can remain Wispbyte's default command that runs `npm install` and then `node index.js`.
`package.json` now has a `postinstall` script that runs:

`PLAYWRIGHT_BROWSERS_PATH=0 npx playwright install chromium`

The server also auto-installs the Chromium headless shell at first recording attempt if the browser binary is missing.

The app binds to `0.0.0.0` and prefers `SERVER_PORT`, then `PORT`, then 10896.

## Render
Build:
`npm install && PLAYWRIGHT_BROWSERS_PATH=0 npx playwright install chromium`

Start:
`npm start`

Health:
`/health`

## Render setup

Build command:
```text
npm install && PLAYWRIGHT_BROWSERS_PATH=0 npx playwright install chromium
```

Start command:
```text
npm start
```

Health check:
```text
/health
```

Render uses `PORT=10000`. The application binds to `0.0.0.0`. The browser is installed at build time, not during recording.


Render Node version: 22.23.2 (.node-version).

## UI state effect
When recording is active, the full page gets a blue/cyan animated Edge Glow and the single action button becomes a red Stop Recording button in the same position. When recording stops, the glow and red state turn off and the button returns to Start Recording.

## v20.12 interactive Live Screen Preview

While a recording is running, the Live Screen Preview is interactive. Click or tap the preview to send the input to the same Playwright browser page being recorded. Mouse-wheel/trackpad scrolling is also forwarded.

The preview uses screenshot frames, so it is not a full 60 FPS remote-desktop stream; input is sent directly to the live page while the next preview frame appears.

Keep the recorder panel private when using interactive control because anyone who can access the panel can interact with the currently open webpage.

## v20.14 stability update
- Keeps the interactive Live Screen Preview, but reduces screenshot frequency and JPEG quality at high recording resolutions to lower CPU/memory pressure.
- Serializes preview click/touch/wheel events so they do not race with each other or with browser-context shutdown.
- Disables live input immediately after Stop is requested, preventing Stop/context-close races.
- Relaunches Chromium automatically for the next URL if the browser process disconnects.
- Keeps the existing UI, B2 features, recording format, URL queue, and quality choices unchanged.

## v20.15 Live Preview Control

The Live Screen Preview now has a **Touch / Click Control** switch.

- **ON**: click, tap, right-click, and mouse-wheel/trackpad interaction are forwarded to the active hosted Chromium page.
- **OFF**: the preview is view-only and does not send click, tap, or wheel input to Chromium.
- The switch defaults to **OFF**; the user must turn it ON to control the hosted Chromium page.

This is a UI-level interaction toggle; recording behavior and the existing preview/recording features are unchanged.


## v20.17 automatic daily schedule
The panel now supports a daily automatic recording window. Example: enable the schedule, set Start time to `05:30`, End time to `06:00`, choose your local IANA time zone such as `Asia/Kolkata`, and save it. The service reads the saved `urls.txt` list, starts automatically at the start time, and requests a safe recording stop at the end time.

The schedule is a daily local-time window. Start and end can cross midnight, for example `23:00` to `01:00`. Manual recording remains available and is unchanged.


## v20.17 schedule time UI
Schedule start/end times are now explicit 12-hour controls with AM/PM selectors. The backend still stores HH:MM 24-hour values internally.

## v20.18 changes
- Seconds per URL can be switched ON/OFF. OFF means manual duration: recording continues until Stop, or until a scheduled end time.
- Live Screen Preview Touch / Click Control defaults to OFF and must be enabled manually.

## v20.20 stability fix
- Recording runs now use a per-run cancellation token instead of a shared stop flag, preventing a stale Stop/Stop-race state from causing a new recording to exit before opening the URL.
- Added queue checkpoint logging so Render logs show whether a run was stopped before the first URL started.
- Manual duration remains available; the default is OFF when no saved setting exists.


## v20.22 schedule/manual-start fix
- The Schedule ON/OFF toggle is saved immediately, so turning the timer OFF really disables the server-side scheduler before a manual recording.
- Manual **Start Recording** works independently of the schedule. With the schedule OFF, Start begins immediately and does not wait for the scheduled start time.
- If a manual recording is started while an enabled schedule window is already active, that manual run takes the active schedule window slot so the scheduler does not launch a duplicate recording.
- Scheduled recording still starts automatically at the configured AM/PM time and stops at the configured End Time.
- Seconds per URL remains independently controlled by its ON/OFF switch; OFF is manual duration.


## v20.23 manual start fix
The recording queue now treats a missing/null schedule end time as no end time. When the Daily Schedule is OFF, manual Start Recording begins immediately instead of exiting the queue at once. Schedule ON remains optional and can still auto-start/stop at the configured AM/PM times.
