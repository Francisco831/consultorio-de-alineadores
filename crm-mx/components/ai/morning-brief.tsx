"use client";

// AI Morning Brief (/hoy) — muestra el último brief persistido (GET) y permite
// generar uno nuevo on-demand (POST). El brief lo emite el commercial_director
// con sus tools de agregación; acá solo se muestra, nunca se ejecuta nada.

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Toaster } from "@/components/ui/sonner";
import { Loader2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { AgentBadge } from "@/components/ai/agent-badge";
import { formatDate } from "@/lib/format";
import type { DirectorBrief } from "@/lib/ai/types";

function briefTime(iso: string | null): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return new Date(t).toLocaleTimeString("es-MX", {
    timeZone: "America/Mexico_City",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function MorningBrief() {
  const [brief, setBrief] = useState<DirectorBrief | null>(null);
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);
  const [initialLoading, setInitialLoading] = useState(true);
  const [generating, setGenerating] = useState(false);

  // al montar: traer el último brief persistido (si hay)
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/ai/brief");
        if (!res.ok) return;
        const json = (await res.json().catch(() => null)) as {
          brief?: DirectorBrief;
          answer?: string;
          created_at?: string;
          generated_at?: string;
        } | null;
        if (cancelled || !json) return;
        const b = json.brief ?? (json.answer ? (json as unknown as DirectorBrief) : null);
        if (b) {
          setBrief(b);
          setGeneratedAt(json.created_at ?? json.generated_at ?? null);
        }
      } catch {
        // sin brief previo — el empty state alcanza
      } finally {
        if (!cancelled) setInitialLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function generate() {
    setGenerating(true);
    try {
      const res = await fetch("/api/ai/brief", { method: "POST" });
      const json = (await res.json().catch(() => null)) as {
        brief?: DirectorBrief;
        error?: string;
      } | null;
      if (!res.ok || !json?.brief) {
        toast.error(
          json?.error ??
            (res.status === 503
              ? "Falta configurar la API key de Anthropic (ANTHROPIC_API_KEY) en el servidor."
              : "No se pudo generar el brief. Probá de nuevo.")
        );
        return;
      }
      setBrief(json.brief);
      setGeneratedAt(new Date().toISOString());
      toast.success("Brief listo");
    } catch {
      toast.error("No se pudo conectar con el servidor.");
    } finally {
      setGenerating(false);
    }
  }

  const hora = briefTime(generatedAt);

  return (
    <Card size="sm">
      <Toaster position="bottom-right" />
      <CardHeader>
        <CardTitle className="flex items-center gap-1.5">
          <Sparkles className="size-4" />
          AI Morning Brief
        </CardTitle>
        <CardDescription>
          El director comercial AI resume el día: meta, riesgos y dónde empujar.
        </CardDescription>
        <CardAction>
          <Button
            size="sm"
            variant="outline"
            onClick={generate}
            disabled={generating || initialLoading}
          >
            {generating ? (
              <>
                <Loader2 data-icon="inline-start" className="animate-spin" />
                Generando…
              </>
            ) : brief ? (
              "Regenerar brief"
            ) : (
              "Generar brief"
            )}
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-3">
        {generating ? (
          <p className="text-sm text-muted-foreground">
            El director comercial AI está preparando el brief…
          </p>
        ) : null}

        {initialLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        ) : brief ? (
          <>
            <p className="whitespace-pre-wrap text-sm">{brief.answer}</p>

            {brief.findings.length > 0 ? (
              <div className="space-y-2">
                {brief.findings.map((f, i) => (
                  <div key={i} className="rounded-lg border p-3">
                    <p className="text-sm font-medium">{f.title}</p>
                    <p className="mt-0.5 text-sm text-muted-foreground">
                      {f.detail}
                    </p>
                    {f.evidence.length > 0 ? (
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {f.evidence.map((e, j) => (
                          <span
                            key={j}
                            className="inline-flex items-center gap-1 rounded-md border bg-muted/40 px-1.5 py-0.5 text-[11px]"
                          >
                            <span className="font-medium text-muted-foreground">
                              {e.field}:
                            </span>
                            <span className="tabular-nums">{e.value}</span>
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : null}

            {brief.recommendations.length > 0 ? (
              <ul className="space-y-1.5">
                {brief.recommendations.map((r, i) => (
                  <li key={i} className="flex items-start gap-2 text-sm">
                    <AgentBadge agent={r.agent} className="mt-0.5 shrink-0" />
                    <span>
                      {r.recommended_action}
                      {r.objective ? (
                        <span className="text-muted-foreground">
                          {" "}
                          — {r.objective}
                        </span>
                      ) : null}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}

            <p className="text-[11px] text-muted-foreground">
              {hora ? `Generado a las ${hora}` : null}
              {hora && brief.data_as_of ? " · " : null}
              {brief.data_as_of ? `datos al ${formatDate(brief.data_as_of)}` : null}
            </p>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            Todavía no hay brief generado. Generalo para arrancar el día con
            foco.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
