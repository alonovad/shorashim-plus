# Shorashim Plus — Full Working Copy

**Bundled at end of session: 2026-06-27**
**Branch:** `fixed/pdf-export-universal`
**Last deployed commit:** `d42a442` (Meckano upgrade Phases 1-4 + QA pass + deep auth refresh)

This zip contains the **complete current state** of the Shorashim Plus codebase, including:

- All Phase 1-4 work (audit log, geofence sites, schedules + OT engine, leave management)
- QA pass fixes (10 issues — 7 critical/high fixed in firestore.rules + JS)
- Deep auth refresh (proper claim-sync on every login)
- Maintenance back-button regression fix (post-deploy hotfix — NOT yet in git)
- All 33 files needed to deploy from scratch

## Files included

```
.firebaserc, .gitignore, firebase.json, firestore.indexes.json, firestore.rules
docs/MECKANO_UPGRADE_PLAN.md
functions/  -> index.js, package.json, package-lock.json (setUserRole, talgilProxy)
public/     -> index.html, manifest.json, icon.png, sw.js (v9)
public/css/ -> style.css, theme-neon.css
public/js/  -> app.js, audit.js, db.js, display-settings.js, effects.js,
               fieldreport.js, leave.js, maintenance.js, schedule.js,
               sites.js, taskboard.js, timeclock.js
```

Excluded as stale: `talgilProxy` (empty file at repo root), `maintenance-sync-patch.js` (sync code already merged into maintenance.js), `claude skill/` (reference material).

## Deploy from this zip

```powershell
# 1. Extract the zip somewhere (e.g. Downloads).
# 2. Open PowerShell in your repo folder (C:\Users\User\Desktop\shorashim-plus).
# 3. Run this block:

$zip  = "$env:USERPROFILE\Downloads\shorashim-plus-full.zip"
$repo = "C:\Users\User\Desktop\shorashim-plus"

# Extract the zip into a temp dir
$tmp = "$env:TEMP\shorashim-plus-unzip"
if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
Expand-Archive -Path $zip -DestinationPath $tmp -Force

# Copy the extracted folder's contents over the repo
Copy-Item -Path "$tmp\shorashim-plus-full\*" -Destination $repo -Recurse -Force

# Cleanup temp
Remove-Item $tmp -Recurse -Force

# Confirm what changed
git status

# If git status looks right, commit + push + deploy:
git add . ; git commit -m "Session bundle: Phases 1-4 + QA + auth + maintenance fix" ; git push ; firebase deploy
```

After deploy: hard-refresh PWA (SW jumped to v9). On phone: close+reopen the app.

## Tests passing

- 17 OT engine assertions (schedule.js)
- 20 leave engine assertions (leave.js)
- All JS files pass `node -c` syntax check
