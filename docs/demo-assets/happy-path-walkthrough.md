# Happy-Path Walkthrough Recording

This file tracks the demo recording asset for the jira_workload project.

---

## Recording Status

| Field | Value |
|---|---|
| **Status** | Placeholder — record before first prospect demo |
| **Recommended tool** | [Kap](https://getkap.co/) (macOS) · [ScreenToGif](https://www.screentogif.com/) (Windows) · [Peek](https://github.com/phw/peek) (Linux) · [asciinema](https://asciinema.org/) (terminal-only) |
| **Target length** | 3–5 minutes |
| **Hosted link** | _To be added after recording_ |

---

## Recording Script

Record the following flow in a single uninterrupted session. Refer to
[`docs/DEMO.md`](../DEMO.md) for detailed steps at each section.

| # | Section | What to capture |
|---|---|---|
| 1 | Startup | Terminal showing `./start.sh` output and `{"status":"ok"}` health response; browser loading `connect.html` |
| 2 | OAuth Connect | Full OAuth redirect flow through `auth.atlassian.com` consent screen and callback success page |
| 3 | Trigger Backup | Clicking "Back Up Now" on `manage.html`, progress indicator, completion with object counts |
| 4 | Browse Issues | `browse.html` — keyword search with filters applied, change indicator badges on results, attachment tab |
| 5 | Restore | Restore wizard on `browse.html` — destination = Alternate, pre-flight checks passing, job completion |
| 6 | SDI Scan | `sdi.html` — scan triggered, findings table with regulation badges, match counts |
| 7 | Resilience | `resilience.html` — sidebar with lock icons, workflow grid, purge blocked message |

---

## How to Add the Recording

1. Record the walkthrough using your tool of choice.
2. For GIF/video: upload to a permanent host (e.g. GitHub release asset, Loom, YouTube unlisted).
3. For asciinema: upload to [asciinema.org](https://asciinema.org) and copy the share URL.
4. Replace the **Hosted link** placeholder in the table above with the real URL.
5. Optionally embed directly in `docs/DEMO.md`:

   For a GIF:
   ```markdown
   ![Happy-path walkthrough](demo-assets/happy-path-walkthrough.gif)
   ```

   For a video link:
   ```markdown
   [Watch the full demo walkthrough (video)](https://your-link-here)
   ```

   For asciinema:
   ```markdown
   [![asciicast](https://asciinema.org/a/<ID>.svg)](https://asciinema.org/a/<ID>)
   ```

---

## Screenshot Placeholders

The `docs/demo-assets/screenshots/` directory should contain the following files
(referenced from `docs/DEMO.md`):

| Filename | Section |
|---|---|
| `screenshots/01-startup-health.png` | Section 1 — Startup and health check |
| `screenshots/02-oauth-success.png` | Section 2 — OAuth callback success |
| `screenshots/03-backup-complete.png` | Section 3 — Backup completed with object counts |
| `screenshots/04-browse-issues.png` | Section 4 — Browse issues with change indicators |
| `screenshots/05-restore-alternate.png` | Section 5 — Restore wizard alternate location |
| `screenshots/06-sdi-findings.png` | Section 6 — SDI findings dashboard |
| `screenshots/07-resilience-module.png` | Section 7 — Resilience Module protected inventory |

To take the screenshots: start the application, follow the steps in `docs/DEMO.md`,
and save each screenshot to the filename above.
