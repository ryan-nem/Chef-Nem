# PC setup (about 15 minutes, one time)

Your current app keeps working the whole time. The new app runs alongside it until you switch.

## 1. Open the script
Open the **Chef Nem** sheet → **Extensions** → **Apps Script**.

## 2. Check for a conflict
Press **Ctrl+F** in each existing file and search for `doPost`.
- Not found: continue.
- Found: stop and tell Claude. The new file adds its own `doPost`, and two can't exist.

## 3. Add the new file
1. Next to **Files**, click **+** → **Script**. Name it **Api**.
2. Delete the placeholder code, then paste everything from
   `https://raw.githubusercontent.com/ryan-nem/chef-nem/main/apps-script/Api.gs`
3. Click **Save** (disk icon).

## 4. Add the notification key
1. Click the **gear** (Project Settings) on the left.
2. Scroll to **Script properties** → **Add script property**.
3. Property: `CN_FCM_SERVICE_ACCOUNT`. Value: open the `.json` file from Firebase (step 4 of the Firebase guide) in Notepad, copy all of it, and paste it.
4. **Save script properties**. Delete the `.json` file from Downloads.

## 5. Run setup once
1. Back in the editor (`< >` icon), open **Api.gs**.
2. In the function menu at the top, pick **cnSetup** → **Run**.
3. Google asks for permission: **Review permissions** → your account → **Advanced** → **Go to … (unsafe)** → **Allow**.
   ("Unsafe" only means Google hasn't reviewed your own script.)
4. The log should say "Chef Nem API … is set up. Notification key found."

## 6. Make the app link
1. **Deploy** → **New deployment** → gear next to "Select type" → **Web app**.
2. Description: `Chef Nem app API`. **Execute as: Me**. **Who has access: Anyone**.
3. **Deploy**, then copy the **Web app URL** (ends in `/exec`).
   Don't change your existing deployment. That one runs the current app.

"Anyone" is needed so your phone can reach it without a Google sign-in. The family passcode protects it.

## 7. Connect your phone
1. On your iPhone, open **https://ryan-nem.github.io/chef-nem/** in Safari.
2. Paste the app link, tap **Connect**, create the family passcode, then tap **Ryan**.
3. **Share** → **Add to Home Screen** → **Add**. Open Chef Nem from the new icon.
4. **More** → **Turn on notifications** → **Allow** → **Send a test**.

## 8. Add Ari
In the app: **More** → **Share app link** → send it to Ari. She opens it in Safari, enters the passcode (tell her in person), taps **Ari**, adds it to her Home Screen, and turns on notifications.

## Later: updating the script
When the code changes: paste the new `Api.gs`, then **Deploy** → **Manage deployments** → pencil on "Chef Nem app API" → **Version: New version** → **Deploy**. The link stays the same.
