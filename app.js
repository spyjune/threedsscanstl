app_js = r'''const video = document.getElementById("video");
const glcanvas = document.getElementById("glcanvas");

const start = document.getElementById("start");
const snap = document.getElementById("snap");
const autoButton = document.getElementById("auto");
const finish = document.getElementById("finish");
const exportButton = document.getElementById("export");
const exportSTLButton = document.getElementById("exportSTL");
const toggleView = document.getElementById("toggleView");

const status = document.getElementById("status");
const count = document.getElementById("count");
const meshBadge = document.getElementById("meshBadge");

const canvas = document.getElementById("canvas");

let stream = null;
let photos = [];
let scanning = false;

let showing3D = false;

let autoCapture = false;
const AUTO_STEP_DEG = 12;
let lastAutoAzimuth = null;

/* ---------------- orientation tracking ---------------- */

let azimuthDeg = null;      /* latest compass azimuth, or null if unavailable */
let gotOrientation = false;

function toRadians(deg) {
  return (deg * Math.PI) / 180;
}

function angleDiff(a, b) {
  let d = (a - b) % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}

window.addEventListener("deviceorientation", function (event) {

  if (event.alpha === null || event.alpha === undefined) {
    return;
  }

  gotOrientation = true;

  /* alpha: 0..360 counter-clockwise from north */
  azimuthDeg = (360 - event.alpha) % 360;

  maybeAutoCapture();
});

async function requestOrientationPermission() {

  if (typeof DeviceOrientationEvent === "undefined") {
    return;
  }

  if (typeof DeviceOrientationEvent.requestPermission === "function") {

    try {
      const result = await DeviceOrientationEvent.requestPermission();

      if (result !== "granted") {
        status.textContent =
          "Compass off — mesh will auto-place slices";
      }
    }

    catch (error) {
      console.warn(error);
    }
  }
}

/*
 * Fallback azimuth when no compass data arrives (desktop / denied):
 * advance a synthetic angle a little every capture so the mesh
 * still wraps around the object.
 */
function effectiveAzimuth() {

  if (azimuthDeg !== null) {
    return azimuthDeg;
  }

  return (photos.length * 18) % 360;
}

/* ---------------- auto capture ---------------- */

let lastAutoTime = 0;

function maybeAutoCapture() {

  if (!autoCapture || !scanning || !stream) {
    return;
  }

  if (azimuthDeg === null) {
    return;
  }

  if (lastAutoAzimuth === null) {
    lastAutoAzimuth = azimuthDeg;
    return;
  }

  const now = performance.now();

  if (now - lastAutoTime < 500) {
    return;
  }

  if (Math.abs(angleDiff(azimuthDeg, lastAutoAzimuth)) >= AUTO_STEP_DEG) {
    lastAutoAzimuth = azimuthDeg;
    lastAutoTime = now;
    captureImage();
  }
}

setInterval(maybeAutoCapture, 250);

/* ---------------- UI ---------------- */

function updateUI() {

  count.textContent = photos.length;

  snap.disabled = !scanning;

  finish.disabled =
    !scanning || photos.length < 8;

  exportButton.disabled =
    photos.length === 0;

  const stats = MeshViewer.stats();

  exportSTLButton.disabled =
    stats.triangles === 0;

  meshBadge.hidden =
    stats.triangles === 0;

  meshBadge.textContent =
    "mesh: " +
    stats.vertices.toLocaleString() +
    " pts / " +
    stats.triangles.toLocaleString() +
    " tris";

  toggleView.hidden =
    stats.triangles === 0;
}

/* ---------------- camera ---------------- */

async function startCamera() {

  if (!navigator.mediaDevices ||
      !navigator.mediaDevices.getUserMedia) {

    status.textContent =
      "Camera requires HTTPS and Safari.";

    return;
  }

  await requestOrientationPermission();

  try {

    stream =
      await navigator.mediaDevices.getUserMedia({

        video: {

          facingMode: {
            ideal: "environment"
          },

          width: {
            ideal: 1920
          },

          height: {
            ideal: 1080
          }

        },

        audio: false

      });

    video.srcObject = stream;

    scanning = true;
    lastAutoAzimuth = null;

    start.disabled = true;
    start.textContent = "Scanning…";
    autoButton.disabled = false;

    status.textContent =
      "Move around the object";

    updateUI();

  }

  catch (error) {

    console.error(error);

    status.textContent =
      "Camera permission was denied.";

  }
}

/* ---------------- photo → mesh slice sampling ---------------- */

const sampleCanvas = document.createElement("canvas");
const sampleContext = sampleCanvas.getContext("2d", {
  willReadFrequently: true
});

/*
 * Downscale the captured photo to the mesh grid.
 * Returns { lum: Float32Array, rgb: Uint8Array } or null.
 */
function samplePhoto(source) {

  const cols = MeshViewer.COLS;
  const rows = MeshViewer.ROWS;

  sampleCanvas.width = cols;
  sampleCanvas.height = rows;

  /* cover-crop so the sampling matches what the user framed */
  const sw = source.width || source.videoWidth;
  const sh = source.height || source.videoHeight;

  if (!sw || !sh) {
    return null;
  }

  const srcAspect = sw / sh;
  const dstAspect = cols / rows;

  let sx = 0, sy = 0, sWidth = sw, sHeight = sh;

  if (srcAspect > dstAspect) {
    sWidth = sh * dstAspect;
    sx = (sw - sWidth) / 2;
  } else {
    sHeight = sw / dstAspect;
    sy = (sh - sHeight) / 2;
  }

  sampleContext.drawImage(
    source,
    sx, sy, sWidth, sHeight,
    0, 0, cols, rows
  );

  const data =
    sampleContext.getImageData(0, 0, cols, rows).data;

  const lum = new Float32Array(cols * rows);
  const rgb = new Uint8Array(cols * rows * 3);

  for (let i = 0; i < cols * rows; i++) {

    const r = data[i * 4];
    const g = data[i * 4 + 1];
    const b = data[i * 4 + 2];

    rgb[i * 3] = r;
    rgb[i * 3 + 1] = g;
    rgb[i * 3 + 2] = b;

    /* perceived luminance, 0..1 */
    lum[i] =
      (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  }

  return { lum: lum, rgb: rgb };
}

/* ---------------- capture ---------------- */

function captureImage() {

  if (!stream) {
    return;
  }

  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;

  const context = canvas.getContext("2d");

  context.drawImage(
    video,
    0, 0,
    canvas.width, canvas.height
  );

  const sample = samplePhoto(canvas);

  canvas.toBlob(

    function (blob) {

      if (!blob) {
        return;
      }

      photos.push(blob);

      addSliceToMesh(sample);

      status.textContent =
        "Captured " +
        photos.length +
        " — keep moving";

      updateUI();

    },

    "image/jpeg",
    0.92
  );
}

function addSliceToMesh(sample) {

  if (!MeshViewer.supported || !sample) {
    return;
  }

  const result = MeshViewer.addScan({
    azimuth: toRadians(effectiveAzimuth()),
    lum: sample.lum,
    rgb: sample.rgb
  });

  if (!result.ok && result.reason === "full") {
    status.textContent =
      "Mesh full (" +
      MeshViewer.MAX_SLICES +
      " slices) — finish the scan";
    return;
  }

  if (result.ok) {

    if (!gotOrientation && azimuthDeg === null) {
      meshBadge.textContent =
        "mesh: " +
        result.vertices.toLocaleString() +
        " pts (auto-placed)";
    }

    updateUI();
  }
}

/* ---------------- finish ---------------- */

function finishScan() {

  scanning = false;
  autoCapture = false;
  autoButton.textContent = "Auto: Off";

  if (stream) {
    stream
      .getTracks()
      .forEach(track => track.stop());
  }

  start.disabled = false;
  start.textContent = "New Scan";
  autoButton.disabled = true;

  status.textContent =
    "Scan complete — export your mesh or photos";

  updateUI();
}

/* ---------------- exports ---------------- */

async function exportPhotos() {

  if (photos.length === 0) {
    return;
  }

  const files =
    photos.map(

      (blob, index) => {

        return new File(

          [blob],

          "scan_" +
          String(index + 1)
            .padStart(3, "0") +
          ".jpg",

          {
            type: "image/jpeg"
          }

        );

      }

    );

  if (
    navigator.share &&
    navigator.canShare &&
    navigator.canShare({ files: files })
  ) {

    try {

      await navigator.share({

        title: "3D Scan",

        text: "3D object scan photos",

        files: files

      });

      return;

    }

    catch (error) {

      if (error.name === "AbortError") {
        return;
      }

    }

  }

  for (const file of files) {

    const link = document.createElement("a");

    link.href = URL.createObjectURL(file);
    link.download = file.name;
    link.click();

    await new Promise(
      resolve =>
        setTimeout(resolve, 250)
    );

  }

  status.textContent = "Photos exported.";
}

function exportSTL() {

  const stats = MeshViewer.stats();

  if (stats.triangles === 0) {
    return;
  }

  const stamp = new Date()
    .toISOString()
    .slice(0, 19)
    .replace(/[:T]/g, "-");

  const ok = MeshViewer.exportSTL(
    "scan_mesh_" + stamp + ".stl"
  );

  if (ok) {
    status.textContent =
      "STL exported (" +
      stats.triangles.toLocaleString() +
      " triangles)";
  }
}

/* ---------------- 2D / 3D view toggle ---------------- */

function setView3D(show) {

  showing3D = show;

  video.hidden = show;
  glcanvas.hidden = !show;

  toggleView.textContent = show ? "2D" : "3D";

  MeshViewer.setVisible(show && MeshViewer.supported);
}

toggleView.addEventListener(
  "click",
  function () {
    setView3D(!showing3D);
  }
);

/* ---------------- wire up ---------------- */

start.addEventListener(

  "click",

  function () {

    if (start.textContent === "New Scan") {

      photos = [];
      MeshViewer.clear();

      if (showing3D) {
        setView3D(false);
      }

      updateUI();
    }

    startCamera();

  }

);

snap.addEventListener("click", captureImage);

autoButton.addEventListener(

  "click",

  function () {

    autoCapture = !autoCapture;
    lastAutoAzimuth = azimuthDeg;

    autoButton.textContent =
      autoCapture ? "Auto: On" : "Auto: Off";

    status.textContent =
      autoCapture
        ? "Auto-capture every " + AUTO_STEP_DEG + "° — walk slowly"
        : "Auto-capture off";

  }

);

finish.addEventListener("click", finishScan);

exportButton.addEventListener("click", exportPhotos);

exportSTLButton.addEventListener("click", exportSTL);

updateUI();
'''

open(f'{base}/app.js','w').write(app_js)
print("app.js written, bytes:", len(app_js))
