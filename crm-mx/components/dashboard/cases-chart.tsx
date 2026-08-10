"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

export interface MonthPoint {
  key: string; // "2026-08"
  label: string; // "ago 26"
  count: number;
}

/**
 * Casos nuevos por mes (12 meses). Una sola serie → sin leyenda; el título
 * de la card nombra la serie. Azul validado en ambos modos (dataviz skill).
 */
export function CasesChart({
  data,
  goal,
}: {
  data: MonthPoint[];
  goal: number | null;
}) {
  return (
    <div className="h-64 w-full [--chart-series:#2a5bd7] dark:[--chart-series:#7da2f7]">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 12, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid
            vertical={false}
            stroke="var(--border)"
            strokeWidth={1}
          />
          <XAxis
            dataKey="label"
            tickLine={false}
            axisLine={{ stroke: "var(--border)" }}
            tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
            interval={0}
          />
          <YAxis
            allowDecimals={false}
            tickLine={false}
            axisLine={false}
            tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
            width={32}
          />
          <Tooltip
            cursor={{ fill: "var(--muted)", opacity: 0.6 }}
            content={<ChartTip />}
            isAnimationActive={false}
          />
          {goal != null ? (
            <ReferenceLine
              y={goal}
              stroke="var(--muted-foreground)"
              strokeDasharray="4 4"
              strokeWidth={1}
              label={{
                value: `Objetivo ${goal}`,
                position: "insideTopRight",
                fill: "var(--muted-foreground)",
                fontSize: 11,
              }}
            />
          ) : null}
          <Bar
            dataKey="count"
            fill="var(--chart-series)"
            maxBarSize={24}
            radius={[4, 4, 0, 0]}
            isAnimationActive={false}
          />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function ChartTip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: { value?: number | string }[];
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  const value = payload[0]?.value ?? 0;
  return (
    <div className="rounded-lg border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-md">
      <span className="text-muted-foreground">{label}</span>{" "}
      <span className="font-medium tabular-nums">
        {value} {value === 1 ? "caso" : "casos"}
      </span>
    </div>
  );
}
