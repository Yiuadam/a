"use client";

import { cropRect, outputSize, type View } from "./crop";

/*
  Turning whatever the learner picked into something small enough to send.

  ---------------------------------------------------------------------------
  Why the browser does this and not the server

  The obvious way to accept a 9 MB photo is to raise the limit on the upload
  route and on the Supabase bucket behind it. That was rejected. The upload
  route is the only thing in this app that writes a file, so its ceiling is a
  security property, not an inconvenience: every megabyte it accepts is a
  megabyte anyone holding a session can push into storage, over and over, from
  a script. Raising it to 10 MB would multiply the cost of the cheapest abuse
  there is by five and buy the learner nothing, because nobody has ever needed
  9 MB to show a face at 64 pixels across.

  So the ceiling stays where it is and the work moves to where the picture
  already lives. By the time anything crosses the network it is a 256-pixel
  square — a few kilobytes, not megabytes — and the server's 2 MB guard is
  never even approached. The learner's side of the bargain is that they may
  pick anything they like: any resolution, any orientation, any of the formats
  their browser can decode, up to MAX_SOURCE_BYTES.

  ---------------------------------------------------------------------------
  Why the output prefers WebP

  app/api/account/avatar/route.ts identifies a file by its first bytes and not
  by its name or its Content-Type, and accepts exactly three types. Whatever
  comes out of here therefore has to genuinely be one of those three. Canvas
  encoding is the guarantee: a WebP produced by toBlob has a real RIFF/WEBP
  signature, no matter what went in. WebP is materially smaller than JPEG for
  the same tiny portrait. A JPEG fallback keeps the upload working in an older
  embedded browser that can decode the picture but cannot encode WebP. A HEIC
  from an iPhone, a TIFF from a scanner, an animated GIF — if the browser can
  decode it, what leaves here is a small ordinary still image the route can
  identify safely.
*/

/**
 * The largest file this will even open.
 *
 * Not a technical limit — it is the point past which reading the file into
 * memory to shrink it is itself the problem, on the phones this app is mostly
 * used on. Ten megabytes covers every photo a modern phone camera produces
 * with a good deal of room to spare.
 */
export const MAX_SOURCE_BYTES = 10 * 1024 * 1024;

/**
 * What the finished square must fit inside.
 *
 * Well under the route's own 2 MB so there is no argument at the boundary: a
 * 256-pixel WebP lands near 10–25 KB in practice, and if a pathological image
 * ever pushed past this the quality ladder below brings it back rather than
 * letting the upload fail in front of the learner.
 */
export const TARGET_BYTES = 96 * 1024;

/*
  The first canvas is capped at 2048 on a side.

  iOS Safari refuses to allocate a canvas past roughly 16.7 million pixels and,
  worse, does not always say so — it hands back a blank context and the upload
  becomes a white square. 2048 squared is a quarter of that ceiling, which is
  comfortable on the oldest device this app supports, and costs nothing:
  everything here is on its way down to 256 regardless.
*/
const MAX_FIRST_PASS = 2048;

/*
  Quality is tried in descending order and the first attempt that fits wins. In
  practice the first one always does; the rest exist so that "the picture was
  too big" can never be something the learner is told after they have already
  cropped it.
*/
const QUALITY_LADDER = [0.82, 0.7, 0.58, 0.45];
const OUTPUT_TYPES = ["image/webp", "image/jpeg"] as const;

export interface LoadedImage {
  element: HTMLImageElement;
  /*
    The same object URL the element was decoded from, so the editor can hand it
    to an <img> in its own markup instead of trying to graft a detached DOM
    node into React's tree. Both point at one blob and the browser decodes it
    once, so this costs nothing beyond the string.
  */
  url: string;
  width: number;
  height: number;
  /** Frees the object URL. Always call it, including on the failure path. */
  release: () => void;
}

/** Why a picture could not be used, in words the learner can act on. */
export class PictureProblem extends Error {}

/**
 * Reads a chosen file into an image the editor can show and the canvas can
 * draw.
 *
 * An <img> rather than createImageBitmap, and that is a deliberate downgrade.
 * Photographs from a phone carry an EXIF orientation flag, and an <img> is the
 * one path where every browser applies it for us — both on screen and when the
 * element is later drawn into a canvas. createImageBitmap needs an option for
 * it that older WebKit ignores, and the failure mode is the worst kind: the
 * preview looks right, the saved picture is on its side, and nothing anywhere
 * reports an error.
 */
export async function loadImage(file: File): Promise<LoadedImage> {
  if (file.size === 0) {
    throw new PictureProblem("That file is empty. Please choose another picture.");
  }
  if (file.size > MAX_SOURCE_BYTES) {
    throw new PictureProblem(
      "That picture is larger than 10 MB. Please choose a smaller one, or take a new photo.",
    );
  }

  const url = URL.createObjectURL(file);
  const element = new Image();
  element.src = url;

  try {
    /*
      decode() rejects for anything the browser cannot turn into pixels, which
      is exactly the test worth running here — it covers a PDF renamed to .jpg
      and a HEIC on a browser that has never heard of HEIC, without this file
      needing a list of formats that would be out of date within the year.
    */
    if (typeof element.decode === "function") {
      await element.decode();
    } else {
      await new Promise<void>((resolve, reject) => {
        element.onload = () => resolve();
        element.onerror = () => reject(new Error("decode failed"));
      });
    }
  } catch {
    URL.revokeObjectURL(url);
    throw new PictureProblem(
      "This browser can't open that picture. A JPEG, PNG or WebP will work.",
    );
  }

  const width = element.naturalWidth;
  const height = element.naturalHeight;
  if (width < 1 || height < 1) {
    URL.revokeObjectURL(url);
    throw new PictureProblem("That picture has no image in it. Please choose another.");
  }

  return { element, url, width, height, release: () => URL.revokeObjectURL(url) };
}

function context(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new PictureProblem(
      "This browser wouldn't let us prepare the picture. Please try a different browser.",
    );
  }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  return ctx;
}

function square(size: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = context(canvas);
  /*
  A white base under everything, so every output has the same opaque backdrop.
  Without it a PNG with a cut-out background can arrive as a face on a black
  square, which looks like a bug in the app rather than a property of the
  format. White is
    also invisible in the place it would otherwise show: avatars are drawn as
    circles, and the corners of the square where a transparent edge would sit
    are outside that circle and never seen.
  */
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, size, size);
  return { canvas, ctx };
}

function toBlob(
  canvas: HTMLCanvasElement,
  mime: (typeof OUTPUT_TYPES)[number],
  quality: number,
): Promise<Blob | null> {
  return new Promise((resolve) => {
    if (typeof canvas.toBlob !== "function") {
      resolve(null);
      return;
    }
    canvas.toBlob(
      (blob) => resolve(blob?.type === mime ? blob : null),
      mime,
      quality,
    );
  });
}

/**
 * Renders the learner's crop and hands back the file to upload.
 *
 * The shrink happens in halving steps rather than in one jump. drawImage does
 * a cheap bilinear sample, which is fine for a small reduction and visibly
 * wrong for a large one: taking a 4000-pixel photo straight down to 256 throws
 * away most of its pixels at once and produces the speckled, aliased look
 * of a badly resized image. Halving repeatedly averages the pixels that are
 * being discarded, and three or four extra draws on a 256-pixel canvas cost
 * nothing a person can perceive.
 */
export async function renderCrop(image: LoadedImage, view: View): Promise<Blob> {
  const crop = cropRect(view, image.width, image.height);
  const out = outputSize(crop.size);

  let edge = Math.max(out, Math.min(Math.round(crop.size), MAX_FIRST_PASS));
  const first = square(edge);
  first.ctx.drawImage(image.element, crop.x, crop.y, crop.size, crop.size, 0, 0, edge, edge);
  let canvas = first.canvas;

  while (edge > out) {
    const next = Math.max(out, Math.floor(edge / 2));
    const step = square(next);
    step.ctx.drawImage(canvas, 0, 0, edge, edge, 0, 0, next, next);
    canvas = step.canvas;
    edge = next;
  }

  let smallest: Blob | null = null;
  for (const mime of OUTPUT_TYPES) {
    for (const quality of QUALITY_LADDER) {
      const blob = await toBlob(canvas, mime, quality);
      if (!blob) break;
      if (blob.size <= TARGET_BYTES) return blob;
      if (!smallest || blob.size < smallest.size) smallest = blob;
    }
  }

  if (smallest) return smallest;
  throw new PictureProblem(
    "This browser wouldn't let us prepare the picture. Please try a different browser.",
  );
}
