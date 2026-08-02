/**
 * A byte count as something a person reads at a glance.
 *
 * Its own module because two places show one — the remote file list and an
 * upload's progress — and they have to agree. The first copy of this lived in
 * `FilesPanel`; the second would have rounded differently within a week, which
 * reads as a bug when the same file is on screen twice.
 *
 * One decimal below 10 and none above, so a column of these has a stable width
 * and "9.4 MB" is still distinguishable from "9.9 MB" while "412 MB" does not
 * pretend to a precision the number does not have.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i++
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[i]}`
}
