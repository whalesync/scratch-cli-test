# scratch-desktop

Desktop Electron app for Scratch.

## Troubleshooting

### Deep link protocol (`scratch://`) opens packaged app instead of dev instance

macOS Launch Services caches which app handles the `scratch://` protocol. If you have a packaged Scratch.app installed (e.g. in `/Applications`), it will intercept deep links even when a dev instance is running.

To fix this:

1. Move or rename the packaged app (e.g. `mv /Applications/Scratch.app /Applications/Scratch.app.bak`)
2. Reset the Launch Services database:
   ```bash
   /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -kill -r -domain local -domain system -domain user
   ```
3. Restart your dev server (`yarn dev` from the repo root)

The dev Electron instance will re-register itself as the `scratch://` protocol handler on launch. Deep links like `open scratch://workbook/...` should now route to the running dev instance.
