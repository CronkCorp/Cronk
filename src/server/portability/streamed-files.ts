import { isStored, textOf, unwrapFolder, type StoredFolder } from "./archive.js";
import type { FileLimits } from "./import-context.js";
import { readFrontmatter } from "./frontmatter.js";
import { fileLimitsIn } from "./workspace.js";

/**
 * Which files of an export an import streams into the file store as they arrive, rather than holding them in memory, and
 * how large each may be. An archive may wrap the export in a folder, so paths are matched wherever the export starts.
 */

/** A file attached to something, in its `.attachments/` folder, other than the folder's `index.md`. */
const ATTACHMENT_FILE = /\.attachments\/(?!index\.md$)[^/]+$/;

/** A file of an Artifact Version, in `artifacts/<n>-<title>/<version>/`. */
const ARTIFACT_FILE = /(?:^|\/)artifacts\/[^/]+\/\d+\//;

/** Whether the file at `path` is one of the export's own Markdown files, held in memory: a `.md` file that is no Attachment or Artifact file. */
export function isExportMarkdown(path: string): boolean {
  return path.endsWith(".md") && !ATTACHMENT_FILE.test(path) && !ARTIFACT_FILE.test(path);
}

/** The most a file streamed in may take, and what it is, for saying so when one is larger. */
export interface StreamedFileLimit {
  maxBytes: number;
  /** What the file is, as a refusal names it: "an Attachment" or "an Artifact Version". */
  of: string;
}

/**
 * The most bytes the file at `path` may take once the import is done: an Attachment's file the Attachment limit, and any
 * other the Artifact Version limit, which no Artifact file may exceed. The limits are the export's own `workspace.md`
 * ones if it is a Workspace export and they have arrived, as an export's Markdown files arrive before its other
 * files; else `here`, the importing Workspace's.
 */
export function streamedFileLimit(path: string, markdown: StoredFolder, here: FileLimits): StreamedFileLimit {
  const limits = { ...here, ...exportedFileLimits(unwrapFolder(markdown)) };
  return ATTACHMENT_FILE.test(path) ? { maxBytes: limits.attachmentMaxBytes, of: "an Attachment" } : { maxBytes: limits.artifactMaxBytes, of: "an Artifact Version" };
}

/** The file limits a Workspace export's `workspace.md` sets, if it has arrived; none for a Project export, or one that can't be read, which the import refuses later. */
function exportedFileLimits(folder: StoredFolder): Partial<FileLimits> {
  const read = (path: string) => {
    const contents = folder.get(path);
    return contents === undefined || isStored(contents) ? undefined : { path, ...readFrontmatter(textOf(contents)) };
  };
  try {
    const manifest = read("README.md")?.data.cronk as { scope?: unknown } | undefined;
    const settings = read("workspace.md");
    return manifest?.scope === "workspace" && settings ? fileLimitsIn(settings) : {};
  } catch {
    return {};
  }
}
