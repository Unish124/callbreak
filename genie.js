/*!
 * Genie window animation for Callbreak
 * ------------------------------------------------------------------
 * Drop-in: <script src="genie.js" defer></script> in index.html.
 *
 * Callbreak shows every sheet (Settings, Enter bids, Standings, ...) in one
 * <dialog id="dlg">. This script watches that dialog's `open` attribute and
 * plays a macOS-style genie between the dialog and the button that opened
 * it. Nothing in the app's own open / close code has to change.
 *
 * Settings -> "Window animation": Genie (default) / Classic.
 * "Classic" switches this script off, so the app's own slide-up is used.
 *
 * Public API:  window.GenieFX = { setMode, getMode, isActive, status, prepareClose }
 */
(() => {
  'use strict';

  const dlg = document.getElementById('dlg');
  if (!dlg) return;

  /* ------------------------------------------------------------------ *
   *  Config
   * ------------------------------------------------------------------ */
  const STORE_KEY = 'callbreak.windowAnimation';   // 'genie' | 'classic'
  const ROWS      = 90;     // mesh rows: more = smoother funnel edges
  const LAG       = 0.7;    // how far the far edge trails the near edge
  const TIP       = 24;     // width (px) of the genie tip at the button
  const PAD       = 16;     // snapshot margin around the sheet
  const MAX_NODES = 2500;   // safety limit for the snapshot
  const OPEN_MS   = 620;
  const CLOSE_MS  = 500;
  const BD        = 0.4;    // backdrop dimming (matches dialog::backdrop)

  const clamp  = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
  const smooth = x => x * x * (3 - 2 * x);
  const ease   = x => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
  const plain  = r => ({ left: r.left, top: r.top, width: r.width, height: r.height });

  /* ------------------------------------------------------------------ *
   *  Mode (genie / classic) - genie is the default
   * ------------------------------------------------------------------ */
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  let mode = 'genie';
  try {
    const v = localStorage.getItem(STORE_KEY);
    if (v === 'genie' || v === 'classic') mode = v;
  } catch (e) { /* storage blocked */ }

  let broken = false;                       // WebGL / snapshot not usable here
  const enabled = () => mode === 'genie' && !reduced.matches && !broken && ensureGL();

  /* ------------------------------------------------------------------ *
   *  Styles
   * ------------------------------------------------------------------ */
  const css = document.createElement('style');
  css.textContent = `
    dialog.genie-hold { opacity: 0 !important; transition: none !important; animation: none !important; pointer-events: none !important; }
    dialog.genie-live { animation: none !important; }
    .genie-scrim { position: fixed; left: 0; top: 0; right: 0; bottom: 0; background: #000; opacity: 0; pointer-events: none; z-index: 2147483645; }
    #genieCanvas { position: fixed; inset: auto; left: 0; top: 0; margin: 0; padding: 0; border: 0; background: transparent;
                   max-width: none; max-height: none; overflow: visible; pointer-events: none; z-index: 2147483646; }
  `;
  document.head.appendChild(css);

  /* ------------------------------------------------------------------ *
   *  WebGL: one shared canvas draws the genie ghost.
   *  The canvas is a manual popover, so it lives in the browser's top layer
   *  and is drawn ABOVE the modal <dialog> and its backdrop.
   * ------------------------------------------------------------------ */
  const canvas = document.createElement('canvas');
  canvas.id = 'genieCanvas';
  canvas.setAttribute('aria-hidden', 'true');
  const hasPopover = typeof canvas.showPopover === 'function';
  if (hasPopover) canvas.setAttribute('popover', 'manual');
  else canvas.style.display = 'none';

  let gl = null, glTried = false, isGL2 = false, posBuf = null, uViewport = null, uAlpha = null;
  const posArray = new Float32Array((ROWS + 1) * 4);

  function ensureGL() {
    if (!glTried) { glTried = true; initGL(); }
    return !!gl;
  }

  function initGL() {
    try {
      const opts = { alpha: true, premultipliedAlpha: true, antialias: true };
      gl = canvas.getContext('webgl2', opts);
      isGL2 = !!gl;
      if (!gl) gl = canvas.getContext('webgl', opts);
      if (!gl) return;

      const sh = (type, src) => {
        const s = gl.createShader(type);
        gl.shaderSource(s, src);
        gl.compileShader(s);
        return s;
      };
      const prog = gl.createProgram();
      gl.attachShader(prog, sh(gl.VERTEX_SHADER, `
        attribute vec2 aPos; attribute vec2 aUv;
        uniform vec2 uViewport; varying vec2 vUv;
        void main() {
          vec2 c = aPos / uViewport;
          gl_Position = vec4(c.x * 2.0 - 1.0, 1.0 - c.y * 2.0, 0.0, 1.0);
          vUv = aUv;
        }`));
      gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, `
        precision mediump float;
        uniform sampler2D uTex; uniform float uAlpha; varying vec2 vUv;
        void main() { gl_FragColor = texture2D(uTex, vUv) * uAlpha; }`));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) { gl = null; return; }
      gl.useProgram(prog);

      uViewport = gl.getUniformLocation(prog, 'uViewport');
      uAlpha    = gl.getUniformLocation(prog, 'uAlpha');

      const uv = new Float32Array((ROWS + 1) * 4);
      for (let k = 0; k <= ROWS; k++) uv.set([0, k / ROWS, 1, k / ROWS], k * 4);
      const uvBuf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, uvBuf);
      gl.bufferData(gl.ARRAY_BUFFER, uv, gl.STATIC_DRAW);
      const aUv = gl.getAttribLocation(prog, 'aUv');
      gl.enableVertexAttribArray(aUv);
      gl.vertexAttribPointer(aUv, 2, gl.FLOAT, false, 0, 0);

      posBuf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
      gl.bufferData(gl.ARRAY_BUFFER, posArray.byteLength, gl.DYNAMIC_DRAW);
      const aPos = gl.getAttribLocation(prog, 'aPos');
      gl.enableVertexAttribArray(aPos);
      gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.clearColor(0, 0, 0, 0);
    } catch (e) { gl = null; }
  }

  function makeTexture(img) {
    try {
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      if (isGL2) {
        gl.generateMipmap(gl.TEXTURE_2D);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      } else {
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      }
      return tex;
    } catch (e) {
      broken = true;      // e.g. image counts as tainted: fall back to classic
      return null;
    }
  }

  /* ------------------------------------------------------------------ *
   *  DOM -> image snapshot
   *  The sheet is cloned with its *computed* styles written inline (only what
   *  differs from browser defaults), so it renders identically inside an SVG
   *  <foreignObject> without needing the page's stylesheet.
   * ------------------------------------------------------------------ */
  const SKIP_TAGS = new Set(['script', 'style', 'link', 'noscript', 'video', 'audio', 'iframe', 'object', 'embed', 'template']);
  const SKIP_PROP = /^(transition|animation|will-change|cursor|pointer-events|user-select|-webkit-user-select|scroll|overscroll|touch-action|resize|view-transition|anchor|position-|interactivity|caret|-webkit-locale|-webkit-tap|container|content-visibility|inline-size|block-size|min-inline|min-block|max-inline|max-block|margin-inline|margin-block|padding-inline|padding-block|border-inline|border-block|inset-inline|inset-block|border-start|border-end|app-region|-webkit-app-region)/;
  const FORCE_PROP = new Set(['width', 'height', 'display', 'position', 'box-sizing']);

  let baseFrame = null;
  const baseCache = new Map();

  function baselineFor(node) {
    const key = (node.namespaceURI || '') + '|' + node.localName;
    let b = baseCache.get(key);
    if (b) return b;
    if (!baseFrame) {
      baseFrame = document.createElement('iframe');
      baseFrame.setAttribute('aria-hidden', 'true');
      baseFrame.tabIndex = -1;
      baseFrame.style.cssText = 'position:fixed;left:-9999px;top:0;width:1234px;height:600px;border:0;visibility:hidden;pointer-events:none';
      document.body.appendChild(baseFrame);
      const d = baseFrame.contentDocument;
      d.open(); d.write('<!doctype html><html><body></body></html>'); d.close();
    }
    const d = baseFrame.contentDocument;
    const el = node.namespaceURI && node.namespaceURI !== 'http://www.w3.org/1999/xhtml'
      ? d.createElementNS(node.namespaceURI, node.localName)
      : d.createElement(node.localName);
    (node.namespaceURI === 'http://www.w3.org/2000/svg'
      ? (() => { const s = d.createElementNS('http://www.w3.org/2000/svg', 'svg'); d.body.appendChild(s); return s; })()
      : d.body).appendChild(el);
    b = readStyle(baseFrame.contentWindow.getComputedStyle(el));
    el.remove();
    baseCache.set(key, b);
    return b;
  }

  function readStyle(cs) {
    const o = {};
    for (let i = 0; i < cs.length; i++) {
      const n = cs[i];
      if (SKIP_PROP.test(n)) continue;
      o[n] = cs.getPropertyValue(n);
    }
    return o;
  }

  function styleString(vals, base, parent) {
    let s = '';
    for (const n in vals) {
      const v = vals[n];
      if (FORCE_PROP.has(n) || v !== base[n] || v !== parent[n]) s += n + ':' + v + ';';
    }
    return s;
  }

  function imgToData(img) {
    try {
      if (!img.complete || !img.naturalWidth) return null;
      const r = img.getBoundingClientRect();
      const w = Math.max(1, Math.min(Math.round(r.width * 2) || img.naturalWidth, 640));
      const h = Math.max(1, Math.min(Math.round(r.height * 2) || img.naturalHeight, 640));
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, w, h);
      return c.toDataURL(w * h > 4096 ? 'image/jpeg' : 'image/png', 0.88);
    } catch (e) { return null; }
  }

  function pseudoNode(host, which, hostVals) {
    const pcs = getComputedStyle(host, which);
    const c = pcs.content;
    if (!c || c === 'none' || c === 'normal' || pcs.display === 'none') return null;
    const sp = document.createElement('span');
    const vals = readStyle(pcs);
    delete vals.content;
    sp.setAttribute('style', styleString(vals, baselineFor(sp), hostVals));
    const m = /^"([\s\S]*)"$/.exec(c);
    if (m) sp.textContent = m[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    return sp;
  }

  function cloneEl(node, ctx, parentVals, isRoot, scrollOff) {
    if (++ctx.count > MAX_NODES) throw new Error('snapshot too large');
    const tag = node.localName;
    if (SKIP_TAGS.has(tag)) return null;
    const cs = getComputedStyle(node);
    if (cs.display === 'none') return null;

    let out;
    if (tag === 'canvas') {
      out = document.createElement('img');
      try { out.setAttribute('src', node.toDataURL()); } catch (e) { /* ignore */ }
    } else {
      out = node.cloneNode(false);
      if (tag === 'img') {
        const d = imgToData(node);
        if (d) out.setAttribute('src', d);
        out.removeAttribute('srcset');
        out.removeAttribute('loading');
      }
    }
    for (const a of Array.from(out.attributes)) {
      if (/^on/i.test(a.name)) out.removeAttribute(a.name);
    }

    const vals = readStyle(cs);
    let s = styleString(vals, baselineFor(node), parentVals);

    if (cs.overflowX === 'auto' || cs.overflowX === 'scroll' || cs.overflowY === 'auto' || cs.overflowY === 'scroll') {
      s += 'overflow:hidden;';
    }
    if (isRoot) {
      const r = ctx.rect;
      s += `position:absolute;left:${PAD}px;top:${PAD}px;right:auto;bottom:auto;margin:0;` +
           `transform:none;translate:none;rotate:none;scale:none;opacity:1;visibility:visible;` +
           `width:${r.width}px;height:${r.height}px;min-width:0;min-height:0;max-width:none;max-height:none;box-sizing:border-box;`;
      if (cs.display === 'inline') s += 'display:block;';
      out.removeAttribute('open');      // drop the UA's [open] positioning; we place it ourselves
      s += 'display:block;';          // inline display beats the UA's dialog:not([open]){display:none}
    }
    if (scrollOff) s += `translate:${-scrollOff[0]}px ${-scrollOff[1]}px;`;
    out.setAttribute('style', s);

    if (tag === 'input') {
      const t = (node.type || '').toLowerCase();
      if (t === 'checkbox' || t === 'radio') {
        if (node.checked) out.setAttribute('checked', ''); else out.removeAttribute('checked');
      } else out.setAttribute('value', node.value);
    }
    if (tag === 'option') {
      if (node.selected) out.setAttribute('selected', ''); else out.removeAttribute('selected');
    }
    if (tag === 'textarea') { out.textContent = node.value; return out; }
    if (tag === 'canvas' || tag === 'img') return out;

    /* prune children that are scrolled / clipped out of view (keep the box) */
    let prune = false;
    if (!isRoot && ctx.clips && cs.display !== 'contents') {
      const r = node.getBoundingClientRect(), cr = ctx.rect;
      prune = r.bottom < cr.top - 30 || r.top > cr.bottom + 30 || r.right < cr.left - 30 || r.left > cr.right + 30;
    }
    if (prune) return out;

    const before = pseudoNode(node, '::before', vals);
    if (before) out.appendChild(before);

    const off = (node.scrollTop || node.scrollLeft) ? [node.scrollLeft, node.scrollTop] : null;
    for (let c = node.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 3) out.appendChild(c.cloneNode());
      else if (c.nodeType === 1) {
        const k = cloneEl(c, ctx, vals, false, off);
        if (k) out.appendChild(k);
      }
    }

    const after = pseudoNode(node, '::after', vals);
    if (after) out.appendChild(after);
    return out;
  }

  function serialize(card, r) {
    const ccs = getComputedStyle(card);
    const ctx = {
      count: 0,
      rect: r,
      clips: ccs.overflowX !== 'visible' || ccs.overflowY !== 'visible'
    };
    const div = document.createElement('div');
    const root = cloneEl(card, ctx, baselineFor(div), true, null);
    const xml = new XMLSerializer().serializeToString(root);

    const W = r.width + PAD * 2, H = r.height + PAD * 2;
    const sc = Math.min(window.devicePixelRatio || 1, 2.5, 4096 / Math.max(W, H));
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${W * sc}" height="${H * sc}" viewBox="0 0 ${W} ${H}">` +
      `<foreignObject x="0" y="0" width="${W}" height="${H}">` +
      `<div xmlns="http://www.w3.org/1999/xhtml" style="position:relative;width:${W}px;height:${H}px;overflow:hidden">${xml}</div>` +
      `</foreignObject></svg>`;
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }

  /* ------------------------------------------------------------------ *
   *  State of the (single) sheet
   * ------------------------------------------------------------------ */
  const t = {
    open: dlg.open,
    snap: null,            // { tex, W, H }
    rect: null,            // last known rect of the open sheet
    hard: true,            // content structure changed since the snapshot
    soft: false,           // small attribute changes since the snapshot
    building: null,
    token: 0,
    anim: null,
    timer: 0,
    trash: [],
    origin: null,          // where the sheet flies to / from
    closedAt: 0,
    dragDy: 0
  };

  /* ------------------------------------------------------------------ *
   *  Which button did the person tap? The genie flies to / from it.
   * ------------------------------------------------------------------ */
  let lastAct = null;
  const remember = e => {
    const b = e.target && e.target.closest && e.target.closest('button,[data-a],a,label,[role="button"]');
    if (!b) return;
    const r = b.getBoundingClientRect();
    lastAct = { el: b, time: performance.now(), x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, inDlg: dlg.contains(b) };
  };
  document.addEventListener('pointerdown', remember, true);
  document.addEventListener('click', remember, true);

  function isVisible(e) {
    if (!e || !e.isConnected) return false;
    const r = e.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
  }
  const centre = e => { const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, el: e }; };
  const fallbackOrigin = () => ({ x: innerWidth / 2, y: innerHeight - 36, w: 44, el: null });   // bottom centre

  function openOrigin() {
    const now = performance.now();
    if (lastAct && now - lastAct.time < 2500 && !lastAct.inDlg) {
      if (isVisible(lastAct.el)) return centre(lastAct.el);
      return { x: lastAct.x, y: lastAct.y, w: lastAct.w, el: null };
    }
    if (t.origin && now - t.closedAt < 1200) return t.origin;      // sheet replaced by another sheet
    return fallbackOrigin();
  }

  function closeOrigin() {
    const o = t.origin;
    if (o && o.el && isVisible(o.el)) return centre(o.el);
    return o || fallbackOrigin();
  }

  /* ------------------------------------------------------------------ *
   *  Watching the dialog
   * ------------------------------------------------------------------ */
  new MutationObserver(recs => {
    let opened = false;
    for (const r of recs) {
      if (r.type === 'attributes') {
        if (r.target === dlg) {
          if (r.attributeName !== 'open') continue;        // our own class / style changes
          if (r.oldValue === null) { t.open = true; opened = true; }
          else { t.open = false; opened = false; onClose(); }
        } else t.soft = true;                              // a button got disabled, a chip got selected...
      } else t.hard = true;                                // content was replaced
    }
    if (opened) onOpen();
    else if (t.open && !t.anim && (t.hard || t.soft)) scheduleRefresh(220);
  }).observe(dlg, { attributes: true, attributeOldValue: true, childList: true, subtree: true, characterData: true });

  dlg.addEventListener('input',  () => { t.soft = true; if (t.open) scheduleRefresh(300); }, true);
  dlg.addEventListener('change', () => { t.soft = true; if (t.open) scheduleRefresh(300); }, true);

  function scheduleRefresh(delay) {
    clearTimeout(t.timer);
    t.timer = setTimeout(() => {
      if (!t.open || t.anim || !enabled() || document.hidden) return;
      if (dlg.style.transform) { scheduleRefresh(300); return; }       // being dragged
      if (t.hard || t.soft || !t.snap) ensureSnap();
    }, delay);
  }

  function ensureSnap() {
    if (t.building) return t.building;
    t.building = build().then(ok => { t.building = null; return ok; }, () => { t.building = null; return false; });
    return t.building;
  }

  async function build() {
    const r = dlg.getBoundingClientRect();
    if (!t.open || r.width < 4 || r.height < 4) return false;
    t.hard = false; t.soft = false;

    let url;
    try { url = serialize(dlg, r); }
    catch (e) { t.hard = true; return false; }

    const img = new Image();
    const loaded = await new Promise(res => { img.onload = () => res(true); img.onerror = () => res(false); img.src = url; });
    if (!loaded) { t.hard = true; return false; }

    const tex = makeTexture(img);
    if (!tex) return false;

    const old = t.snap && t.snap.tex;
    t.snap = { tex, W: r.width, H: r.height };
    t.rect = plain(r);
    if (old) {
      if (t.anim && t.anim.tex === old) t.trash.push(old); else gl.deleteTexture(old);
    }
    return true;
  }

  /* ------------------------------------------------------------------ *
   *  Open / close
   * ------------------------------------------------------------------ */
  function hold() {
    dlg.classList.remove('genie-live');
    dlg.classList.add('genie-hold');
    dlg.style.setProperty('--bd', '0');
  }
  function release() {
    dlg.classList.remove('genie-hold', 'genie-live');
    dlg.style.removeProperty('--bd');
  }

  async function onOpen() {
    const token = ++t.token;
    if (t.anim) cancelAnim();                         // a previous genie was still flying
    if (!enabled()) { release(); return; }
    hold();
    const origin = openOrigin();
    t.origin = origin;

    const r = dlg.getBoundingClientRect();
    const resized = t.snap && (Math.abs(r.width - t.snap.W) > 1 || Math.abs(r.height - t.snap.H) > 1);
    let ok = true;
    if (!t.snap || t.hard || resized) ok = await ensureSnap();
    if (token === t.token && ok && t.hard) ok = await ensureSnap();       // content changed while building
    if (token !== t.token) return;                    // closed / re-opened meanwhile

    if (!ok || !t.snap) { release(); return; }
    t.rect = plain(dlg.getBoundingClientRect());
    startAnim(0, origin, 0);
  }

  function onClose() {
    ++t.token;
    t.closedAt = performance.now();
    const dy = t.dragDy; t.dragDy = 0;

    if (t.anim) {                                     // closed while still opening: fly back
      if (t.anim.target === 0) startAnim(1);
      return;
    }
    if (!enabled() || !t.snap || !t.rect || t.hard) { release(); return; }
    startAnim(1, closeOrigin(), dy);
  }

  /* ------------------------------------------------------------------ *
   *  Animation loop
   * ------------------------------------------------------------------ */
  const anims = new Set();
  let raf = 0;

  function mount() {
    if (canvas.parentNode !== document.body) document.body.appendChild(canvas);
    if (hasPopover) {
      try { if (!canvas.matches(':popover-open')) canvas.showPopover(); } catch (e) { /* ignore */ }
    } else canvas.style.display = 'block';
  }
  function unmount() {
    if (hasPopover) {
      try { if (canvas.matches(':popover-open')) canvas.hidePopover(); } catch (e) { /* ignore */ }
    } else canvas.style.display = 'none';
  }

  function makeGeo(o, dy) {
    const r = t.rect;
    const left = r.left - PAD, top = r.top - PAD + (dy || 0);
    const TW = r.width + PAD * 2, TH = r.height + PAD * 2;
    return {
      left, top, TW, TH,
      tx: clamp(o.x, 0, innerWidth), ty: clamp(o.y, 0, innerHeight),
      tip: Math.min(TIP, Math.max(10, o.w * 0.55)),
      nearTop: o.y < top + TH / 2
    };
  }

  function startAnim(target, origin, dy) {
    const prev = t.anim;
    const now = performance.now();
    if (prev) {                                        // reverse smoothly from where it is
      prev.from = prev.p;
      prev.target = target;
      prev.t0 = now;
      prev.dur = (target === 0 ? OPEN_MS : CLOSE_MS) * Math.max(0.35, Math.abs(target - prev.p));
      setBackdrop(prev, clamp(1 - prev.p));
      return;
    }
    const a = {
      tex: t.snap.tex, geo: makeGeo(origin, dy),
      p: target === 0 ? 1 : 0, from: target === 0 ? 1 : 0, target,
      t0: now, dur: target === 0 ? OPEN_MS : CLOSE_MS, scrim: null
    };
    t.anim = a;
    anims.add(a);
    mount();
    setBackdrop(a, clamp(1 - a.p));
    drawFrame(now);                                    // first frame right away, so nothing flashes
    if (!raf) raf = requestAnimationFrame(tick);
  }

  /* Dimming behind the sheet: while the dialog is open its own ::backdrop is
     faded through --bd; once it has closed, a copy (scrim) takes over. */
  function setBackdrop(a, v) {
    if (dlg.open) {
      dlg.style.setProperty('--bd', String(BD * v));
      if (a.scrim) a.scrim.style.opacity = '0';
    } else {
      if (!a.scrim) {
        a.scrim = document.createElement('div');
        a.scrim.className = 'genie-scrim';
        document.body.appendChild(a.scrim);
      }
      dlg.style.removeProperty('--bd');
      a.scrim.style.opacity = String(BD * v);
    }
  }

  function fit() {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(innerWidth * dpr), h = Math.round(innerHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w; canvas.height = h;
      canvas.style.width = innerWidth + 'px';
      canvas.style.height = innerHeight + 'px';
    }
    gl.viewport(0, 0, w, h);
  }

  function drawGhost(a) {
    const g = a.geo, p = a.p, cxw = g.left + g.TW / 2;
    let prevY = -Infinity;
    for (let k = 0; k <= ROWS; k++) {
      const f = k / ROWS;
      const d = g.nearTop ? f : 1 - f;
      const s = clamp(p * (1 + LAG) - d * LAG);        // rows nearest the button lead
      const ey = 1 - (1 - s) * (1 - s);
      const ex = smooth(s);
      const y0 = g.top + f * g.TH;
      let y = y0 + (g.ty - y0) * ey;
      if (y < prevY) y = prevY;
      prevY = y;
      const cx = cxw + (g.tx - cxw) * ex;
      const w = g.TW + (g.tip - g.TW) * ey;
      const i = k * 4;
      posArray[i] = cx - w / 2; posArray[i + 1] = y;
      posArray[i + 2] = cx + w / 2; posArray[i + 3] = y;
    }
    gl.bindTexture(gl.TEXTURE_2D, a.tex);
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, posArray);
    gl.uniform2f(uViewport, innerWidth, innerHeight);
    gl.uniform1f(uAlpha, 1 - smooth(clamp((p - 0.86) / 0.14)));
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, (ROWS + 1) * 2);
  }

  function finish(a) {
    anims.delete(a);
    t.anim = null;
    if (a.scrim) a.scrim.remove();
    dlg.style.removeProperty('--bd');
    for (const x of t.trash) gl.deleteTexture(x);
    t.trash.length = 0;

    if (a.target === 0 && t.open) {                    // the real sheet takes over
      dlg.classList.add('genie-live');                 // ...without replaying the classic slide-up
      dlg.classList.remove('genie-hold');
      if (t.hard || t.soft) scheduleRefresh(300);
    } else {
      dlg.classList.remove('genie-hold', 'genie-live');
    }
  }

  function cancelAnim() { const a = t.anim; if (a) { a.p = a.target; finish(a); } }

  function drawFrame(now) {
    fit();
    gl.clear(gl.COLOR_BUFFER_BIT);
    for (const a of Array.from(anims)) {
      const k = clamp((now - a.t0) / a.dur);
      a.p = k >= 1 ? a.target : a.from + (a.target - a.from) * ease(k);
      if (k >= 1) { finish(a); continue; }
      drawGhost(a);
      setBackdrop(a, clamp(1 - a.p));
    }
  }

  function tick(now) {
    raf = 0;
    drawFrame(now);
    if (anims.size) raf = requestAnimationFrame(tick);
    else unmount();
  }

  function cancelAll() {
    ++t.token;
    for (const a of Array.from(anims)) { a.p = a.target; finish(a); }
    cancelAnimationFrame(raf); raf = 0;
    unmount();
    dlg.classList.remove('genie-hold');
    if (!t.open) dlg.classList.remove('genie-live');   // keep it while open: no slide-up replay
    dlg.style.removeProperty('--bd');
  }

  /* Keep the rect fresh while the sheet is open, so a close starts exactly
     where the sheet is. */
  setInterval(() => {
    if (!t.open || t.anim || document.hidden || !enabled() || dlg.style.transform) return;
    const r = dlg.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return;
    t.rect = plain(r);
    if (t.snap && (Math.abs(r.width - t.snap.W) > 1 || Math.abs(r.height - t.snap.H) > 1)) {
      t.hard = true;
      scheduleRefresh(300);
    }
  }, 250);

  reduced.addEventListener && reduced.addEventListener('change', () => { if (reduced.matches) cancelAll(); });

  /* ------------------------------------------------------------------ *
   *  Public API
   * ------------------------------------------------------------------ */
  function setMode(m) {
    if (m !== 'genie' && m !== 'classic') return;
    mode = m;
    try { localStorage.setItem(STORE_KEY, m); } catch (e) { /* ignore */ }
    if (m === 'classic') cancelAll();
    else if (t.open) { t.hard = true; scheduleRefresh(0); }
  }

  /* 'ok' | 'reduced' (device asks for less motion) | 'unsupported' (no WebGL / snapshot blocked) */
  function status() {
    if (mode !== 'genie') return 'ok';
    if (reduced.matches) return 'reduced';
    if (broken || !ensureGL()) return 'unsupported';
    return 'ok';
  }

  window.GenieFX = {
    setMode,
    getMode: () => mode,
    isActive: enabled,
    status,
    /* call right before dlg.close() when the sheet was dragged down by `dy` px */
    prepareClose: dy => { t.dragDy = dy || 0; }
  };

  document.body.appendChild(canvas);
})();
