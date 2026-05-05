import { displayChannelName } from "./assignmentMatch";
import type { LiveStream } from "./nodecastCatalog";

/** Apply a saved stream_id sequence; unknown streams append alphabetically. */
export function applySavedOrder(streams: LiveStream[], saved: number[] | null | undefined): LiveStream[] {
  if (!saved?.length) return streams;
  const byId = new Map(streams.map((s) => [s.stream_id, s]));
  const ordered: LiveStream[] = [];
  const used = new Set<number>();
  for (const id of saved) {
    const s = byId.get(id);
    if (s) {
      ordered.push(s);
      used.add(id);
    }
  }
  const rest = streams.filter((s) => !used.has(s.stream_id));
  rest.sort((a, b) => displayChannelName(a.name).localeCompare(displayChannelName(b.name), "fr"));
  return [...ordered, ...rest];
}

/**
 * Merge a reordered visible subset into the full order: keeps relative positions of
 * hidden (filtered-out) streams while moving only the visible block.
 */
export function mergeVisibleReorder(
  fullOrder: readonly number[],
  visibleSet: ReadonlySet<number>,
  newVisibleOrder: readonly number[]
): number[] {
  const vset = visibleSet;
  const without = fullOrder.filter((id) => !vset.has(id));
  const indices = [...visibleSet].map((id) => fullOrder.indexOf(id)).filter((i) => i >= 0);
  if (indices.length === 0) {
    return fullOrder.length ? [...fullOrder] : [...newVisibleOrder];
  }
  const anchorIdx = Math.min(...indices);
  let insertPos = 0;
  for (let i = 0; i < anchorIdx; i++) {
    if (!vset.has(fullOrder[i])) insertPos++;
  }
  return [...without.slice(0, insertPos), ...newVisibleOrder, ...without.slice(insertPos)];
}
