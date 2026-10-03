import React, { useState, useEffect } from 'react';
import { dbService } from '../services/databaseService';
import type { HybridRecord } from '../types';
import { Card } from '../components/Card';
import { Database, Save, RefreshCw, FileX, Server, ShieldAlert, Lock } from 'lucide-react';

interface AdminConsoleProps {
  walletAddress: string;
}

export const AdminConsole: React.FC<AdminConsoleProps> = ({ walletAddress }) => {
  const [records, setRecords] = useState<HybridRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string>('');
  const [jsonData, setJsonData] = useState<string>('');
  const [loading, setLoading] = useState(false);

  const loadRecords = async () => {
    setLoading(true);
    try {
      const data = await dbService.getAllRecords();
      setRecords(data);
    } catch (e) {
      console.error("Failed to load records in Admin Console", e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadRecords();
  }, []);

  useEffect(() => {
    if (selectedId) {
      const rec = records.find(r => r._id === selectedId);
      if (rec) {
        setJsonData(JSON.stringify(rec.patientData, null, 2));
      }
    }
  }, [selectedId, records]);

  const handleUpdateRecord = async () => {
    if (!selectedId) return;
    try {
      const parsedData = JSON.parse(jsonData);
      
      // Execute the direct update via API
      await dbService.directHackUpdate(selectedId, parsedData, walletAddress);

      alert("REGISTRO ACTUALIZADO: Los datos han sido sobrescritos en la Base de Datos Centralizada.\n\nNota: Al no pasar por el Smart Contract, se generará una alerta de integridad en la vista de Auditoría.");

      loadRecords();
    } catch (e: any) {
      alert(e?.message || "Error: El formato JSON no es válido.");
    }
  };

  // RNF-07: Deshabilitar simulación en producción — este panel permite
  // manipulación directa de la BD sin firma blockchain y solo debe existir en desarrollo.
  if (!import.meta.env.DEV) {
    return (
      <div className="p-8 text-center text-slate-400 bg-slate-50 rounded-xl border-2 border-dashed border-slate-200">
        <ShieldAlert className="w-10 h-10 mx-auto mb-3 opacity-40" />
        <p className="font-medium text-slate-600">Consola de simulación no disponible</p>
        <p className="text-sm">Esta funcionalidad está deshabilitada en entornos de producción.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header profesional de Administrador de BD */}
      <div className="bg-slate-800 text-white p-6 rounded-xl shadow-lg border-l-4 border-blue-500 relative overflow-hidden">
        <div className="relative z-10">
          <div className="flex items-center gap-3 mb-2">
            <div className="p-2 bg-slate-700 rounded-lg">
              <Server className="w-6 h-6 text-blue-400" />
            </div>
            <h2 className="text-2xl font-bold">Gestor de Base de Datos Centralizada</h2>
          </div>
          <p className="text-slate-300 max-w-2xl">
            Vista de superusuario (Root) para la gestión directa de registros en MongoDB. 
            <span className="text-amber-400 ml-1 font-medium">
               Las modificaciones realizadas aquí son directas y no generan firma criptográfica en Blockchain.
            </span>
          </p>
        </div>
        {/* Background deco */}
        <Database className="absolute -right-4 -bottom-4 w-32 h-32 text-slate-700 opacity-50" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-1">
          <Card 
            title={`Registros (${records.length})`} 
            action={
              <button onClick={loadRecords} className="p-1 hover:bg-slate-100 rounded-full transition-colors">
                <RefreshCw className={`w-4 h-4 text-slate-500 ${loading ? 'animate-spin' : ''}`} />
              </button>
            }
          >
             <div className="space-y-2 max-h-[600px] overflow-y-auto pr-2">
               {loading && records.length === 0 && (
                 <div className="text-center py-8 text-slate-400 text-sm">Sincronizando...</div>
               )}
               
               {!loading && records.length === 0 && (
                 <div className="text-center py-12 flex flex-col items-center text-slate-400">
                    <FileX className="w-10 h-10 mb-3 opacity-30"/>
                    <span className="text-sm font-medium">Base de Datos Vacía</span>
                 </div>
               )}

               {records.map(r => (
                 <button
                   key={r._id}
                   onClick={() => setSelectedId(r._id)}
                   className={`w-full text-left p-3 rounded-lg border transition-all duration-200 group
                     ${selectedId === r._id 
                       ? 'bg-blue-50 border-blue-500 shadow-sm' 
                       : 'bg-white border-slate-200 hover:border-blue-300 hover:shadow-sm'}
                   `}
                 >
                   <div className="flex justify-between items-start mb-1">
                      <span className={`font-bold text-sm ${selectedId === r._id ? 'text-blue-800' : 'text-slate-700'}`}>
                        {r.patientData.name}
                      </span>
                      <span className="text-[10px] font-mono text-slate-400 bg-slate-100 px-1.5 py-0.5 rounded">
                        {r._id.slice(-4)}
                      </span>
                   </div>
                   <div className="text-xs text-slate-500 flex items-center gap-2">
                     <span className="truncate">ID: {r.patientData.cedula}</span>
                   </div>
                 </button>
               ))}
             </div>
          </Card>
        </div>

        <div className="lg:col-span-2">
          <Card 
            title="Editor de Registro (Raw JSON)" 
            action={
              selectedId ? (
                <span className="flex items-center gap-2 text-xs font-mono text-amber-600 bg-amber-50 px-2 py-1 rounded border border-amber-200">
                  <Lock className="w-3 h-3" /> Modo Edición (Root)
                </span>
              ) : null
            }
          >
            {selectedId ? (
              <div className="flex flex-col h-full">
                <div className="mb-4 flex-1">
                  <div className="flex justify-between items-center mb-2">
                    <label className="text-xs font-bold text-slate-500 uppercase tracking-wider">
                      Contenido del Documento
                    </label>
                    <span className="text-[10px] text-slate-400">Formato: JSON Estándar</span>
                  </div>
                  <textarea 
                    className="w-full h-[400px] font-mono text-xs bg-slate-50 text-slate-800 p-4 rounded-lg outline-none border border-slate-300 focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10 transition-all resize-none shadow-inner leading-relaxed"
                    value={jsonData}
                    onChange={e => setJsonData(e.target.value)}
                    spellCheck={false}
                  />
                </div>
                
                <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 mb-4 flex items-start gap-3">
                  <ShieldAlert className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
                  <div className="text-xs text-amber-800">
                    <strong className="block mb-1">Advertencia de Integridad</strong>
                    Al modificar este registro directamente, el Hash SHA-256 almacenado en la Blockchain dejará de coincidir con el contenido actual de la base de datos. Esto será detectado inmediatamente por el módulo de Auditoría.
                  </div>
                </div>

                <button
                  onClick={handleUpdateRecord}
                  className="w-full bg-blue-600 hover:bg-blue-700 text-white py-3 rounded-lg font-bold shadow-sm hover:shadow transition-all flex items-center justify-center gap-2"
                >
                  <Save className="w-4 h-4" />
                  Guardar Cambios en Base de Datos
                </button>
              </div>
            ) : (
              <div className="h-[500px] flex flex-col items-center justify-center text-slate-400 bg-slate-50/50 rounded-lg border-2 border-dashed border-slate-200">
                <div className="p-4 bg-white rounded-full shadow-sm mb-4">
                  <Database className="w-8 h-8 text-slate-300" />
                </div>
                <p className="font-medium text-slate-600">Ningún registro seleccionado</p>
                <p className="text-sm">Seleccione un paciente de la lista para ver o editar sus datos raw.</p>
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
};