// Codex 阅读指南 —— 单页静态阅读器（无构建步骤）
// 路由：#/read/<id> 读章节，#/repo 看仓库地图

const GH_BASE = "https://github.com/openai/codex/tree/main/codex-rs/";

const state = {
  manifest: [],
  crates: null,
};

// ---------- 主题 ----------
function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  document.getElementById("hljs-light").disabled = theme === "dark";
  document.getElementById("hljs-dark").disabled = theme === "light";
  try { localStorage.setItem("codex-guide-theme", theme); } catch (e) {}
}
(function initTheme() {
  let t = "light";
  try { t = localStorage.getItem("codex-guide-theme") || "light"; } catch (e) {}
  applyTheme(t);
  document.getElementById("theme-toggle").addEventListener("click", () => {
    const cur = document.documentElement.getAttribute("data-theme");
    applyTheme(cur === "dark" ? "light" : "dark");
  });
})();

// ---------- 顶部阅读进度条 ----------
// 监听 window 滚动，按“已滚动距离 / 可滚动总距离”计算已读百分比，更新进度条宽度。
// 章节内容渲染后高度会变化，因此 showChapter / 窗口 resize / 图片加载完成后都会重算。
const progressBar = document.getElementById("progress-bar");
function updateProgress() {
  const doc = document.documentElement;
  const scrollTop = window.scrollY || doc.scrollTop || 0;
  const scrollable = (doc.scrollHeight - doc.clientHeight) || 0;
  const pct = scrollable > 0 ? (scrollTop / scrollable) * 100 : 0;
  progressBar.style.width = Math.min(100, Math.max(0, pct)) + "%";
}
window.addEventListener("scroll", updateProgress, { passive: true });
window.addEventListener("resize", updateProgress);

// ---------- Markdown 配置 ----------
marked.setOptions({ gfm: true, breaks: false });

function renderMarkdown(md) {
  return marked.parse(md);
}

// ---------- Mermaid 架构图 ----------
// marked 会把 ```mermaid 渲染成 <pre><code class="language-mermaid">，
// mermaid 默认只认 class="mermaid" 的元素，因此先把这类 code 块转成 mermaid 容器，
// 再初始化并运行 mermaid。整体用 try/catch 包裹，失败不影响正文。
function renderMermaid(root) {
  if (typeof mermaid === "undefined") return;
  try {
    root.querySelectorAll("pre > code.language-mermaid").forEach((code) => {
      const pre = code.parentElement;
      const div = document.createElement("div");
      div.className = "mermaid";
      div.textContent = code.textContent;
      pre.replaceWith(div);
    });
    mermaid.initialize({ startOnLoad: false, securityLevel: "loose", theme: "default" });
    mermaid.run({ querySelector: ".mermaid" });
  } catch (e) {
    console.warn("mermaid 渲染失败，已跳过：", e);
  }
}

// ---------- 代码块「复制」按钮 ----------
// 给正文每个 pre > code 块加一个右上角的「复制」按钮（mermaid 在 renderMermaid
// 里已被替换为 div.mermaid，不再是 pre>code，这里再加一道保险跳过）。
// 点击把代码纯文本写入 navigator.clipboard，按钮短暂变为「已复制」。
function addCopyButtons(root) {
  root.querySelectorAll("pre > code").forEach((code) => {
    if (code.classList.contains("language-mermaid")) return;
    const pre = code.parentElement;
    if (pre.querySelector(".copy-btn")) return;          // 避免重复添加
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "copy-btn";
    btn.textContent = "复制";
    btn.setAttribute("aria-label", "复制代码");
    btn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(code.textContent);
        btn.textContent = "已复制";
        btn.classList.add("copied");
        setTimeout(() => {
          btn.textContent = "复制";
          btn.classList.remove("copied");
        }, 1500);
      } catch (e) {
        btn.textContent = "复制失败";
        setTimeout(() => { btn.textContent = "复制"; }, 1500);
      }
    });
    pre.appendChild(btn);
  });
}

// ---------- 源码引用自动转 GitHub 链接 ----------
// 扫描正文文本节点，把形如 `path/file.rs:153` 的「源码引用」变成指向 GitHub 的链接。
// 规则：
//   1) 仅在「反引号内联 code」或「行内普通文本」里匹配，不进入 <pre> 代码块
//      （保留 hljs 高亮，避免把高亮 span 拆碎），也不进入 mermaid 图（renderMermaid 已
//      把它转成 div.mermaid）。
//   2) 已在 <a> 内的文本跳过，避免重复处理 / 产生嵌套链接。
//   3) 用 DOM 文本节点重建的方式替换，不重写整段 innerHTML，因此不会破坏既有高亮与 SVG。
// 正则（带 g 用于提取，另用一个无 g 的同形正则做存在性判断，避免 lastIndex 串味）：
//   /([A-Za-z0-9_./-]+\.rs):(\d+)/
// 链接：href = GH_BASE + path + "#L" + line，target=_blank rel=noopener。
const CITE_RE = /([A-Za-z0-9_./-]+\.rs):(\d+)/g;
const CITE_TEST = /([A-Za-z0-9_./-]+\.rs):(\d+)/;

function linkifyCitations(root) {
  if (!root) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      // 跳过已在 <a> 内、<pre> 代码块内、或 mermaid 图内的文本
      let el = node.parentElement;
      while (el && el !== root) {
        const tag = el.tagName;
        if (tag === "A" || tag === "PRE") return NodeFilter.FILTER_REJECT;
        if (el.classList && el.classList.contains("mermaid")) return NodeFilter.FILTER_REJECT;
        el = el.parentElement;
      }
      // 无候选片段的文本节点直接跳过，减少无谓重建
      return CITE_TEST.test(node.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });

  const targets = [];
  let textNode;
  while ((textNode = walker.nextNode())) targets.push(textNode);
  if (!targets.length) return;

  targets.forEach((node) => {
    const text = node.nodeValue;
    CITE_RE.lastIndex = 0;
    const frag = document.createDocumentFragment();
    let last = 0;
    let m;
    while ((m = CITE_RE.exec(text))) {
      if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      const a = document.createElement("a");
      a.className = "cite";
      a.href = GH_BASE + m[1] + "#L" + m[2];
      a.target = "_blank";
      a.rel = "noopener";
      a.textContent = m[0];
      frag.appendChild(a);
      last = m.index + m[0].length;
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    node.parentNode.replaceChild(frag, node);
  });
}

// ---------- 阅读时长估算 ----------
// 中文按 400 字/分钟、其余按 200 词/分钟粗略估算；至少 1 分钟。
// CJK 字符走中文速率，其余非空白字符按 ~5 字符/词折算后走英文速率。
// 直接数非空白字符总数 / 400 也给出近似结果，这里稍作区分更准一点。
function estimateReadingMinutes(md) {
  if (!md) return 1;
  const cjk = (md.match(/[一-鿿㐀-䶿]/g) || []).length;
  const other = (md.replace(/[一-鿿㐀-䶿]/g, " ").match(/\S+/g) || []).length; // 非中文词数
  const minutes = cjk / 400 + other / 200;
  return Math.max(1, Math.round(minutes));
}

// ---------- 章节难度徽标 ----------
// 把 manifest 里的 level（中文）映射成 CSS 类名与徽标 HTML。
function levelClass(level) {
  switch (level) {
    case "入门": return "beginner";
    case "进阶": return "intermediate";
    case "深入": return "advanced";
    case "参考": return "reference";
    default: return "";
  }
}
function levelBadgeHtml(level) {
  const cls = levelClass(level);
  return cls ? `<span class="level-badge ${cls}">${level}</span>` : "";
}

// 在首个 h1 之下插入难度徽标（标题与阅读时长之间），不改动其它内容。
function insertLevelBadge(article, level) {
  if (!article || !level) return;
  const h1 = article.querySelector("h1");
  const wrap = document.createElement("div");
  wrap.className = "chapter-level";
  wrap.innerHTML = levelBadgeHtml(level);
  if (h1 && h1.nextSibling) h1.parentNode.insertBefore(wrap, h1.nextSibling);
  else article.insertBefore(wrap, article.firstChild);
}

// 在标题（首个 h1）之后、正文之前插入「约 X 分钟读完」标签，不改动其它内容。
function insertReadingTime(article, minutes) {
  if (!article) return;
  const h1 = article.querySelector("h1");
  const label = document.createElement("p");
  label.className = "reading-time";
  label.textContent = `约 ${minutes} 分钟读完`;
  if (h1 && h1.nextSibling) h1.parentNode.insertBefore(label, h1.nextSibling);
  else article.insertBefore(label, article.firstChild);
}

// ---------- 章节底部导航（上一章 / 下一章） ----------
function buildChapterNav(chap) {
  const idx = state.manifest.findIndex((c) => c.id === chap.id);
  if (idx < 0) return "";
  const prev = idx > 0 ? state.manifest[idx - 1] : null;
  const next = idx < state.manifest.length - 1 ? state.manifest[idx + 1] : null;
  if (!prev && !next) return "";
  const links = [];
  if (prev) {
    links.push(`<a class="chap-nav-link prev" href="#/read/${prev.id}">← ${prev.title}</a>`);
  }
  if (next) {
    links.push(`<a class="chap-nav-link next" href="#/read/${next.id}">${next.title} →</a>`);
  }
  return `<nav class="chap-nav">${links.join("")}</nav>`;
}

// ---------- 本页目录（页内标题锚点） ----------
// 给正文里的 h2/h3 生成稳定 id，并在右侧/顶部生成一个可点击跳转的浮层目录。
// 不修改 hash，避免触发 router 重新加载章节；点击用 scrollIntoView 平滑滚动。
let tocObserver = null;

function slugify(text) {
  // 保留字母数字、中文、连字符；其余（标点、空格）去掉或转连字符
  const base = text.trim().toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^\w一-鿿-]/g, "");
  return base || "";
}

function buildPageToc(article) {
  const box = document.getElementById("page-toc");
  const list = document.getElementById("page-toc-list");
  if (!box || !list) return;

  if (tocObserver) { tocObserver.disconnect(); tocObserver = null; }

  // 收集正文里的 h2/h3（排除目录自身可能产生的标题）
  const heads = Array.from(article.querySelectorAll("h2, h3"))
    .filter((h) => !h.classList.contains("page-toc-skip"));

  if (heads.length < 2) { box.hidden = true; return; }

  // 1) 生成稳定 id（slug 化，重名追加序号），顺序与出现顺序一致
  const seen = new Map();
  const items = heads.map((h, i) => {
    let id = slugify(h.textContent) || `section-${i}`;
    if (seen.has(id)) {
      const n = seen.get(id) + 1;
      seen.set(id, n);
      id = `${id}-${n}`;
    } else {
      seen.set(id, 1);
    }
    h.id = id;
    return { id, text: h.textContent.trim(), level: h.tagName.toLowerCase() };
  });

  // 2) 渲染目录
  list.innerHTML = items.map((it) =>
    `<a class="page-toc-link ${it.level}" href="#${it.id}" data-target="${it.id}">${it.text}</a>`
  ).join("");
  box.hidden = false;
  // 移动端默认收起
  box.classList.toggle("collapsed", window.matchMedia("(max-width: 860px)").matches);

  // 3) 点击平滑滚动（拦截默认跳转，避免污染 hash 触发 router）
  const links = Array.from(list.querySelectorAll(".page-toc-link"));
  const linksById = {};
  links.forEach((a) => {
    const id = a.dataset.target;
    linksById[id] = a;
    a.addEventListener("click", (e) => {
      e.preventDefault();
      const target = document.getElementById(id);
      if (target) {
        target.scrollIntoView({ behavior: "smooth", block: "start" });
        // 更新高亮，并收起移动端目录
        links.forEach((l) => l.classList.remove("active"));
        a.classList.add("active");
        if (window.matchMedia("(max-width: 860px)").matches) box.classList.add("collapsed");
      }
    });
  });

  // 4) 滚动高亮当前章节（scrollspy）
  tocObserver = new IntersectionObserver((entries) => {
    entries.forEach((en) => {
      if (en.isIntersecting) {
        const active = linksById[en.target.id];
        if (active) {
          links.forEach((l) => l.classList.remove("active"));
          active.classList.add("active");
        }
      }
    });
  }, { rootMargin: "0px 0px -70% 0px", threshold: 0 });
  heads.forEach((h) => tocObserver.observe(h));
}

// ---------- 侧边栏 ----------
async function buildToc() {
  const res = await fetch("content/manifest.json");
  state.manifest = await res.json();
  const toc = document.getElementById("toc");
  const repoLink = `<a href="#/repo" class="repo" data-route="repo">▦ 仓库地图（${state.manifest.length} 章 + crates）</a>`;
  toc.innerHTML =
    state.manifest.map((c) =>
      `<a href="#/read/${c.id}" data-id="${c.id}">
        <span class="toc-title">${c.title}</span>${levelBadgeHtml(c.level)}
       </a>`
    ).join("") + repoLink;

  // 章节搜索（只匹配标题文字，不把难度徽标文字计入搜索）
  const search = document.getElementById("search");
  search.addEventListener("input", () => {
    const q = search.value.trim().toLowerCase();
    toc.querySelectorAll("a[data-id]").forEach((a) => {
      const txt = (a.querySelector(".toc-title") || a).textContent.toLowerCase();
      a.style.display = !q || txt.includes(q) ? "" : "none";
    });
  });
}

// ---------- 移动端侧边栏抽屉 ----------
// 窄屏（<=860px）下侧边栏默认移出视口，靠 .open 类滑入；
// 点击汉堡切换，点击遮罩 / 任一章节链接 / 路由切换 / Esc 都会收起。
// 桌面端汉堡与遮罩在 CSS 里是 display:none，这些逻辑不产生任何视觉影响。
const sidebarEl = document.getElementById("sidebar");
const sidebarOverlay = document.getElementById("sidebar-overlay");
const menuToggle = document.getElementById("menu-toggle");

function setSidebarOpen(open) {
  if (!sidebarEl) return;
  sidebarEl.classList.toggle("open", open);
  if (sidebarOverlay) {
    sidebarOverlay.classList.toggle("show", open);
    sidebarOverlay.setAttribute("aria-hidden", open ? "false" : "true");
  }
  if (menuToggle) {
    menuToggle.setAttribute("aria-expanded", open ? "true" : "false");
    menuToggle.setAttribute("aria-label", open ? "关闭章节菜单" : "打开章节菜单");
  }
}

function closeSidebar() { setSidebarOpen(false); }

(function initSidebarDrawer() {
  if (!sidebarEl || !menuToggle) return;
  menuToggle.addEventListener("click", () => setSidebarOpen(!sidebarEl.classList.contains("open")));
  if (sidebarOverlay) sidebarOverlay.addEventListener("click", closeSidebar);
  // 章节链接与仓库地图入口由 buildToc 动态插入，这里用事件委托
  const toc = document.getElementById("toc");
  if (toc) toc.addEventListener("click", (e) => { if (e.target.closest("a")) closeSidebar(); });
  window.addEventListener("keydown", (e) => { if (e.key === "Escape") closeSidebar(); });
  // 窄屏拉宽回桌面时清掉抽屉状态，避免遮罩残留
  window.addEventListener("resize", () => {
    if (!window.matchMedia("(max-width: 860px)").matches) closeSidebar();
  });
})();

// ---------- 路由 ----------
function setActive(id) {
  document.querySelectorAll("#toc a").forEach((a) => {
    a.classList.toggle("active", a.dataset.id === id);
  });
}

async function showChapter(id) {
  const chap = state.manifest.find((c) => c.id === id) || state.manifest[0];
  setActive(chap.id);
  const article = document.getElementById("article");
  article.innerHTML = `<p class="loading">正在加载 ${chap.title}…</p>`;
  try {
    const md = await (await fetch(chap.file)).text();
    article.innerHTML = renderMarkdown(md) + buildChapterNav(chap);
    insertReadingTime(article, estimateReadingMinutes(md));   // 标题下插入阅读时长
    insertLevelBadge(article, chap.level);                    // 标题下插入难度徽标
    article.querySelectorAll("pre code").forEach((el) => hljs.highlightElement(el));
    renderMermaid(article);
    buildPageToc(article);                  // 生成「本页目录」与标题锚点
    addCopyButtons(article);                // 给代码块加「复制」按钮
    linkifyCitations(article);              // 正文源码引用 → GitHub 链接
    try { localStorage.setItem("codex-guide-last", chap.id); } catch (e) {}
    document.getElementById("content").scrollTop = 0;
    window.scrollTo({ top: 0, left: 0, behavior: "instant" });   // 切章立即归零，不触发平滑滚动
    updateProgress();                         // 切换章节后重新计算进度（重置为 0%）
    setTimeout(updateProgress, 60);           // 等图片/字体加载、布局稳定后再校准一次
  } catch (e) {
    article.innerHTML = `<p>加载失败：${e.message}<br/>请通过 HTTP 服务（如 GitHub Pages）访问，而不是直接用 file:// 打开。</p>`;
  }
}

async function showRepo() {
  setActive(null);
  const box = document.getElementById("page-toc");
  if (box) box.hidden = true;             // 仓库地图不显示「本页目录」
  if (tocObserver) { tocObserver.disconnect(); tocObserver = null; }
  document.querySelectorAll("#toc a").forEach((a) =>
    a.classList.toggle("active", a.dataset.route === "repo")
  );
  const article = document.getElementById("article");
  if (!state.crates) {
    try {
      state.crates = await (await fetch("data/crates.json")).json();
    } catch (e) {
      article.innerHTML = `<p>仓库索引加载失败：${e.message}</p>`;
      return;
    }
  }
  const crates = state.crates.filter((c) => c.path !== ".");
  article.innerHTML = `
    <div class="repo-head">
      <h1>仓库地图</h1>
      <p>下面是对 <code>codex-rs</code> 下全部 crate 的扫描结果。点击名称跳到 GitHub 对应目录。用搜索框按名称或描述过滤。</p>
    </div>
    <div class="repo-filter"><input id="repo-search" placeholder="过滤 crate（名称 / 描述）…" autocomplete="off" /></div>
    <div class="repo-count" id="repo-count"></div>
    <div class="repo-grid" id="repo-grid"></div>
  `;
  const grid = document.getElementById("repo-grid");
  const count = document.getElementById("repo-count");
  const draw = (q) => {
    const list = crates.filter((c) => {
      if (!q) return true;
      return (
        c.name.toLowerCase().includes(q) ||
        (c.desc || "").toLowerCase().includes(q) ||
        c.path.toLowerCase().includes(q)
      );
    });
    count.textContent = `共 ${list.length} 个 crate`;
    grid.innerHTML = list
      .map(
        (c) => `
      <div class="crate-card">
        <a href="${GH_BASE}${c.path}" target="_blank" rel="noopener">${c.name} ↗</a>
        <div class="path">${c.path}</div>
        <div class="desc">${c.desc || "<em>无描述</em>"}</div>
      </div>`
      )
      .join("");
  };
  draw("");
  document.getElementById("repo-search").addEventListener("input", (e) => draw(e.target.value.trim().toLowerCase()));
  window.scrollTo(0, 0);
  updateProgress();
}

function router() {
  closeSidebar();                       // 路由切换后收起移动端抽屉
  const h = window.location.hash || "";
  if (h.startsWith("#/repo")) return showRepo();
  const m = h.match(/^#\/read\/(.+)$/);
  if (m) return showChapter(m[1]);
  // 默认：没有 hash 时，优先打开上次阅读的章节
  if (!h) {
    let last = null;
    try { last = localStorage.getItem("codex-guide-last"); } catch (e) {}
    const id = last && state.manifest.some((c) => c.id === last) ? last : state.manifest[0].id;
    window.location.hash = "#/read/" + id;
  } else showChapter(state.manifest[0].id);
}

window.addEventListener("hashchange", router);

// ---------- 键盘左右键翻章 ----------
function navigateRelative(delta) {
  const m = window.location.hash.match(/^#\/read\/(.+)$/);
  if (!m) return; // 仅在阅读章节时生效
  const idx = state.manifest.findIndex((c) => c.id === m[1]);
  if (idx < 0) return;
  const target = idx + delta;
  if (target < 0 || target >= state.manifest.length) return;
  window.location.hash = "#/read/" + state.manifest[target].id;
}

// ---------- 快捷键帮助浮层 ----------
// 动态创建一次，之后用 hidden 切换显隐；点击遮罩 / Esc 关闭。
let helpOverlayEl = null;

function buildHelpOverlay() {
  if (helpOverlayEl) return helpOverlayEl;
  const overlay = document.createElement("div");
  overlay.className = "help-overlay";
  overlay.id = "help-overlay";
  overlay.hidden = true;
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", "快捷键帮助");
  overlay.innerHTML = `
    <div class="help-card">
      <h2 class="help-title">快捷键</h2>
      <ul class="help-list">
        <li><kbd>←</kbd><kbd>→</kbd><span>上一章 / 下一章</span></li>
        <li><kbd>j</kbd><kbd>k</kbd><span>下一章 / 上一章</span></li>
        <li><kbd>?</kbd><span>打开本帮助</span></li>
        <li><kbd>Esc</kbd><span>关闭浮层 / 菜单</span></li>
      </ul>
    </div>
  `;
  // 仅点击遮罩本身（而非卡片）时关闭
  overlay.addEventListener("click", (e) => { if (e.target === overlay) closeHelpOverlay(); });
  document.body.appendChild(overlay);
  helpOverlayEl = overlay;
  return overlay;
}

function openHelpOverlay() {
  buildHelpOverlay().hidden = false;
}

function closeHelpOverlay() {
  if (helpOverlayEl) helpOverlayEl.hidden = true;
}

window.addEventListener("keydown", (e) => {
  // 帮助浮层打开时：仅 Esc 可关闭，其余按键均不触发翻章
  if (helpOverlayEl && !helpOverlayEl.hidden) {
    if (e.key === "Escape") { e.preventDefault(); closeHelpOverlay(); }
    return;
  }
  // 焦点在输入框 / 搜索框时不拦截，避免与搜索冲突
  const tag = (e.target.tagName || "").toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select" || e.target.isContentEditable) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === "ArrowLeft") { e.preventDefault(); navigateRelative(-1); }
  else if (e.key === "ArrowRight") { e.preventDefault(); navigateRelative(1); }
  else if (e.key === "j" || e.key === "J") { e.preventDefault(); navigateRelative(1); }
  else if (e.key === "k" || e.key === "K") { e.preventDefault(); navigateRelative(-1); }
  else if (e.key === "?") { e.preventDefault(); openHelpOverlay(); }
});

// ---------- 本页目录折叠（移动端） ----------
(function initPageTocToggle() {
  const box = document.getElementById("page-toc");
  const btn = document.getElementById("page-toc-toggle");
  if (!box || !btn) return;
  btn.addEventListener("click", () => box.classList.toggle("collapsed"));
})();

// ---------- 启动 ----------
(async function main() {
  await buildToc();
  router();
})();
