/* livingview3d.js — תצוגת תלת-מימד למתחם המגורים (WebGL)
 * ------------------------------------------------------------------
 * The accommodation plan in real 3D: a WebGL scene (three.js r128), with a
 * depth buffer, shadows, perspective-correct satellite ground and smooth
 * orbit / pinch / pan. It replaces the canvas painter (shed3d.js) for this
 * one view because a furnished floor plan is exactly what a painter does
 * worst: hundreds of small boxes against long walls, seen at a low angle,
 * on an image that has to stay straight under perspective.
 *
 * It draws the SAME model livingunit.js builds for the painter — faces in
 * east / north / up metres — so geometry, bearing, openings, layers and the
 * cut-away are defined once. It also offers the same calls livingedit.js
 * already makes (update, setGround, setSun, setView, resetView, getState,
 * destroy), so the editor only chooses which engine to mount.
 *
 * three.js is fetched from cdnjs only when the 3D view is first opened (the
 * service worker keeps it for offline use after that). If it cannot load,
 * LivingView3D.ready() resolves false and the editor stays on the painter.
 *
 * Rendering is on demand — a frame when something changed, nothing while
 * idle — so an open 3D tab does not drain a phone.
 */
var LivingView3D = (function () {
  'use strict';

  var SRC = 'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js';
  var loading = null;

  function tt(he, th, ar) {
    var lang = (typeof currentLang !== 'undefined') ? currentLang : 'he';
    if (lang === 'th') return th || he;
    if (lang === 'ar') return ar || he;
    return he;
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  // Resolves true once THREE is usable, false if it cannot be had.
  function ready() {
    if (window.THREE && window.THREE.WebGLRenderer) return Promise.resolve(true);
    if (loading) return loading;
    loading = new Promise(function (res) {
      var s = document.createElement('script');
      s.src = SRC;
      s.async = true;
      s.onload = function () { res(!!(window.THREE && window.THREE.WebGLRenderer)); };
      s.onerror = function () { loading = null; res(false); };
      document.head.appendChild(s);
    });
    return loading;
  }
  function supported() {
    try {
      var c = document.createElement('canvas');
      return !!(window.WebGLRenderingContext && (c.getContext('webgl') || c.getContext('experimental-webgl')));
    } catch (e) { return false; }
  }

  // Colours are written as ordinary (sRGB) hex. The renderer outputs sRGB,
  // so they are handed to it linear — otherwise every colour comes out a
  // gamma step too pale and the drawing loses its contrast.
  function lin(hex) { return new window.THREE.Color(hex).convertSRGBToLinear(); }

  // east / north / up  →  three.js x / y(up) / z(south)
  function V(p) { return [p[0], p[2], -p[1]]; }

  function mount(host, model, opts) {
    var T = window.THREE;
    opts = opts || {};
    var labelsMap = opts.labels || {};
    var isPhone = Math.min(window.innerWidth || 800, window.innerHeight || 800) < 600;

    // ── renderer, scene, camera ──
    var renderer = new T.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: !!opts.keepBuffer });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = T.PCFSoftShadowMap;
    renderer.outputEncoding = T.sRGBEncoding;
    var cvs = renderer.domElement;
    // pinned to the host's box, not sized as a percentage of it: in
    // fullscreen the host's height is set by its insets, and a percentage
    // child of that does not resolve — the canvas came out a quarter high
    cvs.style.cssText = 'position:absolute;inset:0;display:block;width:100%;height:100%;touch-action:none;cursor:grab;';
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
    host.appendChild(cvs);
    var overlay = document.createElement('div');
    overlay.style.cssText = 'position:absolute;inset:0;pointer-events:none;overflow:hidden;font-family:Heebo,sans-serif;';
    host.appendChild(overlay);

    var scene = new T.Scene();
    scene.background = lin('#bcd6ea');
    scene.fog = new T.Fog(lin('#bcd6ea'), 260, 900);
    var camera = new T.PerspectiveCamera(40, 1, 0.1, 2000);

    var hemi = new T.HemisphereLight(lin('#ffffff'), lin('#8a7f66'), 0.55);
    scene.add(hemi);
    var sun = new T.DirectionalLight(lin('#fff4e0'), 0.95);
    sun.castShadow = true;
    sun.shadow.mapSize.set(isPhone ? 1024 : 2048, isPhone ? 1024 : 2048);
    sun.shadow.bias = -0.0006;
    sun.shadow.normalBias = 0.02;
    scene.add(sun);
    scene.add(sun.target);

    // a wide neutral ground under the imagery, so the site never floats
    var base = new T.Mesh(new T.PlaneGeometry(1, 1), new T.MeshLambertMaterial({ color: lin('#a99d80') }));
    base.rotation.x = -Math.PI / 2;
    base.position.y = -0.05;
    base.receiveShadow = true;
    scene.add(base);

    var root = new T.Group();
    scene.add(root);
    var ground = null, groundTex = null, groundExt = null, groundImg = null;
    var solid = null, glass = null, edges = null, selBox = null;
    var triGroup = [], groupBoxes = {}, groupFaces = {};
    var tags = [], meta = {}, center = new T.Vector3(), size = 10;

    // ── camera state: orbit around a target ──
    var st = { yaw: -Math.PI / 2 - 0.45, pitch: 0.62, dist: 30, tx: 0, ty: 0, tz: 0 };
    var initial = opts.state && opts.state.webgl ? opts.state.webgl : null;
    function applyCam() {
      st.pitch = Math.max(0.12, Math.min(1.5, st.pitch));
      st.dist = Math.max(2.5, Math.min(size * 6, st.dist));
      var cp = Math.cos(st.pitch), sp = Math.sin(st.pitch);
      // yaw measured in east/north: direction from target to camera
      var ex = Math.cos(st.yaw) * cp, ny = Math.sin(st.yaw) * cp;
      camera.position.set(st.tx + ex * st.dist, st.ty + sp * st.dist, st.tz - ny * st.dist);
      camera.lookAt(st.tx, st.ty, st.tz);
      kick();
    }
    function fit() {
      st.tx = center.x; st.ty = 0.6; st.tz = center.z;
      var r = size * 0.5;
      st.dist = r / Math.sin((camera.fov * Math.PI / 180) / 2) * (camera.aspect < 1 ? 1.25 / camera.aspect * 0.8 : 1.0);
      st.yaw = -Math.PI / 2 - 0.45; st.pitch = 0.62;
    }

    // ── geometry from the model's faces ──
    function disposeObj(o) {
      if (!o) return;
      root.remove(o);
      if (o.geometry) o.geometry.dispose();
      if (o.material) { if (o.material.map) o.material.map.dispose(); o.material.dispose(); }
    }
    function build(m) {
      [solid, glass, edges, ground].forEach(disposeObj);
      solid = glass = edges = ground = null;
      if (selBox) { root.remove(selBox); selBox = null; }
      triGroup = []; groupBoxes = {}; groupFaces = {};
      meta = (m && m.meta) || {};
      tags = meta.tags || [];
      var pos = [], col = [], gpos = [], gcol = [], gext = null, gpts = null;
      var c = new T.Color();
      (m.faces || []).forEach(function (f) {
        if (f.group === 'ground') { gext = f.extent || null; gpts = f.pts; return; }
        var P = f.pts.map(V);
        var tris = P.length >= 4 ? [[0, 1, 2], [0, 2, 3]] : [[0, 1, 2]];
        c.set(f.color || '#cccccc').convertSRGBToLinear();
        var into = (f.alpha != null && f.alpha < 1) ? [gpos, gcol] : [pos, col];
        tris.forEach(function (t) {
          // skip the degenerate triangle of a 4-point face with a repeated corner
          var a = P[t[0]], b = P[t[1]], d = P[t[2]];
          if ((a[0] === d[0] && a[1] === d[1] && a[2] === d[2]) || (b[0] === d[0] && b[1] === d[1] && b[2] === d[2])) return;
          t.forEach(function (i) { into[0].push(P[i][0], P[i][1], P[i][2]); into[1].push(c.r, c.g, c.b); });
          if (into[0] === pos) triGroup.push(f.group || '');
        });
        if (f.group && f.group !== 'slab' && f.group !== 'north') {
          var bb = groupBoxes[f.group] || (groupBoxes[f.group] = new T.Box3());
          P.forEach(function (q) { bb.expandByPoint(new T.Vector3(q[0], q[1], q[2])); });
        }
      });
      var g = new T.BufferGeometry();
      g.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
      g.setAttribute('color', new T.Float32BufferAttribute(col, 3));
      g.computeVertexNormals();
      solid = new T.Mesh(g, new T.MeshLambertMaterial({ vertexColors: true, side: T.DoubleSide }));
      solid.castShadow = true; solid.receiveShadow = true;
      root.add(solid);
      // soft outlines: they are what makes small boxes readable from afar
      edges = new T.LineSegments(new T.EdgesGeometry(g, 25),
        new T.LineBasicMaterial({ color: lin('#1e1e1e'), transparent: true, opacity: 0.35 }));
      root.add(edges);
      if (gpos.length) {
        var gg = new T.BufferGeometry();
        gg.setAttribute('position', new T.Float32BufferAttribute(gpos, 3));
        gg.setAttribute('color', new T.Float32BufferAttribute(gcol, 3));
        gg.computeVertexNormals();
        glass = new T.Mesh(gg, new T.MeshLambertMaterial({ vertexColors: true, side: T.DoubleSide, transparent: true, opacity: 0.45, depthWrite: false }));
        root.add(glass);
      }
      // the site
      if (gext) {
        groundExt = gext;
        var gw = gext.x1 - gext.x0, gh = gext.y1 - gext.y0;
        var pg = new T.PlaneGeometry(gw, gh);
        ground = new T.Mesh(pg, new T.MeshLambertMaterial({ color: lin('#c7bc9f') }));
        ground.rotation.x = -Math.PI / 2;
        ground.position.set((gext.x0 + gext.x1) / 2, -0.02, -(gext.y0 + gext.y1) / 2);
        ground.receiveShadow = true;
        root.add(ground);
        if (groundImg) applyGround();
      }
      // framing from the building, not from the ground patch
      var bb2 = new T.Box3().setFromBufferAttribute(g.getAttribute('position'));
      var mid = new T.Vector3(); bb2.getCenter(mid);
      if (m.cx != null && m.cy != null) { mid.x = m.cx; mid.z = -m.cy; }
      center.copy(mid);
      size = Math.max(meta.length || 0, meta.span || 0, 6);
      base.scale.set(size * 14, size * 14, 1);
      base.position.x = center.x; base.position.z = center.z;
      // sun shadow box around the building
      var sc = sun.shadow.camera, half = size * 0.9;
      sc.left = -half; sc.right = half; sc.top = half; sc.bottom = -half; sc.near = 0.5; sc.far = size * 6;
      sc.updateProjectionMatrix();
      placeSun();
    }

    // ── satellite ground ──
    function applyGround() {
      if (!ground || !groundImg || !groundExt || !groundImg.ext) return;
      var e = groundImg.ext, gx = groundExt;
      if (groundTex) groundTex.dispose();
      groundTex = new T.Texture(groundImg.img);
      groundTex.encoding = T.sRGBEncoding;
      groundTex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
      groundTex.needsUpdate = true;
      // the plane covers the model's ground extent; the image covers its own
      var uv = ground.geometry.getAttribute('uv');
      // PlaneGeometry corners: (x0,y1) (x1,y1) (x0,y0) (x1,y0) in east/north after the rotation
      var corners = [[gx.x0, gx.y1], [gx.x1, gx.y1], [gx.x0, gx.y0], [gx.x1, gx.y0]];
      corners.forEach(function (cn, i) {
        uv.setXY(i, (cn[0] - e.x0) / (e.x1 - e.x0), (cn[1] - e.y0) / (e.y1 - e.y0));
      });
      uv.needsUpdate = true;
      ground.material.dispose();
      ground.material = new T.MeshLambertMaterial({ map: groundTex });
      kick();
    }

    // ── light ──
    var sunAz = (opts.state && opts.state.sunAz != null) ? opts.state.sunAz : -Math.PI / 2 - 0.5;
    var sunEl = (opts.state && opts.state.sunEl != null) ? opts.state.sunEl : 1.0;
    function placeSun() {
      var d = size * 2.5;
      var ex = Math.cos(sunEl) * Math.cos(sunAz), ny = Math.cos(sunEl) * Math.sin(sunAz), up = Math.sin(sunEl);
      sun.position.set(center.x + ex * d, up * d, center.z - ny * d);
      sun.target.position.copy(center);
      sun.target.updateMatrixWorld();
      kick();
    }

    // ── labels: few, quiet, and never on top of one another ──
    var lblEls = [];
    function labelStyle(k) {
      if (k === 'north') return 'background:#c62828;color:#fff;font-weight:800;font-size:13px;padding:3px 8px;border-radius:7px;box-shadow:0 1px 4px rgba(0,0,0,.35);';
      if (k === 'compass') return 'background:rgba(20,28,24,.78);color:#fff;font-weight:700;font-size:12px;padding:2px 7px;border-radius:7px;';
      if (k === 'dim') return 'background:rgba(20,28,24,.82);color:#ffd166;font-weight:700;font-size:12px;padding:2px 7px;border-radius:7px;';
      if (k === 'sel') return 'background:#ffd166;color:#1b1b1b;font-weight:700;font-size:12px;padding:4px 9px;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,.35);line-height:1.3;';
      return 'color:#1d2a22;font-weight:700;font-size:11px;text-shadow:0 0 3px #fff,0 0 3px #fff,0 0 2px #fff;';
    }
    var selected = null;
    function drawLabels() {
      var w = cvs.clientWidth, h = cvs.clientHeight;
      overlay.innerHTML = '';
      lblEls = [];
      var list = tags.slice();
      if (selected && groupBoxes[selected]) {
        var b = groupBoxes[selected], cc = new T.Vector3(); b.getCenter(cc); cc.y = b.max.y + 0.25;
        var lab = labelsMap[selected] || {};
        list.unshift({ v: cc, t: esc(lab.title || '') + (lab.sub ? '<br><span dir="ltr" style="font-weight:600;unicode-bidi:isolate;">' + esc(lab.sub) + '</span>' : ''), k: 'sel', html: true });
      }
      var placed = [];
      var prio = { sel: 0, north: 1, compass: 2, dim: 3, room: 4 };
      list.sort(function (a, b) { return (prio[a.k] || 5) - (prio[b.k] || 5) || ((b.a || 0) - (a.a || 0)); });
      list.forEach(function (tg) {
        var v = tg.v ? tg.v.clone() : new T.Vector3(tg.p[0], tg.p[2], -tg.p[1]);
        v.project(camera);
        if (v.z > 1 || v.z < -1) return;
        var x = (v.x + 1) / 2 * w, y = (1 - v.y) / 2 * h;
        var pinned = tg.k === 'north' || tg.k === 'compass';
        if (!pinned && (x < -40 || x > w + 40 || y < -20 || y > h + 20)) return;
        var el = document.createElement('div');
        el.style.cssText = 'position:absolute;white-space:nowrap;transform:translate(-50%,-50%);' + labelStyle(tg.k);
        el.dir = 'auto';                       // "32.7 m" left-to-right, Hebrew right-to-left
        if (tg.html) el.innerHTML = tg.t; else el.textContent = tg.t;
        overlay.appendChild(el);
        var bw = el.offsetWidth || tg.t.length * 7 + 14, bh = el.offsetHeight || 18;
        // a direction off the edge of the view stays on the edge, pointing the way
        if (pinned) { x = Math.max(bw / 2 + 6, Math.min(w - bw / 2 - 6, x)); y = Math.max(bh / 2 + 52, Math.min(h - bh / 2 - 60, y)); }
        var r = { x0: x - bw / 2 - 3, x1: x + bw / 2 + 3, y0: y - bh / 2 - 2, y1: y + bh / 2 + 2 };
        var clash = placed.some(function (q) { return r.x0 < q.x1 && r.x1 > q.x0 && r.y0 < q.y1 && r.y1 > q.y0; });
        if (clash && tg.k !== 'sel' && tg.k !== 'north') { overlay.removeChild(el); return; }
        el.style.left = x + 'px'; el.style.top = y + 'px';
        placed.push(r);
        lblEls.push(el);
      });
    }

    // ── render on demand ──
    var raf = 0, dead = false;
    function kick() {
      if (raf || dead) return;
      raf = requestAnimationFrame(function () {
        raf = 0;
        if (dead) return;
        renderer.render(scene, camera);
        drawLabels();
      });
    }
    function resize() {
      var w = host.clientWidth || 600, h = host.clientHeight || 400;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      applyCam();
    }
    var ro = (typeof ResizeObserver !== 'undefined') ? new ResizeObserver(resize) : null;
    if (ro) ro.observe(host); else window.addEventListener('resize', resize);

    // ── input: orbit, pan, zoom, pick ──
    var ptrs = {}, gest = null;
    function count() { return Object.keys(ptrs).length; }
    function two() {
      var k = Object.keys(ptrs), a = ptrs[k[0]], b = ptrs[k[1]];
      return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, d: Math.hypot(a.x - b.x, a.y - b.y) || 1 };
    }
    function pan(dx, dy) {
      // move the target in the ground plane, scaled to what is on screen
      var s = st.dist * 0.0018 * (600 / (cvs.clientHeight || 600)) * 1.6;
      var fx = -Math.cos(st.yaw), fz = Math.sin(st.yaw);     // forward on the ground (toward target from camera), in three x/z
      var rx = -fz, rz = fx;                                 // right
      st.tx += (-dx * rx + dy * fx) * s;
      st.tz += (-dx * rz + dy * fz) * s;
      applyCam();
    }
    function onDown(e) {
      cvs.setPointerCapture && cvs.setPointerCapture(e.pointerId);
      ptrs[e.pointerId] = { x: e.clientX, y: e.clientY };
      if (count() === 2) { var t2 = two(); gest = { two: true, d0: t2.d, dist0: st.dist, mx: t2.x, my: t2.y }; }
      else gest = { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, pan: e.button === 2 || e.shiftKey, moved: false };
      cvs.style.cursor = 'grabbing';
    }
    function onMove(e) {
      if (!ptrs[e.pointerId]) return;
      ptrs[e.pointerId] = { x: e.clientX, y: e.clientY };
      if (!gest) return;
      if (gest.two && count() >= 2) {
        var t2 = two();
        st.dist = gest.dist0 * gest.d0 / t2.d;
        pan(t2.x - gest.mx, t2.y - gest.my);
        gest.mx = t2.x; gest.my = t2.y;
        gest.moved = true;
        return;
      }
      if (gest.two) return;
      var dx = e.clientX - gest.x, dy = e.clientY - gest.y;
      gest.x = e.clientX; gest.y = e.clientY;
      if (Math.hypot(e.clientX - gest.sx, e.clientY - gest.sy) > 4) gest.moved = true;
      if (gest.pan) pan(dx, dy);
      else { st.yaw -= dx * 0.008; st.pitch += dy * 0.006; applyCam(); }
    }
    function onUp(e) {
      var g = gest;
      delete ptrs[e.pointerId];
      if (count() === 0) { gest = null; cvs.style.cursor = 'grab'; }
      else if (g && g.two) gest = null;
      if (g && !g.two && !g.moved && e.type === 'pointerup') pick(e.clientX, e.clientY);
    }
    function onWheel(e) {
      e.preventDefault();
      st.dist *= Math.exp(e.deltaY * 0.0012);
      applyCam();
    }
    var ray = new T.Raycaster();
    function pick(cx, cy) {
      if (!solid) return;
      var rc = cvs.getBoundingClientRect();
      var ndc = new T.Vector2(((cx - rc.left) / rc.width) * 2 - 1, -((cy - rc.top) / rc.height) * 2 + 1);
      ray.setFromCamera(ndc, camera);
      var hit = ray.intersectObject(solid, false)[0];
      var g = hit ? triGroup[hit.faceIndex] : null;
      if (g === 'slab' || g === 'north') g = null;
      select(g || null);
      if (opts.onSelect) opts.onSelect(g || null);
    }
    // The selection: a translucent amber block with a bright outline — a
    // thin outline alone vanishes against a busy plan.
    function select(g) {
      selected = g;
      if (selBox) {
        root.remove(selBox);
        selBox.traverse(function (o) { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
        selBox = null;
      }
      if (g && groupBoxes[g]) {
        var b = groupBoxes[g].clone().expandByScalar(0.04);
        var sz = new T.Vector3(), c = new T.Vector3();
        b.getSize(sz); b.getCenter(c);
        // a room is selected by its floor, which is flat and under the
        // furniture: tint the room's volume instead, up to 1.2 m
        if (sz.y < 0.2) { c.y = 0.6; sz.y = 1.2; }
        var geo = new T.BoxGeometry(sz.x, sz.y, sz.z);
        selBox = new T.Group();
        var fill = new T.Mesh(geo, new T.MeshBasicMaterial({ color: lin('#ffb300'), transparent: true, opacity: 0.28, depthWrite: false }));
        var line = new T.LineSegments(new T.EdgesGeometry(geo), new T.LineBasicMaterial({ color: lin('#ffd54f') }));
        selBox.add(fill); selBox.add(line);
        selBox.position.copy(c);
        root.add(selBox);
      }
      kick();
    }
    cvs.addEventListener('pointerdown', onDown);
    cvs.addEventListener('pointermove', onMove);
    cvs.addEventListener('pointerup', onUp);
    cvs.addEventListener('pointercancel', onUp);
    cvs.addEventListener('wheel', onWheel, { passive: false });
    cvs.addEventListener('contextmenu', function (e) { e.preventDefault(); });

    // ── go ──
    build(model);
    if (initial) { st.yaw = initial.yaw; st.pitch = initial.pitch; st.dist = initial.dist; st.tx = initial.tx; st.ty = initial.ty; st.tz = initial.tz; }
    resize();
    if (!initial) { fit(); applyCam(); }

    return {
      update: function (m) { build(m); if (selected && !groupBoxes[selected]) selected = null; select(selected); kick(); },
      setGround: function (img, extent) { groundImg = { img: img, ext: extent }; applyGround(); },
      setSun: function (az, el) { sunAz = az; sunEl = el; placeSun(); },
      setView: function (yaw, pitch) {
        // a top view keeps north up the screen
        if (pitch > 1.3) {
          // straight down, north up, the whole building in frame
          st.yaw = -Math.PI / 2; st.pitch = 1.5;
          st.tx = center.x; st.tz = center.z;
          var half = size * 0.72, tanH = Math.tan((camera.fov * Math.PI / 180) / 2);
          st.dist = half / tanH / Math.min(1, camera.aspect);
        } else { st.yaw = yaw; st.pitch = pitch; }
        applyCam();
      },
      resetView: function () { fit(); applyCam(); },
      setLabels: function (l) { labelsMap = l || {}; kick(); },
      select: function (g) { select(g); },
      getState: function () {
        return { sunAz: sunAz, sunEl: sunEl, webgl: { yaw: st.yaw, pitch: st.pitch, dist: st.dist, tx: st.tx, ty: st.ty, tz: st.tz } };
      },
      render: function () { renderer.render(scene, camera); drawLabels(); },
      destroy: function () {
        dead = true;
        if (raf) cancelAnimationFrame(raf);
        if (ro) ro.disconnect(); else window.removeEventListener('resize', resize);
        [solid, glass, edges, ground].forEach(disposeObj);
        if (groundTex) groundTex.dispose();
        base.geometry.dispose(); base.material.dispose();
        renderer.dispose();
        if (cvs.parentNode) cvs.parentNode.removeChild(cvs);
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      }
    };
  }

  return { ready: ready, supported: supported, mount: mount };
})();
