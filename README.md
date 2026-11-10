# abinashrasonowal.github.io

My portfolio, built as an IntelliJ-style IDE: **https://abinashrasonowal.github.io**

- `about.md` is the landing tab: who I am, resume, featured projects.
- Every public repo is browsable in the project tree. Markdown renders, code is syntax-highlighted, notebooks and PDFs open in tabs.
- `Learning/` is my study notebook. Clicking a topic folder opens its `NOTES.md`, and the topic's code is one click away under "In this topic".
- `Ctrl K` (or double `Shift`) searches every file.

Plain static site with no build step. Repo trees come from the GitHub API and file contents from `raw.githubusercontent.com`, so anything I push shows up here without redeploying.

## Editing

Everything personal is in [`site.config.json`](site.config.json): profile text, links, featured projects, hidden repos, and hidden paths (glob patterns such as `Learning/**/*.pdf`). The resume is `resume.pdf`.

Run it locally:

```bash
python3 -m http.server 8765
```

After changing `assets/style.css` or `assets/app.js`, bump the `?v=` number in `index.html` so browsers pick up the new files.
