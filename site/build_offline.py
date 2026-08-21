#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
build_offline.py — 生成可离线打开的自包含单文件站点 site/dist/index.html。

只用 Python 标准库，不联网、不依赖 marked/highlight/mermaid 等 CDN。
产物内联了 CSS、全部章节正文、SVG 图、crates.json，并用原生 JS 实现
深浅色切换与仓库地图过滤。不改动现有多文件版（GitHub Pages 版）。

用法：python3 build_offline.py
"""

import json
import os
import re
import html as html_module

BASE = os.path.dirname(os.path.abspath(__file__))

LEVEL_CLASS = {
    "入门": "beginner",
    "进阶": "intermediate",
    "深入": "advanced",
    "参考": "reference",
}

# --------------------------------------------------------------------------
# 基础工具
# --------------------------------------------------------------------------

def escape_html(s):
    return html_module.escape(str(s), quote=False)


def strip_scheme(s):
    """去掉 http(s):// 协议前缀，保证离线产物不含任何外链 http(s) 引用。"""
    return re.sub(r"https?://", "", str(s))


def slug(s):
    s = re.sub(r"[^\w\u4e00-\u9fff\-]+", "-", s).strip("-")
    return s or "sec"


def read_text(rel):
    with open(os.path.join(BASE, rel), "r", encoding="utf-8") as f:
        return f.read()


# --------------------------------------------------------------------------
# 行内渲染：code / 图片 / 链接 / 粗体 / 斜体
# --------------------------------------------------------------------------

TOKEN = re.compile(
    r"(!\[[^\]]*\]\([^)]+\))"      # 1 图片
    r"|(\[[^\]]+\]\([^)]+\))"      # 2 链接
    r"|(\*\*.+?\*\*)"              # 3 粗体
    r"|(\*.+?\*)"                  # 4 斜体
    r"|(`[^`]+`)"                  # 5 行内代码
)


def render_inline_image(alt, url):
    if url.endswith(".svg"):
        p = os.path.join(BASE, url)
        if os.path.exists(p):
            return inline_svg(p, "img")
    return '<img src="%s" alt="%s">' % (escape_html(url), escape_html(alt))


def render_link(text, url):
    text = escape_html(strip_scheme(text))
    if url.startswith("#/read/"):  # 多文件版的 SPA 路由 → 离线版锚点
        url = "#" + url[len("#/read/"):]
    if url.startswith("#"):
        return '<a href="%s">%s</a>' % (escape_html(url), text)
    if re.match(r"^https?://", url):
        # 外链：丢弃 URL，仅保留可见文字，避免任何 http(s) 引用
        return text
    return '<a href="%s">%s</a>' % (escape_html(url), text)


def _repl(m):
    if m.group(1):  # 图片
        mm = re.match(r"!\[([^\]]*)\]\(([^)]+)\)", m.group(1))
        return render_inline_image(mm.group(1), mm.group(2))
    if m.group(2):  # 链接
        mm = re.match(r"\[([^\]]+)\]\(([^)]+)\)", m.group(2))
        return render_link(mm.group(1), mm.group(2))
    if m.group(3):  # 粗体
        return "<strong>" + escape_html(strip_scheme(m.group(3)[2:-2])) + "</strong>"
    if m.group(4):  # 斜体
        return "<em>" + escape_html(strip_scheme(m.group(4)[1:-1])) + "</em>"
    if m.group(5):  # 行内代码
        return "<code>" + escape_html(strip_scheme(m.group(5)[1:-1])) + "</code>"
    return ""


def render_inline(text):
    out = []
    last = 0
    for m in TOKEN.finditer(text):
        out.append(escape_html(strip_scheme(text[last:m.start()])))
        out.append(_repl(m))
        last = m.end()
    out.append(escape_html(strip_scheme(text[last:])))
    return "".join(out)


# --------------------------------------------------------------------------
# SVG 内联：去掉 xmlns（HTML5 内联 SVG 不需要）、统一 id 避免冲突
# --------------------------------------------------------------------------

SVG_CACHE = {}


def inline_svg(path, prefix):
    key = (os.path.relpath(path, BASE), prefix)
    if key in SVG_CACHE:
        return SVG_CACHE[key]
    svg = read_text(os.path.relpath(path, BASE))
    # 去掉命名空间声明，既符合 HTML5 内联规则，也消除唯一的 http:// 引用
    svg = re.sub(r'\sxmlns="http://www\.w3\.org/2000/svg"', "", svg)
    svg = re.sub(r"\sxmlns='http://www\.w3\.org/2000/svg'", "", svg)
    for old in re.findall(r'\bid="([^"]+)"', svg):
        new = "%s_%s" % (prefix, old)
        svg = svg.replace('id="%s"' % old, 'id="%s"' % new)
        svg = svg.replace("url(#%s)" % old, "url(#%s)" % new)
        svg = svg.replace('href="#%s"' % old, 'href="#%s"' % new)
        svg = svg.replace('xlink:href="#%s"' % old, 'xlink:href="#%s"' % new)
    svg = svg.strip()
    SVG_CACHE[key] = svg
    return svg


def render_image_block(alt, url):
    if url.endswith(".svg"):
        p = os.path.join(BASE, url)
        if os.path.exists(p):
            return inline_svg(p, "blk")
    return '<img src="%s" alt="%s">' % (escape_html(url), escape_html(alt))


# --------------------------------------------------------------------------
# 块级渲染
# --------------------------------------------------------------------------

def split_row(line):
    line = line.strip()
    if line.startswith("|"):
        line = line[1:]
    if line.endswith("|"):
        line = line[:-1]
    return [c.strip() for c in line.split("|")]


def parse_table(rows):
    if len(rows) < 2:
        return ""
    header = split_row(rows[0])
    body = [split_row(r) for r in rows[2:] if r.strip()]
    thead = "<thead><tr>" + "".join(
        "<th>%s</th>" % render_inline(c) for c in header
    ) + "</tr></thead>"
    tbody = "<tbody>" + "".join(
        "<tr>" + "".join("<td>%s</td>" % render_inline(c) for c in row) + "</tr>"
        for row in body
    ) + "</tbody>"
    return "<table>%s%s</table>" % (thead, tbody)


def is_special(line):
    s = line.lstrip()
    if s.startswith("```"):
        return True
    if re.match(r"^#{1,6}\s", s):
        return True
    if s.startswith(">"):
        return True
    if s.startswith("|"):
        return True
    if re.match(r"^\s*\d+[.)]\s", line):
        return True
    if re.match(r"^\s*[-*+]\s", line):
        return True
    if re.match(r"^\s*([-*_])(\s*\1){2,}\s*$", line):
        return True
    if re.match(r"^!\[([^\]]*)\]\(([^)]+)\)\s*$", line):
        return True
    return False


def render_markdown(md, cid):
    lines = md.split("\n")
    out = []
    i = 0
    n = len(lines)
    first_h1_skipped = False

    while i < n:
        line = lines[i]
        if line.strip() == "":
            i += 1
            continue

        # 围栏代码块
        if line.lstrip().startswith("```"):
            lang = line.strip()[3:].strip()
            i += 1
            buf = []
            while i < n and not lines[i].lstrip().startswith("```"):
                buf.append(lines[i])
                i += 1
            i += 1  # 跳过结束围栏
            code = "\n".join(buf)
            code = escape_html(strip_scheme(code))
            if lang.lower() == "mermaid":
                out.append(
                    '<div class="mermaid"><pre><code>%s</code></pre>'
                    '<p style="margin:8px 0 0;color:var(--text-faint);font-size:12px">'
                    "⚠ 离线版不渲染 Mermaid 图，仅保留源码文本。</p></div>" % code
                )
            else:
                out.append("<pre><code>%s</code></pre>" % code)
            continue

        # 标题
        m = re.match(r"^(#{1,6})\s+(.*)$", line)
        if m:
            level = len(m.group(1))
            text = m.group(2).strip()
            if level == 1 and not first_h1_skipped:
                first_h1_skipped = True  # 标题由 manifest 单独渲染
                i += 1
                continue
            out.append(
                '<h%d id="%s">%s</h%d>'
                % (level, escape_html(cid + "-" + slug(text)),
                   render_inline(text), level)
            )
            i += 1
            continue

        # 整行图片
        m = re.match(r"^!\[([^\]]*)\]\(([^)]+)\)\s*$", line)
        if m:
            out.append(render_image_block(m.group(1), m.group(2)))
            i += 1
            continue

        # 引用
        if line.lstrip().startswith(">"):
            buf = []
            while i < n and lines[i].lstrip().startswith(">"):
                buf.append(re.sub(r"^\s*>\s?", "", lines[i]))
                i += 1
            out.append(
                "<blockquote>%s</blockquote>"
                % " ".join(render_inline(l) for l in buf)
            )
            continue

        # 表格
        if line.strip().startswith("|"):
            buf = []
            while i < n and lines[i].strip().startswith("|"):
                buf.append(lines[i])
                i += 1
            out.append(parse_table(buf))
            continue

        # 有序列表
        if re.match(r"^\s*\d+[.)]\s+", line):
            buf = []
            while i < n and re.match(r"^\s*\d+[.)]\s+", lines[i]):
                buf.append(re.sub(r"^\s*\d+[.)]\s+", "", lines[i]))
                i += 1
            out.append(
                "<ol>" + "".join("<li>%s</li>" % render_inline(x) for x in buf) + "</ol>"
            )
            continue

        # 无序列表
        if re.match(r"^\s*[-*+]\s+", line):
            buf = []
            while i < n and re.match(r"^\s*[-*+]\s+", lines[i]):
                buf.append(re.sub(r"^\s*[-*+]\s+", "", lines[i]))
                i += 1
            out.append(
                "<ul>" + "".join("<li>%s</li>" % render_inline(x) for x in buf) + "</ul>"
            )
            continue

        # 分隔线
        if re.match(r"^\s*([-*_])(\s*\1){2,}\s*$", line):
            out.append("<hr>")
            i += 1
            continue

        # 段落
        buf = []
        while i < n and lines[i].strip() != "" and not is_special(lines[i]):
            buf.append(lines[i])
            i += 1
        out.append("<p>%s</p>" % render_inline(" ".join(buf)))

    return "\n".join(out)


# --------------------------------------------------------------------------
# 章节 / 仓库地图装配
# --------------------------------------------------------------------------

def build_chapter(meta):
    cid = meta["id"]
    md = read_text(meta["file"])
    body = render_markdown(md, cid)
    lvl = meta.get("level", "")
    cls = LEVEL_CLASS.get(lvl, "reference")
    badge = (
        '<span class="level-badge %s">%s</span>' % (cls, escape_html(lvl))
        if lvl else ""
    )
    return (
        '<section id="%s" class="chapter">\n'
        "<h1>%s</h1>\n"
        '<div class="chapter-level">%s</div>\n'
        "%s\n</section>"
        % (escape_html(cid), escape_html(meta["title"]), badge, body)
    )


def build_explorer(crates):
    data_json = json.dumps(crates, ensure_ascii=False).replace("</", "<\\/")
    template = """
<section id="crate-explorer" class="chapter">
<h1>仓库地图（可搜索）</h1>
<div class="repo-head"><p>来自 <code>data/crates.json</code> 的全部 crate；在下方输入框输入名字 / 路径 / 描述即可实时过滤。</p></div>
<div class="repo-filter"><input id="repo-search" type="search" placeholder="过滤 crate（名称 / 路径 / 描述）…" aria-label="过滤 crate"></div>
<div class="repo-count" id="repo-count"></div>
<div class="repo-grid" id="repo-grid"></div>
<script type="application/json" id="crate-data">__DATA__</script>
<script>
(function(){
  var data = JSON.parse(document.getElementById('crate-data').textContent);
  var grid = document.getElementById('repo-grid');
  var count = document.getElementById('repo-count');
  var input = document.getElementById('repo-search');
  function esc(s){
    return (s==null?'':String(s)).replace(/[&<>"']/g,function(c){
      return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
    });
  }
  function card(c){
    var core = c.core ? '<span class="core-badge">核心</span>' : '';
    var desc = c.desc ? c.desc : '';
    return '<div class="crate-card"><a class="crate-name" href="#">'+esc(c.name)+'</a>'+core
      +'<div class="path">'+esc(c.path)+'</div>'
      +'<div class="desc">'+esc(desc)+'</div></div>';
  }
  function render(list){
    grid.innerHTML = list.length ? list.map(card).join('') : '<p class="repo-count">无匹配 crate。</p>';
    count.textContent = '共 '+list.length+' / '+data.length+' 个 crate';
  }
  input.addEventListener('input', function(e){
    var q = e.target.value.trim().toLowerCase();
    if(!q){ render(data); return; }
    render(data.filter(function(c){
      return (c.name+' '+c.path+' '+(c.desc||'')).toLowerCase().indexOf(q) >= 0;
    }));
  });
  render(data);
})();
</script>
</section>
"""
    return template.replace("__DATA__", data_json)


# --------------------------------------------------------------------------
# 主流程
# --------------------------------------------------------------------------

def main():
    manifest = json.loads(read_text("content/manifest.json"))
    crates = json.loads(read_text("data/crates.json"))
    css = read_text("css/styles.css")

    toc = []
    for meta in manifest:
        lvl = meta.get("level", "")
        cls = LEVEL_CLASS.get(lvl, "reference")
        toc.append(
            '<a href="#%s" class="toc-link"><span class="toc-title">%s</span>'
            '<span class="level-badge %s">%s</span></a>'
            % (escape_html(meta["id"]), escape_html(meta["title"]), cls, escape_html(lvl))
        )
    toc.append(
        '<a href="#crate-explorer" class="toc-link repo">'
        '<span class="toc-title">仓库地图（可搜索）</span></a>'
    )
    toc_html = "\n".join(toc)

    chapters = [build_chapter(meta) for meta in manifest]
    sections_html = "\n".join(chapters) + "\n" + build_explorer(crates)

    theme_head = (
        "<script>(function(){try{var s=localStorage.getItem('theme');"
        "var m=window.matchMedia('(prefers-color-scheme: dark)').matches"
        "?\"dark\":\"light\";"
        "document.documentElement.setAttribute('data-theme',s||m);}"
        "catch(e){document.documentElement.setAttribute('data-theme','light');}})();</script>"
    )

    toggle_js = (
        "<script>(function(){var btn=document.getElementById('theme-toggle');"
        "if(btn)btn.addEventListener('click',function(){"
        "var r=document.documentElement;"
        "var cur=r.getAttribute('data-theme')||'light';"
        "var next=cur==='dark'?'light':'dark';"
        "r.setAttribute('data-theme',next);"
        "try{localStorage.setItem('theme',next);}catch(e){}}});})();</script>"
    )

    toc_filter_js = (
        "<script>(function(){var s=document.getElementById('search');"
        "if(!s)return;"
        "s.addEventListener('input',function(e){"
        "var q=e.target.value.trim().toLowerCase();"
        "var links=document.querySelectorAll('#toc a');"
        "links.forEach(function(a){"
        "var t=a.textContent.toLowerCase();"
        "a.style.display=(!q||t.indexOf(q)>=0)?'':'none';});});})();</script>"
    )

    html = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Codex 阅读指南 · 离线单文件版</title>
<style>__CSS__</style>
__THEME_HEAD__
</head>
<body>
<div class="layout">
  <aside class="sidebar" id="sidebar">
    <div class="brand">
      <div class="brand-mark">Cx</div>
      <div class="brand-text">
        <strong>Codex 阅读指南</strong>
        <span>codex-rs 源码导读 · 离线版</span>
      </div>
    </div>
    <div class="search">
      <input id="search" type="search" placeholder="搜索章节…" autocomplete="off" aria-label="搜索章节">
    </div>
    <nav class="toc" id="toc" role="navigation" aria-label="章节导航">__TOC__</nav>
    <div class="sidebar-foot">
      <button id="theme-toggle" class="theme-toggle" title="切换深/浅色" aria-label="切换深/浅色主题">◐ 主题</button>
    </div>
  </aside>
  <main class="content" id="content">
    <article class="markdown" id="article">
__SECTIONS__
    </article>
    <footer id="site-footer">
      <p class="footer-note">本指南为 codex-rs 仓库的源码导读，引用位置随上游版本可能漂移，以函数/结构体名为准。</p>
      <p class="footer-meta">离线单文件版 · 自动构建自 site/ 多文件版</p>
    </footer>
  </main>
</div>
__TOGGLE_JS__
__TOC_FILTER_JS__
</body>
</html>
"""

    html = (
        html.replace("__CSS__", css)
        .replace("__THEME_HEAD__", theme_head)
        .replace("__TOC__", toc_html)
        .replace("__SECTIONS__", sections_html)
        .replace("__TOGGLE_JS__", toggle_js)
        .replace("__TOC_FILTER_JS__", toc_filter_js)
    )

    dist = os.path.join(BASE, "dist")
    os.makedirs(dist, exist_ok=True)
    out_path = os.path.join(dist, "index.html")
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(html)

    size = os.path.getsize(out_path)
    print("OK -> %s" % out_path)
    print("体积: %.1f KB (%.2f MB)" % (size / 1024, size / 1024 / 1024))
    print("章节数: %d, crate 数: %d" % (len(manifest), len(crates)))
    # 校验：产物不应含有任何外链 http(s) 引用
    ext = re.findall(r'https?://', html)
    print("外链 http(s) 引用数量: %d" % len(ext))


if __name__ == "__main__":
    main()
