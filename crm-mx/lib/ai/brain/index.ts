// KeepSmilingCommercialBrain — fuente central versionada de contexto comercial.
// NO copiar el brain entero en cada prompt: cada agente pide solo sus secciones.
// Contenido: lib/ai/brain/sections.ts.
//
// Precedencia del contenido (jerarquía de fuentes, Fase 2):
//   decisión del dueño/país > configuración vigente en el CRM > material oficial
//   > datos observados > inferencia de la IA (siempre marcada como inferencia).
//
// Ningún número comercial (precio, descuento, campaña) vive en el Brain: sale de
// commercial_offers vía getActiveCommercialOffers.

import { SECTIONS } from "./sections";

/**
 * Versión del Brain. Se persiste en cada recomendación y corrida (ai_recommendations
 * / agent_runs) para poder comparar después con qué doctrina se generó cada cosa.
 *
 * 2026.08   — Fase 1: 13 secciones extraídas del cuestionario comercial.
 * 2026.08.2 — Fase 2 (Commercial Brain V1): 24 secciones, jerarquía de fuentes
 *             explícita, cultura mexicana y registro de comunicación como núcleo,
 *             equipo clínico como activo comercial, memoria basada en evidencia,
 *             ruteo por cuello de botella y cero números comerciales en el texto.
 */
export const BRAIN_VERSION = "2026.08.2";

export type BrainSectionKey =
  // núcleo — lo lleva todo agente
  | "identity"
  | "brand_values"
  | "doctor_value"
  | "commercial_philosophy"
  | "mexico_culture"
  | "communication"
  | "guardrails"
  | "pending_definitions"
  // journey
  | "accreditation"
  | "activation"
  | "growth"
  | "retention"
  // clínica y servicio
  | "clinical"
  | "clinical_owner"
  | "service"
  // oferta
  | "pricing"
  | "products"
  | "competition"
  // sistema
  | "memory"
  | "routing"
  | "lifecycle"
  | "programs"
  | "escalation"
  | "management";

/** Orden canónico de render. Estable a propósito: el bloque del Brain se cachea
 *  en la API y cualquier reordenamiento invalidaría el cache. */
export const ALL_SECTION_KEYS: BrainSectionKey[] = [
  "identity",
  "brand_values",
  "doctor_value",
  "commercial_philosophy",
  "mexico_culture",
  "communication",
  "lifecycle",
  "accreditation",
  "activation",
  "growth",
  "retention",
  "clinical",
  "clinical_owner",
  "service",
  "pricing",
  "products",
  "competition",
  "programs",
  "memory",
  "routing",
  "escalation",
  "management",
  "guardrails",
  "pending_definitions",
];

/**
 * Secciones que TODO agente lleva siempre. Son las que impiden que un agente se
 * comporte como un agente genérico de SaaS B2B: quién es KeepSmiling, qué compra
 * realmente el doctor, cómo se piensa comercialmente, cómo se habla en México,
 * qué está prohibido y qué todavía no está definido.
 */
export const CORE_SECTION_KEYS: BrainSectionKey[] = [
  "identity",
  "brand_values",
  "doctor_value",
  "commercial_philosophy",
  "mexico_culture",
  "communication",
  "guardrails",
  "pending_definitions",
];

export function getBrainSections(keys: BrainSectionKey[]): string {
  const uniq = new Set<BrainSectionKey>([...CORE_SECTION_KEYS, ...keys]);
  // orden estable (por ALL_SECTION_KEYS) para no invalidar el prompt cache
  return ALL_SECTION_KEYS.filter((k) => uniq.has(k))
    .map((k) => SECTIONS[k])
    .join("\n\n");
}
