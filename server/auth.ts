/**
 * Autenticación de las peticiones a la API mediante la firma de un mensaje con la wallet del usuario.
 *
 * 1. GET  /api/auth/nonce?address=0x...  → mensaje de inicio de sesión con un nonce aleatorio de un solo uso.
 * 2. El usuario firma ese mensaje con MetaMask (personal_sign; no es una transacción ni cuesta gas).
 * 3. POST /api/auth/login {address, signature} → el servidor recupera la dirección que firmó, consulta sus
 *    roles (contrato inteligente y lista de Admisión) y entrega un token de sesión.
 * 4. Cada petición protegida envía "Authorization: Bearer <token>"; requireRole comprueba el token y el rol.
 *
 * Así el servidor sabe quién envía cada petición: ya no basta con escribir una dirección en el cuerpo.
 * Las sesiones viven en memoria: si el servidor se reinicia, el usuario vuelve a iniciar sesión.
 */
import crypto from 'crypto';
import { ethers } from 'ethers';
import type { Request, Response, NextFunction } from 'express';

export type Role = 'DOCTOR' | 'ADMIN' | 'AUDITOR' | 'ADMISSION';

export interface Session { address: string; roles: Role[]; expiresAt: number }

const NONCE_TTL_MS = 5 * 60 * 1000;        // 5 minutos para firmar el mensaje
const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // una jornada de 8 horas

const nonces = new Map<string, { message: string; expiresAt: number }>();
const sessions = new Map<string, Session>();

export class AuthError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

// Mensaje que firma el usuario. Incluye la cuenta y el nonce para que una firma no sirva para otra
// cuenta ni pueda reutilizarse.
export function createLoginMessage(address: string): string {
  if (!ethers.isAddress(address)) throw new AuthError(400, 'Dirección de wallet inválida');
  const checksum = ethers.getAddress(address);
  const message = [
    'MediChain: inicio de sesión',
    `Cuenta: ${checksum}`,
    `Nonce: ${crypto.randomBytes(16).toString('hex')}`,
    `Emitido: ${new Date().toISOString()}`,
  ].join('\n');
  nonces.set(checksum.toLowerCase(), { message, expiresAt: Date.now() + NONCE_TTL_MS });
  return message;
}

// Verifica la firma del último mensaje emitido para la cuenta y abre una sesión con sus roles.
// El nonce se descarta en cualquier caso: cada mensaje sirve para un solo intento.
export async function login(
  address: string,
  signature: string,
  resolveRoles: (address: string) => Promise<Role[]>
): Promise<{ token: string; roles: Role[]; expiresAt: number }> {
  if (!ethers.isAddress(address) || typeof signature !== 'string') throw new AuthError(400, 'Faltan la dirección o la firma');
  const key = address.toLowerCase();
  const pending = nonces.get(key);
  nonces.delete(key);
  if (!pending || pending.expiresAt < Date.now()) throw new AuthError(401, 'El mensaje de inicio de sesión expiró; vuelva a intentarlo');

  let signer: string;
  try { signer = ethers.verifyMessage(pending.message, signature); }
  catch { throw new AuthError(401, 'Firma inválida'); }
  if (signer.toLowerCase() !== key) throw new AuthError(401, 'La firma no corresponde a la cuenta indicada');

  const roles = await resolveRoles(signer);
  if (roles.length === 0) throw new AuthError(403, 'La cuenta no tiene ningún rol autorizado en MediChain');

  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + SESSION_TTL_MS;
  sessions.set(token, { address: signer, roles, expiresAt });
  return { token, roles, expiresAt };
}

const bearer = (req: Request): string | null => {
  const header = req.headers.authorization;
  return header?.startsWith('Bearer ') ? header.slice(7) : null;
};

export function logout(req: Request): void {
  const token = bearer(req);
  if (token) sessions.delete(token);
}

// Middleware: exige una sesión vigente con al menos uno de los roles indicados.
// 401 si no hay sesión (o expiró); 403 si la cuenta no tiene el rol.
export function requireRole(...allowed: Role[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const token = bearer(req);
    const session = token ? sessions.get(token) : undefined;
    if (!session || session.expiresAt < Date.now()) {
      if (token && session) sessions.delete(token);
      return res.status(401).json({ error: 'No autenticado: inicie sesión con su wallet' });
    }
    if (!session.roles.some(r => allowed.includes(r))) {
      return res.status(403).json({ error: `Forbidden: se requiere uno de estos roles: ${allowed.join(', ')}` });
    }
    (req as any).session = session;
    next();
  };
}

export const sessionOf = (req: Request): Session => (req as any).session;
