// Portfolio IDE — an IntelliJ-style browser for my GitHub repos.
// Static site: repo trees come from the GitHub REST API, file contents from raw.githubusercontent.com.

const API = 'https://api.github.com';
const CACHE_TTL = 15 * 60 * 1000;
const MAX_HIGHLIGHT = 400_000;
const MAX_PDF = 25_000_000;
const isMobile = () => matchMedia('(max-width: 760px)').matches;

let CFG;
const repos = new Map();      // name -> { name, branch, base, language, description, root, loaded, loading }
const nodes = new Map();      // sitePath -> tree node
const textCache = new Map();  // url -> Promise<string>

/* ---------------- tiny helpers ---------------- */

const $ = (sel) => document.querySelector(sel);

function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const extOf = (name) => { const i = name.lastIndexOf('.'); return i > 0 ? name.slice(i + 1).toLowerCase() : ''; };
const baseName = (p) => p.slice(p.lastIndexOf('/') + 1);
const dirName = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const encPath = (p) => p.split('/').map(encodeURIComponent).join('/');
const isAbsUrl = (u) => /^[a-z][a-z0-9+.-]*:/i.test(u) || u.startsWith('//');

function resolvePath(dir, rel) {
  const parts = rel.startsWith('/') ? [] : dir.split('/').filter(Boolean);
  for (const seg of rel.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') parts.pop(); else parts.push(seg);
  }
  return parts.join('/');
}

function slugify(text) {
  return text.trim().toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s/g, '-');
}

function cacheGet(key) {
  try {
    const v = JSON.parse(localStorage.getItem(key));
    if (v && Date.now() - v.t < CACHE_TTL) return v.d;
  } catch { /* storage unavailable */ }
  return null;
}
function cacheSet(key, d) {
  try { localStorage.setItem(key, JSON.stringify({ t: Date.now(), d })); } catch { /* full or blocked */ }
}

class GitHubError extends Error {
  constructor(msg, rateLimited) { super(msg); this.rateLimited = rateLimited; }
}

async function gh(path, shrink = (d) => d) {
  const key = 'gh2:' + path;
  const cached = cacheGet(key);
  if (cached) return cached;
  const res = await fetch(API + path, { headers: { Accept: 'application/vnd.github+json' } });
  if (!res.ok) {
    const limited = (res.status === 403 || res.status === 429) && res.headers.get('x-ratelimit-remaining') === '0';
    throw new GitHubError(limited ? 'GitHub rate limit reached — try again in a little while.' : `GitHub returned ${res.status}.`, limited);
  }
  const data = shrink(await res.json());
  cacheSet(key, data);
  return data;
}

function fetchText(url) {
  if (!textCache.has(url)) {
    const p = fetch(url).then((r) => {
      if (!r.ok) throw new Error(r.status === 404 ? 'File not found.' : `Couldn't load file (${r.status}).`);
      return r.text();
    });
    p.catch(() => textCache.delete(url));
    textCache.set(url, p);
  }
  return textCache.get(url);
}

/* ---------------- file types ---------------- */

const LANG = {
  java: 'java', kt: 'kotlin', kts: 'kotlin', py: 'python', js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', tsx: 'typescript', groovy: 'groovy', gradle: 'groovy', json: 'json', yml: 'yaml', yaml: 'yaml',
  xml: 'xml', html: 'xml', htm: 'xml', css: 'css', scss: 'scss', less: 'less', sql: 'sql', sh: 'bash', bash: 'bash', zsh: 'bash',
  c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp', cs: 'csharp', go: 'go', rs: 'rust', rb: 'ruby', php: 'php', swift: 'swift',
  properties: 'ini', toml: 'ini', ini: 'ini', cfg: 'ini', r: 'r', lua: 'lua', diff: 'diff', md: 'markdown', txt: 'plaintext',
};
const LANG_LABEL = { java: 'Java', kotlin: 'Kotlin', python: 'Python', javascript: 'JavaScript', typescript: 'TypeScript', groovy: 'Groovy', markdown: 'Markdown' };
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif']);
const BINARY_EXT = new Set(['zip', 'gz', 'tar', 'jar', 'war', 'class', 'pt', 'pth', 'h5', 'hdf5', 'pkl', 'pickle', 'npy', 'npz', 'onnx', 'tflite',
  'bin', 'exe', 'dll', 'so', 'dylib', 'o', 'a', 'mp4', 'mov', 'mp3', 'wav', 'ogg', 'woff', 'woff2', 'ttf', 'otf', 'eot', 'xlsx', 'xls', 'docx',
  'doc', 'pptx', 'ppt', 'apk', 'aab', 'keystore', 'jks', 'db', 'sqlite', 'parquet', 'avro', 'pdb', 'ckpt', 'safetensors', 'mat', 'twbx', 'pbix']);
const PLAIN_NAMES = new Set(['dockerfile', 'makefile', 'license', 'gradlew', 'procfile', '.gitignore', '.gitattributes', '.dockerignore', '.env.example', '.editorconfig']);

function fileKind(name) {
  const ext = extOf(name);
  if (ext === 'md' || ext === 'markdown') return 'markdown';
  if (ext === 'pdf') return 'pdf';
  if (ext === 'ipynb') return 'notebook';
  if (ext === 'svg') return 'svg';
  if (IMAGE_EXT.has(ext)) return 'image';
  if (BINARY_EXT.has(ext)) return 'binary';
  return 'text';
}

const SVG_FOLDER = (fill) => `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill="${fill}" d="M1.5 3.6c0-.6.4-1.1 1-1.1h3.7l1.6 1.6h5.7c.6 0 1 .5 1 1.1v7.2c0 .6-.4 1.1-1 1.1H2.5c-.6 0-1-.5-1-1.1z"/></svg>`;

function icon(name, kind) {
  if (kind === 'dir') return h('span', { class: 'fi dir', html: SVG_FOLDER('#c9a26d') });
  if (kind === 'repo' || kind === 'group') return h('span', { class: 'fi repo', html: SVG_FOLDER('#6f9ee8') });
  if (name === 'contact.md') return h('span', { class: 'fi mail', text: '✉' });
  const ext = extOf(name);
  const map = {
    md: ['md', 'M'], markdown: ['md', 'M'], java: ['java', 'J'], kt: ['kt', 'K'], kts: ['kt', 'K'], py: ['py', 'Py'],
    js: ['js', 'JS'], mjs: ['js', 'JS'], jsx: ['js', 'JS'], ts: ['ts', 'TS'], tsx: ['ts', 'TS'], json: ['json', '{}'],
    pdf: ['pdf', 'PDF'], ipynb: ['nb', 'NB'], groovy: ['groovy', 'G'], gradle: ['groovy', 'G'], html: ['html', '<>'],
    css: ['css', '#'], scss: ['css', '#'], xml: ['xml', '<>'], yml: ['cfg', 'Y'], yaml: ['cfg', 'Y'], sql: ['cfg', 'SQ'],
    svg: ['img', 'SV'], txt: ['txt', '≡'],
  };
  const [cls, label] = map[ext] || (IMAGE_EXT.has(ext) ? ['img', '▣'] : ['txt', '≡']);
  const el = h('span', { class: `fi ${cls}`, text: label });
  if (label.length > 2) el.style.fontSize = '6px';
  return el;
}

/* ---------------- repos & tree model ---------------- */

const newNode = (props) => Object.assign({ children: null, parent: null, open: false, rendered: false }, props);

function isHidden(repo, path) {
  const globs = (CFG.hiddenPaths || []).map((g) => new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*') + '$'));
  let p = `${repo}/${path}`;
  while (p.includes('/')) {
    if (globs.some((g) => g.test(p))) return true;
    p = dirName(p);
  }
  return false;
}

let repoListPromise;
function ensureRepoList() {
  if (!repoListPromise) {
    repoListPromise = gh(`/users/${CFG.githubUser}/repos?per_page=100&sort=pushed`, (list) =>
      list.map((r) => ({ name: r.name, branch: r.default_branch, fork: r.fork, language: r.language, description: r.description, homepage: r.homepage, pushed: r.pushed_at })))
      .catch(() => CFG.fallbackRepos.map((name) => ({ name, branch: 'main', fork: false })))
      .then((list) => {
        const hidden = new Set(CFG.hiddenRepos || []);
        for (const r of list) {
          if (hidden.has(r.name) || (r.fork && !CFG.showForks)) continue;
          const base = r.name === CFG.revisionRepo ? r.name : `projects/${r.name}`;
          repos.set(r.name, { ...r, base, loaded: false });
        }
        return repos;
      });
  }
  return repoListPromise;
}

function ensureRepoTree(repo) {
  if (!repo.loading) {
    repo.loading = gh(`/repos/${CFG.githubUser}/${repo.name}/git/trees/${encodeURIComponent(repo.branch)}?recursive=1`, (d) =>
      ({ truncated: d.truncated, tree: d.tree.filter((e) => e.type !== 'commit').map((e) => [e.path, e.type === 'tree' ? 1 : 0, e.size || 0]) }))
      .then((d) => {
        const root = repo.root;
        root.children = [];
        const byPath = new Map([['', root]]);
        for (const [path, isDir, size] of d.tree) {
          if (isHidden(repo.name, path)) continue;
          const parent = byPath.get(dirName(path));
          if (!parent) continue;
          const n = newNode({ name: baseName(path), kind: isDir ? 'dir' : 'file', repo: repo.name, path, size, sitePath: `${repo.base}/${path}`, parent, children: isDir ? [] : null });
          parent.children.push(n);
          byPath.set(path, n);
          nodes.set(n.sitePath, n);
        }
        repo.loaded = true;
        repo.truncated = d.truncated;
        return repo;
      })
      .catch((e) => { repo.loading = null; throw e; });
  }
  return repo.loading;
}

const rawUrl = (repo, path) => `https://raw.githubusercontent.com/${CFG.githubUser}/${repo.name}/${encodeURIComponent(repo.branch)}/${encPath(path)}`;
const githubUrl = (repo, path, kind = 'blob') => `https://github.com/${CFG.githubUser}/${repo.name}/${kind}/${encodeURIComponent(repo.branch)}/${encPath(path)}`;

// sitePath -> { type: 'virtual' | 'local' | 'repo', ... }
function resolve(sitePath) {
  if (sitePath === 'about.md') return { type: 'virtual', id: 'about' };
  if (sitePath === 'contact.md') return { type: 'virtual', id: 'contact' };
  if (sitePath === 'resume.pdf') return { type: 'local', href: 'resume.pdf' };
  let name, path;
  if (sitePath.startsWith(CFG.revisionRepo + '/')) { name = CFG.revisionRepo; path = sitePath.slice(name.length + 1); }
  else if (sitePath.startsWith('projects/')) { const rest = sitePath.slice(9); name = rest.split('/')[0]; path = rest.slice(name.length + 1); }
  const repo = repos.get(name);
  if (!repo || !path || isHidden(name, path)) return null;
  return { type: 'repo', repo, path };
}

/* ---------------- tree view ---------------- */

const isLeaf = (n) => n.kind === 'file' || n.kind === 'virtual' || n.kind === 'local';

function sortChildren(list, keepOrder = false) {
  if (keepOrder) return list.slice();
  return list.slice().sort((a, b) => {
    const da = isLeaf(a) ? 1 : 0, db = isLeaf(b) ? 1 : 0;
    return da - db || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  });
}

function renderNode(node, depth) {
  const isContainer = node.kind !== 'file' && node.kind !== 'virtual' && node.kind !== 'local';
  const row = h('div', {
    class: 'tree-row', role: 'treeitem', tabindex: '0', 'aria-expanded': isContainer ? String(node.open) : null,
    onclick: () => onRowClick(node),
    onkeydown: (e) => onRowKey(e, node),
  },
    h('span', { class: 'chev', text: isContainer ? '▶' : '' }),
    icon(node.name, node.kind === 'virtual' || node.kind === 'local' ? 'file' : node.kind),
    h('span', { class: 'name', text: node.name }),
    node.hint ? h('span', { class: 'hint', text: node.hint }) : null);
  row.style.paddingLeft = `${6 + depth * 16}px`;
  const li = h('li', {}, row);
  node.row = row;
  node.depth = depth;
  if (isContainer) {
    node.ul = h('ul', { role: 'group', hidden: true });
    li.append(node.ul);
    if (node.open) expand(node);
  }
  return li;
}

function renderChildren(node) {
  node.ul.replaceChildren(...sortChildren(node.children || [], node.kind === 'group').map((c) => renderNode(c, node.depth + 1)));
  node.rendered = true;
}

async function expand(node) {
  node.open = true;
  node.row.classList.add('open');
  node.row.setAttribute('aria-expanded', 'true');
  node.ul.hidden = false;
  if (node.kind === 'repo' && !repos.get(node.repo).loaded) {
    node.ul.replaceChildren(h('li', { class: 'tree-msg', text: 'Loading…' }));
    try {
      await ensureRepoTree(repos.get(node.repo));
    } catch (e) {
      node.ul.replaceChildren(h('li', { class: 'tree-msg' }, e.message + ' ',
        h('a', { href: `https://github.com/${CFG.githubUser}/${node.repo}`, target: '_blank', rel: 'noopener', text: 'Open on GitHub ↗' })));
      return;
    }
    renderChildren(node);
  } else if (!node.rendered) {
    renderChildren(node);
  }
}

function collapse(node) {
  node.open = false;
  node.row.classList.remove('open');
  node.row.setAttribute('aria-expanded', 'false');
  node.ul.hidden = true;
}

async function onRowClick(node) {
  if (node.kind === 'file' || node.kind === 'virtual' || node.kind === 'local') {
    openFile(node.sitePath);
    closeDrawer();
    return;
  }
  if (node.open) { collapse(node); return; }
  await expand(node);
  // Opening a folder shows its notes: NOTES.md first (revision topics), then README.md.
  const kids = node.children || [];
  const pick = ['notes.md', 'readme.md'].map((n) => kids.find((k) => k.kind === 'file' && k.name.toLowerCase() === n)).find(Boolean);
  if (pick) openFile(pick.sitePath, { reveal: false });
}

function onRowKey(e, node) {
  const rows = [...document.querySelectorAll('#treeRoot .tree-row')].filter((r) => r.offsetParent !== null);
  const i = rows.indexOf(e.currentTarget);
  const container = node.kind === 'dir' || node.kind === 'repo' || node.kind === 'group';
  if (e.key === 'ArrowDown') rows[i + 1]?.focus();
  else if (e.key === 'ArrowUp') rows[i - 1]?.focus();
  else if (e.key === 'ArrowRight' && container && !node.open) expand(node);
  else if (e.key === 'ArrowLeft' && container && node.open) collapse(node);
  else if (e.key === 'ArrowLeft' && node.parent?.row) node.parent.row.focus();
  else if (e.key === 'Enter' || e.key === ' ') onRowClick(node);
  else return;
  e.preventDefault();
}

let activeRow;
async function revealInTree(sitePath) {
  activeRow?.classList.remove('active');
  const r = resolve(sitePath);
  if (r?.type === 'repo' && !r.repo.loaded) {
    try { await ensureRepoTree(r.repo); } catch { return; }
  }
  const node = nodes.get(sitePath);
  if (!node) return;
  const chain = [];
  for (let p = node.parent; p; p = p.parent) chain.unshift(p);
  for (const p of chain) if (p.row && !p.open) await expand(p);
  if (currentPath !== sitePath || !node.row) return;
  activeRow = node.row;
  activeRow.classList.add('active');
  activeRow.scrollIntoView({ block: 'nearest' });
}

function buildTree() {
  const root = newNode({ name: CFG.projectName, kind: 'group', sitePath: '', open: true, children: [] });
  const projects = newNode({ name: 'projects', kind: 'dir', sitePath: 'projects', parent: root, open: true, children: [] });
  root.children.push(
    newNode({ name: 'about.md', kind: 'virtual', sitePath: 'about.md', parent: root }),
    newNode({ name: 'resume.pdf', kind: 'local', sitePath: 'resume.pdf', parent: root }),
    newNode({ name: 'contact.md', kind: 'virtual', sitePath: 'contact.md', parent: root }),
    projects,
  );
  for (const n of root.children) nodes.set(n.sitePath, n);

  for (const repo of repos.values()) {
    const node = newNode({ name: repo.name, kind: 'repo', repo: repo.name, sitePath: repo.base, hint: repo.language || '', children: [] });
    repo.root = node;
    nodes.set(node.sitePath, node);
    if (repo.base.startsWith('projects/')) { node.parent = projects; projects.children.push(node); }
    else { node.parent = root; root.children.push(node); }
  }


  const ul = $('#treeRoot');
  root.depth = -1;
  root.ul = ul;
  root.row = h('div', { class: 'tree-row open' });
  const li = renderNode(root, 0);
  ul.replaceChildren(li);
}

/* ---------------- tabs & panes ---------------- */

const tabs = []; // { sitePath, btn, pane }
let currentPath = null;

function openFile(sitePath, { reveal = true, push = true, background = false } = {}) {
  let tab = tabs.find((t) => t.sitePath === sitePath);
  if (!tab) {
    const name = baseName(sitePath);
    const pane = h('div', { class: 'pane', role: 'tabpanel', hidden: true });
    const btn = h('button', { class: 'tab', role: 'tab', title: sitePath, onclick: () => openFile(sitePath), onauxclick: (e) => { if (e.button === 1) closeTab(sitePath); } },
      icon(name, 'file'), h('span', { text: name }),
      h('span', { class: 'x', 'aria-label': `Close ${name}`, text: '×', onclick: (e) => { e.stopPropagation(); closeTab(sitePath); } }));
    tab = { sitePath, btn, pane };
    tabs.push(tab);
    $('#tabs').append(btn);
    $('#editor').append(pane);
    renderInto(pane, sitePath);
  }
  if (background) return;
  for (const t of tabs) {
    const on = t === tab;
    t.btn.classList.toggle('active', on);
    t.btn.setAttribute('aria-selected', String(on));
    t.pane.hidden = !on;
  }
  tab.btn.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  currentPath = sitePath;
  const hash = sitePath === 'about.md' ? '#/' : '#/' + encPath(sitePath);
  if (push && location.hash !== hash && !(hash === '#/' && !location.hash)) history.pushState(null, '', hash);
  document.title = sitePath === 'about.md' ? `${CFG.profile.name} — Backend & Java Engineer` : `${baseName(sitePath)} — ${CFG.profile.name}`;
  updateStatus(sitePath);
  if (reveal) revealInTree(sitePath);
  else { activeRow?.classList.remove('active'); const n = nodes.get(sitePath); if (n?.row) { activeRow = n.row; n.row.classList.add('active'); } }
}

function closeTab(sitePath) {
  const i = tabs.findIndex((t) => t.sitePath === sitePath);
  if (i < 0) return;
  const [t] = tabs.splice(i, 1);
  t.btn.remove();
  t.pane.remove();
  if (currentPath === sitePath) {
    const next = tabs[i] || tabs[i - 1];
    if (next) openFile(next.sitePath);
    else {
      currentPath = null;
      activeRow?.classList.remove('active');
      history.pushState(null, '', '#/~');
      $('#editor').append(h('div', { class: 'pane empty-pane' }, h('div', { class: 'placeholder' },
        h('h3', { text: 'No files are open' }),
        h('p', {}, 'Open a file from the project tree, or press ', h('kbd', { class: 'mono', text: 'Ctrl K' }), ' to search.'),
        h('button', { class: 'btn', text: 'Open about.md', onclick: () => openFile('about.md') }))));
      updateStatus('');
    }
  }
}

function updateStatus(sitePath) {
  const crumb = $('#crumb');
  crumb.replaceChildren(CFG.projectName, ...(sitePath ? sitePath.split('/') : []).flatMap((p) => [h('span', { class: 'sep', text: '›' }), p]));
  const lang = LANG_LABEL[LANG[extOf(sitePath)]];
  $('#statusRight').replaceChildren(...(lang ? [lang, '   '] : []), h('span', { class: 'ok', text: '● ' }), CFG.status);
}

/* ---------------- renderers ---------------- */

async function renderInto(pane, sitePath) {
  document.querySelectorAll('.empty-pane').forEach((e) => e.remove());
  pane.replaceChildren(h('div', { class: 'loading', text: 'Loading…' }));
  try {
    await ensureRepoList();
    const r = resolve(sitePath);
    let content;
    if (!r) content = placeholder('File not found', `There's no file at ${sitePath}.`, null);
    else if (r.type === 'virtual') content = r.id === 'about' ? renderAbout() : renderMarkdown(CFG.contactMarkdown, null);
    else if (r.type === 'local') content = renderLocalPdf(r.href);
    else content = await renderRepoFile(r.repo, r.path);
    pane.replaceChildren(content);
  } catch (e) {
    pane.replaceChildren(placeholder("Couldn't open this file", e.message, null));
  }
}

function placeholder(title, text, actions) {
  return h('div', { class: 'placeholder' }, h('h3', { text: title }), h('p', { text }), actions ? h('div', { style: 'display:flex;gap:8px;justify-content:center;flex-wrap:wrap' }, actions) : null);
}

function banner(repo, path, extra) {
  return h('div', { class: 'file-banner mono' }, h('span', { class: 'path', text: `${repo.name} / ${path}` }), extra || null,
    h('a', { href: githubUrl(repo, path), target: '_blank', rel: 'noopener', text: 'View on GitHub ↗' }));
}

async function renderRepoFile(repo, path) {
  const kind = fileKind(baseName(path));
  const node = nodes.get(`${repo.base}/${path}`);
  const size = node?.size || 0;
  const gitHubBtn = h('a', { class: 'btn', href: githubUrl(repo, path), target: '_blank', rel: 'noopener', text: 'Open on GitHub ↗' });

  if (kind === 'binary') return placeholder("This file can't be previewed", `${baseName(path)} is a binary file.`, [gitHubBtn]);
  if (kind === 'image') return h('div', { class: 'img-view' }, h('img', { src: rawUrl(repo, path), alt: baseName(path) }));
  if (kind === 'svg') {
    const blob = new Blob([await fetchText(rawUrl(repo, path))], { type: 'image/svg+xml' });
    return h('div', { class: 'img-view' }, h('img', { src: URL.createObjectURL(blob), alt: baseName(path) }));
  }
  if (kind === 'pdf') {
    if (size > MAX_PDF) return placeholder('This PDF is too large to preview', `${baseName(path)} is ${(size / 1e6).toFixed(1)} MB.`, [gitHubBtn]);
    if (isMobile()) return placeholder(baseName(path), 'PDFs open best in your phone’s viewer.', [h('a', { class: 'btn primary', href: rawUrl(repo, path), target: '_blank', rel: 'noopener', text: 'Open PDF' }), gitHubBtn]);
    const res = await fetch(rawUrl(repo, path));
    if (!res.ok) throw new Error(`Couldn't load file (${res.status}).`);
    const url = URL.createObjectURL(new Blob([await res.arrayBuffer()], { type: 'application/pdf' }));
    return h('div', { class: 'pdf-wrap' }, banner(repo, path), h('iframe', { src: url, title: baseName(path) }));
  }

  const text = await fetchText(rawUrl(repo, path));
  if (kind === 'markdown') {
    const wrap = h('div', {}, renderMarkdown(text, { repo, path }));
    companion(repo, path).then((c) => c && wrap.append(c));
    return wrap;
  }
  if (kind === 'notebook') return renderNotebook(text, repo, path);
  if (text.slice(0, 8000).includes('\u0000')) return placeholder("This file can't be previewed", `${baseName(path)} is a binary file.`, [gitHubBtn]);
  return h('div', {}, banner(repo, path), renderCode(text, path));
}

function highlight(text, lang) {
  if (text.length > MAX_HIGHLIGHT) return escapeHtml(text);
  try {
    if (lang && hljs.getLanguage(lang)) return hljs.highlight(text, { language: lang, ignoreIllegals: true }).value;
  } catch { /* fall through */ }
  return escapeHtml(text);
}

function renderCode(text, path) {
  const name = baseName(path).toLowerCase();
  const lang = LANG[extOf(path)] || (name === 'dockerfile' ? 'bash' : name === 'makefile' ? 'makefile' : PLAIN_NAMES.has(name) ? 'plaintext' : null);
  const body = text.replace(/\n$/, '');
  const count = body.split('\n').length;
  const gutter = Array.from({ length: count }, (_, i) => i + 1).join('\n');
  return h('div', { class: 'code' },
    h('div', { class: 'gutter', 'aria-hidden': 'true', text: gutter }),
    h('pre', {}, h('code', { class: 'hljs', html: highlight(body, lang) })));
}

// Turn links to my own repos on github.com into in-site routes.
function internalRouteForGitHubUrl(url) {
  const m = url.match(new RegExp(`^https://github\\.com/${CFG.githubUser}/([^/]+)/(?:blob|tree)/[^/]+/(.+?)(#.*)?$`, 'i'));
  if (!m) return null;
  const repo = repos.get(m[1]);
  return repo ? `${repo.base}/${decodeURIComponent(m[2])}` : null;
}

function renderMarkdown(text, ctx) {
  const div = h('div', { class: 'mdv' });
  div.innerHTML = DOMPurify.sanitize(marked.parse(text, { gfm: true }));

  const seen = new Map();
  div.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach((hd) => {
    let id = slugify(hd.textContent);
    const n = seen.get(id) || 0;
    seen.set(id, n + 1);
    if (n) id += `-${n}`;
    hd.id = 'h-' + id;
  });

  div.querySelectorAll('pre code').forEach((c) => {
    const lang = (c.className.match(/language-([\w+-]+)/) || [])[1];
    c.innerHTML = highlight(c.textContent, lang && LANG[lang] ? LANG[lang] : lang);
    c.classList.add('hljs');
  });

  const dir = ctx ? dirName(ctx.path) : '';
  div.querySelectorAll('img[src]').forEach((img) => {
    const src = img.getAttribute('src');
    const blob = src.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/(?:blob|raw)\/(.+?)(\?.*)?$/);
    if (blob) img.src = `https://raw.githubusercontent.com/${blob[1]}/${blob[2]}`;
    else if (ctx && !isAbsUrl(src) && !src.startsWith('data:')) img.src = rawUrl(ctx.repo, resolvePath(dir, decodeURIComponent(src.split(/[?#]/)[0])));
  });

  div.querySelectorAll('a[href]').forEach((a) => {
    const href = a.getAttribute('href');
    if (href.startsWith('#')) {
      a.addEventListener('click', (e) => {
        e.preventDefault();
        div.querySelector(`[id="h-${CSS.escape(decodeURIComponent(href.slice(1)).toLowerCase())}"]`)?.scrollIntoView({ behavior: 'smooth' });
      });
      return;
    }
    let route = null;
    if (isAbsUrl(href)) route = internalRouteForGitHubUrl(href);
    else if (ctx) {
      route = `${ctx.repo.base}/${resolvePath(dir, decodeURIComponent(href.split('#')[0]))}`;
      // Relative links to things outside the file tree (../../actions, issues…) behave like on GitHub.
      if (ctx.repo.loaded && !nodes.has(route)) { route = null; a.href = new URL(href, githubUrl(ctx.repo, ctx.path)).href; }
    }
    if (route) {
      a.href = '#/' + encPath(route);
      a.classList.add('internal');
      a.addEventListener('click', (e) => { e.preventDefault(); openRoute(route); });
    } else if (isAbsUrl(a.getAttribute('href')) && !a.getAttribute('href').startsWith('mailto:')) {
      a.target = '_blank';
      a.rel = 'noopener';
    }
  });
  return div;
}

// Open a site path that may be a file or a folder (folders open their NOTES/README and expand).
async function openRoute(route) {
  const r = resolve(route.replace(/\/$/, ''));
  if (r?.type === 'repo' && !r.repo.loaded) { try { await ensureRepoTree(r.repo); } catch { /* open as file */ } }
  const node = nodes.get(route.replace(/\/$/, ''));
  if (node && node.kind !== 'file') {
    await revealInTree(node.sitePath);
    if (!node.open) await onRowClick(node);
    else {
      const pick = ['notes.md', 'readme.md'].map((n) => node.children.find((k) => k.name.toLowerCase() === n)).find(Boolean);
      if (pick) openFile(pick.sitePath);
    }
    return;
  }
  openFile(route.replace(/\/$/, ''));
}

// Under a topic's notes: one click to the topic's code (the revision flow).
async function companion(repo, path) {
  const dir = dirName(path);
  if (!dir) return null;
  try { await ensureRepoTree(repo); } catch { return null; }
  const dirNode = nodes.get(`${repo.base}/${dir}`);
  if (!dirNode) return null;
  const files = [];
  (function walk(n) {
    for (const c of sortChildren(n.children || [])) {
      if (c.kind === 'dir') walk(c);
      else if (c.path !== path) files.push(c);
    }
  })(dirNode);
  if (!files.length || files.length > 80) return null;

  const groups = new Map();
  for (const f of files) {
    const g = dirName(f.path).slice(dir.length + 1) || '.';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(f);
  }
  const box = h('div', { class: 'companion-box' }, h('div', { class: 'label', text: 'In this topic' }));
  for (const [g, list] of [...groups].sort(([a], [b]) => (a === '.' ? -1 : b === '.' ? 1 : 0))) {
    box.append(h('div', { class: 'companion-files', style: 'margin-bottom:6px' },
      g !== '.' ? h('span', { class: 'chip', style: 'cursor:default;border-style:dashed', html: `<span class="grp">${escapeHtml(g)}/</span>` }) : null,
      list.map((f) => h('button', { class: 'chip', onclick: () => openFile(f.sitePath) }, icon(f.name, 'file'), f.name))));
  }
  return h('div', { class: 'companion', style: 'padding-bottom:60px' }, box);
}

function renderNotebook(text, repo, path) {
  let nb;
  try { nb = JSON.parse(text); } catch { return h('div', {}, banner(repo, path), renderCode(text, path)); }
  const lang = nb.metadata?.language_info?.name || nb.metadata?.kernelspec?.language || 'python';
  const src = (s) => (Array.isArray(s) ? s.join('') : s || '');
  const out = h('div', { class: 'mdv', style: 'max-width:1000px' });
  for (const cell of nb.cells || []) {
    if (cell.cell_type === 'markdown') {
      const m = renderMarkdown(src(cell.source), { repo, path });
      m.className = 'nb-cell';
      out.append(m);
    } else if (cell.cell_type === 'code') {
      const cellEl = h('div', { class: 'nb-cell' },
        h('div', { class: 'nb-in' },
          h('div', { class: 'nb-prompt', text: `[${cell.execution_count ?? ' '}]:` }),
          h('pre', { style: 'margin:0' }, h('code', { class: 'hljs', html: highlight(src(cell.source), LANG[lang] || lang) }))));
      for (const o of cell.outputs || []) {
        const data = o.data || {};
        let el = null;
        if (data['image/png']) el = h('img', { src: `data:image/png;base64,${src(data['image/png']).replace(/\s/g, '')}`, alt: 'output' });
        else if (data['image/jpeg']) el = h('img', { src: `data:image/jpeg;base64,${src(data['image/jpeg']).replace(/\s/g, '')}`, alt: 'output' });
        else if (o.output_type === 'stream') el = document.createTextNode(src(o.text).slice(0, 20000));
        else if (data['text/plain']) el = document.createTextNode(src(data['text/plain']).slice(0, 20000));
        else if (o.output_type === 'error') el = document.createTextNode(`${o.ename}: ${o.evalue}`);
        if (el) cellEl.append(h('div', { class: 'nb-out' }, el));
      }
      out.append(cellEl);
    }
  }
  return h('div', {}, banner(repo, path), out);
}

function renderLocalPdf(href) {
  const download = h('a', { class: 'btn primary', href, download: 'Abinash-Sonowal-Resume.pdf', text: '⬇ Download' });
  const open = h('a', { class: 'btn', href, target: '_blank', rel: 'noopener', text: 'Open in new tab ↗' });
  if (isMobile()) return placeholder('Resume', 'Open or download my resume as a PDF.', [download, open]);
  return h('div', { class: 'pdf-wrap' },
    h('div', { class: 'file-banner' }, h('span', { class: 'mono', text: 'resume.pdf' }), h('span', { style: 'margin-left:auto;display:flex;gap:8px' }, open, download)),
    h('iframe', { src: href, title: 'Resume' }));
}

function renderAbout() {
  const p = CFG.profile;
  const linkBtn = (l) => h('a', {
    class: 'btn' + (l.primary ? ' primary' : ''), href: l.href, download: l.download ? 'Abinash-Sonowal-Resume.pdf' : null,
    target: !l.download && !l.href.startsWith('mailto:') ? '_blank' : null, rel: 'noopener',
  }, l.download ? '⬇ ' : '', l.label);

  const card = (f) => {
    const repo = f.repo && repos.get(f.repo);
    const openRepo = () => openRoute(repo.base);
    return h('div', { class: 'card' + (repo ? ' clickable' : ''), onclick: repo ? openRepo : null, tabindex: repo ? '0' : null, onkeydown: repo ? (e) => e.key === 'Enter' && openRepo() : null },
      h('h3', {}, f.title, f.tag ? h('span', { class: 'tag', text: f.tag }) : null),
      h('p', { text: f.text }),
      h('div', { class: 'card-links' },
        repo ? h('a', { href: '#/' + encPath(repo.base), onclick: (e) => { e.preventDefault(); e.stopPropagation(); openRepo(); }, text: 'Browse code →' }) : null,
        f.demo ? h('a', { href: f.demo, target: '_blank', rel: 'noopener', onclick: (e) => e.stopPropagation(), text: 'Live demo ↗' }) : null));
  };

  const featured = new Set(p.featured.map((f) => f.repo).filter(Boolean));
  const others = [...repos.values()].filter((r) => !featured.has(r.name) && r.name !== CFG.revisionRepo);

  return h('div', { class: 'about' },
    h('div', { class: 'about-path', text: '# about.md' }),
    h('h1', { text: p.name }),
    h('div', { class: 'headline', text: p.headline }),
    h('div', { class: 'creds' }, p.credentials.map((c) => h('span', { text: c }))),
    h('div', { class: 'links' }, p.links.map(linkBtn)),
    h('p', { class: 'summary', text: p.summary }),

    h('h2', { text: 'Featured' }),
    h('div', { class: 'cards' }, p.featured.map(card)),

    h('h2', { text: 'Experience' }),
    p.experience.map((x) => h('div', { class: 'xp' },
      h('div', { class: 'role', text: x.role }),
      h('div', { class: 'org', text: `${x.org} · ${x.when}` }),
      h('ul', {}, x.points.map((pt) => h('li', { text: pt }))))),

    h('h2', { text: 'Skills' }),
    h('dl', { class: 'skills' }, Object.entries(p.skills).flatMap(([k, v]) => [h('dt', { text: k }), h('dd', {}, v.map((s) => h('span', { class: 'pill', text: s })))])),

    h('h2', { text: 'Education & achievements' }),
    h('ul', { class: 'plain' }, h('li', { text: p.education }), p.achievements.map((a) => h('li', { text: a }))),

    others.length ? h('h2', { text: 'More projects' }) : null,
    others.length ? h('div', { class: 'cards' }, others.map((r) => card({ title: r.name, text: r.description || r.language || 'Open to browse the code.', repo: r.name, demo: r.homepage || null }))) : null,

    h('p', { class: 'explore' }, 'This site is an IDE: browse every repo in the project tree, press ',
      h('kbd', { class: 'mono', text: 'Ctrl K' }), ' to search, or open my study notes in ',
      h('a', { href: '#/' + CFG.revisionRepo, onclick: (e) => { e.preventDefault(); openRoute(CFG.revisionRepo); }, text: CFG.revisionRepo + '/' }), '.'));
}

/* ---------------- search (Ctrl K / double Shift) ---------------- */

let searchIndex = null;
let searchSel = 0;
let searchItems = [];

async function buildSearchIndex() {
  await ensureRepoList();
  await Promise.allSettled([...repos.values()].map(ensureRepoTree));
  searchIndex = ['about.md', 'resume.pdf', 'contact.md'].map((p) => ({ sitePath: p, lower: p }));
  for (const n of nodes.values()) {
    if (n.kind === 'file') searchIndex.push({ sitePath: n.sitePath, lower: n.sitePath.toLowerCase() });
  }
}

function scoreOne(term, s) {
  const name = s.slice(s.lastIndexOf('/') + 1);
  const i = s.indexOf(term);
  if (i >= 0) return 1000 + (name.includes(term) ? 400 : 0) - i * 0.3;
  let j = 0, last = -2, pts = 0;
  for (let k = 0; k < s.length && j < term.length; k++) {
    if (s[k] === term[j]) { pts += k === last + 1 ? 6 : 1; last = k; j++; }
  }
  return j === term.length ? pts * 10 : -1;
}

function runSearch(q) {
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  let results;
  if (!terms.length) {
    results = searchIndex.filter((e) => !e.sitePath.includes('/') || /\/(notes|readme)\.md$/.test(e.lower)).slice(0, 40);
  } else {
    results = [];
    for (const e of searchIndex) {
      let total = 0;
      for (const t of terms) { const s = scoreOne(t, e.lower); if (s < 0) { total = -1; break; } total += s; }
      if (total < 0) continue;
      if (/\/(notes|readme)\.md$/.test(e.lower)) total += 120;
      total -= e.lower.length * 0.4;
      results.push({ ...e, total });
    }
    results.sort((a, b) => b.total - a.total);
    results = results.slice(0, 60);
  }
  searchItems = results;
  searchSel = 0;
  const mark = (s) => {
    let out = escapeHtml(s);
    for (const t of terms) out = out.replace(new RegExp(escapeHtml(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), (m) => `<mark>${m}</mark>`);
    return out;
  };
  $('#searchResults').replaceChildren(...results.map((r, i) => h('li', {
    role: 'option', class: i === 0 ? 'sel' : '', onclick: () => pickSearch(i), onmousemove: () => setSel(i),
  }, icon(baseName(r.sitePath), 'file'), h('span', { html: mark(baseName(r.sitePath)) }), h('span', { class: 'path', html: mark(dirName(r.sitePath)) }))));
  $('#searchHint').textContent = results.length ? '↑↓ to move · Enter to open · Esc to close' : 'No matching files.';
}

function setSel(i) {
  const lis = $('#searchResults').children;
  lis[searchSel]?.classList.remove('sel');
  searchSel = Math.max(0, Math.min(i, searchItems.length - 1));
  lis[searchSel]?.classList.add('sel');
  lis[searchSel]?.scrollIntoView({ block: 'nearest' });
}

function pickSearch(i) {
  const item = searchItems[i];
  if (!item) return;
  closeSearch();
  openFile(item.sitePath);
}

async function openSearch() {
  const modal = $('#searchModal');
  if (!modal.hidden) return;
  modal.hidden = false;
  const input = $('#searchInput');
  input.value = '';
  input.focus();
  if (!searchIndex) {
    $('#searchResults').replaceChildren();
    $('#searchHint').textContent = 'Indexing repositories…';
    await buildSearchIndex();
  }
  runSearch(input.value);
}

function closeSearch() { $('#searchModal').hidden = true; }

/* ---------------- mobile drawer ---------------- */

function openDrawer() { $('#tree').classList.add('open'); $('#scrim').hidden = false; $('#drawerBtn').setAttribute('aria-expanded', 'true'); }
function closeDrawer() { $('#tree').classList.remove('open'); $('#scrim').hidden = true; $('#drawerBtn').setAttribute('aria-expanded', 'false'); }

/* ---------------- boot ---------------- */

function routeFromHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  if (!raw || raw === '~') return raw === '~' ? null : 'about.md';
  try { return decodeURIComponent(raw); } catch { return raw; }
}

async function main() {
  CFG = await fetch('site.config.json').then((r) => r.json());
  $('#badge').textContent = CFG.initials;
  $('#projectName').textContent = CFG.projectName;
  updateStatus('');

  await ensureRepoList();
  buildTree();

  const route = routeFromHash();
  if (route && route !== 'about.md') {
    openFile('about.md', { background: true });
    openRoute(route);
  } else {
    openFile('about.md', { push: false });
  }

  window.addEventListener('popstate', () => { const r = routeFromHash(); if (r && r !== currentPath) openRoute(r); });

  $('#searchBtn').addEventListener('click', openSearch);
  $('#searchModal').addEventListener('click', (e) => { if (e.target.id === 'searchModal') closeSearch(); });
  $('#searchInput').addEventListener('input', (e) => searchIndex && runSearch(e.target.value));
  $('#searchInput').addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { setSel(searchSel + 1); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { setSel(searchSel - 1); e.preventDefault(); }
    else if (e.key === 'Enter') { pickSearch(searchSel); e.preventDefault(); }
    else if (e.key === 'Escape') closeSearch();
  });

  let lastShift = 0;
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openSearch(); return; }
    if (e.key === 'Escape') { closeSearch(); closeDrawer(); return; }
    if (e.key === 'Shift' && !e.repeat) {
      const now = Date.now();
      if (now - lastShift < 350) { openSearch(); lastShift = 0; } else lastShift = now;
    } else lastShift = 0;
  });

  $('#drawerBtn').addEventListener('click', () => ($('#tree').classList.contains('open') ? closeDrawer() : openDrawer()));
  $('#scrim').addEventListener('click', closeDrawer);
}

main().catch((e) => {
  $('#editor').replaceChildren(h('div', { class: 'placeholder' }, h('h3', { text: 'Something went wrong' }), h('p', { text: e.message })));
});
