export type PaymentProvider = "AIRTEL_MONEY" | "ORANGE_MONEY" | "MPESA";

export interface PaymentRequest {
  provider: PaymentProvider;
  phoneNumber: string;
  amount: number;
  orderId: string;
}

export interface PaymentResult {
  success: boolean;
  status: "PENDING" | "SUCCESS" | "FAILED";
  reference?: string;
  message: string;
}

/**
 * Adaptateur volontairement séparé du reste de l'application.
 * Les appels réels doivent être implémentés avec les API/contrats
 * officiels disponibles pour le pays et l'opérateur sélectionnés.
 */
export async function initiateMobileMoneyPayment(input: PaymentRequest): Promise<PaymentResult> {
  if (!input.phoneNumber || input.amount <= 0) {
    return { success: false, status: "FAILED", message: "Informations de paiement invalides." };
  }

  // V1 développement: aucune transaction réelle n'est déclenchée.
  // Remplacer ce bloc par l'intégration opérateur avant production.
  return {
    success: true,
    status: "PENDING",
    reference: `CBFSOKO-${Date.now()}`,
    message: "Demande de paiement préparée. Connecter l'adaptateur opérateur avant production."
  };
}
