# Callbreak (PWA) — Made by Unish

Files: `index.html` (the whole app), `manifest.webmanifest`, `sw.js`, `icons/`.

## 1. Put it online (needed for install; must be HTTPS)
- Easiest: open https://app.netlify.com/drop and drag the whole `callbreak-app` folder in.
- Or GitHub Pages: upload the folder contents to a repo, then Settings > Pages.
- To test on your PC first: `python3 -m http.server 8000` in this folder, then open http://localhost:8000

## 2. Install
- Android (Chrome): open the site, menu > Install app. Settings inside Callbreak also shows an "Install app" button when available.
- iPhone (Safari): Share > Add to Home Screen.
- Desktop Chrome/Edge: install icon in the address bar.

## 3. Real Android APK / Play Store (optional)
Go to https://www.pwabuilder.com, enter your site URL, choose Android, and download the package.

## Your data
- Saved on the device in localStorage and mirrored to IndexedDB. The app asks the browser for persistent storage so it is not cleared automatically.
- Clearing browser/site data or uninstalling can still erase it. Use Settings > Export games / Export players for backups, and Import data to restore or move to another device.
