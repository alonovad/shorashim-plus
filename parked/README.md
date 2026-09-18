# parked

Complete modules that are **not wired into the app**: no `<script>` tag in
`public/index.html`, no entry in the `sw.js` cache manifest, and nothing
anywhere in the live code calls the globals they define. They were finished
and then never connected.

They live here rather than in `public/js` because everything under `public/`
is served by Firebase Hosting — parked here they are not downloadable, and
they stop answering greps of the live codebase with code that cannot run.
`preflight.js` check 4 now **fails** on anything unreachable left in
`public/js`, so this folder is where such a module waits until it is wired.

Nothing about the files changed; only their path. `git mv` them back when
wiring one up.

| file | what it is | what wiring it needs |
|---|---|---|
| `export.js` | universal export module — `Export.showMenu / exportPDF / exportCSV / exportJSON / exportXLSX`, with adapters carrying the real field names for timeclock, spray, sprayFlat and worklog | script tag, `sw.js` manifest entry + `CACHE_NAME` bump, and the call sites that open the picker |
| `payslip-form.js` | the accountant's monthly hours form (A4 landscape) — roster with per-employee defaults, fill-from-timeclock using the same contract rules as `payroll.js` and `hours-report.js`, every cell hand-editable and manual edits protected from a later auto-fill | script tag, `sw.js` manifest entry + bump, a nav entry, and **`shorashim-payslip-form` added to the admin whitelist in `firestore.rules`** — without it every save is denied |

Both already carry `* { box-sizing: border-box }` in their own print CSS, so
neither is affected by the RTL print work done on the live report generators.
