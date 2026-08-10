"use client";

// Botón "Analizar con AI" — dispara el orchestrator para un doctor
// (POST /api/ai/analyze) y refresca el server component al terminar.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";

export function AnalyzeButton({ doctorId }: { doctorId: string }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function analyze() {
    setLoading(true);
    try {
      const res = await fetch("/api/ai/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ doctorId }),
      });
      const json = (await res.json().catch(() => null)) as {
        error?: string;
      } | null;
      if (!res.ok) {
        toast.error(
          json?.error ??
            (res.status === 503
              ? "Falta configurar la API key de Anthropic (ANTHROPIC_API_KEY) en el servidor."
              : "No se pudo completar el análisis. Probá de nuevo.")
        );
        return;
      }
      toast.success("Análisis completado");
      router.refresh();
    } catch {
      toast.error("No se pudo conectar con el servidor.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Button size="sm" variant="outline" onClick={analyze} disabled={loading}>
      {loading ? (
        <>
          <Loader2 data-icon="inline-start" className="animate-spin" />
          Los agentes están analizando…
        </>
      ) : (
        <>
          <Sparkles data-icon="inline-start" />
          Analizar con AI
        </>
      )}
    </Button>
  );
}
