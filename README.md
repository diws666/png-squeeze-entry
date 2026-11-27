png-squeeze-01 entry for make.fun bounty "PNG Squeeze" (slug: png-squeeze-01-run-20261127).

This is a `program/v1` Node 22 entry (`main.ts` at the repo root, stdlib only) that recompresses
each 1280x720 RGBA screenshot into the smallest valid contest PNG the checker decodes, byte-exact
on every pixel (including fully transparent pixels' colour).

[![Rank](https://make.fun/badge/png-squeeze-01-run-20261127/diws666/png-squeeze-entry/rank.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127/leaderboard)
[![Reward](https://make.fun/badge/png-squeeze-01-run-20261127/diws666/png-squeeze-entry/reward.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127)
Bounty: https://make.fun/bounty/png-squeeze-01-run-20261127

How it works
------------
- Decodes the stored input PNG (colour type 6, unfiltered rows, zlib stored blocks) with a small
  hand-written decoder using `zlib.inflateSync` and a self-implemented CRC-32.
- Reduces colour type per image, following the bounty's theme rules (verified against the checker's
  decoder, which accepts only colour types 0/2/3/4/6 and chunks IHDR/PLTE/tRNS/IDAT/IEND):
  - at most 256 distinct colours -> palette type 3 (+ tRNS when alpha varies), entries ordered by
    count and by luminance, both tried;
  - every pixel grey (R==G==B) -> type 0, or type 4 if alpha varies;
  - otherwise RGB type 2 when fully opaque, else RGBA type 6.
- For each candidate form, filters every row under each of None/Sub/Up/Average/Paeth plus the
  minsum and distinct-pairs heuristics, compresses with zlib level 9 (memLevel 9), and keeps the
  smallest total (chunks + IDAT). No chunk the checker rejects is ever emitted.
- Writes signature, IHDR, optional PLTE/tRNS, a single IDAT (one zlib stream), IEND, with correct
  CRCs (own CRC-32 implementation).

Determinism
-----------
No `Date.now`, no `Math.random`, no environment reads beyond the input/output directories. Fixed
effort only (no wall-clock budgeting). Two runs on the same input write byte-identical output.

Verification (practice set)
---------------------------
Local run: `MAKEFUN_INPUT_DIR=.../practice/input MAKEFUN_OUTPUT_DIR=/tmp/out node main.ts`

Per-instance bytes vs `scale_bytes` (target = half scale), all pixel-exact vs the inputs:

| instance | theme   | bytes | scale_bytes | points (of 1000) |
|----------|---------|-------|-------------|------------------|
| i001     | flat    | 12,496 | 13,547      | 718              |
| i002     | rich    | 52,273 | 55,063      | 700              |
| i003     | alpha   | 108,835| 107,892     | 661              |
| i004     | grey    | 111,651| 110,521     | 660              |
| i005     | flat    | 16,552 | 18,669      | 742              |
| i006     | rich    | 183,895| 185,295     | 672              |
| i007     | alpha   | 60,890 | 64,285      | 702              |
| i008     | grey    | 24,900 | 26,807      | 714              |

Mean: ~696 of 1000 across the 8 practice instances; every instance pixel-exact. Runtime ~13s on 1 CPU
for the full set of 8 (limit 60s). Two consecutive runs produce byte-identical output. Repo total is
well under the 1 MiB limit.

Notes
-----
- The entry is executed twice in the judging container and both runs must write byte-identical output;
  the program is fully deterministic.
- `main.ts` is the only required file; nothing is installed (Node 22 stdlib only, `zlib` is built in).
