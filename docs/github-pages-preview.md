# GitHub Pages: read-only UI demo

The public GitHub Pages site is a **static, explicitly isolated preview**
and is not a deployment of the authenticated Express application.

- Build uses `GITHUB_PAGES_PREVIEW=1` and compiles only `preview.html`.
- No application secrets, environment variables, API endpoints, database URLs,
  API-key form controls, provider calls or email sending are included.
- The candidate list begins with fictional examples. Extra entries and
  template drafts exist in React state only and are lost on refresh.
- No real or sensitive contacts should be entered into the public demo.
- Production/staging Express + Neon deployment remains a separate milestone.
- The preview uses repository-aware Vite base URL for Pages assets.

## Setup

Under GitHub repository **Settings → Pages**, choose **GitHub Actions** as
the source. The repo must allow GitHub Pages publishing for its visibility
and account plan. Merge the preview PR; GitHub Actions will then build and
publish on pushes to main.

Expected URL (only after successful deployment):
https://pikkst.github.io/SnapyCall-Pilot-Outreach/

If Pages publishing is denied, inspect GitHub Actions deployment logs and
repository Pages source settings. Never put server credentials in Actions
for this preview workflow.
