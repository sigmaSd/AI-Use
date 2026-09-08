# AI-Use

Usage monitor for Claude.ai, ChatGPT, and OpenCode Go — five-hour/weekly
limits, reset countdowns, and spend, in one window. Desktop app (Linux,
Windows, macOS) and Android.

<img width="1366" height="768" alt="aiuse dashboard" src="https://github.com/user-attachments/assets/9e648248-4651-4d07-bb9c-c4baf0b582a6" />

## Download

Every push to `main` rebuilds all of these and republishes them under
[**the `latest` release**](https://github.com/sigmaSd/AI-Use/releases/tag/latest)
— pick your platform:

| Platform | Get | Run |
| --- | --- | --- |
| Linux (x64/arm64) | `aiuse-linux-{x64,arm64}.zip` | unzip, run `./aiuse/aiuse` |
| Windows (x64/arm64) | `aiuse-windows-{x64,arm64}.zip` | unzip, run `aiuse\aiuse.exe` |
| macOS (Intel/Apple Silicon) | `aiuse-macos-{x64,arm64}.zip` | unzip, right-click `aiuse.app` → Open |
| Android | `aiuse.apk` | `adb install -r aiuse.apk`, or download on-device and open it |

These are unsigned CI builds, not notarized or code-signed — Windows
SmartScreen, macOS Gatekeeper, and Android will all warn about that on first
run. macOS needs right-click → Open (not a double-click) to get past
Gatekeeper without a security-settings detour; Android needs "install from
unknown sources" allowed for the browser or file manager you install with.

Session tokens are entered once in the UI and stay in that install's local
storage — nothing is sent anywhere but the provider you're checking.
"Share to phone" (top bar, once connected) pushes them from desktop to
Android over your LAN with a QR code, so you don't have to copy-paste
tokens by hand onto a phone.

## How it's built

- **UI**: `web/` is a plain static bundle — the same one runs inside the
  desktop app's window and, packaged by
  [denoapk](https://github.com/sigmaSd/denoapk), inside the Android WebView.
  It talks to Claude/ChatGPT/OpenCode with ordinary `fetch`; a proxy shim
  (`host/runtime.js`, `report.ts`) exists only because a browser can't send
  `Cookie`/`User-Agent` itself and those APIs send no CORS headers — see
  `report.ts`'s own header comment for the rest.
- **Desktop**: [`deno desktop`](https://docs.deno.com/runtime/desktop/)
  compiles `report.ts` straight to a native window, no Electron/Chromium
  bundle.
- **Android**: [denoapk](https://github.com/sigmaSd/denoapk) packages the
  same `web/` into an APK — a WebView shell, no Deno runtime on-device.
- **CI**: `.github/workflows/build.yml` builds all six `deno desktop`
  targets plus the APK on every commit to `main`.

## Run from source

```
deno task bundle && deno desktop --allow-net --allow-env --allow-read --allow-sys report.ts
```

`CLAUDE_ORG_ID` / `OPENCODE_WORKSPACE_ID` env vars override auto-detection
if you ever need them.
