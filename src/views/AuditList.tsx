import React, { useEffect, useState } from 'react';
import { verifyDataIntegrity, generateHash } from '../services/cryptoService';
import { dbService } from '../services/databaseService';
import { web3Service } from '../services/web3Service';
import { ESIBadge } from '../components/Badge';
import { CheckCircle, AlertTriangle, FileSearch, Clock, Hash, FileText, ChevronDown, ChevronUp, RefreshCw, Scale, Edit2, Play, GitCommit, ExternalLink, Info, Activity, Thermometer, User, Shield, Lock, EyeOff, ShieldCheck } from 'lucide-react';
import { format, differenceInMinutes } from 'date-fns';
import { HybridRecord, UserRole } from '../types';

interface AuditListProps {
  userRole?: UserRole; // To decide if we show Edit buttons
  onCorrectRecord?: (record: HybridRecord) => void;
}

export const AuditList: React.FC<AuditListProps> = ({ userRole, onCorrectRecord }) => {
  const [mongoRecords, setMongoRecords] = useState<HybridRecord[]>([]);
  const [chainRecords, setChainRecords] = useState<any[]>([]);
  const [validationMap, setValidationMap] = useState<Record<string, boolean>>({});
  const [calculatedHashMap, setCalculatedHashMap] = useState<Record<string, string>>({}); // NEW: Store actual calculated hashes
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const isDoctor = userRole === UserRole.DOCTOR;

  // Load data and validate
  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    setLoading(true);
    try {
      // 1. Get Off-chain Data (Real MongoDB via API)
      const dbData = await dbService.getAllRecords(); // Await added here
      setMongoRecords(dbData);

      // 2. Get On-chain Data (Real Blockchain)
      const blockchainData = await web3Service.getLatestRecords(50);
      setChainRecords(blockchainData);

      // 3. Cross-Reference and Validate
      const vMap: Record<string, boolean> = {};
      const cMap: Record<string, string> = {};
      
      for (const rec of dbData) {
        // Calculate the CURRENT hash of the data (Wait for promise)
        // ESTO ES CLAVE: Calculamos el hash usando los datos QUE ACABAN DE LLEGAR DE MONGODB
        const currentHash = await generateHash(rec.patientData);
        cMap[rec._id] = currentHash;

        // Find match on chain
        const chainMatch = blockchainData.find(c => c.dataHash === rec.blockchainHash);
        
        if (chainMatch) {
            // Compare recalculated hash vs Blockchain hash
            vMap[rec._id] = (currentHash === chainMatch.dataHash);
        } else {
            // If not mined yet, compare vs the hash stored in DB metadata
            vMap[rec._id] = (currentHash === rec.blockchainHash);
        }
      }
      
      setValidationMap(vMap);
      setCalculatedHashMap(cMap);
    } catch (e) {
      console.error("Audit load failed", e);
    } finally {
      setLoading(false);
    }
  };

  const handleMarkAsAttended = async (e: React.MouseEvent, recordId: string) => {
    e.stopPropagation();
    if(!confirm("¿Confirmar que el paciente está siendo atendido ahora?")) return;
    try {
      await dbService.markAsAttended(recordId);
      loadData(); // Refresh to see timestamp
    } catch (err) {
      alert("Error actualizando estado");
    }
  };

  const handleCorrection = (e: React.MouseEvent, record: HybridRecord) => {
    e.stopPropagation();
    if (onCorrectRecord) onCorrectRecord(record);
  };

  if (loading) {
     return (
        <div className="flex flex-col items-center justify-center h-96 text-slate-400">
           <RefreshCw className="w-10 h-10 animate-spin mb-4 text-blue-500" />
           <p>Verificando Historial de Pacientes...</p>
        </div>
     );
  }

  if (mongoRecords.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-96 text-slate-400">
        <FileSearch className="w-16 h-16 mb-4 opacity-50" />
        <p>No hay registros médicos en el historial.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold text-slate-800">Historial de Triage de Pacientes</h2>
        <div className="text-sm text-slate-500 flex items-center gap-2">
           <div className="w-2 h-2 rounded-full bg-green-500"></div>
           <span>Sincronizado</span>
           <button onClick={loadData} className="ml-4 p-2 bg-slate-100 rounded-full hover:bg-slate-200">
             <RefreshCw className="w-4 h-4" />
           </button>
        </div>
      </div>

      <div className="grid gap-4">
        {mongoRecords.map((rec) => {
          const isIntegritySafe = validationMap[rec._id];
          const calculatedHash = calculatedHashMap[rec._id];
          const isExpanded = expandedId === rec._id;
          const chainMatch = chainRecords.find(c => c.dataHash === rec.blockchainHash);
          const hasOverride = rec.patientData.suggestedEsiLevel !== rec.patientData.finalEsiLevel;
          const isCorrection = !!rec.patientData.parentRecordHash;
          const d = rec.patientData; // Shortcut
          
          // Time Calculations
          const triageTime = rec.patientData.triageTimestamp;
          const attendedTime = rec.patientData.attentionTimestamp;
          const waitTime = attendedTime ? differenceInMinutes(attendedTime, triageTime) : null;
          const now = Date.now();
          const currentWait = differenceInMinutes(now, triageTime);

          return (
            <div key={rec._id} className={`bg-white rounded-xl shadow-sm border overflow-hidden transition-all ${isIntegritySafe ? 'border-slate-200' : 'border-red-300 ring-2 ring-red-100'}`}>
              <div 
                className="p-6 flex flex-col lg:flex-row gap-6 cursor-pointer hover:bg-slate-50 transition-colors"
                onClick={() => setExpandedId(isExpanded ? null : rec._id)}
              >
                {/* Status Indicator */}
                <div className="flex flex-col items-center justify-center min-w-[100px] border-r border-slate-100 pr-6">
                   {isIntegritySafe ? (
                     <>
                       <div className="w-10 h-10 bg-green-100 rounded-full flex items-center justify-center mb-2">
                         <CheckCircle className="w-5 h-5 text-green-600" />
                       </div>
                       <span className="text-[10px] font-bold text-green-700 uppercase tracking-wider">Validado</span>
                     </>
                   ) : (
                     <>
                       <div className="w-10 h-10 bg-red-100 rounded-full flex items-center justify-center mb-2 animate-pulse">
                         <AlertTriangle className="w-5 h-5 text-red-600" />
                       </div>
                       <span className="text-[10px] font-bold text-red-700 uppercase tracking-wider">Corrupto</span>
                     </>
                   )}
                </div>

                {/* Primary Data Row - Protected View for Auditors */}
                <div className="flex-1 grid grid-cols-1 md:grid-cols-3 gap-6 items-center">
                  <div>
                     <div className="flex items-center gap-2 mb-1">
                        {isDoctor ? (
                           // Doctor View: Name
                           <h3 className="font-bold text-lg text-slate-800">{d.name}</h3>
                        ) : (
                           // Auditor View: Anonymized ID
                           <div className="flex items-center gap-2">
                              <Shield className="w-5 h-5 text-purple-600" />
                              <h3 className="font-bold text-lg text-slate-700 font-mono tracking-tight">
                                 ID: {d.id.substring(0, 8)}...
                              </h3>
                           </div>
                        )}
                        
                        {hasOverride && (
                           <span className="bg-amber-100 text-amber-700 text-[10px] px-2 py-0.5 rounded font-bold border border-amber-200 flex items-center gap-1">
                              <Scale className="w-3 h-3"/> {isDoctor ? 'OVERRIDE' : 'MODIFICADO'}
                           </span>
                        )}
                        {isCorrection && (
                           <span className="bg-purple-100 text-purple-700 text-[10px] px-2 py-0.5 rounded font-bold border border-purple-200 flex items-center gap-1">
                              <GitCommit className="w-3 h-3"/> CORRECCIÓN
                           </span>
                        )}
                     </div>
                     
                     {/* Subtitle: ID or Protected */}
                     <div className="text-sm text-slate-500 mb-1">
                        {isDoctor ? `C.I: ${d.cedula}` : <span className="flex items-center gap-1 text-xs italic"><EyeOff className="w-3 h-3"/> Datos Personales Protegidos</span>}
                     </div>
                     
                     <ESIBadge level={d.finalEsiLevel} />
                  </div>
                  
                  {/* TIME METRICS (Visible to ALL - Critical for Audit) */}
                  <div className="text-sm">
                     <div className="flex items-center gap-2 mb-2 text-slate-600">
                        <Clock className="w-4 h-4 text-slate-400" />
                        <span>Triage: {format(triageTime, 'HH:mm')}</span>
                     </div>
                     
                     {attendedTime ? (
                        <div className="bg-green-50 border border-green-200 rounded px-2 py-1 text-xs text-green-800 font-bold inline-flex items-center gap-1">
                          <CheckCircle className="w-3 h-3"/>
                          Atendido en {waitTime} min
                        </div>
                     ) : (
                        <div className="flex items-center gap-2">
                            <span className="text-xs text-slate-400">Espera actual: {currentWait} min</span>
                            {isDoctor && (
                                <button 
                                  onClick={(e) => handleMarkAsAttended(e, rec._id)}
                                  className="bg-blue-600 hover:bg-blue-700 text-white text-[10px] px-2 py-1 rounded flex items-center gap-1 transition-colors"
                                >
                                  <Play className="w-3 h-3" fill="currentColor"/> Atender
                                </button>
                            )}
                        </div>
                     )}
                  </div>

                  <div className="flex flex-col items-end justify-center gap-2">
                     <div className="flex items-center gap-1 text-xs text-slate-400 font-mono bg-slate-100 px-2 py-1 rounded">
                        <ShieldCheck className="w-3 h-3" />
                        {rec.blockchainHash.substring(0, 8)}...
                     </div>
                     
                     {/* Correction Button - Only Doctors */}
                     {isDoctor && !attendedTime && (
                       <button
                         onClick={(e) => handleCorrection(e, rec)}
                         className="text-xs flex items-center gap-1 text-slate-500 hover:text-blue-600 border border-slate-200 hover:border-blue-300 px-2 py-1 rounded transition-colors"
                       >
                         <Edit2 className="w-3 h-3" /> Corregir Triage
                       </button>
                     )}
                     
                     {isExpanded ? <ChevronUp className="text-slate-400 mt-2" /> : <ChevronDown className="text-slate-400 mt-2" />}
                  </div>
                </div>
              </div>

              {/* Expanded Detail View */}
              {isExpanded && (
                <div className="bg-slate-50 border-t border-slate-200 p-6">
                  
                  {/* Traceability Section (Levels & Reasons) */}
                  <div className="mb-6 grid grid-cols-1 md:grid-cols-2 gap-4">
                     <div className="bg-white p-4 rounded-lg border border-slate-200">
                        <h4 className="font-bold text-slate-700 text-sm mb-3">Trazabilidad Algorítmica</h4>
                        <div className="space-y-2 text-sm">
                           <div className="flex justify-between">
                              <span className="text-slate-500">Recursos Contados:</span>
                              <span className="font-mono font-bold">{rec.patientData.resourcesCount || 0}</span>
                           </div>
                           <div className="flex justify-between">
                              <span className="text-slate-500">Nivel Sugerido (Sistema):</span>
                              <span className="font-bold">ESI {rec.patientData.suggestedEsiLevel}</span>
                           </div>
                           <div className="flex justify-between">
                              <span className="text-slate-500">Nivel Final (Médico):</span>
                              <span className="font-bold text-blue-700">ESI {rec.patientData.finalEsiLevel}</span>
                           </div>
                        </div>
                     </div>

                     <div className="space-y-2">
                        {hasOverride && (
                            <div className="bg-amber-50 p-4 rounded-lg border border-amber-200">
                              <h4 className="font-bold text-amber-800 text-sm mb-2 flex items-center gap-2">
                                  <Scale className="w-4 h-4"/> Justificación Médica
                              </h4>
                              {isDoctor ? (
                                <p className="text-sm text-amber-900 italic">"{rec.patientData.overrideReason}"</p>
                              ) : (
                                <p className="text-xs text-amber-900/60 italic flex items-center gap-1">
                                   <Lock className="w-3 h-3"/> Contenido justificado (Texto oculto por privacidad)
                                </p>
                              )}
                            </div>
                        )}
                        
                        {isCorrection && (
                            <div className="bg-purple-50 p-4 rounded-lg border border-purple-200">
                              <h4 className="font-bold text-purple-800 text-sm mb-2 flex items-center gap-2">
                                  <GitCommit className="w-4 h-4"/> Motivo de la Corrección
                              </h4>
                              {isDoctor ? (
                                <p className="text-sm text-purple-900 italic">"{rec.patientData.correctionReason}"</p>
                              ) : (
                                <p className="text-xs text-purple-900/60 italic flex items-center gap-1">
                                   <Lock className="w-3 h-3"/> Motivo registrado (Texto oculto por privacidad)
                                </p>
                              )}
                              <div className="mt-2 text-xs text-purple-600 font-mono">
                                Hash Padre: {rec.patientData.parentRecordHash?.substring(0,15)}...
                              </div>
                            </div>
                        )}
                     </div>
                  </div>

                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
                    
                    {/* COLUMNA 1: CONDICIONAL (CLÍNICA vs AUDITORÍA) */}
                    <div>
                      {isDoctor ? (
                          // VISTA DE MÉDICO: EXPEDIENTE CLÍNICO COMPLETO
                          <>
                            <h4 className="flex items-center gap-2 font-bold text-slate-700 mb-4">
                                <FileText className="w-4 h-4" /> Expediente Clínico Digital (Base de Datos)
                            </h4>
                            <div className="bg-white rounded-lg border border-slate-200 text-sm overflow-hidden">
                                <div className="bg-slate-50 p-3 border-b border-slate-100 flex justify-between items-center">
                                    <div className="flex items-center gap-2">
                                    <User className="w-4 h-4 text-slate-400"/>
                                    <span className="font-bold text-slate-700">{d.name}</span>
                                    </div>
                                    <span className="text-xs text-slate-500">{d.age} años | {d.gender}</span>
                                </div>
                                <div className="p-4 space-y-4">
                                    <div>
                                    <h5 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-2">Signos Vitales</h5>
                                    <div className="grid grid-cols-2 gap-2">
                                        <div className="flex items-center gap-2 text-slate-600">
                                            <Activity className="w-3 h-3 text-red-400"/>
                                            <span>FC: <strong>{d.vitals.heartRate}</strong> bpm</span>
                                        </div>
                                        <div className="flex items-center gap-2 text-slate-600">
                                            <Activity className="w-3 h-3 text-blue-400"/>
                                            <span>SpO2: <strong>{d.vitals.spo2}</strong>%</span>
                                        </div>
                                        <div className="flex items-center gap-2 text-slate-600">
                                            <Thermometer className="w-3 h-3 text-orange-400"/>
                                            <span>Temp: <strong>{d.vitals.temperature}</strong>°C</span>
                                        </div>
                                        <div className="text-slate-600">Dolor (EVA): <strong>{d.vitals.painLevel}/10</strong></div>
                                    </div>
                                    </div>
                                    <div>
                                    <h5 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-2">Hallazgos Críticos</h5>
                                    <div className="space-y-1">
                                        {Object.entries(d.checklist).filter(([_, val]) => val).length > 0 ? (
                                            Object.entries(d.checklist).filter(([_, val]) => val).map(([key, _]) => (
                                                <div key={key} className="flex items-center gap-2 text-xs bg-red-50 text-red-700 px-2 py-1 rounded border border-red-100">
                                                    <AlertTriangle className="w-3 h-3" />
                                                    {key.replace(/([A-Z])/g, ' $1').trim()}
                                                </div>
                                            ))
                                        ) : <div className="text-xs text-slate-400 italic">Sin hallazgos críticos.</div>}
                                    </div>
                                    </div>
                                    <div>
                                    <h5 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-1">Motivo Consulta</h5>
                                    <p className="text-slate-600 italic">"{d.symptoms}"</p>
                                    </div>
                                </div>
                            </div>
                          </>
                      ) : (
                          // VISTA DE AUDITOR: METADATOS TÉCNICOS Y TIEMPOS (PRIVACIDAD ACTIVADA)
                          <>
                            <h4 className="flex items-center gap-2 font-bold text-slate-700 mb-4">
                                <FileSearch className="w-4 h-4" /> Datos de Auditoría (Público)
                            </h4>
                            <div className="bg-white rounded-lg border border-slate-200 text-sm overflow-hidden">
                                <div className="bg-purple-50 p-3 border-b border-purple-100 flex items-center gap-2 text-purple-800">
                                    <Shield className="w-4 h-4"/>
                                    <span className="font-bold text-xs">Datos Sensibles Ocultos</span>
                                </div>
                                <div className="p-4 space-y-4">
                                    <div className="flex justify-between border-b border-slate-100 pb-2">
                                        <span className="text-slate-500">Triage ID (UUID)</span>
                                        <span className="font-mono text-xs font-bold text-slate-700 select-all">{d.id}</span>
                                    </div>
                                    <div className="flex justify-between border-b border-slate-100 pb-2">
                                        <span className="text-slate-500">Fecha Registro</span>
                                        <span className="font-bold text-slate-700">{format(d.triageTimestamp, 'dd/MM/yyyy')}</span>
                                    </div>
                                    <div className="flex justify-between border-b border-slate-100 pb-2">
                                        <span className="text-slate-500">Profesional (Wallet)</span>
                                        <div className="text-right">
                                            <div className="font-mono text-xs text-blue-600 truncate max-w-[150px]" title={d.doctorId}>{d.doctorId}</div>
                                        </div>
                                    </div>
                                    <div className="grid grid-cols-2 gap-4 pt-2">
                                        <div className="bg-slate-50 p-2 rounded border border-slate-100">
                                            <span className="block text-xs text-slate-400 mb-1">Hora Triage</span>
                                            <span className="font-mono font-bold text-slate-700">{format(d.triageTimestamp, 'HH:mm:ss')}</span>
                                        </div>
                                        <div className="bg-slate-50 p-2 rounded border border-slate-100">
                                            <span className="block text-xs text-slate-400 mb-1">Hora Atención</span>
                                            <span className={`font-mono font-bold ${d.attentionTimestamp ? 'text-green-600' : 'text-slate-400'}`}>
                                                {d.attentionTimestamp ? format(d.attentionTimestamp, 'HH:mm:ss') : '--:--:--'}
                                            </span>
                                        </div>
                                    </div>
                                </div>
                            </div>
                          </>
                      )}
                    </div>

                    {/* COLUMNA 2: VALIDACIÓN TÉCNICA (SIEMPRE VISIBLE) */}
                    <div>
                      <h4 className="flex items-center gap-2 font-bold text-slate-700 mb-4">
                        <ShieldCheck className="w-4 h-4" />
                        Validación de Seguridad del Registro
                      </h4>
                      <div className="space-y-3">
                        <div className="bg-white p-3 rounded border border-slate-200">
                           <div className="text-xs text-slate-400 uppercase mb-1">Huella Digital de Seguridad (Original)</div>
                           <div className="font-mono text-xs break-all text-green-700">{rec.blockchainHash}</div>
                        </div>
                        
                        <div className={`bg-white p-3 rounded border ${isIntegritySafe ? 'border-slate-200' : 'border-red-300 bg-red-50'}`}>
                           <div className="text-xs text-slate-400 uppercase mb-1">Huella Digital Actual (Calculada)</div>
                           <div className={`font-mono text-xs break-all ${isIntegritySafe ? 'text-slate-600' : 'text-red-600 font-bold'}`}>
                              {calculatedHash || "Calculando..."}
                           </div>
                           {!isIntegritySafe && (
                             <div className="mt-2 text-[10px] text-red-600 font-bold flex items-center gap-1">
                               <AlertTriangle className="w-3 h-3" />
                               ¡ALERTA DE SEGURIDAD! LOS DATOS HAN SIDO ALTERADOS
                             </div>
                           )}
                        </div>
                        
                        {rec.transactionHash && (
                           <div className="mt-4">
                             <a 
                               href={`https://amoy.polygonscan.com/tx/${rec.transactionHash}`} 
                               target="_blank" 
                               rel="noopener noreferrer"
                               className="block w-full text-center bg-purple-600 hover:bg-purple-700 text-white text-xs font-bold py-3 rounded-lg flex items-center justify-center gap-2 transition-colors"
                             >
                               <ExternalLink className="w-4 h-4" />
                               Verificar Transacción Pública
                             </a>
                           </div>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};