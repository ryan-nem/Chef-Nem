# Firebase setup (phone-friendly, about 10 minutes)

Firebase sends Chef Nem's notifications. It's free (Spark plan). Sign in with the same Google account that owns the Chef Nem sheet.

Tip: the Firebase console works best in Safari with **aA → Request Desktop Website** turned on.

## 1. Create the project
1. Go to **console.firebase.google.com** and sign in.
2. Tap **Create a project** (or **Get started**). Name it **Chef Nem**.
3. Turn **Google Analytics off** (not needed), then tap **Create project**, then **Continue**.

## 2. Add the web app and copy its config
1. On the project home page, tap **+ Add app**, then the **Web** icon (`</>`).
2. App nickname: **Chef Nem app**. Leave "Firebase Hosting" unchecked. Tap **Register app**.
3. Firebase shows a code block that contains `const firebaseConfig = { apiKey: ..., projectId: ..., ... };`.
   Copy that whole block (just the `firebaseConfig` part is enough).
4. Open the **Chef Nem** sheet → **Settings** tab → paste it into the Value cell next to **Firebase web config**.
5. Tap **Continue to console**.

These values are designed to be public, so they're safe in the sheet.

## 3. Create the notification key pair
1. Tap the **gear** (top left) → **Project settings** → **Cloud Messaging** tab.
2. Check that **Firebase Cloud Messaging API (V1)** says **Enabled**.
3. Scroll to **Web configuration** → **Web Push certificates** → **Generate key pair**.
4. Copy the long key that appears and paste it into the Settings tab next to **Firebase VAPID key**.

## 4. The private key (do this on the PC)
This key lets the sheet's script send notifications. Keep it private: don't paste it in a chat, an email or the sheet.

1. **Project settings** → **Service accounts** tab → **Generate new private key** → **Generate key**. A `.json` file downloads.
2. You'll paste its contents into Apps Script during PC setup (see `pc-setup.md`, step 4). Delete the downloaded file afterward.
