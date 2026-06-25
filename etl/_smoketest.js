/* Headless smoke test: stub just enough DOM + Plotly to execute web/app.js
   against the real web/data.js, then drive a few interactions and assert the
   rendered table is sane. Not shipped; a build-time check only. */
const fs = require("fs"), path = require("path");
const WEB = path.join(__dirname, "..", "web");

// ---- fake DOM -------------------------------------------------------- //
class El {
  constructor(){ this.innerHTML=""; this.textContent=""; this.value="";
    this.style={}; this.dataset={}; this._cls=new Set(); this.selectedOptions=[];
    this.checked=false; this.onchange=this.onclick=this.oninput=null; }
  get classList(){ const c=this._cls; return {
    add:x=>c.add(x), remove:x=>c.delete(x), contains:x=>c.has(x),
    toggle:(x,on)=>{ if(on===undefined){c.has(x)?c.delete(x):c.add(x);} else {on?c.add(x):c.delete(x);} } }; }
  querySelectorAll(){ return this._buttons||[]; }   // segs get preset buttons
  querySelector(){ return new El(); }
}
const els = {};
const q = sel => (els[sel] || (els[sel]=new El()));
global.document = {
  querySelector:q, body:new El(),
  createElement:()=>({click(){},set href(_){}, set download(_){}}),
};
global.window = {};
// give the segmented controls real buttons so segWire() can attach handlers
function btns(spec){ return spec.map(d=>{ const b=new El(); b.dataset=d; return b; }); }
q("#modeSeg")._buttons      = btns([{mode:"rank"},{mode:"share"},{mode:"series"}]);
q("#windSeg")._buttons      = btns([{w:"all"},{w:"incl"},{w:"excl"}]);
q("#lineSeg")._buttons      = btns([{line:"all"},{line:"Commercial Residential"},{line:"Personal Residential"}]);
q("#transformSeg")._buttons = btns([{t:"abs"},{t:"qoq"},{t:"yoy"}]);
const click = (seg,idx)=>q(seg)._buttons[idx].onclick();
global.URL = { createObjectURL:()=>"blob:" };
global.Blob = function(){};
let plotCalls=0, lastPlot=null;
global.Plotly = { react:(_el,data)=>{ plotCalls++; lastPlot=data; } };

// ---- load data + app ------------------------------------------------- //
eval(fs.readFileSync(path.join(WEB,"data.js"),"utf8"));      // sets window.FL_DATA
global.window.FL_DATA = window.FL_DATA;
eval(fs.readFileSync(path.join(WEB,"app.js"),"utf8"));       // runs IIFE -> render()

function rowsCount(){ const m=(q("#tbl tbody").innerHTML.match(/<tr>/g)||[]); return m.length; }
function assert(c,msg){ if(!c){ console.error("FAIL:",msg); process.exitCode=1; } else console.log("ok  -",msg); }

// 1. default boot = Ranking, TIV, latest quarter
assert(plotCalls>0, "chart rendered on boot");
assert(rowsCount()>0, "ranking table has rows on boot ("+rowsCount()+")");
console.log("    ctx:", q("#ctx").innerHTML.replace(/<[^>]+>/g," ").replace(/\s+/g," ").trim());
console.log("    title:", q("#tbl tbody").innerHTML.slice(0,0), q("#tableTitle").textContent);

// 2. switch metric to DPW and re-render
q("#metric").value="dpw"; q("#metric").onchange();
assert(rowsCount()>0, "ranking rows after metric=dpw ("+rowsCount()+")");

// 3. switch to time series mode via the mode segment handler is unwired in stub;
//    drive state directly through the exposed period handlers instead.
//    Simulate: market-share + ranking already exercised. Verify period change.
q("#periodSingle").value="2024Q2"; q("#periodSingle").onchange({target:{value:"2024Q2"}});
assert(q("#tableTitle").textContent.includes("2024Q2"), "period change reflected in title");

// 4. time-series mode (covers comparison) — select American Coastal + Citizens
click("#modeSeg",2);                                   // mode=series
const co=q("#companies"); co.selectedOptions=[{value:"12968"},{value:"10064"}];
co.onchange();
assert(rowsCount()>0, "time-series table has rows ("+rowsCount()+")");
assert(q("#tableTitle").textContent.includes("series"), "series title shown");

// 5. YoY transform on the series
click("#transformSeg",2);                              // transform=yoy
assert(rowsCount()>0, "YoY series rows ("+rowsCount()+")");

// 6. derived metric: rate-on-line, back to ranking
click("#modeSeg",0);
q("#metric").value="rate_on_line"; q("#metric").onchange();
assert(rowsCount()>0, "ranking on derived rate_on_line ("+rowsCount()+")");

// 7. line filter = Commercial only, metric net_flow
click("#lineSeg",1);
q("#metric").value="net_flow"; q("#metric").onchange();
assert(rowsCount()>0, "commercial-only net_flow ranking ("+rowsCount()+")");

console.log("\nSMOKE TEST DONE. plotCalls="+plotCalls);
