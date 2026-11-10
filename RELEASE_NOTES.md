# MessagesManager 1.1.0

- Renamed DMsManager to MessagesManager with an always visible top-bar button.
- Added DMs and Servers tabs. Server scans, exports, and purges work in selected accessible text channels.
- Show closed DMs that Discord still has cached or that the manager remembers locally for the account.
- Preview a purge by exact text or substring. Recheck the current text and author before deleting each message.
- Added optional post-purge actions for one-to-one DMs and servers. They run after a completed purge, only where messages were deleted.
- Removed the long help paragraphs from the manager. Export instructions remain in the README.

Replace your existing `src/userplugins/DMsManager` folder using the installer or the included source. Rebuild, restart Discord, and enable MessagesManager.
