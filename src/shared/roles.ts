/**
 * Cuentas del rol Admisión. Es el único rol sin representación en el contrato inteligente, así que se
 * define por esta lista, compartida por el cliente (web3Service) y el servidor (server/auth.ts).
 * Médico, Auditor y Administrador se determinan siempre consultando el contrato.
 */
export const ADMISSION_WALLETS: readonly string[] = [
  '0xe5c4FE69F92f350226276460D238621c361bACcC',
];

export const isAdmissionWallet = (address: string): boolean =>
  ADMISSION_WALLETS.some(w => w.toLowerCase() === address.toLowerCase());
