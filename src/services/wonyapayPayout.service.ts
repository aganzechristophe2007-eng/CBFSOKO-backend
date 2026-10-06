// ==========================================
// RETRAIT WONYAPAY (portefeuille -> Mobile Money)
//
// Ce fichier est volontairement le SEUL endroit à compléter. Je n'ai pas la documentation de l'API de
// décaissement de WonyaPay ni ton fichier Wonyapay.service.ts : plutôt que d'inventer une adresse ou des champs,
// les deux fonctions ci-dessous définissent le contrat que le reste du code attend.
//
// Tant que IMPLEMENTED vaut false, toute demande de retrait est refusée AVANT tout débit (503) :
// aucun argent ne peut être retenu par erreur.
//
// Pour l'activer :
//   1. Remplis initiatePayout() et getPayoutStatus() en suivant la doc WonyaPay (même style que initiateC2B
//      et getTransactionStatus dans Wonyapay.service.ts : mêmes en-têtes, même jeton, même gestion des délais).
//   2. Passe IMPLEMENTED à true.
//   3. Ajoute WONYAPAY_PAYOUT_ENABLED=true dans le .env du serveur.
// ==========================================

const IMPLEMENTED = false;

export const isPayoutConfigured = (): boolean => IMPLEMENTED && process.env.WONYAPAY_PAYOUT_ENABLED === 'true';

// definitive = true  : WonyaPay a clairement refusé, rien n'est parti -> l'argent est rendu tout de suite.
// definitive = false : résultat incertain (délai dépassé, erreur 500...) -> le retrait reste « en attente »
//                      et la vérification auprès de WonyaPay tranchera. Ne JAMAIS marquer definitive = true
//                      sur un doute : cela pourrait payer l'utilisateur deux fois.
export class PayoutError extends Error {
  constructor(
    message: string,
    public readonly kind: 'auth' | 'config' | 'invalid' | 'network' | 'server',
    public readonly definitive: boolean
  ) {
    super(message);
    this.name = 'PayoutError';
  }
}

export interface PayoutRequest {
  refTransa: string; // référence unique de cette tentative (même format que pour les encaissements)
  amount: number;
  currency: 'CDF' | 'USD';
  phone: string; // numéro normalisé à 10 chiffres
  motif: string;
}

export interface PayoutResult {
  providerTransactionId: string | null;
  network: string | null;
}

export interface PayoutStatus {
  found: boolean; // false si WonyaPay ne connaît pas cette référence
  state: 'SUCCESS' | 'FAILED' | 'PENDING';
  amount: number | null;
  devise: string | null;
  transactionId: string | null;
}

export async function initiatePayout(_req: PayoutRequest): Promise<PayoutResult> {
  throw new PayoutError('Retrait WonyaPay non implémenté.', 'config', true);
}

export async function getPayoutStatus(_refTransa: string): Promise<PayoutStatus> {
  throw new PayoutError('Retrait WonyaPay non implémenté.', 'config', true);
}