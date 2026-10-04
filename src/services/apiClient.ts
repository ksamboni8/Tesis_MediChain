/**
 * Cliente de la API con autenticación (ver server/auth.ts).
 *
 * El token de sesión se obtiene al iniciar sesión (web3Service.connectWallet: el usuario firma un mensaje
 * con MetaMask) y se guarda solo en memoria: al recargar la página hay que volver a iniciar sesión.
 * apiFetch lo agrega a cada petición; si el servidor responde 401 (sesión vencida o servidor reiniciado),
 * se emite el evento SESSION_EXPIRED_EVENT para que la aplicación cierre la sesión.
 */
import type { ethers } from 'ethers';

export const SESSION_EXPIRED_EVENT = 'medichain:session-expired';

let token: string | null = null;

export async function apiFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const res = await fetch(url, { ...init, headers });
  if (res.status === 401 && token) {
    token = null;
    window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
  }
  return res;
}

// Inicio de sesión: pide el mensaje con el nonce, lo firma con la wallet y lo envía al servidor.
// Firmar un mensaje no es una transacción: no cuesta gas ni queda en la blockchain.
export async function loginWithWallet(signer: ethers.Signer): Promise<void> {
  const address = await signer.getAddress();
  const nonceRes = await fetch(`/api/auth/nonce?address=${encodeURIComponent(address)}`);
  const nonceData = await nonceRes.json().catch(() => ({}));
  if (!nonceRes.ok) throw new Error(nonceData.error || 'No se pudo iniciar la sesión en el servidor');

  const signature = await signer.signMessage(nonceData.message);

  const loginRes = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address, signature }),
  });
  const loginData = await loginRes.json().catch(() => ({}));
  if (!loginRes.ok) throw new Error(loginData.error || 'El servidor rechazó el inicio de sesión');
  token = loginData.token;
}

export async function logoutSession(): Promise<void> {
  if (token) {
    try { await apiFetch('/api/auth/logout', { method: 'POST' }); } catch { /* el token se descarta igual */ }
  }
  token = null;
}
