import React, { useState, useEffect } from 'react';
import { Login } from './views/Login';
import { TriageForm } from './views/TriageForm';
import { AuditList } from './views/AuditList';
import { AdminConsole } from './views/AdminConsole';
import { UserRole, HybridRecord } from './types';
import { Shield, LayoutDashboard, LogOut, PlusCircle, Database, FileClock } from 'lucide-react';

const App: React.FC = () => {
  const [userRole, setUserRole] = useState<UserRole>(UserRole.NONE);
  const [walletAddress, setWalletAddress] = useState<string>('');
  const [currentView, setCurrentView] = useState<'triage' | 'audit' | 'admin'>('triage');
  
  // State for Correction Mode
  const [recordToCorrect, setRecordToCorrect] = useState<HybridRecord | null>(null);

  // Effect to ensure View matches Role immediately upon login
  useEffect(() => {
    if (userRole === UserRole.ADMIN) {
      setCurrentView('admin');
    } else if (userRole === UserRole.AUDITOR) {
      setCurrentView('audit');
    } else if (userRole === UserRole.DOCTOR) {
      // Keep existing logic: if in correction mode, stay there, else triage
      if (currentView !== 'triage' && currentView !== 'audit') {
        setCurrentView('triage');
      }
    }
  }, [userRole]);

  const handleLogin = (role: UserRole, address: string) => {
    setUserRole(role);
    setWalletAddress(address);
  };

  const handleLogout = () => {
    setUserRole(UserRole.NONE);
    setWalletAddress('');
    setRecordToCorrect(null);
    setCurrentView('triage'); // Reset default
  };

  const handleStartCorrection = (record: HybridRecord) => {
    setRecordToCorrect(record);
    setCurrentView('triage');
  };

  if (userRole === UserRole.NONE) {
    return <Login onLogin={handleLogin} />;
  }

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col md:flex-row font-sans text-slate-900">
      {/* Sidebar Navigation */}
      <aside className="w-full md:w-64 bg-slate-900 text-white flex-shrink-0">
        <div className="p-6 border-b border-slate-800">
          <div className="flex items-center gap-2 font-bold text-xl">
            <Shield className="w-6 h-6 text-blue-400" />
            <span>MediChain</span>
          </div>
          <div className="mt-4 text-xs text-slate-400 bg-slate-800 p-2 rounded break-all">
            Wallet: {walletAddress.substring(0, 6)}...{walletAddress.substring(38)}
          </div>
          <div className={`mt-2 text-xs font-semibold px-2 py-1 rounded inline-block 
            ${userRole === UserRole.ADMIN ? 'bg-red-600' : 
              userRole === UserRole.AUDITOR ? 'bg-purple-600' : 'bg-blue-600'}`}>
            {userRole === UserRole.DOCTOR ? 'MÉDICO AUTORIZADO' : 
             userRole === UserRole.AUDITOR ? 'AUDITOR EXTERNO' : 
             userRole === UserRole.ADMIN ? 'ADMINISTRADOR DB' : 'USUARIO'}
          </div>
        </div>

        <nav className="p-4 space-y-2">
          {userRole === UserRole.DOCTOR && (
            <button
              onClick={() => {
                setRecordToCorrect(null); // Clear correction mode
                setCurrentView('triage');
              }}
              className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-colors ${currentView === 'triage' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:bg-slate-800 hover:text-white'}`}
            >
              <PlusCircle className="w-5 h-5" />
              <span>{recordToCorrect ? 'Corregir Triage' : 'Nuevo Triage'}</span>
            </button>
          )}

          {/* Blockchain View: ONLY for Auditor and Doctor. Admin is excluded. */}
          {(userRole === UserRole.AUDITOR || userRole === UserRole.DOCTOR) && (
            <button
              onClick={() => setCurrentView('audit')}
              className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-colors ${currentView === 'audit' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:bg-slate-800 hover:text-white'}`}
            >
              <FileClock className="w-5 h-5" />
              <span>Historial Pacientes</span>
            </button>
          )}

          {/* Admin Database View: ONLY for Admin */}
          {userRole === UserRole.ADMIN && (
            <button
              onClick={() => setCurrentView('admin')}
              className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-colors ${currentView === 'admin' ? 'bg-red-600 text-white' : 'text-slate-400 hover:bg-slate-800 hover:text-white'}`}
            >
              <Database className="w-5 h-5" />
              <span>Base de Datos</span>
            </button>
          )}

          <div className="pt-8 border-t border-slate-800 mt-8">
            <button
              onClick={handleLogout}
              className="w-full flex items-center gap-3 px-4 py-3 text-slate-400 hover:text-white transition-colors"
            >
              <LogOut className="w-5 h-5" />
              <span>Desconectar</span>
            </button>
          </div>
        </nav>
      </aside>

      {/* Main Content */}
      <main className="flex-1 overflow-y-auto">
        <header className="bg-white border-b border-slate-200 px-8 py-4 sticky top-0 z-10">
          <h1 className="text-2xl font-bold text-slate-800">
            {currentView === 'triage' && (recordToCorrect ? 'Corrección de Registro Existente' : 'Ingreso de Emergencia')}
            {currentView === 'audit' && 'Historial Clínico Unificado'}
            {currentView === 'admin' && 'Panel de Control - Base de Datos Central'}
          </h1>
        </header>

        <div className="p-8 max-w-7xl mx-auto">
          {currentView === 'triage' && (
            <TriageForm 
              walletAddress={walletAddress} 
              initialData={recordToCorrect || undefined}
              onSuccess={() => {
                setRecordToCorrect(null);
                setCurrentView('audit');
              }}
            />
          )}
          {currentView === 'audit' && (
            <AuditList 
              userRole={userRole} 
              onCorrectRecord={handleStartCorrection} 
            />
          )}
          {currentView === 'admin' && (
            <AdminConsole />
          )}
        </div>
      </main>
    </div>
  );
};

export default App;