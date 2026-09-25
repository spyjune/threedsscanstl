const video = document.getElementById("video");

const start = document.getElementById("start");
const snap = document.getElementById("snap");
const finish = document.getElementById("finish");
const exportButton = document.getElementById("export");

const status = document.getElementById("status");
const count = document.getElementById("count");

const canvas = document.getElementById("canvas");

let stream = null;

let photos = [];

let scanning = false;


/* Update buttons and counter */

function updateUI() {

  count.textContent = photos.length;

  snap.disabled = !scanning;

  finish.disabled =
    !scanning || photos.length < 8;

  exportButton.disabled =
    photos.length === 0;
}


/* Start camera */

async function startCamera() {

  if (!navigator.mediaDevices ||
      !navigator.mediaDevices.getUserMedia) {

    status.textContent =
      "Camera requires HTTPS and Safari.";

    return;
  }

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

    start.disabled = true;

    start.textContent =
      "Scanning…";

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


/* Capture image */

function captureImage() {

  if (!stream) {
    return;
  }

  canvas.width =
    video.videoWidth;

  canvas.height =
    video.videoHeight;

  const context =
    canvas.getContext("2d");

  context.drawImage(
    video,
    0,
    0,
    canvas.width,
    canvas.height
  );

  canvas.toBlob(

    function(blob) {

      if (!blob) {
        return;
      }

      photos.push(blob);

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


/* Finish scan */

function finishScan() {

  scanning = false;

  if (stream) {

    stream
      .getTracks()
      .forEach(track =>
        track.stop()
      );

  }

  start.disabled = false;

  start.textContent =
    "New Scan";

  status.textContent =
    "Scan complete — export your photos";

  updateUI();
}


/* Export photos */

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


  /* iPhone Share Sheet */

  if (
    navigator.share &&
    navigator.canShare &&
    navigator.canShare({
      files: files
    })
  ) {

    try {

      await navigator.share({

        title: "3D Scan",

        text:
          "3D object scan photos",

        files: files

      });

      return;

    }

    catch (error) {

      if (
        error.name ===
        "AbortError"
      ) {

        return;

      }

    }

  }


  /* Browser download fallback */

  for (
    const file of files
  ) {

    const link =
      document.createElement("a");

    link.href =
      URL.createObjectURL(file);

    link.download =
      file.name;

    link.click();

    await new Promise(
      resolve =>
        setTimeout(resolve, 250)
    );

  }

  status.textContent =
    "Photos exported.";

}


/* Start */

start.addEventListener(
  "click",
  function() {

    if (
      start.textContent ===
      "New Scan"
    ) {

      photos = [];

      updateUI();

    }

    startCamera();

  }
);


/* Capture */

snap.addEventListener(
  "click",
  captureImage
);


/* Finish */

finish.addEventListener(
  "click",
  finishScan
);


/* Export */

exportButton.addEventListener(
  "click",
  exportPhotos
);


updateUI();