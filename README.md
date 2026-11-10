# MessagesManager

A custom Vencord plugin for cleaning up your own messages and saving DM and server conversations.

Version **1.1.0**.

## What it does

- Choose **DMs** or **Servers**, then select conversations or accessible text channels.
- Scan for messages sent by the account you're currently using. Review the count and sample messages before deleting anything.
- Export conversations as themed HTML or JSON, including available guild tags and their badge images.
- Pause or cancel a running job. Switching accounts stops further requests.

Click the **MessagesManager** speech-bubble icon in Discord's top bar to open the manager. It stays visible across Discord and opens with the current conversation or supported channel selected. You can also open it from the plugin settings or the Vencord toolbox.

## Run in the background

Use **Minimize** at the bottom of the manager to hide it while a scan, export, or deletion continues. The top-bar button stays available while a job is running or the manager is minimized, including outside DMs. Reopen it to see the same selections and live progress, or to pause or cancel the job.

You'll receive a Vencord notification when a job finishes or stops. Click it to reopen the manager. A completed scan still requires the typed confirmation before anything is deleted. Exports trigger their download when ready, including while minimized.

Clicking outside the manager, using the close icon, or pressing Escape also minimizes it. Only **Cancel** or **Cancel and close** stops a running job. Switching accounts or disabling the plugin also stops it. Discord must stay running; jobs don't survive a restart. One request already in flight may still finish after cancellation.

## Delete your messages

1. Select the conversations or channels, then optionally set dates and a message-text filter. **Exact text** matches the whole message; **Contains text** matches a substring. Both ignore capitalization.
2. Choose **Scan and preview**. Scanning does not delete anything.
3. Check the results. Optionally choose to close a purged one-to-one DM, remove its recipient as a friend, block them, or leave the selected server after deletion. Then type the exact `DELETE N` confirmation.
4. Choose **Delete N of my messages**.

Deletion is permanent. Only your ordinary messages and replies are eligible; other participants' messages and system events are excluded. The plugin checks ownership again immediately before each delete. A request already in flight may finish after you pause, cancel, switch accounts, or disable the plugin.

Requests run sequentially. The default delay between deletes is 1.5 seconds, and rate-limit responses are respected. Each scan is limited to 50,000 messages across the selected conversations. For larger histories, use smaller date ranges. Dates use UTC and include the entire selected end date.

## Exports

The default **Themed HTML + media (ZIP)** option combines your themed conversation pages with downloaded media in one archive. It saves two main folders: `avatars/` and `conversations/`. Each conversation has its own `index.html` and `media/` folder. Extract the entire ZIP, then open the root `index.html` to choose a conversation. Keep the folders together so local images and attachments continue to work. Saved media loads from these files without a hosting service.

ZIP exports download available Discord-hosted avatars, attachments, custom emoji, supported stickers, and guild-tag images. On desktop, browser-blocked CDN downloads are retried through Vencord's native helper, without cookies or account tokens. This helper accepts only the supported Discord CDN hosts and enforces the same file-size limit. Fully restart Discord after installing this update so the helper loads.

There is a 25 MB per-file limit, a 100 MB total media limit, and a 2,000-download limit. Files that fail or exceed a limit keep their online links. Open `media-report.html` for their filenames, conversation, error, and original link; `media-report.json` contains the structured report. Conversation pages also show a notice when media is missing. A 404 file cannot be recovered by bypassing a browser restriction. External websites aren't downloaded. Use smaller date ranges for larger archives.

**JSON archive** is the other export option and keeps normalized message data and captured theme values.

HTML pages capture theme colors, font names, message spacing, and avatar rounding, with basic formatting, clickable HTTPS links, audio/video players, attachment sizes, and available guild tags. Replies link to their referenced message when that message is included in the export. Custom CSS effects aren't reproduced and fonts aren't bundled; the viewing computer needs those fonts installed.

Guild tags reflect information available when exporting, not necessarily the tag someone had when they sent a message. Hidden or cleared tags aren't filled back in from cached data when the message explicitly reports that state.

The DM list includes conversations Discord still has cached and conversations the manager remembered locally for this account. Older closed DMs that Discord no longer knows about may be absent. Discord must still allow access to the history. Export includes messages from everyone in each selected conversation; deletion includes only your own eligible messages.

No backend, token entry, or upload service is used. Exported files contain private conversation content and should be shared deliberately.

## Install

Requires a source installation of Vencord.

On Windows, extract the entire download first, then run `Install-MessagesManager.cmd`. It checks both `Documents\Vencord` under your user folder and the Windows Documents location (including OneDrive), moves existing DMsManager and MessagesManager folders to a backup outside the plugin directory, and builds Vencord. Other custom plugins are left in place.

To install manually on Windows or Mac:

1. Move any old `src/userplugins/DMsManager` folder outside `src/userplugins` so Vencord does not load both copies.
2. Copy this `MessagesManager` folder into your Vencord checkout's `src/userplugins` directory.
2. Open a terminal in the Vencord checkout and run `pnpm build`.
4. Fully quit Discord, including its tray/menu-bar process, then reopen it.
5. Enable **MessagesManager** in Vencord's plugin settings.

The final source path must be `src/userplugins/MessagesManager/index.tsx`, with no extra nested MessagesManager folder. For a checkout that hasn't been injected yet, run `pnpm inject` after a successful build and select the Discord installation you use.

## Development

The first build passed TypeScript checking and a production Vencord build. Automated checks cover ownership verification, account changes, preview confirmation, pagination, cancellation, rate limits, and escaped HTML output. Requests in these tests are mocked; they don't verify behavior against a live Discord account.

From the Vencord checkout, run the core tests with:

```sh
node --test src/userplugins/MessagesManager/tests/*.test.mjs
```

Licensed under GPL-3.0-or-later.
