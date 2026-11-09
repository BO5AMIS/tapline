/**
 * The live viewer page: one self-contained HTML document (inline CSS and JavaScript, no
 * external references, no build step). The host serves it at GET /viewer, on the same origin
 * as /stream and /ws; it is a client of docs/VIEWER-PROTOCOL.md.
 *
 * Constraints on the text below: no backticks and no dollar-brace (it is a raw template
 * string), and no double slash anywhere (a test keeps the document free of external URLs).
 */
export const VIEWER_HTML: string = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark">
<title>Tapline viewer</title>
<link rel="icon" href="data:,">
<style>
:root {
  color-scheme: dark;
  --bg: #0e1116;
  --panel: #161b22;
  --line: #2a313c;
  --text: #e6e9ef;
  --muted: #9aa4b2;
  --accent: #7cc4ff;
  --agent: #4cc2ff;
  --person: #8be28b;
  --fail: #ff6b6b;
}
* { box-sizing: border-box; }
[hidden] { display: none !important; }
html, body { margin: 0; height: 100%; }
body {
  height: 100vh;
  height: 100dvh;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  background: var(--bg);
  color: var(--text);
  font: 14px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  overflow: hidden;
}
#bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  background: var(--panel);
  border-bottom: 1px solid var(--line);
}
#statusline {
  flex: 1 1 220px;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  height: 36px;
}
#dot {
  flex: none;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: #6b7480;
}
#dot.live { background: #3fb950; }
#dot.wait { background: #d29922; }
#dot.bad { background: var(--fail); }
#status {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  color: var(--muted);
}
#announce {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}
#tools { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
button, select {
  min-height: 36px;
  padding: 0 12px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: #1f2630;
  color: var(--text);
  font: inherit;
  cursor: pointer;
}
button:hover, select:hover { border-color: #3b4554; }
button[aria-pressed="true"] { background: #1d3550; border-color: var(--accent); }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
label.q { display: inline-flex; align-items: center; gap: 6px; color: var(--muted); }
@media (pointer: coarse) {
  button, select { min-height: 44px; }
  #statusline { height: 44px; }
}
#stage {
  position: relative;
  min-height: 0;
  display: grid;
  place-items: center;
  overflow: hidden;
}
#frame {
  position: relative;
  width: 200px;
  height: 433px;
  background: #000;
  border-radius: 10px;
  box-shadow: 0 0 0 1px var(--line), 0 12px 40px rgba(0, 0, 0, 0.6);
  overflow: hidden;
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
}
#frame.can-point { cursor: crosshair; }
#shot {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: fill;
  pointer-events: none;
  -webkit-user-drag: none;
}
#empty {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  padding: 16px;
  text-align: center;
  color: var(--muted);
}
#frame.has-frame #empty { display: none; }
#overlay, #marks { position: absolute; inset: 0; pointer-events: none; }
#overlay.stale { opacity: 0.3; }
.box {
  position: absolute;
  outline: 1px solid rgba(255, 214, 10, 0.9);
  outline-offset: -1px;
}
.box > span {
  position: absolute;
  left: -1px;
  bottom: 100%; /* above the box, so it doesn't cover what the box marks */
  max-width: 100%;
  overflow: hidden;
  padding: 0 2px;
  font: 10px/12px ui-monospace, Consolas, monospace;
  color: #000;
  background: rgba(255, 214, 10, 0.9);
  white-space: nowrap;
}
.mark {
  --c: var(--agent);
  position: absolute;
  animation: markfade 1.6s ease-out forwards;
}
.mark.person { --c: var(--person); }
.mark.fail { --c: var(--fail); animation-duration: 2.6s; }
.mark .tag {
  position: absolute;
  padding: 1px 6px;
  border-radius: 6px;
  font-size: 11px;
  line-height: 16px;
  white-space: nowrap;
  color: #000;
  background: var(--c);
}
.mark.ring { width: 0; height: 0; }
.mark.ring::before {
  content: "";
  position: absolute;
  left: -16px;
  top: -16px;
  width: 32px;
  height: 32px;
  border: 3px solid var(--c);
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.12);
}
.mark.ring .tag { left: 20px; top: -8px; }
.mark.rect { border: 2px solid var(--c); border-radius: 4px; background: rgba(255, 255, 255, 0.08); }
.mark.rect .tag { left: -2px; top: -20px; }
.mark.pill .tag { position: absolute; left: 8px; top: 8px; }
@keyframes markfade {
  0% { opacity: 1; }
  70% { opacity: 1; }
  100% { opacity: 0; }
}
@media (prefers-reduced-motion: reduce) {
  .mark { animation: none; }
}
#notice {
  position: absolute;
  left: 50%;
  bottom: 12px;
  max-width: calc(100% - 32px);
  transform: translateX(-50%);
  padding: 6px 12px;
  border-radius: 8px;
  background: #3a1c1c;
  border: 1px solid var(--fail);
  color: #ffd7d7;
  opacity: 0;
  pointer-events: none;
}
#notice.on { opacity: 1; }
</style>
</head>
<body>
<header id="bar">
  <div id="statusline">
    <span id="dot" aria-hidden="true"></span>
    <span id="status">Connecting</span>
    <span id="announce" role="status" aria-live="polite"></span>
  </div>
  <div id="tools" role="toolbar" aria-label="Viewer controls">
    <button type="button" id="pause" aria-pressed="false">Pause agent</button>
    <button type="button" id="boxes" aria-pressed="false">Boxes</button>
    <label class="q" id="quality-wrap" hidden>Quality
      <select id="quality" aria-label="Stream quality">
        <option value="sharp">Sharp</option>
        <option value="balanced" selected>Balanced</option>
        <option value="light">Light</option>
      </select>
    </label>
    <button type="button" id="home" hidden>Home</button>
    <button type="button" id="vol-down" hidden>Volume down</button>
    <button type="button" id="vol-up" hidden>Volume up</button>
  </div>
</header>
<main id="stage">
  <div id="frame" tabindex="0" role="img" aria-label="Live phone screen">
    <img id="shot" alt="">
    <div id="empty">Waiting for the first frame</div>
    <div id="overlay" aria-hidden="true"></div>
    <div id="marks" aria-hidden="true"></div>
  </div>
  <div id="notice" role="alert"></div>
</main>
<script>
"use strict";

/* parser:start */
var CRLF2 = new Uint8Array([13, 10, 13, 10]);

function boundaryFromContentType(contentType) {
  var m = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType || "");
  return m ? (m[1] || m[2]) : "frame";
}

function createParserState(boundary) {
  var enc = new TextEncoder();
  return {
    delim: enc.encode("--" + boundary),
    closer: enc.encode("\r\n--" + boundary),
    mode: "preamble",
    buf: new Uint8Array(0),
    headers: null,
    length: -1
  };
}

function concatBytes(a, b) {
  if (a.length === 0) return b;
  var out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function indexOfBytes(hay, needle, from) {
  var n = needle.length;
  var last = hay.length - n;
  var first = needle[0];
  for (var i = from || 0; i <= last; i++) {
    if (hay[i] !== first) continue;
    var j = 1;
    while (j < n && hay[i + j] === needle[j]) j++;
    if (j === n) return i;
  }
  return -1;
}

function parsePartHeaders(bytes) {
  var text = new TextDecoder().decode(bytes);
  var lines = text.split("\r\n");
  var headers = {};
  for (var i = 0; i < lines.length; i++) {
    var at = lines[i].indexOf(":");
    if (at > 0) headers[lines[i].slice(0, at).trim().toLowerCase()] = lines[i].slice(at + 1).trim();
  }
  return headers;
}

/* Feed one chunk of the response body; returns the parts completed by it, each
   { headers, body } with lower-case header names and the exact body bytes. */
function parseMultipartChunk(state, chunk) {
  var parts = [];
  state.buf = concatBytes(state.buf, chunk);
  for (;;) {
    var buf = state.buf;
    if (state.mode === "done") {
      state.buf = new Uint8Array(0);
      break;
    }
    if (state.mode === "preamble") {
      var at = indexOfBytes(buf, state.delim, 0);
      if (at < 0) {
        state.buf = buf.subarray(Math.max(0, buf.length - state.delim.length + 1));
        break;
      }
      state.buf = buf.subarray(at + state.delim.length);
      state.mode = "headers";
      continue;
    }
    if (state.mode === "headers") {
      if (buf.length >= 2 && buf[0] === 45 && buf[1] === 45) {
        state.mode = "done";
        continue;
      }
      var end = indexOfBytes(buf, CRLF2, 0);
      if (end < 0) break;
      state.headers = parsePartHeaders(buf.subarray(0, end));
      var len = parseInt(state.headers["content-length"], 10);
      state.length = len >= 0 ? len : -1;
      state.buf = buf.subarray(end + 4);
      state.mode = "body";
      continue;
    }
    if (state.length >= 0) {
      if (buf.length < state.length) break;
      parts.push({ headers: state.headers, body: buf.slice(0, state.length) });
      state.buf = buf.subarray(state.length);
    } else {
      var stop = indexOfBytes(buf, state.closer, 0);
      if (stop < 0) break;
      parts.push({ headers: state.headers, body: buf.slice(0, stop) });
      state.buf = buf.subarray(stop + 2);
    }
    state.mode = "preamble";
    state.headers = null;
  }
  return parts;
}
/* parser:end */

(function () {
  var $ = function (id) { return document.getElementById(id); };
  var frame = $("frame");
  var shot = $("shot");
  var stage = $("stage");
  var ovl = $("overlay");
  var marks = $("marks");
  var notice = $("notice");

  /* The cookie set with this page authenticates /stream and /ws: take the token out of the
     address bar and the history. */
  if (location.search) history.replaceState(null, "", location.pathname);
  function endpoint(path, socket) {
    var u = new URL(path, location.href);
    u.search = "";
    u.hash = "";
    if (socket) u.protocol = location.protocol === "https:" ? "wss:" : "ws:";
    return u.href;
  }

  var status = null;
  var accepts = {};
  var ws = null;
  var wsOpen = false;
  var wsDelay = 500;
  var overlayOn = false;
  var overlay = null;
  var paused = false;
  var lastActionAt = 0;
  var objectUrl = null;
  var streamLive = false;
  var haveFrame = false;
  var shown = { rev: null, size: null, coverage: "", natural: null };
  var lastAnnounce = "";

  function isNum(v) { return typeof v === "number" && isFinite(v); }
  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
  function round4(v) { return Math.round(v * 10000) / 10000; }
  function pct(v) { return (v * 100).toFixed(3) + "%"; }

  function notify(text) {
    notice.textContent = text;
    notice.classList.add("on");
    clearTimeout(notify.timer);
    notify.timer = setTimeout(function () { notice.classList.remove("on"); }, 4000);
  }

  /* Layout: the frame is scaled to fit the stage and keeps the phone's proportions. */
  function aspect() {
    var s = shown.size || (status && status.size) || shown.natural;
    if (s && isNum(s.w) && isNum(s.h) && s.w > 0 && s.h > 0) return s.w / s.h;
    return 9 / 19.5;
  }
  function layout() {
    var pad = 16;
    var aw = Math.max(40, stage.clientWidth - pad * 2);
    var ah = Math.max(40, stage.clientHeight - pad * 2);
    var a = aspect();
    var w = Math.min(aw, ah * a);
    frame.style.width = Math.floor(w) + "px";
    frame.style.height = Math.floor(w / a) + "px";
  }
  if (typeof ResizeObserver === "function") new ResizeObserver(layout).observe(stage);
  window.addEventListener("resize", layout);
  shot.addEventListener("load", function () {
    shown.natural = { w: shot.naturalWidth, h: shot.naturalHeight };
    layout();
  });

  /* Status line and toolbar state. */
  var STATE_TEXT = {
    live: "Live",
    connecting: "Connecting",
    reconnecting: "Reconnecting",
    locked: "Paused on the phone",
    "no-device": "No device"
  };
  function renderStatus() {
    var dot = $("dot");
    var core = [];
    var cls = "";
    if (!wsOpen) {
      core.push(status ? "Connection lost, retrying" : "Connecting");
      cls = "wait";
    } else if (status) {
      var st = String(status.state || "");
      core.push(STATE_TEXT[st] || st || "Unknown");
      if (status.detail) core.push(String(status.detail));
      if (status.via) core.push("via " + status.via);
      if (st === "live") cls = "live";
      else if (st === "locked" || st === "no-device") cls = "bad";
      else cls = "wait";
    } else {
      core.push("Waiting for status");
      cls = "wait";
    }
    if (wsOpen && status) {
      if (status.driver === "agent" || status.driver === "person") core.push(status.driver + " driving");
      if (paused) core.push("agent paused");
    }
    if (haveFrame && !streamLive) core.push("picture reconnecting");
    if (shown.coverage === "app-window") core.push("app window only");
    var plain = core.join(" · ");
    var text = plain;
    if (wsOpen && status && isNum(status.fps)) text += " · " + status.fps.toFixed(1) + " fps";
    $("status").textContent = text;
    dot.className = cls;
    if (plain !== lastAnnounce) {
      lastAnnounce = plain;
      $("announce").textContent = plain;
    }
    var pause = $("pause");
    pause.textContent = paused ? "Resume agent" : "Pause agent";
    pause.setAttribute("aria-pressed", paused ? "true" : "false");
    $("empty").textContent = streamLive || haveFrame ? "Waiting for the next frame" : "Waiting for the first frame";
  }

  function canPoint() { return !!(accepts.tap || accepts.longPress || accepts.drag); }
  function applyAccepts() {
    accepts = {};
    if (status && Array.isArray(status.accepts)) {
      for (var i = 0; i < status.accepts.length; i++) accepts[String(status.accepts[i])] = true;
    }
    $("quality-wrap").hidden = !accepts.quality;
    var q = status && status.quality;
    if ((q === "sharp" || q === "balanced" || q === "light") && document.activeElement !== $("quality")) $("quality").value = q;
    $("home").hidden = !accepts.home;
    $("vol-down").hidden = !accepts.volume;
    $("vol-up").hidden = !accepts.volume;
    frame.classList.toggle("can-point", canPoint());
  }

  /* Frames. */
  function showPart(part) {
    var h = part.headers;
    var url = URL.createObjectURL(new Blob([part.body], { type: "image/jpeg" }));
    var old = objectUrl;
    objectUrl = url;
    shot.src = url;
    if (old) URL.revokeObjectURL(old);
    var rev = h["x-tree-rev"];
    shown.rev = rev === undefined || rev === "" ? null : String(rev);
    shown.coverage = h["x-coverage"] || "";
    var m = /^(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)$/.exec(h["x-size"] || "");
    shown.size = m ? { w: parseFloat(m[1]), h: parseFloat(m[2]) } : null;
    haveFrame = true;
    frame.classList.add("has-frame");
    layout();
    drawOverlay();
    renderStatus();
  }

  function sleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }

  async function runStream() {
    var delay = 400;
    for (;;) {
      try {
        var res = await fetch(endpoint("/stream", false), { cache: "no-store", credentials: "same-origin" });
        if (!res.ok || !res.body) throw new Error("stream " + res.status);
        var state = createParserState(boundaryFromContentType(res.headers.get("content-type")));
        var reader = res.body.getReader();
        for (;;) {
          var r = await reader.read();
          if (r.done) break;
          var parts = parseMultipartChunk(state, r.value);
          if (parts.length) {
            if (!streamLive) { streamLive = true; }
            delay = 400;
            showPart(parts[parts.length - 1]);
          }
        }
      } catch (e) {
        /* fall through to the backoff */
      }
      streamLive = false;
      renderStatus();
      await sleep(delay);
      delay = Math.min(Math.round(delay * 1.6), 5000);
    }
  }

  /* Overlay: element boxes, drawn only for the frame they belong to. */
  function drawOverlay() {
    ovl.textContent = "";
    if (!overlayOn || !overlay || !Array.isArray(overlay.elements)) return;
    var orev = overlay.rev === undefined || overlay.rev === null ? null : String(overlay.rev);
    if (orev !== null && shown.rev !== null && orev !== shown.rev) return;
    ovl.classList.toggle("stale", isNum(overlay.at) && overlay.at < lastActionAt);
    var els = overlay.elements;
    var n = Math.min(els.length, 400);
    for (var i = 0; i < n; i++) {
      var e = els[i];
      var r = e && e.rect;
      if (!r || !isNum(r.x) || !isNum(r.y) || !isNum(r.w) || !isNum(r.h)) continue;
      var box = document.createElement("div");
      box.className = "box";
      box.style.left = pct(r.x);
      box.style.top = pct(r.y);
      box.style.width = pct(r.w);
      box.style.height = pct(r.h);
      box.title = [e.ref, e.type, e.label, e.id].filter(Boolean).join(" ");
      if (typeof e.ref === "string" && e.ref !== "") {
        var tag = document.createElement("span");
        tag.textContent = e.ref;
        box.appendChild(tag);
      }
      ovl.appendChild(box);
    }
  }

  /* Actions: short-lived marks. */
  function showAction(m) {
    if (isNum(m.at) && m.at > lastActionAt) {
      lastActionAt = m.at;
      drawOverlay();
    }
    var ok = m.ok !== false;
    var label = String(m.label || m.kind || "");
    if (!ok && m.code) label = label ? label + " (" + m.code + ")" : String(m.code);
    var el = document.createElement("div");
    el.className = "mark " + (m.by === "person" ? "person" : "agent") + (ok ? "" : " fail");
    var r = m.rect;
    var p = m.point;
    if (r && isNum(r.x) && isNum(r.y) && isNum(r.w) && isNum(r.h)) {
      el.classList.add("rect");
      el.style.left = pct(r.x);
      el.style.top = pct(r.y);
      el.style.width = pct(r.w);
      el.style.height = pct(r.h);
    } else if (p && isNum(p.x) && isNum(p.y)) {
      el.classList.add("ring");
      el.style.left = pct(p.x);
      el.style.top = pct(p.y);
    } else {
      el.classList.add("pill");
      el.style.left = "0";
      el.style.top = "0";
    }
    if (label) {
      var tag = document.createElement("span");
      tag.className = "tag";
      tag.textContent = label;
      el.appendChild(tag);
    }
    marks.appendChild(el);
    while (marks.children.length > 12) marks.removeChild(marks.firstChild);
    setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, ok ? 1700 : 2700);
  }

  /* WebSocket. */
  function send(obj) {
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify(obj));
      return true;
    }
    notify("Not connected");
    return false;
  }

  function handleMessage(data) {
    if (typeof data !== "string") return;
    var m;
    try { m = JSON.parse(data); } catch (e) { return; }
    if (!m || typeof m !== "object" || Array.isArray(m) || typeof m.type !== "string") return;
    if (m.type === "status") {
      status = m;
      paused = m.paused === true;
      applyAccepts();
      layout();
      renderStatus();
    } else if (m.type === "overlay") {
      if (!overlayOn) return;
      overlay = m;
      drawOverlay();
    } else if (m.type === "action") {
      showAction(m);
    } else if (m.type === "error") {
      var text = String(m.message || "Error");
      notify(m.code ? text + " (" + m.code + ")" : text);
    }
  }

  function connectWs() {
    var sock;
    try {
      sock = new WebSocket(endpoint("/ws", true));
    } catch (e) {
      scheduleWs();
      return;
    }
    ws = sock;
    sock.onopen = function () {
      wsOpen = true;
      wsDelay = 500;
      if (overlayOn) send({ type: "overlay", on: true });
      renderStatus();
    };
    sock.onmessage = function (ev) { handleMessage(ev.data); };
    sock.onclose = function () {
      if (ws !== sock) return;
      ws = null;
      wsOpen = false;
      renderStatus();
      scheduleWs();
    };
    sock.onerror = function () { /* a close follows */ };
  }
  function scheduleWs() {
    setTimeout(connectWs, wsDelay);
    wsDelay = Math.min(Math.round(wsDelay * 1.7), 5000);
  }

  /* Toolbar. */
  $("pause").addEventListener("click", function () {
    var next = !paused;
    if (send({ type: "pause", on: next })) {
      paused = next;
      renderStatus();
    }
  });
  $("boxes").addEventListener("click", function () {
    overlayOn = !overlayOn;
    this.setAttribute("aria-pressed", overlayOn ? "true" : "false");
    if (!overlayOn) overlay = null;
    drawOverlay();
    send({ type: "overlay", on: overlayOn });
  });
  $("quality").addEventListener("change", function () {
    send({ type: "quality", preset: this.value });
  });
  $("home").addEventListener("click", function () { send({ type: "button", name: "home" }); });
  $("vol-up").addEventListener("click", function () { send({ type: "button", name: "volumeUp" }); });
  $("vol-down").addEventListener("click", function () { send({ type: "button", name: "volumeDown" }); });

  /* Pointer: one finger or the mouse, sent as a path on release. */
  var drag = null;
  function fractionOf(ev) {
    var r = frame.getBoundingClientRect();
    return [
      round4(clamp01((ev.clientX - r.left) / Math.max(1, r.width))),
      round4(clamp01((ev.clientY - r.top) / Math.max(1, r.height)))
    ];
  }
  frame.addEventListener("pointerdown", function (ev) {
    if (!canPoint() || drag || !ev.isPrimary) return;
    if (ev.pointerType === "mouse" && ev.button !== 0) return;
    ev.preventDefault();
    var active = document.activeElement;
    if (active && active !== document.body && typeof active.blur === "function") active.blur();
    try { frame.setPointerCapture(ev.pointerId); } catch (e) { /* not capturable */ }
    var p = fractionOf(ev);
    drag = { id: ev.pointerId, t0: ev.timeStamp, pts: [[0, p[0], p[1]]] };
  });
  frame.addEventListener("pointermove", function (ev) {
    if (!drag || ev.pointerId !== drag.id) return;
    var p = fractionOf(ev);
    var pt = [Math.round(ev.timeStamp - drag.t0), p[0], p[1]];
    if (drag.pts.length >= 300) drag.pts[drag.pts.length - 1] = pt;
    else drag.pts.push(pt);
  });
  frame.addEventListener("pointerup", function (ev) {
    if (!drag || ev.pointerId !== drag.id) return;
    var p = fractionOf(ev);
    drag.pts.push([Math.max(0, Math.round(ev.timeStamp - drag.t0)), p[0], p[1]]);
    var points = drag.pts;
    drag = null;
    send({ type: "gesture", points: points });
  });
  frame.addEventListener("pointercancel", function (ev) {
    if (drag && ev.pointerId === drag.id) drag = null;
  });

  /* Mouse wheel: events within 120 ms become one scroll. */
  var wheel = null;
  function flushWheel() {
    var w = wheel;
    wheel = null;
    if (w) send({ type: "scroll", x: round4(w.x), y: round4(w.y), dx: round4(w.dx), dy: round4(w.dy) });
  }
  frame.addEventListener("wheel", function (ev) {
    if (!accepts.scroll) return;
    ev.preventDefault();
    var r = frame.getBoundingClientRect();
    var k = ev.deltaMode === 1 ? 16 : ev.deltaMode === 2 ? r.height : 1;
    if (!wheel) {
      wheel = {
        x: clamp01((ev.clientX - r.left) / Math.max(1, r.width)),
        y: clamp01((ev.clientY - r.top) / Math.max(1, r.height)),
        dx: 0,
        dy: 0
      };
      setTimeout(flushWheel, 120);
    }
    wheel.dx += (ev.deltaX * k) / Math.max(1, r.width);
    wheel.dy += (ev.deltaY * k) / Math.max(1, r.height);
  }, { passive: false });

  /* Keyboard and paste: only when the page itself has focus, not a toolbar control. */
  var typed = "";
  var typedTimer = 0;
  function flushText() {
    clearTimeout(typedTimer);
    typedTimer = 0;
    if (!typed) return;
    var t = typed;
    typed = "";
    send({ type: "text", text: t });
  }
  function inToolbar(target) {
    return !!(target && target.closest && target.closest("#bar"));
  }
  document.addEventListener("keydown", function (ev) {
    if (ev.defaultPrevented || ev.isComposing) return;
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    if (inToolbar(ev.target)) return;
    if (ev.key === "Backspace" && accepts.backspace) {
      ev.preventDefault();
      flushText();
      send({ type: "key", key: "backspace" });
    } else if (ev.key === "Enter" && accepts.enter) {
      ev.preventDefault();
      flushText();
      send({ type: "key", key: "enter" });
    } else if (accepts.text && Array.from(ev.key).length === 1) {
      ev.preventDefault();
      typed += ev.key;
      clearTimeout(typedTimer);
      typedTimer = setTimeout(flushText, 300);
    }
  });
  document.addEventListener("paste", function (ev) {
    if (!accepts.text || inToolbar(ev.target)) return;
    var text = ev.clipboardData ? ev.clipboardData.getData("text") : "";
    if (!text) return;
    ev.preventDefault();
    flushText();
    send({ type: "text", text: text });
  });

  layout();
  renderStatus();
  connectWs();
  runStream();
})();
</script>
</body>
</html>
`;
