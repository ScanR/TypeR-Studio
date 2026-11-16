// Turns the pictures session.js keeps into PNGs away from the page. A browser encodes a
// canvas's toBlob() on the page's own thread, in its idle moments: with a chapter of large pages
// just opened, that is the page busy for a minute while one tries to work on it.

"use strict";

self.onmessage = async ({ data: { id, bitmap } }) => {
  try {
    // The picture is handed to the canvas as it is, not drawn on it: the same pixels
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    canvas.getContext("bitmaprenderer").transferFromImageBitmap(bitmap);
    const blob = await canvas.convertToBlob({ type: "image/png" });
    // A large page's pixels aren't left waiting for the worker's next tidy-up
    canvas.width = canvas.height = 0;
    self.postMessage({ id, blob });
  } catch (error) {
    self.postMessage({ id, error: String((error && error.message) || error) });
  }
};
