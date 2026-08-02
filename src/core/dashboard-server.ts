import { createServer, type Server, type ServerResponse } from 'node:http';
import type { StateQueryStore } from '../state/state-store.js';
import type { ResourceSampler } from '../types/m3-types.js';
import { buildStatusSnapshot } from './status-snapshot.js';

export interface DashboardServerOptions {
  store: StateQueryStore;
  sampler: ResourceSampler;
  userMaxParallel: number;
  runId?: string | null;
  dbPath?: string;
}

function commonHeaders(contentType: string): Record<string, string> {
  return {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; connect-src 'self'; img-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  };
}

function send(response: ServerResponse, statusCode: number, contentType: string, body: string, headOnly = false): void {
  response.writeHead(statusCode, commonHeaders(contentType));
  response.end(headOnly ? undefined : body);
}

export function createDashboardServer(options: DashboardServerOptions): Server {
  return createServer(async (request, response) => {
    const method = request.method || 'GET';
    const headOnly = method === 'HEAD';
    if (method !== 'GET' && !headOnly) {
      response.setHeader('Allow', 'GET, HEAD');
      send(response, 405, 'application/json; charset=utf-8', JSON.stringify({ error: 'method_not_allowed' }));
      return;
    }

    const url = new URL(request.url || '/', 'http://127.0.0.1');
    if (url.pathname === '/api/status') {
      try {
        const requestedRunId = url.searchParams.get('runId') || options.runId || null;
        const snapshot = await buildStatusSnapshot({
          store: options.store,
          sampler: options.sampler,
          userMaxParallel: options.userMaxParallel,
          dbPath: options.dbPath,
        }, requestedRunId);
        send(response, 200, 'application/json; charset=utf-8', JSON.stringify(snapshot), headOnly);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        send(response, 500, 'application/json; charset=utf-8', JSON.stringify({ error: 'snapshot_failed', message }), headOnly);
      }
      return;
    }

    if (url.pathname === '/' || url.pathname === '/index.html') {
      send(response, 200, 'text/html; charset=utf-8', DASHBOARD_HTML, headOnly);
      return;
    }

    send(response, 404, 'application/json; charset=utf-8', JSON.stringify({ error: 'not_found' }), headOnly);
  });
}

const DASHBOARD_HTML = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Bridge 只读状态台</title>
  <style>
    :root{color-scheme:dark;--bg:#0b1020;--panel:#151d33;--line:#2a3859;--text:#ecf1ff;--muted:#9dafd2;--ok:#4bd4a0;--warn:#ffc857;--bad:#ff6b7a;--accent:#72a7ff}
    *{box-sizing:border-box}body{margin:0;background:linear-gradient(145deg,#090d18,#111a30);color:var(--text);font:14px/1.5 ui-sans-serif,system-ui,"Microsoft YaHei",sans-serif}
    header,main{max-width:1180px;margin:auto;padding:22px}header{display:flex;align-items:end;justify-content:space-between;border-bottom:1px solid var(--line)}h1{font-size:22px;margin:0}.sub{color:var(--muted)}
    .grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin:18px 0}.card,.run{background:color-mix(in srgb,var(--panel) 94%,transparent);border:1px solid var(--line);border-radius:12px;padding:14px;box-shadow:0 10px 30px #0003}.metric{font-size:22px;font-weight:700}.label{color:var(--muted);font-size:12px}
    .run{margin:14px 0}.runhead,.stagehead,.task{display:flex;justify-content:space-between;gap:16px;align-items:center}.run h2{font-size:17px;margin:0}.stage{border-top:1px solid var(--line);padding:12px 0}.stage:first-of-type{margin-top:12px}.task{padding:6px 8px;margin:5px 0;background:#0d1427;border-radius:7px}.name{overflow:hidden;text-overflow:ellipsis}.status{font-weight:700}.completed,.merged,.approved{color:var(--ok)}.paused,.rework_required,.waiting_decision{color:var(--warn)}.failed,.rejected,.merge_blocked{color:var(--bad)}.running,.ready,.worker_completed,.reviewing,.validating{color:var(--accent)}
    .events{font-family:ui-monospace,Consolas,monospace;color:var(--muted);font-size:12px}.action{display:flex;gap:8px;align-items:center;background:#0d1427;border:1px solid var(--line);border-radius:8px;padding:8px;margin:8px 0;font-family:Consolas,monospace}.action code{overflow:auto;flex:1}.action button{background:var(--accent);border:0;border-radius:6px;padding:6px 10px;cursor:pointer}.empty{padding:35px;text-align:center;color:var(--muted)}@media(max-width:760px){.grid{grid-template-columns:repeat(2,1fr)}header{align-items:start;flex-direction:column;gap:6px}.runhead,.stagehead{align-items:start;flex-direction:column}}
  </style>
</head>
<body>
  <header><div><h1>Bridge 只读状态台</h1><div class="sub">SQLite 是唯一任务状态源 · 页面每 2 秒刷新</div></div><div id="stamp" class="sub">加载中…</div></header>
  <main><section id="metrics" class="grid"></section><section id="runs"></section></main>
  <script>
    const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const status = value => '<span class="status '+esc(value)+'">'+esc(value)+'</span>';
    function render(snapshot){
      document.getElementById('stamp').textContent = new Date(snapshot.timestamp).toLocaleString();
      const s=snapshot.system;
      document.getElementById('metrics').innerHTML=[['CPU',s.cpu.usagePercent.toFixed(0)+'%'],['内存',s.memory.usagePercent.toFixed(0)+'%'],['Pi 进程',s.piProcesses.activeCount+'/'+s.piProcesses.hardCap],['并发预算',s.budget.dispatchPaused?'PAUSED':s.budget.current+'/'+s.budget.userMax]].map(x=>'<div class="card"><div class="label">'+x[0]+'</div><div class="metric">'+esc(x[1])+'</div></div>').join('');
      const runs=snapshot.runs||[];
      document.getElementById('runs').innerHTML=runs.length?runs.map(run=>{
        const stages=(run.stages||[]).map(stage=>'<div class="stage"><div class="stagehead"><strong>阶段 '+stage.stageNumber+' · '+esc(stage.title)+'</strong>'+status(stage.status)+'</div>'+(stage.tasks||[]).map(task=>'<div class="task"><span class="name">'+esc(task.title)+' <span class="sub">'+esc(task.id)+'</span></span>'+status(task.status)+'</div>').join('')+'</div>').join('');
        const events=(run.events||[]).slice(0,8).map(e=>'<div>'+esc(new Date(e.timestamp).toLocaleTimeString())+' · '+esc(e.type)+'</div>').join('');
        const b=run.cost&&run.cost.breakdown?run.cost.breakdown:null;
        const cost=run.cost?'<p class="sub">金额：'+esc(run.cost.committed)+' / '+esc(run.cost.limit)+' '+esc(run.cost.currency)+(b?' · reserved '+esc(b.reserved)+' · spawned '+esc(b.spawned)+' · unavailable '+esc(b.unavailable)+' · written_off '+esc(b.written_off)+' · settled '+esc(b.settled):'')+'</p>':'';
        const action=run.nextAction?'<div class="action"><code>'+esc(run.nextAction)+'</code><button data-copy="'+esc(run.nextAction)+'">复制</button></div>':'';
        return '<article class="run"><div class="runhead"><div><h2>'+esc(run.id)+'</h2><div class="sub">'+esc(run.projectRoot)+'</div></div>'+status(run.status)+'</div><p>'+esc(run.requestText)+'</p>'+cost+stages+(run.pausedReason?'<p class="status paused">暂停原因：'+esc(run.pausedReason)+'</p>':'')+action+'<div class="events">'+events+'</div></article>';
      }).join(''):'<div class="card empty">暂无 Run</div>';
    }
    document.addEventListener('click',async event=>{const button=event.target.closest('[data-copy]');if(!button)return;await navigator.clipboard.writeText(button.dataset.copy);button.textContent='已复制';setTimeout(()=>button.textContent='复制',1200)});
    async function refresh(){try{const response=await fetch('/api/status',{cache:'no-store'});if(!response.ok)throw new Error('HTTP '+response.status);render(await response.json())}catch(error){document.getElementById('stamp').textContent='读取失败：'+error.message}}
    refresh();setInterval(refresh,2000);
  </script>
</body>
</html>`;
