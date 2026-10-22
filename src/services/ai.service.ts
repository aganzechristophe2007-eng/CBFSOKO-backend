const BASE = "https://generativelanguage.googleapis.com/v1beta";
const KEY = (process.env.GEMINI_API_KEY ?? "").trim();

// Liste blanche des modeles (separes par des virgules), ex: GEMINI_MODEL=gemini-2.5-flash
const ALLOWED = (process.env.GEMINI_MODEL ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

export const SYSTEM_PROMPT =
  "Tu es A30 IA, l'assistante de CBFSOKO, une marketplace de Bukavu (RDC). " +
  "Reponds en francais, sauf si l'utilisateur ecrit dans une autre langue. " +
  "Sois claire et concise. Ne demande jamais de mot de passe, de code de verification ni de numero de carte.";

let cache: { at: number; list: string[] } | null = null;

// Modeles reellement disponibles chez Google, limites a la liste blanche.
export async function listModels(): Promise<string[]> {
  if (cache && Date.now() - cache.at < 10 * 60 * 1000) return cache.list;
  try {
    const r = await fetch(`${BASE}/models?pageSize=200`, {
      headers: { "x-goog-api-key": KEY },
      signal: AbortSignal.timeout(8000),
    });
    if (r.ok) {
      const j: any = await r.json();
      const remote = new Set<string>(
        (j.models ?? [])
          .filter((m: any) => (m.supportedGenerationMethods ?? []).includes("generateContent"))
          .map((m: any) => String(m.name).replace(/^models\//, ""))
      );
      const list = ALLOWED.filter((m) => remote.has(m));
      if (list.length) {
        cache = { at: Date.now(), list };
        return list;
      }
      console.warn("[AI] Aucun modele de GEMINI_MODEL trouve chez Google.", {
        allowed: ALLOWED,
        exemples: [...remote].filter((m) => m.startsWith("gemini")).slice(0, 20),
      });
    } else {
      console.warn("[AI] /models a repondu", r.status, (await r.text().catch(() => "")).slice(0, 200));
    }
  } catch (err: any) {
    console.warn("[AI] /models inaccessible:", err?.message);
  }
  return ALLOWED;
}

export async function chat(
  model: string,
  messages: { role: string; content: string }[]
): Promise<string> {
  if (!KEY) throw new Error("GEMINI_API_KEY manquante (variable d'environnement non definie)");

  // Gemini separe le prompt systeme des messages, et nomme le role "model" (pas "assistant")
  const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
  const contents = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));

  const r = await fetch(`${BASE}/models/${encodeURIComponent(model)}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": KEY },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents,
      // Les tokens de reflexion comptent dans cette limite : on laisse de la marge
      generationConfig: { maxOutputTokens: 2048 },
    }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!r.ok) {
    const detail = await r.text().catch(() => "");
    throw new Error(`AI_UPSTREAM_${r.status}: ${detail.slice(0, 300)}`);
  }

  const j: any = await r.json();

  if (j.promptFeedback?.blockReason) {
    throw new Error(`AI_BLOCKED: ${j.promptFeedback.blockReason}`);
  }

  const cand = j.candidates?.[0];
  const text = (cand?.content?.parts ?? [])
    .map((p: any) => (typeof p.text === "string" ? p.text : ""))
    .join("")
    .trim();

  if (!text) throw new Error(`AI_EMPTY (finishReason: ${cand?.finishReason ?? "inconnu"})`);
  return text.slice(0, 8000);
}