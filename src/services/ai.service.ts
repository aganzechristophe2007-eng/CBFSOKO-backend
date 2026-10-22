const BASE = (process.env.AI_BASE_URL ?? "https://agentrouter.org/v1").replace(/\/$/, "");
const KEY = process.env.AI_API_KEY ?? "";

// Liste blanche des modeles autorises (variable d'environnement, separes par des virgules)
const ALLOWED = (process.env.AI_MODELS ?? "claude-opus-5,claude-opus-4-8")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

export const SYSTEM_PROMPT =
  "Tu es A30 IA, l'assistante de CBFSOKO, une marketplace de Bukavu (RDC). " +
  "Reponds en francais, sauf si l'utilisateur ecrit dans une autre langue. " +
  "Sois claire et concise. Ne demande jamais de mot de passe, de code de verification ni de numero de carte.";

let cache: { at: number; list: string[] } | null = null;

// Modeles reellement disponibles chez le fournisseur, limites a la liste blanche.
export async function listModels(): Promise<string[]> {
  if (cache && Date.now() - cache.at < 10 * 60 * 1000) return cache.list;
  try {
    const r = await fetch(`${BASE}/models`, {
      headers: { Authorization: `Bearer ${KEY}` },
      signal: AbortSignal.timeout(8000),
    });
    if (r.ok) {
      const j: any = await r.json();
      const remote = new Set<string>((j.data ?? []).map((m: any) => m.id));
      const list = ALLOWED.filter((m) => remote.has(m));
      if (list.length) {
        cache = { at: Date.now(), list };
        return list;
      }
    }
  } catch {
    // on retombe sur la liste blanche
  }
  return ALLOWED;
}

export async function chat(
  model: string,
  messages: { role: string; content: string }[]
): Promise<string> {
  const r = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model, messages, max_tokens: 1000 }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!r.ok) throw new Error(`AI_UPSTREAM_${r.status}`);
  const j: any = await r.json();
  const text = j.choices?.[0]?.message?.content;
  if (typeof text !== "string" || !text.trim()) throw new Error("AI_EMPTY");
  return text.slice(0, 8000);
}
