import { SHOWN_MEDIA_TYPES } from "../../shared/values.js";

/** How files are named and measured on screen: sizes, and the short type label shown where there is no preview. */

const KB = 1024;
const MB = 1024 * KB;
const GB = 1024 * MB;

/** "8.4 MB", "220 KB", "96 B": a size as people read it, to one decimal below 10. */
export function formatBytes(bytes: number): string {
  const [unit, size] = bytes >= GB ? ["GB", bytes / GB] : bytes >= MB ? ["MB", bytes / MB] : bytes >= KB ? ["KB", bytes / KB] : ["B", bytes];
  return `${size < 10 && unit !== "B" ? (Math.round(size * 10) / 10).toString() : Math.round(size).toString()} ${unit}`;
}

/** What a file is, as its thumbnail shows it in a browser: an image, a video or audio it plays, or anything else. */
export type FileKind = "image" | "video" | "audio" | "other";

/** The kind of a file of `contentType`; only what Cronk serves to show in the page counts as an image, video or audio. */
export function fileKind(contentType: string): FileKind {
  const shown = (types: readonly string[]) => types.includes(contentType);
  if (shown(SHOWN_MEDIA_TYPES.image)) return "image";
  if (shown(SHOWN_MEDIA_TYPES.video)) return "video";
  if (shown(SHOWN_MEDIA_TYPES.audio)) return "audio";
  return "other";
}

/** "PNG", "LOG", "MP4": a file's type as a short label, from its name's extension, or else its media type. */
export function typeLabel(name: string, contentType: string): string {
  const extension = /\.([A-Za-z0-9]{1,5})$/.exec(name)?.[1];
  return (extension ?? contentType.split("/")[1]?.split(/[+.-]/)[0] ?? "file").toUpperCase();
}
