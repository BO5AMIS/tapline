import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";

// A read of a file inside a folder that may hold links (an explore report folder, a bug's folder): the file's real place must lie inside the
// folder's real place, and the file that is opened must be the one that was checked. Used for every read of a run's or a bug's file.

const within = (root: string, path: string): boolean => {
  const base = resolve(root);
  const full = resolve(path);
  return full === base || full.startsWith(base + sep);
};

/** Whether the file's real place (links followed) is inside the folder's real place; a file that isn't there is not. */
export function insideReal(root: string, path: string): boolean {
  try {
    return within(realpathSync(root), realpathSync(path));
  } catch {
    return false;
  }
}

/**
 * The bytes of `path` when its real place is inside `root`'s real place, else an error. The file is opened by its real path (a link swapped in at the
 * last step is refused where the platform has `O_NOFOLLOW`), and the opened file must be the regular file the check saw (same device and index) and
 * still lie at the same real place afterwards, so a link swapped in between the check and the read is caught.
 */
export function readContained(root: string, path: string): Buffer {
  const real = realpathSync(path);
  if (!within(realpathSync(root), real)) throw new Error("the file lies outside its folder");
  const seen = statSync(real, { bigint: true });
  if (!seen.isFile()) throw new Error("not a regular file");
  const fd = openSync(real, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (!opened.isFile() || opened.dev !== seen.dev || opened.ino !== seen.ino) throw new Error("the file changed while it was opened");
    if (realpathSync(path) !== real) throw new Error("the file's place changed while it was opened");
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

export const readContainedText = (root: string, path: string): string => readContained(root, path).toString("utf8");
