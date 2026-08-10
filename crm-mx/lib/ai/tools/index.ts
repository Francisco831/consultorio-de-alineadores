// Registry de tools AI con allowlist por agente (docs/AI_ARCHITECTURE.md §2 y §5).
// Los agentes NUNCA reciben SQL ni escritura directa: solo estas tools tipadas.

import type { AgentKey, AiToolDef } from "@/lib/ai/types";
import { READ_TOOLS } from "./read";
import { DRAFT_TOOLS } from "./drafts";
import { OFFER_TOOLS } from "./offers";
import { VIABILITY_TOOLS } from "./viability";

export const ALL_TOOLS: AiToolDef[] = [
  ...READ_TOOLS,
  ...DRAFT_TOOLS,
  ...OFFER_TOOLS,
  ...VIABILITY_TOOLS,
];

// Set común: todo agente puede leer el 360 de un doctor y armar borradores.
const COMMON_TOOL_NAMES = [
  "getDoctor360",
  "getDoctorTimeline",
  "getDoctorCases",
  "getDoctorOpportunities",
  "getDoctorTasks",
  "searchDoctors",
  "createTaskDraft",
  "createMessageDraft",
  "createActivityDraft",
  "proposeDoctorUpdate",
  // Antes de mencionar CUALQUIER incentivo hay que consultar la oferta vigente:
  // los porcentajes salen de commercial_offers, nunca del prompt.
  "getActiveCommercialOffers",
];

// Tools distintivas por agente (tabla del §2).
const DISTINCTIVE_TOOL_NAMES: Record<AgentKey, string[]> = {
  // el orchestrator rutea determinísticamente y sintetiza: no necesita tools extra
  orchestrator: [],
  acquisition: ["getProspects"],
  accreditation: ["getAccreditationHistory", "getProspects"],
  activation: ["getAccreditedNotActivated", "getViabilityStatus"],
  clinical_education: [
    "getClinicalInteractions",
    "getTrainingHistory",
    "getViabilityStatus",
    "requestViabilityDraft",
  ],
  growth: ["getCasesByPeriod", "getViabilityStatus"],
  retention_reactivation: ["getAtRiskDoctors", "getDormantDoctors"],
  doctor_success: ["getServiceIssues"],
  // el director responde al manager: todas las de agregación
  commercial_director: [
    "getPipeline",
    "getForecast",
    "getGoals",
    "getSalesRepPerformance",
    "getAtRiskDoctors",
    "getDormantDoctors",
    "getAccreditedNotActivated",
    "getProspects",
    "getCasesByPeriod",
    "getDoctorSegments",
    "getServiceIssues",
    "getViabilityStatus",
  ],
};

export function getToolsForAgent(agent: AgentKey): AiToolDef[] {
  const allowed = new Set([...COMMON_TOOL_NAMES, ...DISTINCTIVE_TOOL_NAMES[agent]]);
  return ALL_TOOLS.filter((t) => allowed.has(t.name));
}
