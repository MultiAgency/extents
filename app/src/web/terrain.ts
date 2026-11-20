/**
 * An objective's terrain: contour lines drawn from a hex seed, deterministic
 * so the same objective always has the same map. The seed is the objective's
 * address once its terms are final (the address is derived from them), and
 * a hash of the draft before that, so the map reshapes as the terms change.
 */

/** mulberry32 over the seed's first 32 bits, mixed with the rest. */
function rng(seed: string): () => number {
  let a = 0;
  for (let i = 0; i < seed.length; i += 8) a = (a ^ parseInt(seed.slice(i, i + 8).padEnd(8, "0"), 16)) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const TERRAIN_W = 64;
export const TERRAIN_H = 20;

/** One path per contour level, in a TERRAIN_W × TERRAIN_H box; the last levels are the summits. */
export function terrain(seed: string, levels = 16): string[] {
  const rand = rng(seed.replace(/[^0-9a-f]/gi, "") || "0");
  // a few broad rises and some small knolls, so every map has both relief and detail
  const hills = Array.from({ length: 11 }, (_, i) => ({
    x: rand() * TERRAIN_W,
    y: rand() * TERRAIN_H,
    r: i < 4 ? 9 + rand() * 12 : 2.5 + rand() * 5,
    h: (i < 4 ? 0.6 : 0.25) + rand() * 0.6,
  }));
  const field = (x: number, y: number) =>
    hills.reduce((z, k) => z + k.h * Math.exp(-((x - k.x) ** 2 + (y - k.y) ** 2) / (2 * k.r ** 2)), 0);

  const step = 1;
  const cols = TERRAIN_W / step + 1;
  const rows = TERRAIN_H / step + 1;
  const z: number[] = [];
  let max = 0;
  for (let j = 0; j < rows; j++)
    for (let i = 0; i < cols; i++) {
      const v = field(i * step, j * step);
      z.push(v);
      max = Math.max(max, v);
    }

  const paths: string[] = [];
  for (let l = 1; l <= levels; l++) {
    const t = (max * l) / (levels + 1);
    let d = "";
    for (let j = 0; j < rows - 1; j++)
      for (let i = 0; i < cols - 1; i++) {
        const v = [z[j * cols + i]!, z[j * cols + i + 1]!, z[(j + 1) * cols + i + 1]!, z[(j + 1) * cols + i]!];
        const corner = [
          [i, j],
          [i + 1, j],
          [i + 1, j + 1],
          [i, j + 1],
        ];
        // crossing points on each cell edge, by linear interpolation
        const pts: [number, number][] = [];
        for (let e = 0; e < 4; e++) {
          const a = v[e]!,
            b = v[(e + 1) % 4]!;
          if (a < t !== b < t) {
            const f = (t - a) / (b - a);
            const [x0, y0] = corner[e]!,
              [x1, y1] = corner[(e + 1) % 4]!;
            pts.push([(x0! + (x1! - x0!) * f) * step, (y0! + (y1! - y0!) * f) * step]);
          }
        }
        for (let p = 0; p + 1 < pts.length; p += 2)
          d += `M${pts[p]![0].toFixed(2)} ${pts[p]![1].toFixed(2)}L${pts[p + 1]![0].toFixed(2)} ${pts[p + 1]![1].toFixed(2)}`;
      }
    paths.push(d);
  }
  return paths;
}
