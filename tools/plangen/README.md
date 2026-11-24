# plangen

Produces a plan set PDF for a build project and embeds the model it was drawn from
(`shorashim-plan.json`, schema `shorashim-plan/1`) as a PDF attachment. Uploading the PDF
to the project's plans tab reads that data on the device (no model call) and compares it
with the project and with the linked maintenance job's BOQ.

1. Export the project JSON from the app (project, takeoff rows, totals, checks).
2. `python3 gen.py project.json out/`
3. `google-chrome --headless=new --no-pdf-header-footer --print-to-pdf=out/raw.pdf out/plan.html`
4. Attach `out/shorashim-plan.json` with pypdf (`PdfWriter.add_attachment`).
