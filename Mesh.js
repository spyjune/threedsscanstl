mesh_js = r'''"use strict";

/*
 * mesh.js — live 3D mesh viewer + surface reconstruction + STL export.
 *
 * Each captured photo becomes a curved "surface slice": the photo is
 * sampled on a grid, luminance becomes pseudo-depth (bright = closer),
 * and the slice is placed on a cylinder around the object at the
 * azimuth angle the user is currently facing. Slices are merged into
 * one growing BufferGeometry-style mesh rendered with raw WebGL.
 * No external libraries — works fully offline.
 */

const MeshViewer = (function () {

  const canvas = document.getElementById("glcanvas");
  const gl = canvas.getContext("webgl", {
    antialias: true,
    alpha: true
  });

  const supported = !!gl;

  /* ---------------- reconstruction parameters ---------------- */

  const COLS = 26;
  const ROWS = 34;

  const SECTOR = (58 * Math.PI) / 180;  /* horizontal arc per slice */
  const VSPAN  = (74 * Math.PI) / 180;  /* vertical arc            */
  const RADIUS = 1.0;

  const MAX_SLICES = 120;

  /* ---------------- CPU geometry store ---------------- */

  let positions = new Float32Array(0);
  let normals   = new Float32Array(0);
  let colors    = new Float32Array(0);
  let indices   = new Uint32Array(0);

  let vertexCount = 0;
  let sliceCount  = 0;
  let triangleCount = 0;

  function growStore(extraVerts, extraIndices) {

    const p = new Float32Array(positions.length + extraVerts * 3);
    p.set(positions);
    positions = p;

    const n = new Float32Array(normals.length + extraVerts * 3);
    n.set(normals);
    normals = n;

    const c = new Float32Array(colors.length + extraVerts * 3);
    c.set(colors);
    colors = c;

    const i = new Uint32Array(indices.length + extraIndices);
    i.set(indices);
    indices = i;
  }

  /* ---------------- WebGL boilerplate ---------------- */

  let program = null;
  let posBuf, nrmBuf, colBuf, idxBuf;
  let aPosition, aNormal, aColor;
  let uMVP, uNormalMatrix, uLightDir;

  function compileShader(type, source) {

    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);

    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.error(gl.getShaderInfoLog(shader));
      return null;
    }

    return shader;
  }

  function initGL() {

    const vsSource = `
      attribute vec3 aPosition;
      attribute vec3 aNormal;
      attribute vec3 aColor;

      uniform mat4 uMVP;
      uniform mat3 uNormalMatrix;

      varying vec3 vNormal;
      varying vec3 vColor;

      void main() {
        vNormal = uNormalMatrix * aNormal;
        vColor  = aColor;
        gl_Position = uMVP * vec4(aPosition, 1.0);
      }
    `;

    const fsSource = `
      precision mediump float;

      varying vec3 vNormal;
      varying vec3 vColor;

      uniform vec3 uLightDir;

      void main() {
        vec3 n = normalize(vNormal);
        float diff = max(dot(n, normalize(uLightDir)), 0.0);
        vec3 color = vColor * (0.38 + 0.72 * diff);
        gl_FragColor = vec4(color, 1.0);
      }
    `;

    const vs = compileShader(gl.VERTEX_SHADER, vsSource);
    const fs = compileShader(gl.FRAGMENT_SHADER, fsSource);

    program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error(gl.getProgramInfoLog(program));
      return;
    }

    gl.useProgram(program);

    aPosition = gl.getAttribLocation(program, "aPosition");
    aNormal   = gl.getAttribLocation(program, "aNormal");
    aColor    = gl.getAttribLocation(program, "aColor");

    uMVP          = gl.getUniformLocation(program, "uMVP");
    uNormalMatrix = gl.getUniformLocation(program, "uNormalMatrix");
    uLightDir     = gl.getUniformLocation(program, "uLightDir");

    posBuf = gl.createBuffer();
    nrmBuf = gl.createBuffer();
    colBuf = gl.createBuffer();
    idxBuf = gl.createBuffer();

    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
  }

  function uploadBuffers() {

    gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.DYNAMIC_DRAW);

    gl.bindBuffer(gl.ARRAY_BUFFER, nrmBuf);
    gl.bufferData(gl.ARRAY_BUFFER, normals, gl.DYNAMIC_DRAW);

    gl.bindBuffer(gl.ARRAY_BUFFER, colBuf);
    gl.bufferData(gl.ARRAY_BUFFER, colors, gl.DYNAMIC_DRAW);

    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.DYNAMIC_DRAW);
  }

  /* ---------------- minimal mat4 / mat3 ---------------- */

  function perspective(fovy, aspect, near, far) {

    const f = 1 / Math.tan(fovy / 2);
    const nf = 1 / (near - far);

    return new Float32Array([
      f / aspect, 0, 0, 0,
      0, f, 0, 0,
      0, 0, (far + near) * nf, -1,
      0, 0, 2 * far * near * nf, 0
    ]);
  }

  function multiply(a, b) {

    const out = new Float32Array(16);

    for (let c = 0; c < 4; c++) {
      for (let r = 0; r < 4; r++) {
        out[c * 4 + r] =
          a[r]      * b[c * 4]     +
          a[4 + r]  * b[c * 4 + 1] +
          a[8 + r]  * b[c * 4 + 2] +
          a[12 + r] * b[c * 4 + 3];
      }
    }

    return out;
  }

  function orbitView(yaw, pitch, dist) {

    const cy = Math.cos(yaw),   sy = Math.sin(yaw);
    const cp = Math.cos(pitch), sp = Math.sin(pitch);

    /* camera position */
    const ex = dist * sy * cp;
    const ey = dist * sp;
    const ez = dist * cy * cp;

    /* lookAt(origin) basis */
    let zx = -ex, zy = -ey, zz = -ez;
    const zl = Math.hypot(zx, zy, zz);
    zx /= zl; zy /= zl; zz /= zl;

    let xx = zz, xy = 0, xz = -zx;
    const xl = Math.hypot(xx, xy, xz) || 1;
    xx /= xl; xy /= xl; xz /= xl;

    /* y = z cross x */
    const yx = zy * xz - zz * xy;
    const yy = zz * xx - zx * xz;
    const yz = zx * xy - zy * xx;

    return new Float32Array([
      xx, yx, zx, 0,
      xy, yy, zy, 0,
      xz, yz, zz, 0,
      -(xx * ex + xy * ey + xz * ez),
      -(yx * ex + yy * ey + yz * ez),
      -(zx * ex + zy * ey + zz * ez),
      1
    ]);
  }

  /* ---------------- orbit camera + controls ---------------- */

  let yaw = 0.6;
  let pitch = 0.25;
  let dist = 3.1;

  let autoRotate = true;
  let lastInteract = 0;

  const pointers = new Map();
  let pinchDist = 0;

  function onPointerDown(e) {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      const pts = [...pointers.values()];
      pinchDist = Math.hypot(
        pts[0].x - pts[1].x,
        pts[0].y - pts[1].y
      );
    }
    lastInteract = performance.now();
  }

  function onPointerMove(e) {

    if (!pointers.has(e.pointerId)) {
      return;
    }

    const prev = pointers.get(e.pointerId);
    const dx = e.clientX - prev.x;
    const dy = e.clientY - prev.y;

    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    lastInteract = performance.now();

    if (pointers.size === 1) {
      yaw   -= dx * 0.008;
      pitch -= dy * 0.008;
      pitch = Math.max(-1.35, Math.min(1.35, pitch));
    }

    if (pointers.size === 2) {
      const pts = [...pointers.values()];
      const d = Math.hypot(
        pts[0].x - pts[1].x,
        pts[0].y - pts[1].y
      );
      if (pinchDist > 0) {
        dist *= pinchDist / d;
        dist = Math.max(1.4, Math.min(8, dist));
      }
      pinchDist = d;
    }
  }

  function onPointerUp(e) {
    pointers.delete(e.pointerId);
    pinchDist = 0;
  }

  function bindControls() {

    canvas.style.touchAction = "none";

    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointercancel", onPointerUp);

    canvas.addEventListener("wheel", function (e) {
      e.preventDefault();
      dist *= e.deltaY > 0 ? 1.1 : 0.9;
      dist = Math.max(1.4, Math.min(8, dist));
      lastInteract = performance.now();
    }, { passive: false });
  }

  /* ---------------- render loop ---------------- */

  let visible = false;

  function resize() {

    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    const w = canvas.clientWidth  * dpr;
    const h = canvas.clientHeight * dpr;

    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
  }

  function frame() {

    if (!visible) {
      return;
    }

    resize();

    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    if (autoRotate && performance.now() - lastInteract > 2000) {
      yaw += 0.004;
    }

    const aspect = canvas.width / Math.max(1, canvas.height);

    const proj = perspective(0.9, aspect, 0.1, 50);
    const view = orbitView(yaw, pitch, dist);
    const mvp  = multiply(proj, view);

    gl.useProgram(program);

    gl.uniformMatrix4fv(uMVP, false, mvp);

    /* model = identity, so the view rotation is the normal matrix */
    gl.uniformMatrix3fv(uNormalMatrix, false, new Float32Array([
      view[0], view[1], view[2],
      view[4], view[5], view[6],
      view[8], view[9], view[10]
    ]));

    gl.uniform3f(uLightDir, 0.45, 0.85, 0.35);

    gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
    gl.enableVertexAttribArray(aPosition);
    gl.vertexAttribPointer(aPosition, 3, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, nrmBuf);
    gl.enableVertexAttribArray(aNormal);
    gl.vertexAttribPointer(aNormal, 3, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, colBuf);
    gl.enableVertexAttribArray(aColor);
    gl.vertexAttribPointer(aColor, 3, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf);

    gl.drawElements(
      gl.TRIANGLES,
      indices.length,
      gl.UNSIGNED_INT,
      0
    );

    requestAnimationFrame(frame);
  }

  /* ---------------- reconstruction ---------------- */

  /*
   * scan = {
   *   azimuth : radians (direction the user is facing),
   *   lum     : Float32Array(COLS*ROWS) 0..1 (0 = dark),
   *   rgb     : Uint8Array(COLS*ROWS*3)
   * }
   */
  function addScan(scan) {

    if (!supported) {
      return { ok: false, reason: "webgl" };
    }

    if (sliceCount >= MAX_SLICES) {
      return { ok: false, reason: "full" };
    }

    const base = vertexCount;
    const verts = COLS * ROWS;
    const tris  = (COLS - 1) * (ROWS - 1) * 2;

    growStore(verts, tris * 3);

    /* build slice vertices on a cylinder sector */
    for (let row = 0; row < ROWS; row++) {

      const v = row / (ROWS - 1);

      for (let col = 0; col < COLS; col++) {

        const u = col / (COLS - 1);
        const k = row * COLS + col;

        const theta = scan.azimuth + (u - 0.5) * SECTOR;
        const phi   = (0.5 - v) * VSPAN;

        /* bright pixels sit closer to the camera center */
        const depth = 1.0 - scan.lum[k];
        const r = RADIUS * (0.58 + 0.5 * depth);

        const cp = Math.cos(phi);

        const x = r * cp * Math.sin(theta);
        const y = r * Math.sin(phi);
        const z = r * cp * Math.cos(theta);

        const o = (base + k) * 3;

        positions[o]     = x;
        positions[o + 1] = y;
        positions[o + 2] = z;

        colors[o]     = scan.rgb[k * 3]     / 255;
        colors[o + 1] = scan.rgb[k * 3 + 1] / 255;
        colors[o + 2] = scan.rgb[k * 3 + 2] / 255;
      }
    }

    /* triangulate + accumulate smooth normals */
    const va = new Float32Array(verts * 3);
    let vi = 0;

    function addTri(a, b, c) {

      indices[vi++] = base + a;
      indices[vi++] = base + b;
      indices[vi++] = base + c;

      const oa = a * 3, ob = b * 3, oc = c * 3;

      const ax = positions[(base + a) * 3];
      const ay = positions[(base + a) * 3 + 1];
      const az = positions[(base + a) * 3 + 2];

      const e1x = positions[(base + b) * 3]     - ax;
      const e1y = positions[(base + b) * 3 + 1] - ay;
      const e1z = positions[(base + b) * 3 + 2] - az;

      const e2x = positions[(base + c) * 3]     - ax;
      const e2y = positions[(base + c) * 3 + 1] - ay;
      const e2z = positions[(base + c) * 3 + 2] - az;

      const nx = e1y * e2z - e1z * e2y;
      const ny = e1z * e2x - e1x * e2z;
      const nz = e1x * e2y - e1y * e2x;

      va[oa] += nx; va[oa + 1] += ny; va[oa + 2] += nz;
      va[ob] += nx; va[ob + 1] += ny; va[ob + 2] += nz;
      va[oc] += nx; va[oc + 1] += ny; va[oc + 2] += nz;
    }

    for (let row = 0; row < ROWS - 1; row++) {
      for (let col = 0; col < COLS - 1; col++) {

        const a = row * COLS + col;
        const b = a + 1;
        const c = a + COLS;
        const d = c + 1;

        addTri(a, c, b);
        addTri(b, c, d);
      }
    }

    /* normalize accumulated normals into the normal store */
    for (let k = 0; k < verts; k++) {

      const s = k * 3;
      const d = k * 3 + (base * 3);

      let nx = va[s], ny = va[s + 1], nz = va[s + 2];
      const l = Math.hypot(nx, ny, nz) || 1;

      normals[d]     = nx / l;
      normals[d + 1] = ny / l;
      normals[d + 2] = nz / l;
    }

    vertexCount  += verts;
    triangleCount = indices.length / 3;
    sliceCount   += 1;

    uploadBuffers();

    return {
      ok: true,
      vertices: vertexCount,
      triangles: triangleCount,
      slices: sliceCount
    };
  }

  function clear() {

    positions = new Float32Array(0);
    normals   = new Float32Array(0);
    colors    = new Float32Array(0);
    indices   = new Uint32Array(0);

    vertexCount = 0;
    triangleCount = 0;
    sliceCount = 0;

    if (supported) {
      uploadBuffers();
    }
  }

  /* ---------------- binary STL export ---------------- */

  function exportSTL(filename) {

    if (triangleCount === 0) {
      return false;
    }

    const triCount = triangleCount;
    const buffer = new ArrayBuffer(84 + triCount * 50);
    const view = new DataView(buffer);

    const header = "3D Scan live mesh — generated in browser";
    for (let i = 0; i < Math.min(80, header.length); i++) {
      view.setUint8(i, header.charCodeAt(i));
    }

    view.setUint32(80, triCount, true);

    let offset = 84;

    for (let t = 0; t < triCount; t++) {

      const ia = indices[t * 3] * 3;
      const ib = indices[t * 3 + 1] * 3;
      const ic = indices[t * 3 + 2] * 3;

      const ax = positions[ia], ay = positions[ia + 1], az = positions[ia + 2];
      const bx = positions[ib], by = positions[ib + 1], bz = positions[ib + 2];
      const cx = positions[ic], cy = positions[ic + 1], cz = positions[ic + 2];

      /* face normal */
      const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
      const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;

      let nx = e1y * e2z - e1z * e2y;
      let ny = e1z * e2x - e1x * e2z;
      let nz = e1x * e2y - e1y * e2x;

      const nl = Math.hypot(nx, ny, nz) || 1;
      nx /= nl; ny /= nl; nz /= nl;

      view.setFloat32(offset, nx, true); offset += 4;
      view.setFloat32(offset, ny, true); offset += 4;
      view.setFloat32(offset, nz, true); offset += 4;

      view.setFloat32(offset, ax, true); offset += 4;
      view.setFloat32(offset, ay, true); offset += 4;
      view.setFloat32(offset, az, true); offset += 4;

      view.setFloat32(offset, bx, true); offset += 4;
      view.setFloat32(offset, by, true); offset += 4;
      view.setFloat32(offset, bz, true); offset += 4;

      view.setFloat32(offset, cx, true); offset += 4;
      view.setFloat32(offset, cy, true); offset += 4;
      view.setFloat32(offset, cz, true); offset += 4;

      view.setUint16(offset, 0, true); offset += 2;
    }

    const blob = new Blob([buffer], {
      type: "model/stl"
    });

    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = filename || "scan_mesh.stl";
    link.click();

    setTimeout(function () {
      URL.revokeObjectURL(link.href);
    }, 4000);

    return true;
  }

  /* ---------------- public API ---------------- */

  if (supported) {
    initGL();
    bindControls();
  }

  return {

    supported: supported,
    COLS: COLS,
    ROWS: ROWS,

    addScan: addScan,
    clear: clear,
    exportSTL: exportSTL,

    setVisible: function (v) {

      visible = v;

      if (v && supported) {
        resize();
        requestAnimationFrame(frame);
      }
    },

    stats: function () {
      return {
        vertices: vertexCount,
        triangles: triangleCount,
        slices: sliceCount
      };
    }
  };

})();
'''

open(f'{base}/mesh.js','w').write(mesh_js)
print("mesh.js written, bytes:", len(mesh_js))
