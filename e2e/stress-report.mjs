// Turns a stress run (see stress.mjs) into one self-contained HTML page:
// inline SVG charts, no scripts from anywhere else, readable offline.
//
//   node e2e/stress-report.mjs e2e/results/stress-<time>.json > report.html

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const COLORS = { before: 'var(--series-1)', after: 'var(--series-2)', blank: 'var(--text-muted)' };
const LABELS = { before: '改动前', after: '改动后', blank: '空白弹窗' };
const SCENARIO_LABELS = { small: '存储小', large: '存储大（约 4 MB）', busy: '忙碌：标签页都在运行' };

const median = (xs) => {
  const s = xs.filter((x) => x != null).sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : null;
};
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// A top for the y axis that splits into four round steps.
function niceMax(v) {
  if (v <= 0) return 10;
  const raw = v / 4;
  const p = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= raw) return m * p * 4;
  return 40 * p;
}

// series: [{ key, points: [{ x, y, runs: [..] }] }]
// x is categorical (tab counts, latencies): evenly spaced, labelled as given.
function lineChart({ xs, xLabel, series, yMax, reference }) {
  const W = 460, H = 240, L = 58, R = 16, T = 14, B = 40;
  const pw = W - L - R, ph = H - T - B;
  const allY = series.flatMap((s) => s.points.flatMap((p) => [p.y, ...(p.runs ?? [])])).filter((v) => v != null);
  const top = yMax ?? niceMax(Math.max(...allY, reference ? Math.max(...xs) : 0) * 1.05);
  const xAt = (i) => L + (xs.length === 1 ? pw / 2 : (i * pw) / (xs.length - 1));
  const yAt = (v) => T + ph - (v / top) * ph;

  let svg = `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img">`;
  for (let k = 0; k <= 4; k++) {
    const v = (top * k) / 4;
    svg += `<line x1="${L}" x2="${W - R}" y1="${yAt(v)}" y2="${yAt(v)}" class="grid"/>`;
    svg += `<text x="${L - 8}" y="${yAt(v) + 4}" class="tick" text-anchor="end">${Math.round(v).toLocaleString('en-US')}</text>`;
  }
  xs.forEach((x, i) => {
    svg += `<text x="${xAt(i)}" y="${H - B + 18}" class="tick" text-anchor="middle">${x}</text>`;
  });
  svg += `<text x="${L + pw / 2}" y="${H - 4}" class="axis-label" text-anchor="middle">${esc(xLabel)}</text>`;
  svg += `<text x="10" y="${T + ph / 2}" class="axis-label" text-anchor="middle" transform="rotate(-90 10 ${T + ph / 2})">毫秒</text>`;

  if (reference) {
    const d = xs.map((x, i) => `${i ? 'L' : 'M'}${xAt(i)},${yAt(x)}`).join(' ');
    svg += `<path d="${d}" class="reference"/>`;
  }

  for (const s of series) {
    // Individual runs, faint, so the spread is visible behind the median.
    s.points.forEach((p) => {
      const i = xs.indexOf(p.x);
      const off = { before: -5, after: 5 }[s.key] ?? 0;
      for (const r of p.runs ?? []) {
        svg += `<circle cx="${xAt(i) + off}" cy="${yAt(Math.min(r, top))}" r="2" fill="${COLORS[s.key]}" opacity="0.28"/>`;
      }
    });
    const pts = s.points.filter((p) => p.y != null);
    const d = pts.map((p, j) => `${j ? 'L' : 'M'}${xAt(xs.indexOf(p.x))},${yAt(p.y)}`).join(' ');
    svg += `<path d="${d}" fill="none" stroke="${COLORS[s.key]}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
    for (const p of pts) {
      const tip = `${LABELS[s.key]} · ${xLabel} ${p.x}：中位数 ${p.y} ms` + (p.runs?.length ? `（${p.runs.length} 次，${Math.min(...p.runs)}–${Math.max(...p.runs)}）` : '');
      svg += `<circle cx="${xAt(xs.indexOf(p.x))}" cy="${yAt(p.y)}" r="4.5" fill="${COLORS[s.key]}" class="dot" data-tip="${esc(tip)}"/>`;
    }
  }
  return svg + '</svg>';
}

function table(xs, xLabel, series) {
  const head = `<tr><th>${esc(xLabel)}</th>${series.map((s) => `<th>${LABELS[s.key]}（中位数 ms）</th>`).join('')}</tr>`;
  const rows = xs.map((x) => `<tr><td>${x}</td>${series.map((s) => {
    const p = s.points.find((q) => q.x === x);
    return `<td>${p?.y ?? '—'}</td>`;
  }).join('')}</tr>`).join('');
  return `<details><summary>查看数据表</summary><table>${head}${rows}</table></details>`;
}

function panel(title, note, spec) {
  return `<figure class="panel"><figcaption><h3>${esc(title)}</h3>${note ? `<p>${esc(note)}</p>` : ''}</figcaption>
    ${lineChart(spec)}${table(spec.xs, spec.xLabel, spec.series)}</figure>`;
}

export function renderReport(run) {
  const all = run.builds.map((b) => b.name);
  const builds = all.filter((b) => b !== 'blank');
  const scenarioOf = (r) => r.scenario ?? r.storage;
  const scenarios = (run.config.SCENARIOS ?? run.config.STORAGE_LEVELS.map((x) => ({ scenario: x }))).map((x) => x.scenario);
  const opens = run.results.filter((r) => r.kind === 'open' && !r.error);
  const commands = run.results.filter((r) => r.kind === 'command');
  const tabsXs = run.config.TAB_LEVELS;

  const openSeries = (scenario, field, withBlank = false) => (withBlank ? all : builds).map((key) => ({
    key,
    points: tabsXs.map((x) => {
      const runs = opens.filter((r) => r.build === key && scenarioOf(r) === scenario && r.tabs === x).map((r) => r[field]);
      return { x, y: median(runs), runs };
    }),
  }));
  const cmdSeries = (sweep, xField, xs, field) => builds.map((key) => ({
    key,
    points: xs.map((x) => {
      const runs = commands.filter((r) => r.build === key && r.sweep === sweep && r[xField] === x).map((r) => r[field]);
      return { x, y: median(runs), runs };
    }),
  }));

  // Shared y scale per metric across the storage panels, so they compare.
  const scaleFor = (field) => niceMax(Math.max(...opens.map((r) => r[field])) * 1.02);

  const maxTabs = tabsXs[tabsXs.length - 1];
  const tile = (label, field, scenario) => {
    const keys = field === 'visible' ? all : builds;
    const vals = keys.map((b) => median(opens.filter((r) => r.build === b && scenarioOf(r) === scenario && r.tabs === maxTabs).map((r) => r[field])));
    const delta = vals[1] - vals[0];
    return `<div class="tile"><div class="tile-label">${esc(label)}</div>
      <div class="tile-values">${keys.map((b, i) => `<span><i style="background:${COLORS[b]}"></i>${LABELS[b]} <b>${vals[i]} ms</b></span>`).join('')}</div>
      <div class="tile-delta">${delta === 0 ? '没有差别' : delta < 0 ? `快了 ${-delta} ms` : `慢了 ${delta} ms`}</div></div>`;
  };

  const cmdVals = builds.map((b) => median(commands.filter((r) => r.build === b && r.sweep === 'tabs' && r.tabs === maxTabs).map((r) => r.overhead)));
  const cmdTile = `<div class="tile"><div class="tile-label">模型命令，扩展自己花的时间（不含 Groq）</div>
      <div class="tile-values">${builds.map((b, i) => `<span><i style="background:${COLORS[b]}"></i>${LABELS[b]} <b>${cmdVals[i]} ms</b></span>`).join('')}</div>
      <div class="tile-delta">同样 ${maxTabs} 个标签页，比打开弹窗贵得多</div></div>`;

  const errors = run.results.filter((r) => r.error);
  const legend = `<div class="legend">${run.builds.map((b) => `<span><i style="background:${COLORS[b.name]}"></i>${LABELS[b.name]}：<code>${esc(b.ref)}</code> @ <code>${esc(b.sha)}</code> ${esc(b.subject)}</span>`).join('')}</div>`;

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>弹窗启动压力测试</title>
<style>
:root { color-scheme: light;
  --surface: #fcfcfb; --surface-2: #f3f2ef; --text-primary: #0b0b0b; --text-secondary: #52514e; --text-muted: #7a7974;
  --grid: #e4e3df; --series-1: #2a78d6; --series-2: #eb6834; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { color-scheme: dark;
  --surface: #1a1a19; --surface-2: #252524; --text-primary: #f0efec; --text-secondary: #c3c2b7; --text-muted: #94938b;
  --grid: #33332f; --series-1: #3987e5; --series-2: #d95926; } }
:root[data-theme="dark"] { color-scheme: dark;
  --surface: #1a1a19; --surface-2: #252524; --text-primary: #f0efec; --text-secondary: #c3c2b7; --text-muted: #94938b;
  --grid: #33332f; --series-1: #3987e5; --series-2: #d95926; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--surface); color: var(--text-primary);
  font: 15px/1.6 -apple-system, BlinkMacSystemFont, "PingFang SC", "Noto Sans SC", "Segoe UI", sans-serif; }
main { max-width: 1000px; margin: 0 auto; padding: 32px 16px 64px; }
h1 { font-size: 26px; margin: 0 0 4px; } h2 { font-size: 19px; margin: 40px 0 6px; } h3 { font-size: 15px; margin: 0; }
p { color: var(--text-secondary); margin: 6px 0; } code { font-size: 13px; }
.meta { color: var(--text-muted); font-size: 13px; }
.legend { display: flex; flex-direction: column; gap: 4px; margin: 16px 0; font-size: 13px; color: var(--text-secondary); }
.legend i, .tile i { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 6px; }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; margin-top: 16px; }
.tile { background: var(--surface-2); border-radius: 10px; padding: 14px 16px; }
.tile-label { font-size: 13px; color: var(--text-secondary); }
.tile-values { display: flex; flex-direction: column; margin: 6px 0; font-size: 14px; }
.tile-values b { font-size: 18px; }
.tile-delta { font-size: 13px; color: var(--text-muted); }
.grid2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 16px; }
.panel { margin: 12px 0 0; background: var(--surface-2); border-radius: 10px; padding: 14px; min-width: 0; }
.panel p { font-size: 13px; }
.chart { width: 100%; height: auto; display: block; margin-top: 8px; }
.grid { stroke: var(--grid); stroke-width: 1; }
.tick { fill: var(--text-muted); font-size: 11px; }
.axis-label { fill: var(--text-secondary); font-size: 11px; }
.reference { fill: none; stroke: var(--text-muted); stroke-width: 1; stroke-dasharray: 4 4; }
.dot { stroke: var(--surface-2); stroke-width: 2; cursor: default; }
.dot:hover { r: 6; }
details { margin-top: 6px; font-size: 13px; color: var(--text-secondary); }
table { border-collapse: collapse; margin-top: 6px; width: 100%; }
th, td { text-align: right; padding: 3px 8px; border-bottom: 1px solid var(--grid); font-variant-numeric: tabular-nums; }
th:first-child, td:first-child { text-align: left; }
#tip { position: fixed; pointer-events: none; background: var(--text-primary); color: var(--surface); font-size: 12px;
  padding: 5px 8px; border-radius: 6px; opacity: 0; transition: opacity .1s; max-width: 280px; }
ul { color: var(--text-secondary); padding-left: 20px; }
</style></head><body><main>
<h1>弹窗启动压力测试</h1>
<p class="meta">${esc(run.startedAt.slice(0, 16).replace('T', ' '))} UTC · ${esc(run.machine.platform)} ${esc(run.machine.arch)}，${run.machine.cpus} 核 · 每格每个版本打开 ${run.config.OPEN_RUNS} 次，取中位数</p>
${legend}

<h2>${maxTabs} 个标签页时，点击图标到弹窗出现</h2>
<div class="tiles">
${scenarios.includes('busy') ? tile('忙碌浏览器，点击到看见弹窗', 'visible', 'busy') : ''}
${tile('存储小，点击到看见弹窗', 'visible', 'small')}
${cmdTile}
</div>

<h2>打开弹窗：点击到看见</h2>
<p>从 chrome.action.openPopup() 到弹窗第一次绘制。这是用户真正等的那段时间，包含 Chrome 自己创建弹窗窗口的时间。</p>
<div class="grid2">
${scenarios.map((sc) => panel(SCENARIO_LABELS[sc] ?? sc, null, { xs: tabsXs, xLabel: '标签页数', series: openSeries(sc, 'visible', true), yMax: scaleFor('visible') })).join('')}
</div>

<h2>打开弹窗：点击到数据填好</h2>
<p>到标签页数量和上次状态都显示出来为止。弹窗故意先显示、后填数据，所以这一段可能比看见弹窗晚一点。</p>
<div class="grid2">
${scenarios.map((sc) => panel(SCENARIO_LABELS[sc] ?? sc, null, { xs: tabsXs, xLabel: '标签页数', series: openSeries(sc, 'ready'), yMax: scaleFor('ready') })).join('')}
</div>

<h2>Chrome 回答一次 tabs.query 要多久</h2>
<p>弹窗打开后单独测的。标签页越多，这次查询越贵；忙碌场景里每个标签页都带着整张图标，所以贵得多。</p>
<div class="grid2">
${scenarios.map((sc) => panel(SCENARIO_LABELS[sc] ?? sc, null, { xs: tabsXs, xLabel: '标签页数', series: openSeries(sc, 'query'), yMax: scaleFor('query') })).join('')}
</div>

<h2>模型命令（"group by topic"），Groq 用本地桩代替</h2>
<p>Groq 被替换成固定延迟回答的桩，所以总时间减去这个延迟，就是扩展自己花的时间：收集标签页、拼提示词、解析回复、真正去分组。</p>
<div class="grid2">
${panel(`扩展自身开销，Groq 延迟固定 ${run.config.SWEEP_LATENCY} ms`, '总时间减去桩的延迟', { xs: tabsXs, xLabel: '标签页数', series: cmdSeries('tabs', 'tabs', tabsXs, 'overhead') })}
${panel(`总时间 vs 网络延迟（${run.config.LATENCY_SWEEP_TABS} 个标签页）`, '虚线是延迟本身，线和虚线的距离就是扩展的开销', { xs: run.config.LATENCIES, xLabel: 'Groq 延迟（毫秒）', series: cmdSeries('latency', 'latency', run.config.LATENCIES, 'total'), reference: true })}
</div>

<h2>怎么测的</h2>
<ul>
<li>两个版本装进<b>同一个</b>浏览器，轮流打开各自的弹窗，所以它们面对的标签页、机器负载和时间点都一样。</li>
<li>标签页先加载出真实标题，再全部丢弃（discard），这样几百个也放得下，也和 Chrome 处理旧标签页的方式一致。</li>
<li>"存储大"是额外 400 个 10 KB 的键，模拟用了几个月后的 chrome.storage.local。</li>
<li>"忙碌"场景里标签页不丢弃，每个页面都在跑一个小定时器，并且用一个约 ${run.config.FAVICON_KB ?? 20} KB 的 data: 图标。chrome.tabs.query 会把每个标签页的图标原样带回来，这是最坏情况，但确实有网页这样做。</li>
<li>灰线是一个空白扩展的弹窗（只有一行字），代表 Chrome 自己的开销，两个版本都不可能比它更快。</li>
<li>每个版本的 pop_up.html 前面插了同一个探针脚本，只记录标签页数量和状态栏什么时候被填上。</li>
<li>浅色点是每一次的单独结果，实心点和线是中位数。弹窗打开的时间本身就很抖，看趋势和两条线的相对位置，别太看单个数字。</li>
<li>无效的测量（弹窗被复用等）：${errors.length} 次，已剔除。</li>
</ul>
<p class="meta">浏览器：${esc(run.browser)}</p>
</main>
<div id="tip"></div>
<script>
const tip = document.getElementById('tip');
document.addEventListener('mouseover', (e) => {
  const t = e.target.closest('[data-tip]');
  if (!t) { tip.style.opacity = 0; return; }
  tip.textContent = t.dataset.tip; tip.style.opacity = 1;
});
document.addEventListener('mousemove', (e) => {
  tip.style.left = Math.min(e.clientX + 12, innerWidth - tip.offsetWidth - 8) + 'px';
  tip.style.top = (e.clientY + 12) + 'px';
});
</script>
</body></html>`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: node e2e/stress-report.mjs <stress-*.json>');
    process.exit(1);
  }
  process.stdout.write(renderReport(JSON.parse(readFileSync(file, 'utf8'))));
}
