import React, { useState } from 'react';
import { UserRole } from '../types';
import { web3Service } from '../services/web3Service';
import { 
  ShieldCheck, 
  Wallet, 
  Activity, 
  Database, 
  Lock, 
  ChevronRight, 
  AlertCircle 
} from 'lucide-react';

interface LoginProps {
  onLogin: (role: UserRole, walletAddress: string) => void;
}

export const Login: React.FC<LoginProps> = ({ onLogin }) => {
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<string>('');
  
  const handleWalletConnect = async () => {
    setIsConnecting(true);
    setError('');
    
    try {
      const { address, role } = await web3Service.connectWallet();
      
      if (role === UserRole.NONE) {
        setError(`La billetera ${address.substring(0,6)}... no está autorizada en el Smart Contract.`);
        setIsConnecting(false);
        return;
      }
      
      onLogin(role, address);
    } catch (e: any) {
      console.error(e);
      setError(e.message || "No se pudo conectar con la Billetera.");
    } finally {
      setIsConnecting(false);
    }
  };

  return (
    <div className="min-h-screen flex bg-slate-50 font-sans">
      
      {/* LEFT COLUMN: BRANDING & THESIS INFO */}
      <div className="hidden lg:flex lg:w-1/2 bg-slate-900 text-white flex-col justify-between p-12 relative overflow-hidden">
        {/* Abstract Background Decoration */}
        <div className="absolute top-0 right-0 w-96 h-96 bg-blue-600 rounded-full blur-[120px] opacity-20 -translate-y-1/2 translate-x-1/2"></div>
        <div className="absolute bottom-0 left-0 w-64 h-64 bg-indigo-600 rounded-full blur-[100px] opacity-20 translate-y-1/2 -translate-x-1/2"></div>

        <div className="relative z-10">
          <div className="flex items-center gap-3 mb-6">
            <div className="bg-blue-600 p-2 rounded-lg">
              <ShieldCheck className="w-8 h-8 text-white" />
            </div>
            <span className="text-2xl font-bold tracking-tight">MediChain Triage</span>
          </div>
          
          <h1 className="text-4xl font-extrabold leading-tight mb-6 text-slate-100">
            Seguridad e Integridad <br />
            <span className="text-blue-400">En Datos Médicos Críticos</span>
          </h1>
          
          <p className="text-slate-400 max-w-md text-lg leading-relaxed">
            Sistema de Triage Híbrido que combina lecturas IoT en tiempo real con auditoría inmutable en Blockchain Polygon.
          </p>
        </div>

        <div className="relative z-10 space-y-6">
          <div className="flex items-start gap-4 p-4 bg-slate-800/50 rounded-xl border border-slate-700 backdrop-blur-sm">
             <Activity className="w-6 h-6 text-green-400 mt-1" />
             <div>
               <h3 className="font-bold text-slate-200">Sensores IoT</h3>
               <p className="text-sm text-slate-400">Captura automática de signos vitales mediante Bluetooth Low Energy.</p>
             </div>
          </div>
          <div className="flex items-start gap-4 p-4 bg-slate-800/50 rounded-xl border border-slate-700 backdrop-blur-sm">
             <Lock className="w-6 h-6 text-blue-400 mt-1" />
             <div>
               <h3 className="font-bold text-slate-200">Smart Contracts</h3>
               <p className="text-sm text-slate-400">Lógica de triage ESI v4 inmutable desplegada en Polygon Amoy.</p>
             </div>
          </div>
          <div className="flex items-start gap-4 p-4 bg-slate-800/50 rounded-xl border border-slate-700 backdrop-blur-sm">
             <Database className="w-6 h-6 text-purple-400 mt-1" />
             <div>
               <h3 className="font-bold text-slate-200">Auditoría Híbrida</h3>
               <p className="text-sm text-slate-400">Validación criptográfica SHA-256 contra base de datos centralizada.</p>
             </div>
          </div>
        </div>

        <div className="relative z-10 text-xs text-slate-600 pt-6 border-t border-slate-800">
          Proyecto de Tesis 2024-2025
        </div>
      </div>

      {/* RIGHT COLUMN: LOGIN FORM */}
      <div className="w-full lg:w-1/2 flex items-center justify-center p-8">
        <div className="max-w-md w-full">
          <div className="text-center lg:text-left mb-10">
            <h2 className="text-3xl font-bold text-slate-900 mb-2">Bienvenido</h2>
            <p className="text-slate-500">
              Conecte su billetera Web3 para autenticar su rol (Médico, Auditor o Administrador).
            </p>
          </div>

          <div className="space-y-6">
            
            {/* Main Action Button */}
            <button
              onClick={handleWalletConnect}
              disabled={isConnecting}
              className="w-full group relative flex items-center justify-between p-5 bg-white border-2 border-slate-200 rounded-2xl hover:border-blue-600 hover:shadow-lg transition-all duration-300 disabled:opacity-70 disabled:cursor-wait"
            >
              <div className="flex items-center gap-4">
                <div className="bg-orange-50 p-3 rounded-xl group-hover:bg-blue-50 transition-colors">
                  <Wallet className="w-6 h-6 text-orange-600 group-hover:text-blue-600" />
                </div>
                <div className="text-left">
                  <span className="block font-bold text-slate-800 text-lg group-hover:text-blue-700">
                    {isConnecting ? 'Conectando...' : 'Conectar MetaMask'}
                  </span>
                  <span className="block text-xs text-slate-400 font-medium">
                    Red Polygon Amoy
                  </span>
                </div>
              </div>
              <ChevronRight className="w-5 h-5 text-slate-300 group-hover:text-blue-500 transform group-hover:translate-x-1 transition-all" />
            </button>

            {error && (
              <div className="flex items-start gap-3 bg-red-50 p-4 rounded-xl border border-red-100 animate-in fade-in slide-in-from-top-2">
                <AlertCircle className="w-5 h-5 text-red-600 shrink-0 mt-0.5" />
                <div className="text-sm text-red-700">
                  <span className="font-bold block mb-1">Error de Acceso</span>
                  {error}
                </div>
              </div>
            )}

          </div>
        </div>
      </div>
    </div>
  );
};