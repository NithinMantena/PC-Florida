// Python difflib.get_close_matches (SequenceMatcher without junk), used for
// "Did you mean ...?" hints. Strings here are short company names, so
// Python's autojunk heuristic (inputs of 200+ items) never applies.

function matchedChars(a: string, b: string, b2j: Map<string, number[]>): number {
  const findLongest = (alo: number, ahi: number, blo: number, bhi: number): [number, number, number] => {
    let besti = alo, bestj = blo, bestsize = 0;
    let j2len = new Map<number, number>();
    for (let i = alo; i < ahi; i++) {
      const newj2len = new Map<number, number>();
      for (const j of b2j.get(a[i]) ?? []) {
        if (j < blo) continue;
        if (j >= bhi) break;
        const k = (j2len.get(j - 1) ?? 0) + 1;
        newj2len.set(j, k);
        if (k > bestsize) {
          besti = i - k + 1;
          bestj = j - k + 1;
          bestsize = k;
        }
      }
      j2len = newj2len;
    }
    return [besti, bestj, bestsize];
  };
  let total = 0;
  const queue: [number, number, number, number][] = [[0, a.length, 0, b.length]];
  while (queue.length) {
    const [alo, ahi, blo, bhi] = queue.pop()!;
    const [i, j, k] = findLongest(alo, ahi, blo, bhi);
    if (k) {
      total += k;
      if (alo < i && blo < j) queue.push([alo, i, blo, j]);
      if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi]);
    }
  }
  return total;
}

function ratioOf(matches: number, la: number, lb: number): number {
  const t = la + lb;
  return t ? (2.0 * matches) / t : 1.0;
}

export function getCloseMatches(word: string, possibilities: string[], n = 3, cutoff = 0.6): string[] {
  const b = word;
  const b2j = new Map<string, number[]>();
  for (let j = 0; j < b.length; j++) {
    const arr = b2j.get(b[j]);
    if (arr) arr.push(j);
    else b2j.set(b[j], [j]);
  }
  const bCount = new Map<string, number>();
  for (const ch of b) bCount.set(ch, (bCount.get(ch) ?? 0) + 1);

  const result: [number, string][] = [];
  for (const x of possibilities) {
    const la = x.length, lb = b.length;
    if (ratioOf(Math.min(la, lb), la, lb) < cutoff) continue; // real_quick_ratio
    const avail = new Map<string, number>();
    let inter = 0;
    for (const ch of x) {
      const have = avail.has(ch) ? avail.get(ch)! : (bCount.get(ch) ?? 0);
      avail.set(ch, have - 1);
      if (have > 0) inter++;
    }
    if (ratioOf(inter, la, lb) < cutoff) continue; // quick_ratio
    const r = ratioOf(matchedChars(x, b, b2j), la, lb);
    if (r >= cutoff) result.push([r, x]);
  }
  result.sort((p, q) => (q[0] - p[0]) || (q[1] > p[1] ? 1 : q[1] < p[1] ? -1 : 0));
  return result.slice(0, n).map(([, x]) => x);
}
