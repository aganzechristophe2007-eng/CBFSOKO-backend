import crypto from 'crypto';

// ==========================================
// Client WonyaPay (collecte Mobile Money C2B)
// Documentation : https://app-api.wonyasoft.com — POST /payment, GET /transaction-status/status/:refTransa
//
// Règles de sécurité appliquées ici :
//  - le token n'existe que côté serveur (variables d'environnement), jamais dans le frontend ni dans les logs ;
//  - aucune redirection suivie (le token ne peut pas fuiter vers une autre adresse) ;
//  - délai maximum sur chaque appel ;
//  - RefTransa générée avec un générateur cryptographique, jamais fournie par le client.
// ==========================================

const REF_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const REQUEST_TIMEOUT_MS = 20_000;
const REF_TRANSA_PATTERN = /^[A-Z0-9]{20}$/;
const IS_PRODUCTION = process.env.NODE_ENV === 'production' || !!process.env.RENDER;

export type WonyaPayErrorKind = 'config' | 'auth' | 'invalid' | 'duplicate' | 'unavailable';

export class WonyaPayError extends Error {
  constructor(
    public readonly kind: WonyaPayErrorKind,
    message: string,
    public readonly httpStatus?: number,
    // true = WonyaPay a clairement refusé / n'a rien traité ; false = résultat incertain (délai, erreur 500...)
    public readonly definitive = false
  ) {
    super(message);
    this.name = 'WonyaPayError';
  }
}

// Lues à chaque appel (et non au chargement) pour que les changements de configuration soient pris en compte.
// Nettoie une valeur copiée à la main : espaces, retours à la ligne et guillemets en trop.
const cleanEnv = (v: string | undefined): string => (v ?? '').trim().replace(/^["']+|["']+$/g, '').trim();

const settings = () => ({
  baseUrl: cleanEnv(process.env.WONYAPAY_BASE_URL || 'https://app-api.wonyasoft.com').replace(/\/+$/, ''),
  // Si le préfixe « Bearer » a été collé avec le token, on le retire : il est ajouté par le code.
  token: cleanEnv(process.env.WONYAPAY_TOKEN).replace(/^Bearer\s+/i, ''),
  partnerId: cleanEnv(process.env.WONYAPAY_PARTNER_ID),
  callbackSecret: cleanEnv(process.env.WONYAPAY_CALLBACK_SECRET),
  publicApiUrl: cleanEnv(process.env.PUBLIC_API_URL).replace(/\/+$/, ''),
});

export function isWonyaPayConfigured(): boolean {
  const s = settings();
  if (!s.token || !s.partnerId || s.callbackSecret.length < 24 || !s.publicApiUrl) return false;
  // WonyaPay exige une URL de callback sécurisée : en production, HTTPS obligatoire.
  if (IS_PRODUCTION && !s.publicApiUrl.startsWith('https://')) return false;
  return true;
}

// L'adresse de callback contient un secret : WonyaPay ne signe pas ses callbacks, ce secret empêche
// n'importe qui de deviner l'adresse (et la vérification du statut côté serveur fait le reste).
export function buildCallbackUrl(): string {
  const s = settings();
  return `${s.publicApiUrl}/api/payments/callback/wonyapay/${s.callbackSecret}`;
}

export function isValidCallbackSecret(candidate: string): boolean {
  const expected = settings().callbackSecret;
  if (expected.length < 24) return false;
  // Comparaison en temps constant, sur des empreintes de même longueur.
  const a = crypto.createHash('sha256').update(candidate).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

// 20 caractères alphanumériques majuscules, tirés avec un générateur cryptographique.
export function generateRefTransa(): string {
  let ref = '';
  for (let i = 0; i < 20; i++) ref += REF_ALPHABET[crypto.randomInt(REF_ALPHABET.length)];
  return ref;
}

// WonyaPay attend 10 chiffres (ex. 0997654321). Accepte aussi +243997654321, 243997654321 et 997654321.
export function normalizeMobileNumber(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  let v = input.replace(/[\s().-]/g, '');
  if (v.startsWith('+')) v = v.slice(1);
  if (v.startsWith('00243')) v = v.slice(2);
  if (!/^\d+$/.test(v)) return null;
  if (/^243\d{9}$/.test(v)) v = `0${v.slice(3)}`;
  else if (/^\d{9}$/.test(v)) v = `0${v}`;
  return /^0\d{9}$/.test(v) ? v : null;
}

export const maskMobileNumber = (phone: string): string => `${phone.slice(0, 3)}*****${phone.slice(-2)}`;

const toNumber = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
};

async function wonyaRequest(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const s = settings();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${s.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${s.token}`,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
      redirect: 'error',
    });
    let json: any = null;
    try {
      json = await res.json();
    } catch {
      // réponse sans JSON
    }
    return { status: res.status, json };
  } catch (err: any) {
    throw new WonyaPayError('unavailable', err?.name === 'AbortError' ? 'Délai dépassé' : 'Réseau indisponible');
  } finally {
    clearTimeout(timer);
  }
}

// Codes d'erreur documentés : 400 données invalides / réseau non disponible, 401 token invalide,
// 404 caisse introuvable, 409 RefTransa en doublon, 422 règle métier, 500 erreur serveur, 503 indisponible.
function mapHttpError(status: number, json: any): WonyaPayError {
  const detail = typeof json?.message === 'string' ? json.message.slice(0, 200) : `HTTP ${status}`;
  if (status === 401) {
    // Aide au diagnostic sans jamais écrire le token : seule sa longueur est indiquée.
    console.error(`[WonyaPay] 401 reçu — longueur du token configuré : ${settings().token.length} caractères.`);
    return new WonyaPayError('auth', `Token WonyaPay invalide : ${detail}`, status, true);
  }
  if (status === 404) return new WonyaPayError('config', `Caisse WonyaPay introuvable : ${detail}`, status, true);
  if (status === 409) return new WonyaPayError('duplicate', `RefTransa déjà utilisée : ${detail}`, status, false);
  if (status === 400 || status === 422) return new WonyaPayError('invalid', detail, status, true);
  if (status === 503) return new WonyaPayError('unavailable', 'Service WonyaPay indisponible', status, true);
  return new WonyaPayError('unavailable', detail, status, false);
}

export interface InitiateResult {
  providerTransactionId: string | null;
  feeAmount: number | null;
  totalCharged: number | null;
  network: string | null;
}

// Initie une collecte (C2B) : l'acheteur reçoit une demande de confirmation sur son téléphone.
export async function initiateC2B(p: {
  refTransa: string;
  amount: number;
  currency: 'CDF' | 'USD';
  phone: string;
  motif: string;
  callbackUrl: string;
  // Champs personnalisés renvoyés tels quels dans le callback (ex. paymentId, orderId).
  extra: Record<string, string>;
}): Promise<InitiateResult> {
  const s = settings();
  if (!REF_TRANSA_PATTERN.test(p.refTransa)) throw new WonyaPayError('invalid', 'RefTransa invalide', undefined, true);

  const body = {
    ...p.extra, // d'abord, pour qu'un champ personnalisé ne puisse jamais écraser un champ réservé
    RefPartenaire: s.partnerId,
    RefTransa: p.refTransa,
    Montant: p.amount,
    Devise: p.currency,
    Action: 'C2B',
    MobileMoney: p.phone,
    Motif: p.motif.slice(0, 120),
    CallbackUrl: p.callbackUrl,
  };

  const { status, json } = await wonyaRequest('POST', '/payment', body);
  if (status >= 200 && status < 300 && json?.success === true) {
    const d = json.data ?? {};
    return {
      providerTransactionId: typeof d.transactionId === 'string' ? d.transactionId.slice(0, 80) : null,
      feeAmount: toNumber(d.frais),
      totalCharged: toNumber(d.montantTotal),
      network: typeof d.network === 'string' ? d.network.slice(0, 40) : null,
    };
  }
  if (status >= 200 && status < 300) {
    // Réponse 2xx mais success différent de true : WonyaPay a refusé la demande.
    throw new WonyaPayError('invalid', typeof json?.message === 'string' ? json.message.slice(0, 200) : 'Demande refusée', status, true);
  }
  throw mapHttpError(status, json);
}

export interface ProviderStatus {
  found: boolean;
  rawStatus: string;
  refTransa: string | null;
  transactionId: string | null;
  amount: number | null;
  devise: string | null;
}

// Interroge WonyaPay sur l'état réel d'une transaction. C'est CETTE réponse, obtenue avec notre token,
// qui fait foi : le contenu d'un callback n'est jamais cru tel quel.
export async function getTransactionStatus(refTransa: string): Promise<ProviderStatus> {
  if (!REF_TRANSA_PATTERN.test(refTransa)) throw new WonyaPayError('invalid', 'RefTransa invalide', undefined, true);

  const { status, json } = await wonyaRequest('GET', `/transaction-status/status/${refTransa}`);
  if (status === 404) {
    return { found: false, rawStatus: '', refTransa: null, transactionId: null, amount: null, devise: null };
  }
  if (status >= 200 && status < 300 && json?.success === true && json.data && typeof json.data === 'object') {
    const d = json.data;
    return {
      found: true,
      rawStatus: String(d.status ?? '').trim().toLowerCase(),
      refTransa: typeof d.refTransa === 'string' ? d.refTransa : null,
      transactionId: typeof d.transactionId === 'string' ? d.transactionId : null,
      amount: toNumber(d.amount),
      devise: typeof d.devise === 'string' ? d.devise.toUpperCase() : null,
    };
  }
  throw mapHttpError(status, json);
}

// Seul « completed » (et ses équivalents de succès) valide un paiement. Toute valeur inconnue reste
// « en attente » : on ne valide jamais dans le doute.
const SUCCESS_STATUSES = new Set(['completed', 'success', 'succes', 'successful']);
const FAILURE_STATUSES = new Set(['failed', 'failure', 'echec', 'error', 'cancelled', 'canceled', 'rejected', 'refused', 'declined', 'expired', 'timeout']);

export function mapProviderStatus(raw: string): 'SUCCESS' | 'FAILED' | 'PENDING' {
  const v = raw.trim().toLowerCase();
  if (SUCCESS_STATUSES.has(v)) return 'SUCCESS';
  if (FAILURE_STATUSES.has(v)) return 'FAILED';
  return 'PENDING';
}


// ==========================================================================
// DIAGNOSTIC (réservé aux administrateurs) : teste comment WonyaPay accepte le token.
// Envoie un corps VIDE à POST /payment : aucune transaction ne peut être créée, seule
// l'authentification est vérifiée (401 = token refusé ; 400/422 = token accepté).
// Ne renvoie que des codes HTTP et un court message, jamais le token.
// ==========================================================================
export async function probeAuthVariants(): Promise<Record<string, { status: number | string; message: string }>> {
  const s = settings();
  const variants: Record<string, Record<string, string>> = {
    'sans_token (référence)': {},
    'Authorization: Bearer <token>': { Authorization: `Bearer ${s.token}` },
    'Authorization: <token>': { Authorization: s.token },
    'x-api-key: <token>': { 'x-api-key': s.token },
  };
  const out: Record<string, { status: number | string; message: string }> = {};
  for (const [name, extra] of Object.entries(variants)) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const res = await fetch(`${s.baseUrl}/payment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...extra },
        body: '{}',
        signal: controller.signal,
        redirect: 'error',
      });
      let message = '';
      try {
        const j: any = await res.json();
        message = typeof j?.message === 'string' ? j.message.slice(0, 120) : '';
      } catch {
        // pas de JSON
      }
      out[name] = { status: res.status, message };
    } catch (err: any) {
      out[name] = { status: 'erreur réseau', message: err?.name === 'AbortError' ? 'Délai dépassé' : 'Injoignable' };
    } finally {
      clearTimeout(timer);
    }
  }
  return out;
}