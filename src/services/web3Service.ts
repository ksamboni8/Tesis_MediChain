import { ethers } from 'ethers';
import { CONTRACT_ABI, CONTRACT_ADDRESS } from '../config/contract';
import { UserRole } from '../types';

declare global {
  interface Window {
    ethereum: any;
  }
}

export class Web3Service {
  private provider: ethers.BrowserProvider | null = null;
  private contract: ethers.Contract | null = null;
  private signer: ethers.Signer | null = null;

  constructor() {
    if (typeof window !== 'undefined' && window.ethereum) {
      this.provider = new ethers.BrowserProvider(window.ethereum);
    }
  }

  async connectWallet(): Promise<{ address: string; role: UserRole }> {
    if (!window.ethereum) {
      throw new Error("Metamask no instalado");
    }

    // Reinicializamos el provider para asegurar una conexión fresca
    this.provider = new ethers.BrowserProvider(window.ethereum);

    try {
      // Solicitar explícitamente conexión a MetaMask
      await window.ethereum.request({ method: 'eth_requestAccounts' });
      
      // En Ethers v6, getSigner() obtiene la cuenta conectada
      this.signer = await this.provider.getSigner();
      const address = await this.signer.getAddress();

      // Inicializar contrato con la dirección de src/config/contract.ts
      this.contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, this.signer);

      // Verificación de Roles
      return await this.checkUserRole(address);

    } catch (e: any) {
      console.error("Error conectando wallet:", e);
      throw e;
    }
  }

  private async checkUserRole(address: string): Promise<{ address: string; role: UserRole }> {
    try {
      const lowerAddress = address.toLowerCase();
      console.log(`[MediChain] Verificando permisos para: ${address}`);

      // DOCTOR, AUDITOR y ADMIN se verifican exclusivamente contra el Smart Contract (ver más abajo).
      // ADMISSION no tiene representación on-chain, así que es el único rol con respaldo por whitelist local.
      const FALLBACK_ADMISSION = "0xe5c4FE69F92f350226276460D238621c361bACcC"; // Tu cuenta de admisión

      // 0. ADMISSION no tiene mapping en el Smart Contract: la whitelist local es su único mecanismo.
      if (lowerAddress === FALLBACK_ADMISSION.toLowerCase()) {
          console.log(">> ROL DETECTADO: ADMISSION (Whitelist Local - único mecanismo disponible)");
          return { address, role: UserRole.ADMISSION };
      }

      // 1. VERIFICACIÓN ON-CHAIN: única fuente de verdad para DOCTOR/AUDITOR/ADMIN (sin respaldo local).
      if (this.contract) {
          try {
             // PREFERENCIA TEMPORAL DE ROL (para una wallet que es a la vez médico y owner): si en este
             // navegador existe localStorage 'medichain_role_preference' = 'ADMIN', se comprueba owner()
             // antes que isDoctor(). Solo cambia el orden: el rol ADMIN sigue exigiendo ser owner() en la
             // cadena. Se desactiva borrando la clave. Ver también la comprobación B (sin cambios).
             let preferAdmin = false;
             try { preferAdmin = localStorage.getItem('medichain_role_preference') === 'ADMIN'; } catch { /* sin storage */ }
             if (preferAdmin) {
                 const ownerAddress = await this.contract.owner();
                 if (ownerAddress.toLowerCase() === lowerAddress) {
                     console.log(">> BLOCKCHAIN CONFIRMED: ADMIN (Owner, preferencia de rol activa)");
                     return { address, role: UserRole.ADMIN };
                 }
             }

             // A. Verificar Doctor
             try {
                 if (await this.contract.isDoctor(address)) {
                     console.log(">> BLOCKCHAIN CONFIRMED: DOCTOR");
                     return { address, role: UserRole.DOCTOR };
                 }
             } catch (e) { console.warn("Falló check de doctor en Blockchain", e); }

             // B. Verificar Owner (Admin)
             try {
                 const ownerAddress = await this.contract.owner();
                 if (ownerAddress.toLowerCase() === lowerAddress) {
                     console.log(">> BLOCKCHAIN CONFIRMED: ADMIN (Owner)");
                     return { address, role: UserRole.ADMIN };
                 }
             } catch (e) { console.warn("Falló check de owner en Blockchain", e); }

             // C. Verificar Auditor
             try {
                if (await this.contract.isAuditor(address)) {
                    console.log(">> BLOCKCHAIN CONFIRMED: AUDITOR");
                    return { address, role: UserRole.AUDITOR };
                }
             } catch (e) { console.warn("Falló check de auditor en Blockchain", e); }

          } catch (err) {
             console.error("Error general consultando contrato Blockchain.", err);
          }
      } else {
         console.warn("⚠️ CONTRATO NO CONFIGURADO: no es posible verificar DOCTOR/AUDITOR/ADMIN. Acceso denegado (sin respaldo local).");
      }

      // 2. ACCESO DENEGADO. Se llega aquí si el contrato no está disponible, o si ninguna de las
      // tres verificaciones on-chain fue positiva para esta dirección. Ya no hay whitelist de respaldo
      // para DOCTOR/AUDITOR/ADMIN: el contrato es la única fuente de verdad para estos roles.
      console.error(`ACCESO DENEGADO. La dirección ${address} no está registrada en el Smart Contract (ni es ADMISSION en la whitelist local).`);
      return { address, role: UserRole.NONE };

    } catch (e) {
      console.error("Error crítico verificando rol:", e);
      return { address, role: UserRole.NONE };
    }
  }


  // Lee TODOS los registros anclados en el contrato (no solo los últimos N) para verificar la
  // integridad contra la cadena. Fail-closed: si no se puede consultar el contrato o la respuesta
  // no contiene el total de registros, lanza un error en vez de devolver una lista vacía o parcial.
  async getAllAnchoredRecords(): Promise<any[]> {
    let contractToUse = this.contract;

    if (!contractToUse) {
      if (!window.ethereum) {
        throw new Error('No hay proveedor de blockchain (MetaMask) disponible para consultar el contrato.');
      }
      contractToUse = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, new ethers.BrowserProvider(window.ethereum));
    }

    const total = Number(await contractToUse.getTotalRecords());
    if (total === 0) return [];

    let records = this.mapRecords(await contractToUse.getLatestRecords(total));
    if (records.length !== total) {
      // Plan B por si getLatestRecords limita el tamaño: leer el mapping records(i) uno a uno. No se
      // conoce si los índices empiezan en 0 o en 1, así que se recorre 0..total y se descartan vacíos.
      const byIndex: any[] = [];
      for (let i = 0; i <= total; i++) {
        const r = await contractToUse.records(i);
        if (r && r.dataHash) byIndex.push(r);
      }
      records = this.mapRecords(byIndex);
    }
    if (records.length !== total) {
      throw new Error(`Se leyeron ${records.length} de ${total} registros anclados; la verificación no sería completa.`);
    }
    return records;
  }

  private mapRecords(records: any[]): any[] {
    const toNum = (val: any) => {
      if (typeof val === 'bigint') return Number(val);
      return Number(val);
    };

    const recordsArray = Array.isArray(records) ? records : Array.from(records || []);

    return recordsArray.map((r: any) => ({
      id: r.id.toString(),
      patientIdAnonymized: r.patientIdAnonymized,
      dataHash: r.dataHash,
      triageLevel: toNum(r.triageLevel),
      timestamp: toNum(r.timestamp) * 1000, 
      doctor: r.doctor,
      aiReasoningHash: r.aiReasoningHash
    }));
  }
}

export const web3Service = new Web3Service();