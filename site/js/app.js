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

// ---------- Markdown 配置 ----------
marked.setOptions({ gfm: true, breaks: false });

function renderMarkdown(md) {
  return marked.parse(md);
}

// ---------- 侧边栏 ----------
async function buildToc() {
  const res = await fetch("content/manifest.json");
  state.manifest = await res.json();
  const toc = document.getElementById("toc");
  const repoLink = `<a href="#/repo" class="repo" data-route="repo">▦ 仓库地图（${state.manifest.length} 章 + crates）</a>`;
  toc.innerHTML =
    state.manifest.map((c, i) =>
      `<a href="#/read/${c.id}" data-id="${c.id}">${c.title}</a>`
    ).join("") + repoLink;

  // 章节搜索
  const search = document.getElementById("search");
  search.addEventListener("input", () => {
    const q = search.value.trim().toLowerCase();
    toc.querySelectorAll("a[data-id]").forEach((a) => {
      const txt = a.textContent.toLowerCase();
      a.style.display = !q || txt.includes(q) ? "" : "none";
    });
  });
}

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
    article.innerHTML = renderMarkdown(md);
    article.querySelectorAll("pre code").forEach((el) => hljs.highlightElement(el));
    document.getElementById("content").scrollTop = 0;
    window.scrollTo(0, 0);
  } catch (e) {
    article.innerHTML = `<p>加载失败：${e.message}<br/>请通过 HTTP 服务（如 GitHub Pages）访问，而不是直接用 file:// 打开。</p>`;
  }
}

async function showRepo() {
  setActive(null);
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
}

function router() {
  const h = window.location.hash || "";
  if (h.startsWith("#/repo")) return showRepo();
  const m = h.match(/^#\/read\/(.+)$/);
  if (m) return showChapter(m[1]);
  // 默认：第一章
  if (!h) window.location.hash = "#/read/" + state.manifest[0].id;
  else showChapter(state.manifest[0].id);
}

window.addEventListener("hashchange", router);

// ---------- 启动 ----------
(async function main() {
  await buildToc();
  router();
})();
