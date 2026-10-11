/** Selection contains explicit IDs and never depends on the current search or page. */
export function togglePersonSelection(selectedIds: ReadonlySet<string>, personId: string): Set<string> {
  const next = new Set(selectedIds);
  if (next.has(personId)) next.delete(personId);
  else next.add(personId);
  return next;
}

/** Add/remove only this page, preserving selections from every other page/search. */
export function togglePageSelection(selectedIds: ReadonlySet<string>, pageIds: readonly string[]): Set<string> {
  const next = new Set(selectedIds);
  const page = [...new Set(pageIds)];
  const remove = page.length > 0 && page.every((id) => selectedIds.has(id));
  for (const id of page) {
    if (remove) next.delete(id);
    else next.add(id);
  }
  return next;
}

export function selectedOnPageCount(selectedIds: ReadonlySet<string>, pageIds: readonly string[]): number {
  return [...new Set(pageIds)].filter((id) => selectedIds.has(id)).length;
}
