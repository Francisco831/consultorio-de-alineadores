"use client";

// Ask Your CRM (dashboard) — el Country Manager le pregunta al director
// comercial AI en lenguaje natural (POST /api/ai/ask). Historial solo en
// memoria local (V1, sin persistencia).

import { useState } from "react";
import { Loader2, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { AgentBadge } from "@/components/ai/agent-badge";
import { formatDate } from "@/lib/format";
import type { DirectorBrief } from "@/lib/ai/types";

const EXAMPLES = [
  "¿Cómo venimos vs la meta del mes?",
  "¿Qué doctores están en riesgo y por qué?",
  "¿Quiénes se acreditaron y no activaron?",
];

interface AskEntry {
  question: string;
  brief: DirectorBrief;
}

export function AskCrm() {
  const [question, setQuestion] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<AskEntry[]>([]);

  async function ask(q: string) {
    const trimmed = q.trim();
    if (!trimmed || loading) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/ai/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: trimmed }),
      });
      const json = (await res.json().catch(() => null)) as
        | (DirectorBrief & { error?: string })
        | null;
      if (!res.ok || !json || typeof json.answer !== "string") {
        setError(
          json?.error ??
            (res.status === 503
              ? "Falta configurar la API key de Anthropic (ANTHROPIC_API_KEY) en el servidor."
              : "No se pudo responder la pregunta. Probá de nuevo.")
        );
        return;
      }
      setHistory((prev) => [{ question: trimmed, brief: json }, ...prev]);
      setQuestion("");
    } catch {
      setError("No se pudo conectar con el servidor.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>Ask Your CRM</CardTitle>
        <CardDescription>
          Preguntale al director comercial AI — responde con datos del CRM y
          cita la evidencia.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            ask(question);
          }}
          className="space-y-2"
        >
          <Textarea
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="¿Qué doctores necesitan atención hoy?"
            rows={2}
            disabled={loading}
          />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap gap-1.5">
              {EXAMPLES.map((ex) => (
                <Button
                  key={ex}
                  type="button"
                  size="xs"
                  variant="outline"
                  onClick={() => setQuestion(ex)}
                  disabled={loading}
                >
                  {ex}
                </Button>
              ))}
            </div>
            <Button type="submit" size="sm" disabled={loading || !question.trim()}>
              {loading ? (
                <>
                  <Loader2 data-icon="inline-start" className="animate-spin" />
                  Consultando…
                </>
              ) : (
                <>
                  <Send data-icon="inline-start" />
                  Preguntar
                </>
              )}
            </Button>
          </div>
        </form>

        {loading ? (
          <p className="text-sm text-muted-foreground">
            El director comercial AI está buscando en los datos del CRM…
          </p>
        ) : null}
        {error ? <p className="text-sm text-destructive">{error}</p> : null}

        {history.map((entry, i) => (
          <div key={history.length - i} className="space-y-2 border-t pt-3">
            <p className="text-sm font-medium">{entry.question}</p>
            <p className="whitespace-pre-wrap text-sm">{entry.brief.answer}</p>

            {entry.brief.findings.length > 0 ? (
              <div className="space-y-2">
                {entry.brief.findings.map((f, j) => (
                  <div key={j} className="rounded-lg border p-3">
                    <p className="text-sm font-medium">{f.title}</p>
                    <p className="mt-0.5 text-sm text-muted-foreground">
                      {f.detail}
                    </p>
                    {f.evidence.length > 0 ? (
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {f.evidence.map((e, k) => (
                          <span
                            key={k}
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

            {entry.brief.recommendations.length > 0 ? (
              <ul className="space-y-1.5">
                {entry.brief.recommendations.map((r, j) => (
                  <li key={j} className="flex items-start gap-2 text-sm">
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

            {entry.brief.data_as_of ? (
              <p className="text-[11px] text-muted-foreground">
                Datos al {formatDate(entry.brief.data_as_of)}
              </p>
            ) : null}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
