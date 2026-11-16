/** A size as Users read it in a refusal: whole GB or MB where it is one, MB to one decimal from 1 MB, and bytes below. */
export function formatBytes(bytes: number): string {
  const MB = 1024 * 1024;
  if (bytes >= 1024 * MB && bytes % (1024 * MB) === 0) return `${bytes / (1024 * MB)} GB`;
  if (bytes < MB) return `${bytes} bytes`;
  return bytes % MB === 0 ? `${bytes / MB} MB` : `${(bytes / MB).toFixed(1)} MB`;
}
