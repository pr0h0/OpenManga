import { type PointerEvent, useEffect, useRef, useState } from "react";

/** Series colours in fixed order: a series keeps its slot whatever else is shown. */
export const seriesColor = (i: number) => `var(--series-${(i % 8) + 1})`;

const H = 200;

/** The chart's drawn width in CSS pixels, so text and strokes keep their size at any width. */
function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(640);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(200, Math.round(e!.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}
const PAD = { l: 44, r: 8, t: 8, b: 22 };
const nice = (v: number) => {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((x) => x >= v) ?? v;
};
const short = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k` : String(Math.round(n));

function Axis({ max, fmt, W }: { max: number; fmt: (n: number) => string; W: number }) {
  return (
    <>
      {[0, 0.5, 1].map((f) => {
        const y = PAD.t + (H - PAD.t - PAD.b) * (1 - f);
        return (
          <g key={f}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y} y2={y} stroke="var(--border)" strokeWidth={1} />
            <text x={PAD.l - 6} y={y + 4} textAnchor="end" fontSize={11} fill="var(--muted)">
              {fmt(max * f)}
            </text>
          </g>
        );
      })}
    </>
  );
}

function Tooltip({ x, W, children }: { x: number; W: number; children: React.ReactNode }) {
  return (
    <div
      className="pointer-events-none absolute top-1 z-10 rounded-md border border-[var(--border)] bg-[var(--panel)] px-2 py-1 text-xs shadow-md"
      style={{ left: `${(x / W) * 100}%`, transform: x > W / 2 ? "translateX(calc(-100% - 8px))" : "translateX(8px)" }}
    >
      {children}
    </div>
  );
}

/** First, middle and last index, each once. */
const ticks = (n: number) => [...new Set([0, Math.floor((n - 1) / 2), n - 1])].filter((i) => i >= 0);

/** Index under the pointer, from the SVG's own coordinate system. */
const indexAt = (e: PointerEvent<SVGSVGElement>, n: number, W: number) => {
  const r = e.currentTarget.getBoundingClientRect();
  const x = ((e.clientX - r.left) / r.width) * W;
  const f = (x - PAD.l) / (W - PAD.l - PAD.r);
  return Math.max(0, Math.min(n - 1, Math.round(f * (n - 1))));
};

/**
 * Lines over a shared x axis (null = not measured: a gap, never a guess), with a crosshair tooltip and a legend.
 */
export function LineChart({
  series,
  xLabel,
  label,
  fmt = short,
}: {
  series: { name: string; values: (number | null)[] }[];
  xLabel: (i: number) => string;
  label: string;
  fmt?: (n: number) => string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const [ref, W] = useWidth();
  const n = Math.max(0, ...series.map((s) => s.values.length));
  const max = nice(Math.max(0, ...series.flatMap((s) => s.values.filter((v): v is number => v !== null))));
  const x = (i: number) => PAD.l + ((W - PAD.l - PAD.r) * i) / Math.max(1, n - 1);
  const y = (v: number) => PAD.t + (H - PAD.t - PAD.b) * (1 - v / max);
  const path = (vals: (number | null)[]) =>
    vals.map((v, i) => (v === null ? "" : `${i && vals[i - 1] !== null ? "L" : "M"}${x(i)},${y(v)}`)).join("");
  return (
    <figure className="space-y-2">
      <div ref={ref} className="relative">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          width={W}
          height={H}
          className="block touch-none"
          role="img"
          aria-label={label}
          onPointerMove={(e) => setHover(indexAt(e, n, W))}
          onPointerLeave={() => setHover(null)}
        >
          <Axis max={max} fmt={fmt} W={W} />
          {ticks(n).map((i) => (
            <text
              key={i}
              x={x(i)}
              y={H - 6}
              textAnchor={n > 1 && i === 0 ? "start" : n > 1 && i === n - 1 ? "end" : "middle"}
              fontSize={11}
              fill="var(--muted)"
            >
              {xLabel(i)}
            </text>
          ))}
          {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={PAD.t} y2={H - PAD.b} stroke="var(--muted)" />}
          {series.map((s, i) => (
            <path
              key={s.name}
              d={path(s.values)}
              fill="none"
              stroke={seriesColor(i)}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          ))}
          {hover !== null &&
            series.map((s, i) =>
              s.values[hover] == null ? null : (
                <circle
                  key={s.name}
                  cx={x(hover)}
                  cy={y(s.values[hover]!)}
                  r={4}
                  fill={seriesColor(i)}
                  stroke="var(--panel)"
                  strokeWidth={2}
                />
              ),
            )}
        </svg>
        {hover !== null && (
          <Tooltip W={W} x={x(hover)}>
            <div className="font-medium">{xLabel(hover)}</div>
            {series.map((s, i) => (
              <div key={s.name} className="flex items-center gap-1.5">
                <span className="size-2 rounded-full" style={{ background: seriesColor(i) }} />
                <span className="max-w-40 truncate">{s.name}</span>
                <span className="ml-auto pl-2 tabular-nums">
                  {s.values[hover] == null ? "—" : fmt(s.values[hover]!)}
                </span>
              </div>
            ))}
          </Tooltip>
        )}
      </div>
      {series.length > 1 && (
        <figcaption className="muted flex flex-wrap gap-x-3 gap-y-1 text-xs">
          {series.map((s, i) => (
            <span key={s.name} className="flex min-w-0 items-center gap-1">
              <span className="h-0.5 w-3 shrink-0 rounded" style={{ background: seriesColor(i) }} />
              <span className="truncate">{s.name}</span>
            </span>
          ))}
        </figcaption>
      )}
    </figure>
  );
}

/** One series of bars from the baseline, with a per-bar tooltip. */
export function BarChart({
  points,
  label,
  fmt = short,
}: {
  points: { label: string; value: number }[];
  label: string;
  fmt?: (n: number) => string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const [ref, W] = useWidth();
  const n = points.length;
  const max = nice(Math.max(0, ...points.map((p) => p.value)));
  const slot = (W - PAD.l - PAD.r) / Math.max(1, n);
  const gap = Math.min(2, slot / 4);
  const bx = (i: number) => PAD.l + slot * i + gap / 2;
  const by = (v: number) => PAD.t + (H - PAD.t - PAD.b) * (1 - v / max);
  return (
    <div ref={ref} className="relative">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width={W}
        height={H}
        className="block touch-none"
        role="img"
        aria-label={label}
        onPointerMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          const i = Math.floor((((e.clientX - r.left) / r.width) * W - PAD.l) / slot);
          setHover(i >= 0 && i < n ? i : null);
        }}
        onPointerLeave={() => setHover(null)}
      >
        <Axis max={max} fmt={fmt} W={W} />
        {n > 0 &&
          ticks(n).map((i) => (
            <text
              key={i}
              x={n > 1 && i === 0 ? bx(i) : n > 1 && i === n - 1 ? bx(i) + slot - gap : bx(i) + slot / 2}
              y={H - 6}
              textAnchor={n > 1 && i === 0 ? "start" : n > 1 && i === n - 1 ? "end" : "middle"}
              fontSize={11}
              fill="var(--muted)"
            >
              {points[i]!.label}
            </text>
          ))}
        {points.map((p, i) => {
          const top = by(p.value);
          const h = H - PAD.b - top;
          const w = Math.max(1, slot - gap);
          const r = Math.min(4, w / 2, h);
          return (
            <path
              key={p.label}
              d={`M${bx(i)},${H - PAD.b}V${top + r}q0,-${r} ${r},-${r}h${w - 2 * r}q${r},0 ${r},${r}V${H - PAD.b}Z`}
              fill="var(--series-1)"
              opacity={hover === null || hover === i ? 1 : 0.55}
            />
          );
        })}
      </svg>
      {hover !== null && points[hover] && (
        <Tooltip W={W} x={bx(hover) + slot / 2}>
          <div className="font-medium">{points[hover]!.label}</div>
          <div className="tabular-nums">{fmt(points[hover]!.value)}</div>
        </Tooltip>
      )}
    </div>
  );
}

/** Shares of a whole as labelled horizontal bars: a split by traffic source, country or device. */
export function ShareBars({
  rows,
  fmt = short,
}: {
  rows: { key: string; value: number }[];
  fmt?: (n: number) => string;
}) {
  const total = rows.reduce((n, r) => n + r.value, 0) || 1;
  return (
    <ul className="space-y-1.5 text-xs">
      {rows.map((r) => (
        <li key={r.key}>
          <div className="flex justify-between gap-2">
            <span className="truncate">{r.key}</span>
            <span className="muted tabular-nums">
              {fmt(r.value)} · {Math.round((r.value / total) * 100)}%
            </span>
          </div>
          <div className="mt-0.5 h-1.5 rounded-full bg-[var(--panel-2)]">
            <div
              className="h-full rounded-full bg-[var(--series-1)]"
              style={{ width: `${(r.value / total) * 100}%` }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

export { short as shortNumber };
