//! Proof — a keyboard-first proofing canvas for a Scratch workspace.
//!
//! Reads a local workspace off disk (reusing `scratch-git-2` as a library),
//! renders every record through an AI-authored, per-folder MiniJinja template,
//! and lets you search across everything, j/k through the rows, and open a
//! preview of what the content looks like before it publishes — with word-level
//! changes highlighted in place.
//!
//! Server-authoritative and HTMX-driven: it's a local app, so every interaction
//! is a round-trip the Rust server renders. `/` renders the full page from the
//! URL (so refresh and deep-links Just Work); `/list` and `/card` are fragments
//! HTMX swaps in. A thin bit of JS handles the keyboard and keeps the canonical
//! URL in sync for back/forward.

mod diff;
mod templates;
mod workspace;

use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};

use axum::extract::{Query, RawQuery, State};
use axum::response::{Html, Redirect};
use axum::routing::get;
use axum::Router;
use maud::{html, Markup, PreEscaped, DOCTYPE};
use serde::Deserialize;

use templates::ViewMode;
use workspace::{LookupIndex, Record};

const LISTEN_ADDR: &str = "127.0.0.1:3220";

#[derive(Clone)]
struct AppState {
    workspace_dir: Arc<PathBuf>,
    views_dir: Arc<PathBuf>,
    workspace: Arc<RwLock<workspace::Workspace>>,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let workspace_dir = find_workspace_dir()?;
    let views_dir = workspace_dir.join(templates::VIEWS_SUBDIR);
    templates::ensure_seeded(&views_dir)?;

    let loaded = workspace::load(&workspace_dir)?;
    let changed = loaded
        .records
        .iter()
        .filter(|r| r.state.is_changed())
        .count();
    println!(
        "workspace \"{}\": {} records ({} changed) in {}",
        loaded.name,
        loaded.records.len(),
        changed,
        workspace_dir.display()
    );
    println!("views: {}", views_dir.display());

    let state = AppState {
        workspace_dir: Arc::new(workspace_dir),
        views_dir: Arc::new(views_dir),
        workspace: Arc::new(RwLock::new(loaded)),
    };

    let app = Router::new()
        .route("/", get(index))
        .route("/list", get(list))
        .route("/card", get(card))
        .route("/refresh", get(refresh))
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(LISTEN_ADDR).await?;
    println!("Proof → http://{LISTEN_ADDR}");
    axum::serve(listener, app).await?;
    Ok(())
}

/// Resolves the workspace dir from the first CLI arg, then `$PROOF_WORKSPACE`,
/// then by walking up from the current directory looking for `.scratch/.scratchmd`.
fn find_workspace_dir() -> anyhow::Result<PathBuf> {
    if let Some(arg) = std::env::args().nth(1) {
        return Ok(PathBuf::from(arg));
    }
    if let Ok(env_path) = std::env::var("PROOF_WORKSPACE") {
        return Ok(PathBuf::from(env_path));
    }
    let mut dir = std::env::current_dir()?;
    loop {
        if dir.join(".scratch/.scratchmd").exists() {
            return Ok(dir);
        }
        if !dir.pop() {
            break;
        }
    }
    anyhow::bail!(
        "no Scratch workspace found (looked for .scratch/.scratchmd up from the current directory). \
         Pass a workspace path as the first argument or set PROOF_WORKSPACE."
    )
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/// The full page. Reads the whole state from the URL — `q` filters the list,
/// and `conn`/`path`/`view` (re)open a preview — so a hard refresh or a pasted
/// link lands exactly where you were.
#[derive(Deserialize)]
struct PageQuery {
    #[serde(default)]
    q: Option<String>,
    #[serde(default)]
    conn: Option<String>,
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    view: Option<String>,
}

async fn index(State(state): State<AppState>, Query(params): Query<PageQuery>) -> Html<String> {
    Html(render_page(&state, &params))
}

/// The list fragment — just the rows for a query, swapped into `#list` as you type.
#[derive(Deserialize)]
struct ListQuery {
    #[serde(default)]
    q: Option<String>,
}

async fn list(State(state): State<AppState>, Query(query): Query<ListQuery>) -> Html<String> {
    let workspace = state.workspace.read().unwrap();
    let filtered = workspace::filter_records(&workspace.records, query.q.as_deref().unwrap_or(""));
    let mut renderer =
        templates::RowRenderer::new(&state.views_dir, workspace.lookup_index.clone());
    Html(rows_markup(&mut renderer, &filtered, None).into_string())
}

/// The preview fragment — one record's card in a given view, swapped into `#preview`.
#[derive(Deserialize)]
struct CardQuery {
    conn: String,
    path: String,
    #[serde(default)]
    view: Option<String>,
}

async fn card(State(state): State<AppState>, Query(query): Query<CardQuery>) -> Html<String> {
    let mode = ViewMode::parse(query.view.as_deref().unwrap_or("auto"));
    let workspace = state.workspace.read().unwrap();
    let found = workspace
        .records
        .iter()
        .find(|record| record.connection_dir_name == query.conn && record.path == query.path);

    let body = match found {
        Some(record) => card_markup(
            &state.views_dir,
            record,
            mode,
            workspace.lookup_index.clone(),
        )
        .into_string(),
        None => "<div class=\"card-empty\">record not found</div>".to_string(),
    };
    Html(body)
}

/// Reloads the workspace from disk, then redirects back to wherever you were
/// (preserving the query string), so a workspace refresh keeps your place.
async fn refresh(State(state): State<AppState>, RawQuery(query): RawQuery) -> Redirect {
    if let Ok(updated) = workspace::load(&state.workspace_dir) {
        if let Ok(mut guard) = state.workspace.write() {
            *guard = updated;
        }
    }
    let target = match query {
        Some(q) if !q.is_empty() => format!("/?{q}"),
        _ => "/".to_string(),
    };
    Redirect::to(&target)
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/// Renders the list rows. `selected` marks the open record so a full-page load
/// (refresh/deep-link) shows the right row highlighted; the fragment path passes
/// `None` and lets the client own the cursor.
fn rows_markup(
    renderer: &mut templates::RowRenderer,
    records: &[&Record],
    selected: Option<(&str, &str)>,
) -> Markup {
    html! {
        @for record in records {
            @let is_selected = selected
                .is_some_and(|(conn, path)| conn == record.connection_dir_name && path == record.path);
            div.row.sel[is_selected]
                data-conn=(record.connection_dir_name)
                data-path=(record.path)
            {
                (PreEscaped(renderer.render_row(record)))
            }
        }
    }
}

/// Renders one record's preview card — the toolbar (path + default⇄custom
/// toggle), the source line, and the rendered view.
fn card_markup(
    views_dir: &Path,
    record: &Record,
    mode: ViewMode,
    lookup_index: Arc<LookupIndex>,
) -> Markup {
    let preview = templates::render_preview(views_dir, record, mode, lookup_index);
    // Which toggle button reads as active: the forced mode, or — under Auto —
    // whichever view actually resolved.
    let custom_active =
        matches!(mode, ViewMode::Custom) || (matches!(mode, ViewMode::Auto) && preview.is_custom);
    let default_active = !custom_active;
    html! {
        article.card {
            div.card-toolbar {
                span.card-path { (record.connection_display_name) " · " (record.path) }
                span.view-toggle {
                    button.vt.vt-active[default_active] data-view="default" { "default" }
                    button.vt.vt-active[custom_active].vt-empty[!preview.custom_available]
                        data-view="custom" { "custom" }
                }
            }
            div.card-srcline {
                "preview view: " (preview.label)
                @if !preview.is_custom { " (generic)" }
            }
            (PreEscaped(preview.html))
        }
    }
}

fn render_page(state: &AppState, params: &PageQuery) -> String {
    let workspace = state.workspace.read().unwrap();
    let total = workspace.records.len();
    let query = params.q.clone().unwrap_or_default();
    let filtered = workspace::filter_records(&workspace.records, &query);
    let matched = filtered.len();
    let mut renderer =
        templates::RowRenderer::new(&state.views_dir, workspace.lookup_index.clone());

    let selected = match (params.conn.as_deref(), params.path.as_deref()) {
        (Some(conn), Some(path)) => Some((conn, path)),
        _ => None,
    };
    let preview_markup = selected.and_then(|(conn, path)| {
        workspace
            .records
            .iter()
            .find(|record| record.connection_dir_name == conn && record.path == path)
            .map(|record| {
                let mode = ViewMode::parse(params.view.as_deref().unwrap_or("auto"));
                card_markup(
                    &state.views_dir,
                    record,
                    mode,
                    workspace.lookup_index.clone(),
                )
            })
    });
    let preview_open = preview_markup.is_some();

    let markup = html! {
        (DOCTYPE)
        html {
            head {
                meta charset="utf-8";
                meta name="viewport" content="width=device-width, initial-scale=1";
                title { "Proof · " (workspace.name) }
                script src="https://unpkg.com/htmx.org@2.0.4" {}
                style { (PreEscaped(CSS)) }
            }
            body.split[preview_open] {
                header.topbar {
                    div.brand { "Proof" }
                    div.wbname { (workspace.name) }
                    input #search.search type="text" name="q" value=(query)
                        placeholder="search everything…  try  folder:products  is:changed"
                        autocomplete="off" spellcheck="false"
                        hx-get="/list" hx-trigger="input changed delay:150ms"
                        hx-target="#list" hx-swap="innerHTML" {}
                    div #count.count data-total=(total) { (matched) " / " (total) }
                    a #refresh-link.refresh href="/refresh" title="reload workspace (r)" { "↻" }
                    button.helpbtn type="button"
                        onclick="document.getElementById('help').classList.toggle('show')" { "?" }
                }
                main #main {
                    div #list.list {
                        (rows_markup(&mut renderer, &filtered, selected))
                    }
                    aside #preview.preview {
                        @if let Some(card) = &preview_markup { (card) }
                    }
                    div #minimap title="changes in this record — click to jump" {}
                }
                (help_overlay())
                script { (PreEscaped(JS)) }
            }
        }
    };
    markup.into_string()
}

fn help_overlay() -> Markup {
    html! {
        div #help.overlay {
            div.help {
                h3 { "keyboard" }
                table {
                    tr { td { "j / ↓" } td { "next record" } }
                    tr { td { "k / ↑" } td { "previous record" } }
                    tr { td { "space" } td { "toggle preview" } }
                    tr { td { "enter" } td { "open preview" } }
                    tr { td { "t" } td { "preview: default ⇄ custom view" } }
                    tr { td { "/" } td { "focus search" } }
                    tr { td { "g g / G" } td { "first / last" } }
                    tr { td { "r" } td { "reload workspace" } }
                    tr { td { "esc" } td { "close preview / blur search" } }
                    tr { td { "?" } td { "toggle this help" } }
                }
                p.help-foot { "search modifiers: folder:  service:  conn:  is:changed|unreviewed|unpublished|added|deleted" }
            }
        }
    }
}

const CSS: &str = r#"
:root{
  --bg:#1d1d1d;       /* pasteboard / app base — the canvas sits on this */
  --bg2:#2b2b2b;      /* panels: topbar + list rail (the tool, receding) */
  --bg3:#363636;      /* raised: controls, hover, chips */
  --line:#151515;     /* hard separators between panels */
  --hair:#3a3a3a;     /* subtle internal rules */
  --fg:#dcdcdc;       /* primary text */
  --dim:#8c8c8c;      /* secondary text */
  --accent:#4f8ff7;   /* kept for the canvas only; the chrome stays neutral */
  --sel:#3d4248;      /* selected row — a neutral lifted gray, no color */
  --ins-bg:#23371f;--ins-fg:#86dd7d;--del-fg:#ff7b72;--pill:#3a3a3a;
}
*{box-sizing:border-box}
html,body{margin:0;height:100%}
body{background:var(--bg);color:var(--fg);font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
.topbar{display:flex;align-items:center;gap:14px;height:42px;padding:0 12px;background:var(--bg2);border-bottom:1px solid var(--line);position:sticky;top:0;z-index:5}
.brand{font-weight:650;font-size:13.5px;letter-spacing:.3px;color:var(--fg)}
.wbname{color:var(--dim);font-size:12px}
.search{flex:1;background:var(--bg);border:1px solid var(--line);border-radius:5px;color:var(--fg);padding:5px 11px;font:inherit;font-size:13px;outline:none}
.search::placeholder{color:#6f6f6f}
.search:focus{border-color:#565656;box-shadow:0 0 0 2px rgba(255,255,255,.05)}
.count{color:var(--dim);min-width:72px;text-align:right;font-size:12px;font-variant-numeric:tabular-nums}
.refresh,.helpbtn{background:transparent;border:1px solid transparent;color:var(--dim);border-radius:5px;padding:5px 8px;cursor:pointer;text-decoration:none;font:inherit;font-size:13px;line-height:1}
.refresh:hover,.helpbtn:hover{color:var(--fg);background:var(--bg3)}
#main{display:flex;height:calc(100vh - 43px)}
.list{flex:1;overflow:auto;padding:4px;background:var(--bg2)}
body.split .list{flex:0 0 38%}
.preview{display:none;flex:1;overflow:auto;border-left:1px solid var(--line);background:var(--bg);padding:16px}
body.split .preview{display:block}
.row{padding:4px 9px;border-radius:5px;cursor:pointer}
.row:hover{background:#303236}
.row.sel{background:var(--sel)}
.r-line{display:flex;align-items:center;gap:8px}
.r-title{font-weight:600;font-size:12.5px}
.r-sub{color:var(--dim);font-size:11px;margin-top:1px}
.r-snippet{color:var(--dim);font-size:11px;margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.row.sel .r-snippet{color:#c2c6cd}
.r-pill,.chip{font-size:9.5px;padding:0;background:none;color:var(--dim);text-transform:uppercase;letter-spacing:.7px;font-weight:700;flex:none}
.r-unreviewed,.chip-unreviewed{color:#b58a45}
.r-unpublished,.chip-unpublished{color:#4d9c89}
.r-added,.chip-added{color:#62a259}
.r-deleted,.chip-deleted{color:#bd5d58}
.card{max-width:none;width:100%}
.card-toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px;color:var(--dim);font-size:11.5px;margin-bottom:8px;border-bottom:1px solid var(--hair);padding-bottom:8px}
.view-toggle{display:inline-flex;border:1px solid var(--line);border-radius:5px;overflow:hidden;flex:none}
.vt{background:var(--bg3);color:var(--dim);border:none;padding:3px 11px;font:inherit;font-size:11.5px;cursor:pointer}
.vt+.vt{border-left:1px solid var(--line)}
.vt:hover{color:var(--fg)}
.vt-active{background:#dadada;color:#1d1d1d;font-weight:600}
.vt-empty{font-style:italic;opacity:.55}
.card-srcline{color:var(--dim);font-size:11px;margin-bottom:14px}
.card-srcline code{color:#c4c9d6}
.card-head{margin-bottom:14px}
.card-title{font-size:18px;font-weight:700}
.card-meta{color:var(--dim);font-size:12px;margin-top:4px}
.card-changes{display:flex;flex-direction:column;gap:12px}
.chg{background:var(--bg2);border:1px solid var(--hair);border-radius:8px;padding:10px 12px}
.chg-field{color:var(--dim);font-size:11px;text-transform:uppercase;letter-spacing:.5px;margin-bottom:5px}
.chg-diff{white-space:pre-wrap;word-break:break-word}
.card-fields{display:flex;flex-direction:column;gap:1px;background:var(--hair);border:1px solid var(--hair);border-radius:8px;overflow:hidden}
.cf{display:grid;grid-template-columns:minmax(120px,210px) 1fr;gap:14px;background:var(--bg2);padding:7px 12px}
.cf-changed{background:#343434}
.cf-key{color:var(--dim);font-size:12px;word-break:break-word}
.cf-val{white-space:pre-wrap;word-break:break-word}
.card-empty{color:var(--dim);padding:20px 0}
#minimap{display:none;flex:0 0 40px;position:relative;background:var(--bg2);border-left:1px solid var(--line);cursor:pointer;overflow:hidden;user-select:none}
#minimap.show{display:block}
#minimap .mm-track{position:absolute;inset:0;background:repeating-linear-gradient(180deg,transparent 0 6px,rgba(255,255,255,.018) 6px 7px)}
#minimap .mm-band{position:absolute;left:5px;right:5px;background:#b58a45;border-radius:1px;min-height:3px}
#minimap .mm-band:hover{background:#d2a45a}
#minimap .mm-view{position:absolute;left:0;right:0;background:rgba(255,255,255,.07);border-top:1px solid rgba(255,255,255,.32);border-bottom:1px solid rgba(255,255,255,.32);pointer-events:none}
#minimap .mm-count{position:absolute;top:5px;left:0;right:0;text-align:center;font-size:9px;color:var(--dim);letter-spacing:.04em;pointer-events:none}
.d-eq{color:var(--fg)}
.d-del{color:#cf837e;text-decoration:line-through}
.d-ins{color:#9ccb90;background:rgba(120,170,110,.12);border-radius:2px}
mark.pk-change{background:#ffd24a;color:#1a1a1a;border-radius:2px;padding:0 1px;box-decoration-break:clone;-webkit-box-decoration-break:clone}
.pk-del{display:inline-block;width:3px;height:1em;vertical-align:middle;background:#e5484d;border-radius:1px;margin:0 2px;position:relative;cursor:help}
mark.pk-change[data-del]{cursor:help;position:relative}
.pk-del:hover::after,mark.pk-change[data-del]:hover::after{content:attr(data-del);position:absolute;left:0;bottom:calc(100% + 7px);background:#2a1416;color:#ff9a93;text-decoration:line-through;padding:5px 9px;border-radius:7px;white-space:normal;width:max-content;max-width:340px;font-size:13px;line-height:1.45;font-weight:400;z-index:60;box-shadow:0 6px 18px rgba(0,0,0,.45);pointer-events:none}
.tpl-error{background:#2a1416;border:1px solid #5a2327;color:#ff9a93;border-radius:7px;padding:8px 10px;font-size:12px}
.tpl-error pre{white-space:pre-wrap;margin:6px 0 0}
.overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:10;align-items:center;justify-content:center}
.overlay.show{display:flex}
.help{background:var(--bg2);border:1px solid var(--line);border-radius:10px;padding:18px 22px;min-width:360px}
.help h3{margin:0 0 12px}
.help table{border-collapse:collapse;width:100%}
.help td{padding:3px 8px}
.help kbd{background:var(--bg3);border:1px solid var(--line);border-radius:4px;padding:1px 7px;font:inherit}
.help td:first-child{color:var(--fg);white-space:nowrap}
.help-foot{color:var(--dim);font-size:12px;margin:12px 0 0;max-width:340px}
"#;

const JS: &str = r#"
(function(){
  const list=document.getElementById('list');
  const search=document.getElementById('search');
  const count=document.getElementById('count');
  const help=document.getElementById('help');
  const preview=document.getElementById('preview');
  const minimap=document.getElementById('minimap');
  let rows=[];
  let sel=0;
  let previewOpen=false;
  let currentView='auto';
  let openConn=null, openPath=null;
  let lastG=0;
  let restoring=false;

  function grabRows(){ rows=Array.from(list.querySelectorAll('.row')); }
  function markSel(){ rows.forEach(function(r){ r.classList.remove('sel'); }); if(rows[sel]) rows[sel].classList.add('sel'); }
  function updateCount(){ count.textContent=rows.length+' / '+(count.dataset.total||rows.length); }

  // --- canonical URL: /?q=&conn=&path=&view= drives the whole page ---
  function syncUrl(push){
    if(restoring) return;
    const p=new URLSearchParams();
    const q=search.value.trim();
    if(q) p.set('q',q);
    if(previewOpen && openConn){ p.set('conn',openConn); p.set('path',openPath); if(currentView && currentView!=='auto') p.set('view',currentView); }
    const url=location.pathname+(p.toString()?'?'+p.toString():'');
    if(push) history.pushState({},'',url); else history.replaceState({},'',url);
  }

  function loadCard(row){
    openConn=row.dataset.conn; openPath=row.dataset.path;
    htmx.ajax('GET','/card?conn='+encodeURIComponent(openConn)+'&path='+encodeURIComponent(openPath)+'&view='+currentView,{target:'#preview',swap:'innerHTML'});
  }
  function select(i,scroll){
    if(rows.length===0) return;
    sel=Math.max(0,Math.min(i,rows.length-1));
    markSel();
    const row=rows[sel];
    if(scroll!==false) row.scrollIntoView({block:'nearest'});
    if(previewOpen) loadCard(row);
    syncUrl(false);
  }
  function openPreview(){ if(rows.length===0) return; previewOpen=true; currentView='auto'; document.body.classList.add('split'); loadCard(rows[sel]); syncUrl(true); }
  function closePreview(){ previewOpen=false; document.body.classList.remove('split'); minimap.classList.remove('show'); minimap.innerHTML=''; syncUrl(true); }
  function togglePreview(){ previewOpen?closePreview():openPreview(); }
  function setView(v){ if(!previewOpen) return; currentView=v; loadCard(rows[sel]); syncUrl(false); }
  function flipView(){ setView(currentView==='default'?'custom':'default'); }

  // toggle buttons inside the (htmx-swapped) preview
  preview.addEventListener('click',function(e){ const b=e.target.closest('.vt'); if(b) setView(b.dataset.view); });

  // server re-rendered the list (search): re-grab rows, keep cursor on the open
  // record if it survived the filter, refresh the count + URL
  list.addEventListener('htmx:afterSwap',function(){
    grabRows();
    let idx=-1;
    if(openConn) idx=rows.findIndex(function(r){ return r.dataset.conn===openConn && r.dataset.path===openPath; });
    sel=idx>=0?idx:0;
    markSel();
    updateCount();
    syncUrl(false);
  });

  // --- minimap: a rail of the open record's changes, to the right of the preview ---
  function changeEls(){ return preview.querySelectorAll('.pk-change,.pk-del,.cf-changed,[data-change]'); }
  function buildMinimap(){
    minimap.innerHTML='';
    if(!previewOpen){ minimap.classList.remove('show'); return; }
    const els=changeEls();
    if(els.length===0){ minimap.classList.remove('show'); return; }
    minimap.classList.add('show');
    const H=preview.scrollHeight||1, mh=minimap.clientHeight||1, scTop=preview.getBoundingClientRect().top;
    const track=document.createElement('div'); track.className='mm-track'; minimap.appendChild(track);
    els.forEach(function(el){
      const y=el.getBoundingClientRect().top - scTop + preview.scrollTop;
      const band=document.createElement('div'); band.className='mm-band';
      band.style.top=(y/H*mh)+'px';
      band.style.height=Math.max(3, el.offsetHeight/H*mh)+'px';
      const isDel=el.classList.contains('pk-del');
      if(isDel){ band.style.background='#bd5d58'; }
      const k=el.dataset.del || el.dataset.change || (el.querySelector('.cf-key') ? el.querySelector('.cf-key').textContent : (el.textContent||'change'));
      band.title=(isDel?'deleted: ':'')+k;
      band.addEventListener('click',function(ev){ ev.stopPropagation(); preview.scrollTo({top:Math.max(0,y-preview.clientHeight/2),behavior:'smooth'}); });
      minimap.appendChild(band);
    });
    const label=document.createElement('div'); label.className='mm-count'; label.textContent=els.length+'Δ'; minimap.appendChild(label);
    const view=document.createElement('div'); view.className='mm-view'; minimap.appendChild(view);
    updateMinimapView();
  }
  function updateMinimapView(){
    const view=minimap.querySelector('.mm-view'); if(!view) return;
    const H=preview.scrollHeight||1, mh=minimap.clientHeight||1;
    view.style.top=(preview.scrollTop/H*mh)+'px';
    view.style.height=Math.max(10, preview.clientHeight/H*mh)+'px';
  }
  minimap.addEventListener('click',function(e){
    const rect=minimap.getBoundingClientRect();
    const frac=(e.clientY-rect.top)/rect.height;
    preview.scrollTo({top:frac*preview.scrollHeight - preview.clientHeight/2, behavior:'smooth'});
  });
  preview.addEventListener('scroll',updateMinimapView);
  // rebuild after htmx swaps a new card in (twice: immediately, then after images settle)
  preview.addEventListener('htmx:afterSwap',function(){
    buildMinimap(); setTimeout(buildMinimap,350);
    preview.querySelectorAll('img').forEach(function(im){ if(!im.complete) im.addEventListener('load',buildMinimap,{once:true}); });
  });
  window.addEventListener('resize',buildMinimap);

  document.addEventListener('keydown',function(e){
    if(e.target===search){
      if(e.key==='Escape'||e.key==='Enter') search.blur();
      return;
    }
    if(help.classList.contains('show')){
      if(e.key==='Escape'||e.key==='?') help.classList.remove('show');
      return;
    }
    switch(e.key){
      case 'j': case 'ArrowDown': e.preventDefault(); select(sel+1); break;
      case 'k': case 'ArrowUp': e.preventDefault(); select(sel-1); break;
      case ' ': e.preventDefault(); togglePreview(); break;
      case 'Enter': e.preventDefault(); if(!previewOpen) openPreview(); break;
      case 't': case 'T': e.preventDefault(); flipView(); break;
      case '/': e.preventDefault(); search.focus(); search.select(); break;
      case 'Escape': closePreview(); break;
      case 'G': e.preventDefault(); select(rows.length-1); break;
      case 'g': { const now=Date.now(); if(now-lastG<400) select(0); lastG=now; break; }
      case 'r': case 'R': window.location.href='/refresh'+location.search; break;
      case '?': help.classList.toggle('show'); break;
    }
  });

  list.addEventListener('click',function(e){
    const row=e.target.closest('.row'); if(!row) return;
    const i=rows.indexOf(row); if(i<0) return;
    sel=i; markSel();
    openPreview();
  });

  // the app refresh (↻ / r) reloads the workspace but keeps your place
  const refreshLink=document.getElementById('refresh-link');
  if(refreshLink) refreshLink.addEventListener('click',function(e){ e.preventDefault(); window.location.href='/refresh'+location.search; });

  // restore state from the URL. On first load the server already rendered the
  // list + preview, so we only wire up internal state (refetch=false). On
  // back/forward we re-fetch to match the new URL (refetch=true).
  function restore(refetch){
    restoring=true;
    const p=new URLSearchParams(location.search);
    const q=p.get('q')||'', conn=p.get('conn'), path=p.get('path'), view=p.get('view')||'auto';
    search.value=q;
    function afterList(){
      grabRows(); updateCount(); currentView=view;
      let idx=-1;
      if(conn && path) idx=rows.findIndex(function(r){ return r.dataset.conn===conn && r.dataset.path===path; });
      if(idx>=0){
        previewOpen=true; document.body.classList.add('split');
        openConn=conn; openPath=path; sel=idx; markSel(); rows[idx].scrollIntoView({block:'nearest'});
        if(refetch) loadCard(rows[idx]);
        else { buildMinimap(); setTimeout(buildMinimap,350); }
      } else {
        previewOpen=false; openConn=openPath=null;
        document.body.classList.remove('split'); minimap.classList.remove('show'); minimap.innerHTML='';
        sel=0; markSel();
      }
      restoring=false;
    }
    if(refetch){ htmx.ajax('GET','/list?q='+encodeURIComponent(q),{target:'#list',swap:'innerHTML'}).then(afterList); }
    else afterList();
  }
  window.addEventListener('popstate',function(){ restore(true); });
  restore(false);
})();
"#;
