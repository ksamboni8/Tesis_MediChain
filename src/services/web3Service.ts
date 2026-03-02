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
  private overrideAddress: string | null = null;

  constructor() {
    if (typeof window !== 'undefined' && window.ethereum) {
      this.provider = new ethers.BrowserProvider(window.ethereum);
    }
  }

  // Permite inyectar la dirección manualmente desde el Login si está en 0x000 o se desea sobreescribir
  setContractAddress(address: string) {
    this.overrideAddress = address;
  }

  private getEffectiveAddress(): string {
    if (this.overrideAddress && ethers.isAddress(this.overrideAddress)) {
      return this.overrideAddress;
    }
    return CONTRACT_ADDRESS;
  }

  async connectWallet(): Promise<{ address: string; role: UserRole }> {
    if (!window.ethereum) {
      throw new Error("Metamask no instalado");
    }

    // Reinicializamos el provider para asegurar una conexión fresca
    this.provider = new ethers.BrowserProvider(window.ethereum);

    try {
      // En Ethers v6, getSigner() se encarga de solicitar acceso si es necesario
      this.signer = await this.provider.getSigner();
      const address = await this.signer.getAddress();

      // Inicializar contrato con la dirección efectiva (Config o Manual)
      const finalContractAddress = this.getEffectiveAddress();
      
      if (finalContractAddress && finalContractAddress !== "0x0000000000000000000000000000000000000000") {
          this.contract = new ethers.Contract(finalContractAddress, CONTRACT_ABI, this.signer);
      } else {
          this.contract = null;
      }

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

      let roleFound = UserRole.NONE;
      let blockchainVerified = false;

      // 1. INTENTO DE VERIFICACIÓN REAL (BLOCKCHAIN)
      if (this.contract) {
          try {
             // A. Verificar Owner (Admin)
             try {
                 const ownerAddress = await this.contract.owner();
                 if (ownerAddress.toLowerCase() === lowerAddress) {
                     console.log(">> BLOCKCHAIN CONFIRMED: ADMIN (Owner)");
                     return { address, role: UserRole.ADMIN };
                 }
             } catch (e) { console.warn("Falló check de owner", e); }

             // B. Verificar Doctor
             try {
                 if (await this.contract.isDoctor(address)) {
                     console.log(">> BLOCKCHAIN CONFIRMED: DOCTOR");
                     return { address, role: UserRole.DOCTOR };
                 }
             } catch (e) { console.warn("Falló check de doctor", e); }

             // C. Verificar Auditor
             try {
                if (await this.contract.isAuditor(address)) {
                    console.log(">> BLOCKCHAIN CONFIRMED: AUDITOR");
                    return { address, role: UserRole.AUDITOR };
                }
             } catch (e) { console.warn("Falló check de auditor", e); }

          } catch (err) {
             console.error("Error general consultando contrato Blockchain.", err);
          }
      } else {
         console.warn("⚠️ CONTRATO NO CONFIGURADO: Saltando verificación on-chain.");
      }

      // 2. MODO DE RESPALDO (FALLBACK) PARA TESIS/DEMO
      // Si la blockchain falla, verificamos contra las direcciones conocidas de tu contrato.
      // Esto asegura que puedas entrar a la demo incluso si la red Polygon falla.
      
      const FALLBACK_ADMIN = "0x70b25c90a56541278ff353e1c676413296f21929"; 
      const FALLBACK_DOCTOR = "0x1d75648d720b0bb4e5aa6eaddfe6ceac099a67bc"; // Tu cuenta médico del contrato
      const FALLBACK_AUDITOR = "0xc027c80e710324ca69fe58aa7cfbdf8f5105597e"; // Tu cuenta auditor del contrato

      if (lowerAddress === FALLBACK_ADMIN.toLowerCase()) {
          console.warn("⚠️ ACCESO FALLBACK ACTIVADO: Rol ADMIN concedido por Whitelist Local.");
          return { address, role: UserRole.ADMIN };
      }
      if (lowerAddress === FALLBACK_DOCTOR.toLowerCase()) {
          console.warn("⚠️ ACCESO FALLBACK ACTIVADO: Rol DOCTOR concedido por Whitelist Local.");
          return { address, role: UserRole.DOCTOR };
      }
      if (lowerAddress === FALLBACK_AUDITOR.toLowerCase()) {
          console.warn("⚠️ ACCESO FALLBACK ACTIVADO: Rol AUDITOR concedido por Whitelist Local.");
          return { address, role: UserRole.AUDITOR };
      }

      // 3. ACCESO DENEGADO
      console.error(`ACCESO DENEGADO. La dirección ${address} no está en el contrato ni en la lista blanca.`);
      return { address, role: UserRole.NONE };
      
    } catch (e) {
      console.error("Error crítico verificando rol:", e);
      return { address, role: UserRole.NONE };
    }
  }

  async registerTriage(
    patientId: string,
    dataHash: string,
    triageLevel: number,
    aiReasoningHash: string = "Manual-Override"
  ): Promise<any> {
    if (!this.contract) throw new Error("Error: Contrato no conectado. Verifique la dirección en Config.");
    
    try {
      const GAS_PRICE_GWEI = ethers.parseUnits('35', 'gwei');

      const tx = await this.contract.registerTriage(
        patientId, 
        dataHash,  
        triageLevel, 
        aiReasoningHash,
        {
          maxPriorityFeePerGas: GAS_PRICE_GWEI,
          maxFeePerGas: GAS_PRICE_GWEI,
          gasLimit: 500000 
        }
      );
      
      await tx.wait(1); 
      return tx;
    } catch (error) {
      console.error("Fallo en transacción Blockchain:", error);
      throw error;
    }
  }

  async getLatestRecords(limit: number = 20): Promise<any[]> {
    try {
      let contractToUse = this.contract;

      if (!contractToUse && window.ethereum) {
          const tempProvider = new ethers.BrowserProvider(window.ethereum);
          // Intentamos usar la dirección manual si existe, sino la de config
          const addr = this.getEffectiveAddress();
          if (addr && addr !== "0x0000000000000000000000000000000000000000") {
             contractToUse = new ethers.Contract(addr, CONTRACT_ABI, tempProvider);
          }
      }

      if (!contractToUse) return [];
      
      const records = await contractToUse.getLatestRecords(limit);
      return this.mapRecords(records);

    } catch (e) {
      console.error("Error obteniendo registros:", e);
      return [];
    }
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