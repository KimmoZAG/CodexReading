// Codex 阅读指南 —— 单页静态阅读器（无构建步骤）
// 路由：#/read/<id> 读章节，#/repo 看仓库地图

const GH_BASE = "https://github.com/openai/codex/tree/main/codex-rs/";

const state = {
  manifest: [],
  crates: null,
};

// ---------- 无障碍辅助 ----------
// ① announce()：把动态变化（切章 / 搜索结果数 / 过滤结果数）写入 #sr-live
//    （role=status + aria-live=polite），屏幕阅读器会在空闲时朗读。
//    120ms 合并连续写入，避免逐次按键造成播报刷屏。
// ② prefersReducedMotion()：统一判定「减弱动效」，所有 smooth 滚动都要先问它。
// ③ 跳转到正文链接：拦截默认跳转（不写 hash，避免 router 误把 #content 当路由）后
//    把焦点移到 <main tabindex="-1">，后续 Tab 从正文开始。
const srLive = document.getElementById("sr-live");
let srTimer = null;

function announce(msg) {
  if (!srLive || !msg) return;
  clearTimeout(srTimer);
  srTimer = setTimeout(() => { srLive.textContent = msg; }, 120);
}

function prefersReducedMotion() {
  try { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; }
  catch (e) { return false; }
}

(function initSkipLink() {
  const link = document.querySelector(".skip-link");
  const main = document.getElementById("content");
  if (!link || !main) return;
  link.addEventListener("click", (e) => {
    e.preventDefault();
    main.focus();
    main.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "start" });
  });
})();

// ---------- 主题 ----------
// 主题键：codex-guide-theme（当前主题 light/dark）
// 手动标记：codex-guide-theme-manual（用户点过切换按钮则置 "1"）。
// 未手动选过时，初始主题与系统 prefers-color-scheme 保持一致，并在系统主题变化时自动跟随；
// 一旦用户手动切换过，就不再自动跟随，完全以手动选择为准。
const THEME_KEY = "codex-guide-theme";
const THEME_MANUAL_KEY = "codex-guide-theme-manual";

function systemPrefersDark() {
  try { return window.matchMedia("(prefers-color-scheme: dark)").matches; }
  catch (e) { return false; }
}
function systemTheme() { return systemPrefersDark() ? "dark" : "light"; }

function isManualTheme() {
  try { return localStorage.getItem(THEME_MANUAL_KEY) === "1"; }
  catch (e) { return false; }
}

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  document.getElementById("hljs-light").disabled = theme === "dark";
  document.getElementById("hljs-dark").disabled = theme === "light";
  try { localStorage.setItem(THEME_KEY, theme); } catch (e) {}
}

(function initTheme() {
  // 已手动选过：信任已存主题；否则始终跟随系统（忽略已存主题，应对系统切换发生在页面关闭期间）。
  const theme = isManualTheme()
    ? (function () { try { return localStorage.getItem(THEME_KEY); } catch (e) {} })() || "light"
    : systemTheme();
  applyTheme(theme);

  document.getElementById("theme-toggle").addEventListener("click", () => {
    const cur = document.documentElement.getAttribute("data-theme");
    applyTheme(cur === "dark" ? "light" : "dark");
    // 用户手动切换，标记后不再自动跟随系统主题。
    try { localStorage.setItem(THEME_MANUAL_KEY, "1"); } catch (e) {}

    // 按新主题重渲当前文章里的 mermaid 图（失败不影响主题切换）。
    try {
      document.querySelectorAll("#article .mermaid").forEach((div) => {
        if (div.querySelector("svg")) {
          div.textContent = div.dataset.src;
        }
      });
      const t = document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "default";
      mermaid.initialize({ startOnLoad: false, securityLevel: "loose", theme: t });
      mermaid.run({ querySelector: "#article .mermaid" });
    } catch (e) {
      console.warn("主题切换时 mermaid 重渲失败，已跳过：", e);
    }
  });

  // 监听系统主题变化，仅在用户未手动选过时自动跟随。
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const onSystemThemeChange = (e) => {
    if (isManualTheme()) return;
    applyTheme(e && e.matches ? "dark" : "light");
  };
  if (typeof mq.addEventListener === "function") {
    mq.addEventListener("change", onSystemThemeChange);
  } else if (typeof mq.addListener === "function") {
    mq.addListener(onSystemThemeChange);   // 兼容旧版 Safari
  }
})();

// ---------- 顶部阅读进度条（细粒度：章节级 + 章内位置） ----------
// 进度 = 已读完章数/总章数（基础） + 当前章内进度 × (1/总章数)（权重）。
// 章内进度按“当前章在视口中的滚动位置”计算（站点整窗滚动，章内容即文档主体）。
// 用 requestAnimationFrame 节流；章节切换时通过 AbortController 解绑上一次监听，避免泄漏。
const progressBar = document.getElementById("progress-bar");
let progressRafPending = false;
let chapterScrollAbort = null;

// 计算“当前章内”已读比例 0~1（基于整窗滚动 + 当前 article 在文档中的位置）。
function computeIntraChapterProgress() {
  const article = document.getElementById("article");
  if (!article) return null;
  const artTop = article.getBoundingClientRect().top + (window.scrollY || 0);
  const artHeight = article.scrollHeight;
  const viewH = window.innerHeight || document.documentElement.clientHeight;
  const scrollable = Math.max(1, artHeight - viewH);
  const intra = (window.scrollY - artTop) / scrollable;
  return Math.min(1, Math.max(0, intra));
}

// 同步进度条视觉宽度与 role=progressbar 的 aria-valuenow（取整，避免无谓属性抖动）
function setProgressValue(pct) {
  const v = Math.min(100, Math.max(0, pct));
  progressBar.style.width = v + "%";
  progressBar.setAttribute("aria-valuenow", String(Math.round(v)));
}

function updateProgress() {
  if (!progressBar) return;
  // 仓库地图 / 无当前章节时，退回“整窗滚动百分比”（等同旧行为）
  if (!activeChapterId || !state.manifest.length) {
    const doc = document.documentElement;
    const scrollTop = window.scrollY || doc.scrollTop || 0;
    const scrollable = (doc.scrollHeight - doc.clientHeight) || 0;
    const pct = scrollable > 0 ? (scrollTop / scrollable) * 100 : 0;
    setProgressValue(pct);
    return;
  }
  const total = state.manifest.length;
  const idx = state.manifest.findIndex((c) => c.id === activeChapterId);
  const base = (idx < 0 ? 0 : idx) / total;        // 已读完的章数 / 总章数
  const weight = 1 / total;                        // 单章权重
  const intra = computeIntraChapterProgress();
  const pct = (base + (intra == null ? 0 : intra) * weight) * 100;
  setProgressValue(pct);
}

function onProgressScroll() {
  if (progressRafPending) return;
  progressRafPending = true;
  requestAnimationFrame(() => {
    progressRafPending = false;
    updateProgress();
  });
}

// 章节切换时调用：解绑上一次的 scroll/resize 监听，绑定新的（带 signal，切换时统一 abort）
function bindChapterScroll() {
  if (chapterScrollAbort) chapterScrollAbort.abort();
  chapterScrollAbort = new AbortController();
  window.addEventListener("scroll", onProgressScroll, { passive: true, signal: chapterScrollAbort.signal });
  window.addEventListener("resize", onProgressScroll, { signal: chapterScrollAbort.signal });
}

// ---------- 回到顶部浮动按钮 ----------
// 监听 window 滚动（内容区即整窗滚动），向下滚动超过 600px 时显示按钮；
// 点击滚回顶部（尊重 prefers-reduced-motion）；章节切换时由 showChapter / showRepo 显式隐藏。
const toTop = document.getElementById("back-to-top");
function updateBackToTop() {
  if (!toTop) return;
  const show = window.scrollY > 600;          // 超过 600px 才显示
  toTop.classList.toggle("hidden", !show);
  toTop.classList.toggle("visible", show);
}
function hideBackToTop() {
  if (toTop) {
    toTop.classList.add("hidden");
    toTop.classList.remove("visible");
  }
}
window.addEventListener("scroll", updateBackToTop, { passive: true });
window.addEventListener("resize", updateBackToTop);
if (toTop) {
  toTop.addEventListener("click", () => {
    window.scrollTo({ top: 0, behavior: prefersReducedMotion() ? "auto" : "smooth" });
  });
  toTop.classList.add("hidden");              // 初始隐藏
}

// ---------- 记住每章滚动位置 ----------
// 与「记住上次读的章节」(codex-guide-last) 区分：这里按章节 id 单独保存窗口滚动偏移，
// 重新打开某章时恢复到上次读到的位置。切换章节 / 打开仓库地图时不恢复旧章偏移。
const SCROLL_KEY_PREFIX = "codex-guide-scroll-";
const SCROLL_SAVE_INTERVAL = 300;   // 节流间隔（ms）
let activeChapterId = null;          // 当前正在阅读的章节 id（null 表示不在章节视图）
let suppressScrollSave = false;      // 切章/清内容期间临时禁止保存，避免写入瞬态偏移
let scrollSaveTimer = null;

function scrollKeyFor(id) { return SCROLL_KEY_PREFIX + id; }

// 切章 / 退出章节前，立即把“旧章节”的当前偏移落盘（此时 activeChapterId 仍是旧章）
function flushChapterScroll() {
  if (!activeChapterId) return;
  try {
    localStorage.setItem(scrollKeyFor(activeChapterId), String(window.scrollY || 0));
  } catch (e) {}
}

// 保存当前章节的窗口滚动偏移（仅在章节视图且未被抑制时写入）
function saveChapterScroll() {
  if (!activeChapterId || suppressScrollSave) return;
  try {
    localStorage.setItem(scrollKeyFor(activeChapterId), String(window.scrollY || 0));
  } catch (e) {}
}

// 读取并恢复某章保存的滚动偏移；无记录则回到顶部
function restoreChapterScroll(id) {
  let offset = 0;
  try {
    const raw = localStorage.getItem(scrollKeyFor(id));
    if (raw != null) offset = parseInt(raw, 10) || 0;
  } catch (e) {}
  const content = document.getElementById("content");
  if (content) content.scrollTop = offset;
  window.scrollTo({ top: offset, left: 0, behavior: "instant" });
}

// 滚动时按 ~300ms 节流把偏移写入 localStorage（尾部触发，能捕获最终停止位置）
function scheduleScrollSave() {
  if (scrollSaveTimer) return;
  scrollSaveTimer = setTimeout(() => {
    scrollSaveTimer = null;
    saveChapterScroll();
  }, SCROLL_SAVE_INTERVAL);
}
window.addEventListener("scroll", scheduleScrollSave, { passive: true });

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
      div.dataset.src = code.textContent;
      pre.replaceWith(div);
    });
    const t = document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "default";
    mermaid.initialize({ startOnLoad: false, securityLevel: "loose", theme: t });
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

// ---------- 复制本章链接按钮 ----------
// 在难度徽标同一行（.chapter-level）末尾追加一个低调的文字按钮；
// 点击把当前章节的规范 URL 写入 navigator.clipboard，并短暂提示「已复制」。
// URL 形如 location.origin + location.pathname + '#/read/' + 章节id。
function insertCopyLinkButton(article, id) {
  if (!article || !id) return;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "copy-link-btn";
  btn.textContent = "复制链接";
  btn.setAttribute("aria-label", "复制本章链接");
  btn.addEventListener("click", async () => {
    const url = location.origin + location.pathname + "#/read/" + id;
    try {
      await navigator.clipboard.writeText(url);
      btn.textContent = "已复制";
      btn.classList.add("copied");
      setTimeout(() => {
        btn.textContent = "复制链接";
        btn.classList.remove("copied");
      }, 1500);
    } catch (e) {
      btn.textContent = "复制失败";
      setTimeout(() => { btn.textContent = "复制链接"; }, 1500);
    }
  });
  // 优先挂到难度徽标同一行；无徽标时退化为挂在 h1 之后，不改动其它内容。
  const host = article.querySelector(".chapter-level") || article.querySelector("h1");
  if (host && host.classList && host.classList.contains("chapter-level")) host.appendChild(btn);
  else if (host) host.parentNode.insertBefore(btn, host.nextSibling);
  else article.insertBefore(btn, article.firstChild);
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

// ---------- 章节内 Heading TOC（本页目录 / inpage-toc） ----------
// 给正文里的 h2/h3 生成稳定 id，并在 #article 之前插入一个可点击跳转的浮层目录
// （ul > li > a 结构；当前可见标题所在 li 加 .active）。
// 不修改 hash，避免触发 router 重新加载章节；点击用 scrollIntoView 平滑滚动。
// 标题数 < 3 时不显示，避免短文章出现多余目录。
let inpageTocObserver = null;

function slugify(text) {
  // 保留字母数字、中文、连字符；其余（标点、空格）去掉或转连字符
  const base = text.trim().toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^\w一-鿿-]/g, "");
  return base || "";
}

function buildInpageToc(article) {
  if (!article) return;
  const content = article.parentElement || document.getElementById("content");
  if (!content) return;

  // 容器 div#inpage-toc：若不存在则创建并插入到 article 父容器最前面（article 之前）
  let box = document.getElementById("inpage-toc");
  if (!box) {
    box = document.createElement("aside");
    box.id = "inpage-toc";
    box.className = "inpage-toc";
    box.hidden = true;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "inpage-toc-toggle";
    btn.id = "inpage-toc-toggle";
    btn.setAttribute("aria-expanded", "true");
    btn.innerHTML = '目录 <span class="inpage-toc-chev">∨</span>';
    const list = document.createElement("ul");
    list.className = "inpage-toc-list";
    list.id = "inpage-toc-list";
    box.appendChild(btn);
    box.appendChild(list);
    content.insertBefore(box, article);
  }
  const list = box.querySelector("#inpage-toc-list") || box.querySelector(".inpage-toc-list");
  if (!list) return;

  if (inpageTocObserver) { inpageTocObserver.disconnect(); inpageTocObserver = null; }

  // 收集正文里的 h2/h3（排除目录自身可能产生的标题）
  const heads = Array.from(article.querySelectorAll("h2, h3"))
    .filter((h) => !h.classList.contains("inpage-toc-skip"));

  if (heads.length < 3) { box.hidden = true; return; }

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

  // 2) 渲染目录（ul > li > a）
  list.innerHTML = items.map((it) =>
    `<li class="inpage-toc-item ${it.level}"><a href="#${it.id}" data-target="${it.id}">${it.text}</a></li>`
  ).join("");
  box.hidden = false;
  // 移动端默认收起
  box.classList.toggle("collapsed", window.matchMedia("(max-width: 768px)").matches);

  // 3) 点击平滑滚动（拦截默认跳转，避免污染 hash 触发 router）
  const links = Array.from(list.querySelectorAll("a"));
  const lis = Array.from(list.querySelectorAll("li"));
  const liById = {};
  lis.forEach((li) => { liById[li.querySelector("a").dataset.target] = li; });
  links.forEach((a) => {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      const target = document.getElementById(a.dataset.target);
      if (target) {
        target.scrollIntoView({ behavior: "smooth", block: "start" });
        // 更新高亮，并收起移动端目录
        lis.forEach((l) => l.classList.remove("active"));
        liById[a.dataset.target].classList.add("active");
        if (window.matchMedia("(max-width: 768px)").matches) box.classList.add("collapsed");
      }
    });
  });

  // 4) 滚动高亮当前章节（scrollspy）：标题可见比例 >= 50% 时标记对应 li 为 active
  inpageTocObserver = new IntersectionObserver((entries) => {
    entries.forEach((en) => {
      if (en.isIntersecting) {
        const li = liById[en.target.id];
        if (li) {
          lis.forEach((l) => l.classList.remove("active"));
          li.classList.add("active");
        }
      }
    });
  }, { threshold: 0.5 });
  heads.forEach((h) => inpageTocObserver.observe(h));
}

// ---------- 侧边栏 ----------
async function buildToc() {
  const res = await fetch("content/manifest.json");
  state.manifest = await res.json();
  const toc = document.getElementById("toc");
  // 保留侧边栏静态的「🎮 互动演示」入口（#nav-interactive）：
  // buildToc 重渲章节列表时会被 innerHTML 清掉，这里先取出、重渲后再包进 <li> 挂回列表末尾。
  const staticInteractive = toc.querySelector("#nav-interactive");
  // 导航语义：nav > ul > li > a，屏幕阅读器可播报「列表，共 N 项」并按项浏览
  const items = state.manifest.map((c) =>
    `<li><a href="#/read/${c.id}" data-id="${c.id}">
        <span class="toc-title">${c.title}</span>${levelBadgeHtml(c.level)}
       </a></li>`
  ).join("");
  const repoItem =
    `<li><a href="#/repo" class="repo" data-route="repo"><span aria-hidden="true">▦</span> 仓库地图（${state.manifest.length} 章 + crates）</a></li>`;
  toc.innerHTML = `<ul class="toc-list" id="toc-list">${items}${repoItem}</ul>`;
  const list = toc.querySelector("#toc-list");
  if (staticInteractive) {
    const li = document.createElement("li");
    li.className = "toc-item-extra";     // 上方细分隔线（替代原先的 <hr>，避免列表被打断）
    li.appendChild(staticInteractive);
    list.appendChild(li);
  }

  // 章节搜索（只匹配标题文字，不把难度徽标文字计入搜索）
  // 用 hidden 收起整个 <li>（而非只隐藏 <a>），否则空 li 仍会占用列表间距
  const search = document.getElementById("search");
  search.addEventListener("input", () => {
    const q = search.value.trim().toLowerCase();
    let shown = 0;
    toc.querySelectorAll("a[data-id]").forEach((a) => {
      const txt = (a.querySelector(".toc-title") || a).textContent.toLowerCase();
      const match = !q || txt.includes(q);
      (a.closest("li") || a).hidden = !match;
      if (match) shown++;
    });
    announce(q ? `章节过滤：${shown} 个结果` : `已清空过滤，共 ${shown} 章`);
  });
}

// ---------- 移动端侧边栏抽屉 ----------
// 窄屏（<=860px）下侧边栏默认移出视口，靠 .open 类滑入；
// 点击汉堡切换，点击遮罩 / 任一章节链接 / 路由切换 / Esc 都会收起。
// 桌面端汉堡与遮罩在 CSS 里是 display:none，这些逻辑不产生任何视觉影响。
const sidebarEl = document.getElementById("sidebar");
const sidebarOverlay = document.getElementById("sidebar-overlay");
const menuToggle = document.getElementById("menu-toggle");

// 窄屏抽屉收起时，侧边栏虽被 translateX 移出视口，但链接仍在 Tab 序里，
// 键盘用户会「Tab 进看不见的菜单」。用 inert 把收起态抽屉整体移出焦点序与无障碍树；
// 若焦点此刻正在抽屉内（例如点了章节链接导致收起），先把焦点还给汉堡按钮，避免焦点丢失。
function syncSidebarInert(open) {
  if (!sidebarEl) return;
  const narrow = window.matchMedia("(max-width: 860px)").matches;
  if (narrow && !open) {
    if (sidebarEl.contains(document.activeElement) && menuToggle) menuToggle.focus();
    sidebarEl.setAttribute("inert", "");
  } else {
    sidebarEl.removeAttribute("inert");
  }
}

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
  syncSidebarInert(open);
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
  // 窄屏拉宽回桌面时清掉抽屉状态，避免遮罩残留；窄屏内则同步 inert
  window.addEventListener("resize", () => {
    if (!window.matchMedia("(max-width: 860px)").matches) closeSidebar();
    else syncSidebarInert(sidebarEl.classList.contains("open"));
  });
  syncSidebarInert(false);              // 初始为收起态
})();

// ---------- 路由 ----------
// aria-current="page" 让屏幕阅读器在当前章节链接上播报「当前页」，
// 而不只依赖 .active 的视觉高亮。
function setActive(id) {
  document.querySelectorAll("#toc a").forEach((a) => {
    const on = a.dataset.id === id;
    a.classList.toggle("active", on);
    if (on) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
}

// 切章时用于取消「渲染后校准」的 setTimeout，避免泄漏 / 覆盖新章节
let chapterRenderTimer = null;
// 自增令牌：快速连续切章时，旧请求在 await 后凭令牌失效，避免把过期内容覆写到新章节
let chapterLoadToken = 0;

async function showChapter(id) {
  const chap = state.manifest.find((c) => c.id === id) || state.manifest[0];
  flushChapterScroll();                 // 保存旧章节滚动位置（activeChapterId 仍是旧章）
  // 离开互动演示视图：隐藏面板、恢复正文
  const article = document.getElementById("article");
  const panel = document.getElementById("interactive-panel");
  if (article) article.hidden = false;
  if (panel) panel.hidden = true;
  suppressScrollSave = true;            // 切章 / 清内容期间禁止写入瞬态偏移
  bindChapterScroll();                  // 解绑旧章进度监听，绑定新的（避免泄漏）
  setActive(chap.id);
  clearSearchHighlight();               // 切换章节时先清掉旧的高亮（内存清理）
  // 内存清理：取消未完成的 setTimeout（搜索防抖 timer、上次渲染校准 timer）
  if (fullSearchDebounceTimer) { clearTimeout(fullSearchDebounceTimer); fullSearchDebounceTimer = null; }
  if (chapterRenderTimer) { clearTimeout(chapterRenderTimer); chapterRenderTimer = null; }

  const token = ++chapterLoadToken;     // 标记本次加载，后续 await 后据此判断是否已切章

  // 章节切换动画：先 fadeOut 旧内容（尊重 prefers-reduced-motion）
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (article && !reduceMotion) {
    article.classList.add("fade-out");
    await new Promise((r) => setTimeout(r, 150));
    if (token !== chapterLoadToken) return;   // 已切到其它章，放弃本次渲染
  }

  article.innerHTML = `<p class="loading">正在加载 ${chap.title}…</p>`;
  try {
    const md = await (await fetch(chap.file)).text();
    if (token !== chapterLoadToken) return;
    article.innerHTML = renderMarkdown(md) + buildChapterNav(chap);
    insertReadingTime(article, estimateReadingMinutes(md));   // 标题下插入阅读时长
    insertLevelBadge(article, chap.level);                    // 标题下插入难度徽标
    insertCopyLinkButton(article, chap.id);                   // 标题旁插入「复制链接」按钮
    article.querySelectorAll("pre code").forEach((el) => hljs.highlightElement(el));
    renderMermaid(article);
    buildInpageToc(article);                // 生成「本页目录」(inpage-toc) 与标题锚点
    addCopyButtons(article);                // 给代码块加「复制」按钮
    linkifyCitations(article);              // 正文源码引用 → GitHub 链接
    // 图片 / SVG 懒加载：默认只在进入视口时下载
    article.querySelectorAll("img").forEach((img) => { img.loading = "lazy"; });
    applySearchHighlight();                 // 若带搜索词跳转，则在本页高亮匹配词
    try { localStorage.setItem("codex-guide-last", chap.id); } catch (e) {}
    activeChapterId = chap.id;                // 标记当前章节，后续滚动写入该章 key
    suppressScrollSave = false;               // 恢复完成前不再抑制写入
    restoreChapterScroll(chap.id);            // 恢复上次读到的滚动位置（无记录则回到顶部）
    // 图片加载完成后再校准一次，避免布局变化导致位置偏移
    article.querySelectorAll("img").forEach((img) => {
      if (!img.complete) img.addEventListener("load", () => {
        if (activeChapterId === chap.id) restoreChapterScroll(chap.id);
      }, { once: true });
    });
    hideBackToTop();                          // 章节切换时隐藏「回到顶部」（恢复滚动后会被 updateBackToTop 重新评估）
    updateProgress();                         // 切换章节后重新计算进度
    // 淡入新内容
    if (article && !reduceMotion) {
      article.classList.remove("fade-out");
      article.classList.add("fade-in");
      // 动画结束后清理类，避免残留影响后续渲染
      setTimeout(() => article.classList.remove("fade-in"), 150);
    }
    chapterRenderTimer = setTimeout(() => {     // 等图片/字体加载、布局稳定后再校准一次
      chapterRenderTimer = null;
      if (activeChapterId === chap.id) restoreChapterScroll(chap.id);
      updateProgress();
    }, 60);
  } catch (e) {
    // 错误边界：加载 / 渲染失败时给出友好提示，而非白屏
    if (token !== chapterLoadToken) return;
    if (article) {
      article.classList.remove("fade-out", "fade-in");
      article.innerHTML = `<p class="load-error">加载失败，请刷新重试。</p>`;
    }
    console.warn("章节加载失败：", e);
  }
}

async function showRepo() {
  // 离开章节视图：保存当前章节滚动位置，并停止章节滚动恢复
  flushChapterScroll();
  suppressScrollSave = true;
  bindChapterScroll();                  // 仓库地图视图下也绑定（进度退回整窗滚动百分比）
  // 内存清理：取消未完成的 setTimeout（搜索防抖 / 章节渲染校准）
  if (fullSearchDebounceTimer) { clearTimeout(fullSearchDebounceTimer); fullSearchDebounceTimer = null; }
  if (chapterRenderTimer) { clearTimeout(chapterRenderTimer); chapterRenderTimer = null; }
  activeChapterId = null;
  setActive(null);
  // 离开互动演示视图：隐藏面板、恢复正文
  const articleEl = document.getElementById("article");
  const panelEl = document.getElementById("interactive-panel");
  if (articleEl) articleEl.hidden = false;
  if (panelEl) panelEl.hidden = true;
  const box = document.getElementById("inpage-toc");
  if (box) box.hidden = true;             // 仓库地图不显示「本页目录」
  if (inpageTocObserver) { inpageTocObserver.disconnect(); inpageTocObserver = null; }

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
        <a href="${GH_BASE}${c.path}" target="_blank" rel="noopener">${c.name} ↗</a>${c.core ? ' <span class="core-badge">核心</span>' : ""}
        <div class="path">${c.path}</div>
        <div class="desc">${c.desc || "<em>无描述</em>"}</div>
      </div>`
      )
      .join("");
  };
  draw("");
  document.getElementById("repo-search").addEventListener("input", (e) => draw(e.target.value.trim().toLowerCase()));
  window.scrollTo(0, 0);
  hideBackToTop();                          // 仓库地图切换时同样隐藏「回到顶部」
  updateProgress();
  suppressScrollSave = false;               // 恢复对仓库地图视图的滚动监听（activeChapterId 为 null，不会写入章节 key）
}

// ---------- 互动演示入口 ----------
// 侧边栏「🎮 互动演示」(#/interactive) 展示已建好的独立交互组件清单；
// 点「打开演示」以方案 B（内嵌 iframe）在面板内直接呈现，整合更紧密。
const INTERACTIVES = [
  { id: "arch-explorer", title: "架构探索器", desc: "点击 Codex 四大组件了解各自角色，还有 Quiz 小测验模式", file: "components/arch-explorer.html", icon: "🏗️" },
  { id: "turn-walker", title: "Turn 循环步进器", desc: "逐步演示 run_turn 主循环：问模型→分发→执行工具→循环", file: "components/turn-walker.html", icon: "🔄" },
  { id: "config-layers", title: "配置分层演示器", desc: "可视化 5 层配置覆盖规则，看 CLI 参数如何最终胜出", file: "components/config-layers.html", icon: "⚙️" }
];

function renderInteractiveGrid() {
  const grid = document.getElementById("interactive-grid");
  if (!grid) return;
  grid.innerHTML = INTERACTIVES.map((c) => `
    <div class="interactive-card">
      <div class="interactive-card-icon" aria-hidden="true">${c.icon}</div>
      <h3 class="interactive-card-title">${c.title}</h3>
      <p class="interactive-card-desc">${c.desc}</p>
      <button class="interactive-open-btn" type="button" data-id="${c.id}">打开演示</button>
    </div>`).join("");
  grid.querySelectorAll(".interactive-open-btn").forEach((btn) => {
    btn.addEventListener("click", () => openInteractive(btn.dataset.id));
  });
}

// 方案 B：复用同一个 iframe，在 #interactive-panel 内嵌入组件文件（sandbox 允许 scripts）。
// 懒加载：iframe 默认 about:blank，只有首次点击「打开演示」（或切换到不同组件）时才设置真实 src，
// 避免进入互动演示视图时一次性加载全部组件 HTML。
function openInteractive(id) {
  const comp = INTERACTIVES.find((c) => c.id === id);
  if (!comp) return;
  const panel = document.getElementById("interactive-panel");
  let frame = panel.querySelector("iframe.interactive-frame");
  if (!frame) {
    frame = document.createElement("iframe");
    frame.className = "interactive-frame";
    frame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-popups allow-forms");
    frame.src = "about:blank";          // 默认不加载任何组件
    panel.appendChild(frame);
  }
  frame.title = comp.title;
  // 仅在首次打开该组件 / 切换到不同组件时才真正加载，避免重复请求
  if (frame.getAttribute("data-comp") !== comp.id) {
    frame.src = comp.file;
    frame.setAttribute("data-comp", comp.id);
  }
  frame.scrollIntoView({ behavior: "smooth", block: "start" });
}

function showInteractive() {
  flushChapterScroll();
  suppressScrollSave = true;
  bindChapterScroll();
  // 内存清理：取消未完成的 setTimeout（搜索防抖 / 章节渲染校准）
  if (fullSearchDebounceTimer) { clearTimeout(fullSearchDebounceTimer); fullSearchDebounceTimer = null; }
  if (chapterRenderTimer) { clearTimeout(chapterRenderTimer); chapterRenderTimer = null; }
  activeChapterId = null;                 // 退出章节视图，进度退回整窗滚动
  const article = document.getElementById("article");
  const panel = document.getElementById("interactive-panel");
  if (article) article.hidden = true;
  if (panel) panel.hidden = false;
  // 互动演示视图不显示「本页目录」
  const box = document.getElementById("inpage-toc");
  if (box) box.hidden = true;
  if (inpageTocObserver) { inpageTocObserver.disconnect(); inpageTocObserver = null; }
  // 高亮侧边栏入口（其余 nav 取消高亮）
  document.querySelectorAll("#toc a").forEach((a) =>
    a.classList.toggle("active", a.id === "nav-interactive")
  );
  // 卡片只渲染一次（iframe 切换时不应重建列表）
  if (!panel.dataset.rendered) {
    renderInteractiveGrid();
    // 懒加载：先放一个默认 about:blank 的 iframe，首次点击「打开演示」才加载真实组件
    let frame = panel.querySelector("iframe.interactive-frame");
    if (!frame) {
      frame = document.createElement("iframe");
      frame.className = "interactive-frame";
      frame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-popups allow-forms");
      frame.src = "about:blank";
      panel.appendChild(frame);
    }
    panel.dataset.rendered = "1";
  }
  window.scrollTo(0, 0);
  hideBackToTop();
  updateProgress();                       // 算作额外内容，不影响章节进度
  suppressScrollSave = false;
}

function router() {
  closeSidebar();                       // 路由切换后收起移动端抽屉
  const h = window.location.hash || "";
  if (h === "#/interactive") return showInteractive();
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

// ---------- 全文搜索浮层 ----------
// 跨所有章节正文搜索（而非仅章节标题）。首次打开时按需 fetch 全部章节，
// 去掉代码围栏后转成纯文本并缓存到内存（state.fullIndex），之后不再重复请求。
// 输入时实时匹配，最多展示 20 条；每条含章节标题 + 命中上下文片段（关键词高亮），
// 点击跳转到 #/read/<id>。不依赖构建步骤，也不影响现有标题过滤搜索 / mermaid / 复制按钮。
const fullSearch = {
  index: new Map(),   // id -> { title, plain }
  loading: false,
  loaded: false,
};
let fullSearchEl = null;
let fullSearchDebounceTimer = null;      // 全文搜索 input 防抖 timer（切章时清理）

// 上次全文搜索词（用于跳转章节后在本页正文高亮）
let lastSearchQuery = "";

// ---------- 搜索增强辅助 ----------
// 搜索历史：localStorage 持久化最近 5 条，点击可重搜，单条可删除。
const SEARCH_HISTORY_KEY = "codex-guide-search-history";
function loadSearchHistory() {
  try { return JSON.parse(localStorage.getItem(SEARCH_HISTORY_KEY)) || []; } catch (e) { return []; }
}
function saveSearchHistory(arr) {
  try { localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(arr)); } catch (e) {}
}
function pushSearchHistory(term) {
  if (!term) return;
  const list = loadSearchHistory().filter((x) => x !== term);
  list.unshift(term);
  saveSearchHistory(list.slice(0, 5));
}

// 清除当前章节正文里的搜索高亮（mark.search-hit 还原为纯文本节点）
function clearSearchHighlight() {
  const article = document.getElementById("article");
  if (!article) return;
  article.querySelectorAll("mark.search-hit").forEach((m) =>
    m.replaceWith(document.createTextNode(m.textContent))
  );
}

// 在本页正文的文本节点里高亮 lastSearchQuery 的所有匹配（仅包裹文本，不破坏已有标签）
function applySearchHighlight() {
  const article = document.getElementById("article");
  if (!article || !lastSearchQuery) return;
  const terms = lastSearchQuery.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return;
  const re = new RegExp("(" + terms.map(escapeReg).join("|") + ")", "gi");
  const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      const p = node.parentElement;
      if (!p) return NodeFilter.FILTER_REJECT;
      // 已在高亮标记内的文本不再处理，避免重复包裹
      if (p.classList && p.classList.contains("search-hit")) return NodeFilter.FILTER_REJECT;
      // 跳过脚本 / 样式 / 代码块，避免破坏既有高亮与代码展示
      let el = p;
      while (el && el !== article) {
        const tag = el.tagName;
        if (tag === "SCRIPT" || tag === "STYLE" || tag === "PRE") return NodeFilter.FILTER_REJECT;
        el = el.parentElement;
      }
      const low = node.nodeValue.toLowerCase();
      if (!terms.some((t) => low.includes(t))) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const targets = [];
  let textNode;
  while ((textNode = walker.nextNode())) targets.push(textNode);
  if (!targets.length) return;
  targets.forEach((node) => {
    const text = node.nodeValue;
    re.lastIndex = 0;
    const frag = document.createDocumentFragment();
    let last = 0;
    let m;
    while ((m = re.exec(text))) {
      if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      const mark = document.createElement("mark");
      mark.className = "search-hit";
      mark.textContent = m[0];
      frag.appendChild(mark);
      last = m.index + m[0].length;
      if (m[0].length === 0) re.lastIndex++;   // 防御零宽匹配死循环
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    node.parentNode.replaceChild(frag, node);
  });
}

// 注入搜索增强样式（要求只改 app.js，故在此动态注入 <style>）
(function injectSearchEnhanceStyles() {
  if (document.getElementById("search-enhance-style")) return;
  const s = document.createElement("style");
  s.id = "search-enhance-style";
  s.textContent = `
.search-hit { background: #FEF08A; border-radius: 2px; padding: 0 1px; }
.fs-count { font-size: 12px; color: #6b7280; margin: 8px 2px 2px; }
.fs-history { margin: 6px 2px 2px; }
.fs-history-empty { font-size: 12px; color: #9ca3af; margin: 4px 0; }
.fs-history-item { display: flex; align-items: center; gap: 8px; font-size: 12px; color: #6b7280; padding: 4px 6px; border-radius: 4px; cursor: pointer; }
.fs-history-item:hover { background: rgba(127,127,127,.12); }
.fs-history-term { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fs-history-del { border: none; background: transparent; color: #9ca3af; cursor: pointer; font-size: 14px; line-height: 1; padding: 0 2px; }
.fs-history-del:hover { color: #ef4444; }
`;
  document.head.appendChild(s);
})();

// 注入章节切换淡入淡出 / 错误提示样式（只改 app.js，故动态注入 <style>）
(function injectChapterTransitionStyles() {
  if (document.getElementById("chapter-transition-style")) return;
  const s = document.createElement("style");
  s.id = "chapter-transition-style";
  s.textContent = `
#article { transition: opacity .15s ease; }
#article.fade-out { opacity: 0; }
#article.fade-in { opacity: 1; }
.load-error { color: #ef4444; padding: 24px 16px; text-align: center; font-size: 15px; }
`;
  document.head.appendChild(s);
})();

// 把 markdown 转成用于搜索的纯文本：先去代码围栏/行内代码，再去掉常见标记。
function mdToPlain(md) {
  return (md || "")
    .replace(/```[\s\S]*?```/g, " ")        // 代码围栏（含内容）整块剔除
    .replace(/~~~[\s\S]*?~~~/g, " ")        // 可能的 ~~~ 围栏
    .replace(/`[^`]*`/g, " ")               // 行内代码
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")  // 图片
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // 链接保留文字
    .replace(/^#{1,6}\s+/gm, "")            // 标题 # 号
    .replace(/[*_~>#|]/g, " ")              // 常见标记符号
    .replace(/\s+/g, " ")                   // 多余空白压成单空格
    .trim();
}

// 取首个关键词命中位置前后的上下文片段，并对关键词做高亮（<mark>）。
function makeSnippet(rawText, query) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return "";
  const lower = rawText.toLowerCase();
  let pos = -1;
  for (const t of terms) {
    const i = lower.indexOf(t);
    if (i >= 0) pos = pos < 0 ? i : Math.min(pos, i);
  }
  if (pos < 0) pos = 0;
  const start = Math.max(0, pos - 40);
  const end = Math.min(rawText.length, pos + 120);
  const snip = (start > 0 ? "…" : "") + rawText.slice(start, end) + (end < rawText.length ? "…" : "");
  return highlightTerms(snip, terms);
}

function escapeHtml(s) {
  return (s || "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}
function escapeReg(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function highlightTerms(text, terms) {
  const html = escapeHtml(text);
  const re = new RegExp("(" + terms.map(escapeReg).join("|") + ")", "gi");
  return html.replace(re, "<mark>$1</mark>");
}

// 首次打开时拉取并缓存全部章节正文（Promise.all 并发，逐个 chapter 只 fetch 一次）。
async function loadAllChapters() {
  if (fullSearch.loaded || fullSearch.loading) return;
  fullSearch.loading = true;
  try {
    await Promise.all(
      state.manifest.map(async (c) => {
        if (fullSearch.index.has(c.id)) return;
        const md = await (await fetch(c.file)).text();
        fullSearch.index.set(c.id, { title: c.title, plain: mdToPlain(md) });
      })
    );
    fullSearch.loaded = true;
  } finally {
    fullSearch.loading = false;
  }
}

function runFullSearch(q) {
  const resultsEl = fullSearchEl.querySelector("#fs-results");
  const countEl = fullSearchEl.querySelector("#fs-count");
  const histEl = fullSearchEl.querySelector("#fs-history");
  const query = (q || "").trim();
  // 记录“上次搜索词”，供跳转章节后在本页正文高亮
  lastSearchQuery = query;
  if (!query) {
    resultsEl.innerHTML = '<p class="fs-empty">输入关键词，跨所有章节正文搜索。</p>';
    if (countEl) countEl.hidden = true;
    if (histEl) histEl.hidden = true;
    renderHistory();                 // 空查询时回显历史
    return;
  }
  if (histEl) histEl.hidden = true;  // 有查询时隐藏历史
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const hits = [];
  for (const c of state.manifest) {
    const entry = fullSearch.index.get(c.id);
    if (!entry) continue;
    const lower = entry.plain.toLowerCase();
    // 所有关键词都需命中（AND 语义），对中文按子串包含即可。
    if (!terms.every((t) => lower.includes(t))) continue;
    // 统计首个关键词出现次数，作为相关性排序依据
    let count = 0;
    const first = terms[0];
    let idx = lower.indexOf(first);
    while (idx >= 0) {
      count++;
      idx = lower.indexOf(first, idx + first.length);
    }
    hits.push({ id: c.id, title: entry.title, count, snippet: makeSnippet(entry.plain, query) });
  }
  hits.sort((a, b) => b.count - a.count);
  const top = hits.slice(0, 20);
  if (countEl) {
    countEl.hidden = false;
    countEl.textContent = `找到 ${hits.length} 个章节包含「${query}」`;
  }
  if (!top.length) {
    resultsEl.innerHTML = `<p class="fs-empty">没有匹配「${escapeHtml(query)}」的结果。</p>`;
    return;
  }
  resultsEl.innerHTML = top
    .map(
      (h) => `
      <a class="fs-item" href="#/read/${h.id}">
        <span class="fs-item-head">
          <span class="fs-title">${escapeHtml(h.title)}</span>
          <span class="fs-meta">${h.count} 处命中</span>
        </span>
        <span class="fs-snippet">${h.snippet}</span>
      </a>`
    )
    .join("");
  // 点击：交由默认 hash 跳转，关闭浮层（覆盖层 z-index 较高，需手动收起）
  resultsEl.querySelectorAll(".fs-item").forEach((a) => {
    a.addEventListener("click", () => { recordSearch(); setTimeout(closeFullSearch, 0); });   // 记录已执行的搜索并收起浮层
  });
}

// 把当前输入框里的查询记入搜索历史（在“提交搜索”时调用，而非每次按键）
function recordSearch() {
  const input = fullSearchEl && fullSearchEl.querySelector("#fs-input");
  if (input) pushSearchHistory(input.value.trim());
}

// 渲染搜索历史列表（点击重搜，× 删除单条）
function renderHistory() {
  const histEl = fullSearchEl && fullSearchEl.querySelector("#fs-history");
  if (!histEl) return;
  const list = loadSearchHistory();
  if (!list.length) {
    histEl.hidden = false;
    histEl.innerHTML = '<p class="fs-history-empty">暂无搜索历史</p>';
    return;
  }
  histEl.hidden = false;
  histEl.innerHTML = list
    .map(
      (t) => `
      <div class="fs-history-item" data-term="${escapeHtml(t)}">
        <span class="fs-history-term">${escapeHtml(t)}</span>
        <button class="fs-history-del" type="button" aria-label="删除记录" data-term="${escapeHtml(t)}">×</button>
      </div>`
    )
    .join("");
}

function buildFullSearch() {
  if (fullSearchEl) return fullSearchEl;
  const overlay = document.createElement("div");
  overlay.className = "full-search-overlay";
  overlay.id = "full-search-overlay";
  overlay.hidden = true;
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-labelledby", "fs-title");
  overlay.innerHTML = `
    <div class="full-search-card">
      <h2 id="fs-title" class="fs-dialog-title">全文搜索</h2>
      <div class="fs-input-row">
        <input id="fs-input" type="search" placeholder="搜索全部章节正文…（Ctrl / ⌘ + K）" autocomplete="off" />
        <button id="fs-close" class="fs-close" type="button" aria-label="关闭">✕</button>
      </div>
      <div id="fs-history" class="fs-history" hidden></div>
      <div id="fs-count" class="fs-count" hidden></div>
      <div id="fs-results" class="fs-results">
        <p class="fs-empty">输入关键词，跨所有章节正文搜索。</p>
      </div>
    </div>
  `;
  // 仅点击遮罩本身（而非卡片）时关闭
  overlay.addEventListener("click", (e) => { if (e.target === overlay) closeFullSearch(); });
  document.body.appendChild(overlay);
  fullSearchEl = overlay;

  const input = overlay.querySelector("#fs-input");
  // 200ms 防抖：避免每次按键都重新过滤结果
  input.addEventListener("input", () => {
    if (fullSearchDebounceTimer) clearTimeout(fullSearchDebounceTimer);
    const val = input.value;
    fullSearchDebounceTimer = setTimeout(() => {
      fullSearchDebounceTimer = null;
      runFullSearch(val);
    }, 200);
  });
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") recordSearch(); });
  overlay.querySelector("#fs-close").addEventListener("click", closeFullSearch);
  // 搜索历史：点击条目重搜，点击 × 删除单条（事件委托，避免重渲染后失效）
  const histEl = overlay.querySelector("#fs-history");
  if (histEl) {
    histEl.addEventListener("click", (e) => {
      const del = e.target.closest(".fs-history-del");
      if (del) {
        const term = del.dataset.term;
        saveSearchHistory(loadSearchHistory().filter((x) => x !== term));
        renderHistory();
        return;
      }
      const item = e.target.closest(".fs-history-item");
      if (item) {
        const term = item.dataset.term;
        pushSearchHistory(term);          // 重搜时把该条提到最前
        input.value = term;
        runFullSearch(term);
      }
    });
  }
  return overlay;
}

async function openFullSearch() {
  const o = buildFullSearch();
  o.hidden = false;
  clearSearchHighlight();             // 打开搜索框时清掉正文里的高亮
  const input = o.querySelector("#fs-input");
  input.value = "";
  input.focus();
  const countEl = o.querySelector("#fs-count");
  if (countEl) countEl.hidden = true;
  renderHistory();                   // 展示最近搜索历史
  if (fullSearch.loaded) {
    o.querySelector("#fs-results").innerHTML =
      '<p class="fs-empty">输入关键词，跨所有章节正文搜索。</p>';
  } else {
    o.querySelector("#fs-results").innerHTML = '<p class="fs-empty">正在准备全文索引…</p>';
    loadAllChapters().then(() => { if (!o.hidden) runFullSearch(""); });
  }
}

function closeFullSearch() {
  if (fullSearchDebounceTimer) { clearTimeout(fullSearchDebounceTimer); fullSearchDebounceTimer = null; }
  if (fullSearchEl) fullSearchEl.hidden = true;
}

function initFullSearchButton() {
  const btn = document.getElementById("full-search-btn");
  if (btn) btn.addEventListener("click", openFullSearch);
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
  overlay.setAttribute("aria-labelledby", "help-title");
  overlay.innerHTML = `
    <div class="help-card">
      <h2 class="help-title" id="help-title">快捷键</h2>
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
  // 全文搜索浮层打开时：仅 Esc 可关闭，其余按键交给浮层内的输入框处理
  if (fullSearchEl && !fullSearchEl.hidden) {
    if (e.key === "Escape") { e.preventDefault(); closeFullSearch(); }
    return;
  }
  // 帮助浮层打开时：仅 Esc 可关闭，其余按键均不触发翻章
  if (helpOverlayEl && !helpOverlayEl.hidden) {
    if (e.key === "Escape") { e.preventDefault(); closeHelpOverlay(); }
    return;
  }
  // Ctrl / ⌘ + K 打开全文搜索（放在输入框/修饰键守卫之前，确保任何时候都能唤起）
  if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
    e.preventDefault();
    openFullSearch();
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
(function initInpageTocToggle() {
  const box = document.getElementById("inpage-toc");
  const btn = document.getElementById("inpage-toc-toggle");
  if (!box || !btn) return;
  btn.addEventListener("click", () => box.classList.toggle("collapsed"));
})();

// ---------- 启动 ----------
(async function main() {
  await buildToc();
  initFullSearchButton();
  router();
})();
