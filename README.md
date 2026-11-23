# Chef Nem

A family meal-planning app: weekly plan and approval, grocery lists, recipes and saved favorites, with notifications.

- **The app** (this folder) is a Home Screen web app hosted on GitHub Pages: `https://ryan-nem.github.io/chef-nem/`
- **The data** lives in each family's own Google Sheet. `apps-script/Api.gs` is the sheet's data connection, protected by a family passcode.
- **Notifications** come from Firebase Cloud Messaging, sent by the sheet's script.
- **Settings** for each family (people, allergies, budget, reminder times) live in the sheet's **Settings** tab, not in the code.

## Setup
1. [Firebase setup](docs/firebase-setup.md)
2. [PC setup](docs/pc-setup.md)

## Files
| File | What it is |
|---|---|
| `index.html`, `app.js`, `styles.css` | The app |
| `sw.js` | Offline support and notifications |
| `manifest.webmanifest`, `icons/` | Home Screen name and icon |
| `apps-script/Api.gs` | Goes into the sheet's Apps Script project |
| `docs/` | Setup guides |
