import React, { useEffect, useState } from 'react';
import { generateHash } from '../services/cryptoService';
import { dbService } from '../services/databaseService';
import { web3Service } from '../services/web3Service';
import { ESIBadge } from '../components/Badge';
import { CheckCircle, AlertTriangle, FileSearch, Clock, Hash, FileText, ChevronDown, ChevronUp, RefreshCw, Scale, Edit2, Play, GitCommit, ExternalLink, Info, Activity, Thermometer, User, Shield, Lock, EyeOff, ShieldCheck, Search, Calendar, Download } from 'lucide-react';
import { format, differenceInMinutes } from 'date-fns';
import { HybridRecord, UserRole } from '../types';

import { IntegrityStatus, IntegrityReason, REASON_TEXT, classifyRecords, findUnlinkedAnchors, AuditInput } from '../shared/anchorAudit';

// Regla de verificación (shared/anchorAudit.ts): VALIDO si la transacción del registro ancló exactamente
// su hash recalculado; ALTERADO si no; NO_VERIFICADO si no se pudo consultar la cadena o la transacción.

interface AuditListProps {
  userRole?: UserRole; // To decide if we show Edit buttons
  onCorrectRecord?: (record: HybridRecord) => void;
  onReEvaluateRecord?: (record: HybridRecord) => void;
}

export const AuditList: React.FC<AuditListProps> = ({ userRole, onCorrectRecord, onReEvaluateRecord }) => {
  const [mongoRecords, setMongoRecords] = useState<HybridRecord[]>([]);
  const [validationMap, setValidationMap] = useState<Record<string, IntegrityStatus>>({});
  const [reasonMap, setReasonMap] = useState<Record<string, IntegrityReason>>({});
  // Hashes anclados sin registro válido: ligados a un registro alterado, o sin ningún registro (eliminación)
  const [unlinked, setUnlinked] = useState<{ linkedToAltered: any[]; withoutRecord: any[] }>({ linkedToAltered: [], withoutRecord: [] });
  const [chainError, setChainError] = useState<string | null>(null);
  const [calculatedHashMap, setCalculatedHashMap] = useState<Record<string, string>>({}); // NEW: Store actual calculated hashes
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [dateFilter, setDateFilter] = useState('');
  const [dbError, setDbError] = useState<string | null>(null);

  const isDoctor = userRole === UserRole.DOCTOR;

  // Load data and validate
  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    setLoading(true);
    setDbError(null);
    try {
      // 1. Get Off-chain Data (Real MongoDB via API)
      const dbData = await dbService.getAllRecords(); // Await added here
      setMongoRecords(dbData);

      // 2. Todos los hashes anclados en el contrato (no solo los últimos N). Si la cadena no se
      // puede consultar por completo, ningún registro se marca como válido: queda "no verificado".
      let chainData: any[] = [];
      let anchoredHashes: Set<string> | null = null;
      let txs = new Map();
      try {
        chainData = await web3Service.getAllAnchoredRecords();
        anchoredHashes = new Set(chainData.map(c => String(c.dataHash).toLowerCase()));
        // 3. La transacción de anclaje de cada registro, para comprobar que ancló SU hash
        txs = await web3Service.getAnchorTransactions(
          dbData.map(r => r.transactionHash).filter((h): h is string => !!h)
        );
        setChainError(null);
      } catch (chainErr: any) {
        console.error("No se pudo leer la blockchain para verificar integridad:", chainErr);
        anchoredHashes = null;
        setChainError(chainErr?.message || 'No se pudo consultar el contrato en Polygon Amoy.');
      }

      // 4. Hash recalculado con los datos que acaban de llegar de MongoDB, comparado SOLO contra la
      // cadena: nunca contra el blockchainHash guardado en el mismo documento (que podría estar alterado).
      const inputs: AuditInput[] = [];
      const cMap: Record<string, string> = {};
      for (const rec of dbData) {
        const currentHash = await generateHash(rec.patientData);
        cMap[rec._id] = currentHash;
        inputs.push({ id: rec._id, recomputedHash: currentHash, transactionHash: rec.transactionHash, storedHash: rec.blockchainHash });
      }
      const verdicts = classifyRecords(inputs, anchoredHashes, txs);
      const vMap: Record<string, IntegrityStatus> = {};
      const rMap: Record<string, IntegrityReason> = {};
      verdicts.forEach((v, id) => { vMap[id] = v.status; rMap[id] = v.reason; });

      setValidationMap(vMap);
      setReasonMap(rMap);
      setCalculatedHashMap(cMap);
      // 5. Hashes anclados sin registro válido (solo si la cadena se leyó completa)
      setUnlinked(anchoredHashes === null
        ? { linkedToAltered: [], withoutRecord: [] }
        : findUnlinkedAnchors(chainData, inputs, verdicts));
    } catch (e: any) {
      console.error("Audit load failed", e);
      setDbError(e.message || "Error al conectar con MongoDB Local");
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

  const handleReEvaluation = (e: React.MouseEvent, record: HybridRecord) => {
    e.stopPropagation();
    if (onReEvaluateRecord) onReEvaluateRecord(record);
  };

  if (loading) {
     return (
        <div className="flex flex-col items-center justify-center h-96 text-slate-400">
           <RefreshCw className="w-10 h-10 animate-spin mb-4 text-blue-500" />
           <p>Verificando Historial de Pacientes...</p>
        </div>
     );
  }

  if (dbError) {
    return (
      <div className="flex flex-col items-center justify-center p-8 bg-white rounded-2xl border border-red-200 shadow-sm max-w-xl mx-auto text-center my-12">
        <div className="p-3 bg-red-100 text-red-600 rounded-full mb-3">
          <AlertTriangle className="w-10 h-10" />
        </div>
        <h3 className="text-xl font-bold text-slate-800 mb-2">Error: No se pudo conectar a MongoDB Local</h3>
        <p className="text-slate-600 mb-6 text-sm leading-relaxed">{dbError}</p>
        <button
          onClick={loadData}
          className="px-5 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-xl font-medium shadow-sm transition-colors flex items-center gap-2"
        >
          <RefreshCw className="w-4 h-4" />
          <span>Reintentar Conexión</span>
        </button>
      </div>
    );
  }

  // Sin registros y sin anclajes huérfanos: historial vacío. Si hay anclajes sin registro (todos
  // eliminados), se muestra la vista normal para que aparezca la alerta.
  if (mongoRecords.length === 0 && unlinked.withoutRecord.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-96 text-slate-400">
        <FileSearch className="w-16 h-16 mb-4 opacity-50" />
        <p>No hay registros médicos en el historial.</p>
      </div>
    );
  }

  const filteredRecords = mongoRecords.filter(rec => {
    const d = rec.patientData;
    const matchesSearch = searchTerm === '' || 
      d.cedula.includes(searchTerm) || 
      rec.blockchainHash.toLowerCase().includes(searchTerm.toLowerCase()) ||
      (rec.transactionHash && rec.transactionHash.toLowerCase().includes(searchTerm.toLowerCase()));
      
    const recordDate = format(d.triageTimestamp, 'yyyy-MM-dd');
    const matchesDate = dateFilter === '' || recordDate === dateFilter;
    
    return matchesSearch && matchesDate;
  });

  const exportToCSV = () => {
    const headers = [
      "ID Registro",
      "Fecha Triage",
      "Hora Triage",
      "Cedula",
      "Nivel Sugerido",
      "Nivel IA",
      "Nivel Final",
      "Modificado (Override)",
      "Estado Integridad",
      "Motivo",
      "Hash Blockchain",
      "TxHash"
    ];

    const rows = filteredRecords.map(rec => {
      const d = rec.patientData;
      const integrity = validationMap[rec._id] ?? 'NO_VERIFICADO';
      const hasOverride = d.suggestedEsiLevel != null && d.suggestedEsiLevel !== d.finalEsiLevel;

      return [
        rec._id,
        format(d.triageTimestamp, 'yyyy-MM-dd'),
        format(d.triageTimestamp, 'HH:mm:ss'),
        isDoctor ? d.cedula : "*** PROTEGIDO ***",
        d.suggestedEsiLevel ?? "N/A",
        d.aiLevel ?? "N/A", // N/A: la IA no se ejecutó en este triage
        d.finalEsiLevel,
        hasOverride ? "SI" : "NO",
        integrity === 'VALIDO' ? "VALIDO" : integrity === 'ALTERADO' ? "ALTERADO" : "NO VERIFICADO",
        reasonMap[rec._id] ?? "SIN_CADENA",
        rec.blockchainHash,
        rec.transactionHash || "N/A"
      ].map(val => `"${val}"`).join(",");
    });

    const csvContent = [headers.join(","), ...rows].join("\n");
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", `reporte_auditoria_${format(Date.now(), 'yyyyMMdd_HHmm')}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold text-slate-800">Historial de Triage de Pacientes</h2>
        <div className="text-sm text-slate-500 flex items-center gap-2">
           <div className="w-2 h-2 rounded-full bg-green-500"></div>
           <span>Sincronizado</span>
           <button onClick={loadData} className="ml-4 p-2 bg-slate-100 rounded-full hover:bg-slate-200" title="Actualizar datos">
             <RefreshCw className="w-4 h-4" />
           </button>
           <button 
             onClick={exportToCSV} 
             className="ml-2 p-2 bg-blue-50 text-blue-600 rounded-full hover:bg-blue-100 flex items-center gap-2 px-4 transition-colors font-medium"
             title="Exportar a CSV"
           >
             <Download className="w-4 h-4" />
             <span className="hidden sm:inline">Exportar Reporte</span>
           </button>
        </div>
      </div>

      {chainError && (
        <div className="bg-amber-50 border border-amber-200 text-amber-800 p-4 rounded-xl text-sm flex items-start gap-2">
          <Info className="w-4 h-4 mt-0.5 shrink-0" />
          <span>
            <strong>Integridad no verificada:</strong> no se pudo leer la blockchain ({chainError}). Los registros se muestran como
            "No verificado" hasta que la consulta al contrato funcione; pulse actualizar para reintentar.
          </span>
        </div>
      )}

      {/* Hashes anclados en el contrato que no corresponden a ningún registro válido */}
      {unlinked.withoutRecord.length > 0 && (
        <div className="bg-red-50 border border-red-200 text-red-800 p-4 rounded-xl text-sm">
          <div className="flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
            <span>
              <strong>{unlinked.withoutRecord.length} registro(s) anclado(s) en la blockchain sin registro en la base de datos.</strong>{' '}
              El hash fue anclado, pero ningún registro de MongoDB lo reclama: el registro pudo haber sido eliminado.
            </span>
          </div>
          <ul className="mt-2 ml-6 space-y-1 font-mono text-xs">
            {unlinked.withoutRecord.map(c => (
              <li key={c.id}>
                #{c.id} · {format(c.timestamp, 'yyyy-MM-dd HH:mm')} · nivel {c.triageLevel} · {String(c.dataHash).substring(0, 16)}...
              </li>
            ))}
          </ul>
        </div>
      )}
      {unlinked.linkedToAltered.length > 0 && (
        <div className="bg-slate-50 border border-slate-200 text-slate-600 p-3 rounded-xl text-xs flex items-start gap-2">
          <Info className="w-4 h-4 shrink-0" />
          <span>
            Otros {unlinked.linkedToAltered.length} hash(es) anclado(s) corresponden a registros que ya aparecen como alterados
            (su contenido actual no coincide con lo anclado).
          </span>
        </div>
      )}

      {/* Buscador y Filtros */}
      <div className="flex flex-col md:flex-row gap-4 bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
        <div className="flex-1 relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <input 
            type="text" 
            placeholder="Buscar por Cédula o TxHash..." 
            className="w-full pl-9 pr-4 py-2 border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none text-sm"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
        </div>
        <div className="relative">
          <Calendar className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <input 
            type="date" 
            className="pl-9 pr-4 py-2 border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none text-sm text-slate-600"
            value={dateFilter}
            onChange={(e) => setDateFilter(e.target.value)}
          />
        </div>
        {(searchTerm || dateFilter) && (
          <button 
            onClick={() => { setSearchTerm(''); setDateFilter(''); }}
            className="px-4 py-2 text-sm text-slate-500 hover:bg-slate-100 rounded-lg transition-colors"
          >
            Limpiar
          </button>
        )}
      </div>

      {filteredRecords.length === 0 && (
        <div className="flex flex-col items-center justify-center h-48 text-slate-400 bg-white rounded-xl border border-slate-200 border-dashed">
          <Search className="w-16 h-16 mb-4 opacity-30" />
          <p>No se encontraron registros que coincidan con la búsqueda.</p>
        </div>
      )}

      {filteredRecords.length > 0 && (
        <div className="grid gap-4">
          {filteredRecords.map((rec) => {
          const integrity = validationMap[rec._id] ?? 'NO_VERIFICADO';
          const isIntegritySafe = integrity === 'VALIDO';
          const isTampered = integrity === 'ALTERADO';
          const calculatedHash = calculatedHashMap[rec._id];
          const isExpanded = expandedId === rec._id;
          const hasOverride = rec.patientData.suggestedEsiLevel != null && rec.patientData.suggestedEsiLevel !== rec.patientData.finalEsiLevel;
          const isCorrection = !!rec.patientData.parentRecordHash;
          const d = rec.patientData; // Shortcut
          
          // Time Calculations
          const triageTime = rec.patientData.triageTimestamp;
          const attendedTime = rec.patientData.attentionTimestamp;
          const waitTime = attendedTime ? differenceInMinutes(attendedTime, triageTime) : null;
          const now = Date.now();
          const currentWait = differenceInMinutes(now, triageTime);

          return (
            <div key={rec._id} className={`bg-white rounded-xl shadow-sm border overflow-hidden transition-all ${isIntegritySafe ? 'border-slate-200' : isTampered ? 'border-red-300 ring-2 ring-red-100' : 'border-amber-300'}`}>
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
                   ) : isTampered ? (
                     <>
                       <div className="w-10 h-10 bg-red-100 rounded-full flex items-center justify-center mb-2 animate-pulse">
                         <AlertTriangle className="w-5 h-5 text-red-600" />
                       </div>
                       <span className="text-[10px] font-bold text-red-700 uppercase tracking-wider">Alterado</span>
                     </>
                   ) : (
                     <>
                       <div className="w-10 h-10 bg-amber-100 rounded-full flex items-center justify-center mb-2">
                         <Info className="w-5 h-5 text-amber-600" />
                       </div>
                       <span className="text-[10px] font-bold text-amber-700 uppercase tracking-wider text-center">No verificado</span>
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
                           (() => {
                             const isReEval = d.correctionReason?.toLowerCase().includes('re-eval') || 
                                              d.correctionReason?.toLowerCase().includes('cambio') || 
                                              d.correctionReason?.toLowerCase().includes('estado') || 
                                              d.correctionReason?.toLowerCase().includes('deterioro');
                             return (
                               <span className={`text-[10px] px-2 py-0.5 rounded font-bold border flex items-center gap-1 ${
                                 isReEval 
                                   ? 'bg-blue-100 text-blue-700 border-blue-200' 
                                   : 'bg-purple-100 text-purple-700 border-purple-200'
                               }`}>
                                 <GitCommit className="w-3 h-3"/> {isReEval ? 'RE-EVALUACIÓN' : 'CORRECCIÓN'}
                               </span>
                             );
                           })()
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
                        <span className="text-xs text-slate-400">En espera: {currentWait} min</span>
                     )}
                  </div>

                  <div className="flex flex-col items-end justify-center gap-2">
                     <div className="flex items-center gap-1 text-xs text-slate-400 font-mono bg-slate-100 px-2 py-1 rounded">
                        <ShieldCheck className="w-3 h-3" />
                        {rec.blockchainHash.substring(0, 8)}...
                     </div>
                     
                     {/* Correction & Re-evaluation Buttons - Only Doctors and only if not yet attended */}
                     {isDoctor && !attendedTime && (
                       <div className="flex flex-col sm:flex-row gap-1.5 mt-1">
                         <button
                           onClick={(e) => handleCorrection(e, rec)}
                           className="text-[10px] sm:text-xs flex items-center gap-1 text-amber-600 hover:text-amber-700 bg-amber-50 hover:bg-amber-100 border border-amber-200 px-2.5 py-1.5 rounded-lg transition-colors font-medium shadow-sm"
                           title="Anexar una nota aclaratoria para corregir un error en este registro"
                         >
                           <Edit2 className="w-3 h-3" /> Corregir Error (Nota)
                         </button>
                         <button
                           onClick={(e) => handleReEvaluation(e, rec)}
                           className="text-[10px] sm:text-xs flex items-center gap-1 text-blue-600 hover:text-blue-700 bg-blue-50 hover:bg-blue-100 border border-blue-200 px-2.5 py-1.5 rounded-lg transition-colors font-medium shadow-sm"
                           title="Realizar un nuevo triage por cambio en el estado clínico del paciente"
                         >
                           <RefreshCw className="w-3 h-3" /> Re-evaluar (Estado)
                         </button>
                       </div>
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
                        <h4 className="font-bold text-slate-700 text-sm mb-3">Trazabilidad de la Clasificación</h4>
                        <div className="space-y-2 text-sm">
                           <div className="flex justify-between">
                              <span className="text-slate-500">Nivel Sugerido:</span>
                              <span className="font-bold">{rec.patientData.suggestedEsiLevel != null ? `ESI ${rec.patientData.suggestedEsiLevel}` : 'Sin sugerencia de IA'}</span>
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
                                  <GitCommit className="w-4 h-4"/> Información Anexa
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
                                            <span>FC: <strong>{d.vitals?.heartRate || '-'}</strong> lpm</span>
                                        </div>
                                        <div className="flex items-center gap-2 text-slate-600">
                                            <Activity className="w-3 h-3 text-blue-400"/>
                                            <span>SpO2: <strong>{d.vitals?.spo2 || '-'}</strong>%</span>
                                        </div>
                                        <div className="flex items-center gap-2 text-slate-600">
                                            <Thermometer className="w-3 h-3 text-orange-400"/>
                                            <span>Temp: <strong>{d.vitals?.temperature || '-'}</strong>°C</span>
                                        </div>
                                        <div className="flex items-center gap-2 text-slate-600">
                                            <Activity className="w-3 h-3 text-emerald-500"/>
                                            <span>PA: <strong>{d.vitals?.bloodPressureSys || '-'}/{d.vitals?.bloodPressureDia || '-'}</strong> mmHg</span>
                                        </div>
                                        {((d.vitals as any)?.bloodPressureMap || (d.vitals?.bloodPressureSys && d.vitals?.bloodPressureDia)) && (
                                            <div className="flex items-center gap-2 text-slate-600 col-span-2 bg-blue-50/50 dark:bg-slate-800/10 px-2 py-1 rounded text-xs">
                                                <span>PAM: <strong>{(d.vitals as any)?.bloodPressureMap || Math.round((d.vitals.bloodPressureSys + 2 * d.vitals.bloodPressureDia) / 3)}</strong> mmHg</span>
                                            </div>
                                        )}
                                        <div className="text-slate-600 col-span-2">Dolor (EVA): <strong>{d.vitals?.painLevel || '0'}/10</strong></div>
                                    </div>
                                    </div>
                                    <div>
                                    <h5 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-2">Escala de Glasgow</h5>
                                    <div className="flex items-center gap-2 mb-2">
                                        <div className={`text-lg font-bold ${d.glasgow?.total <= 8 ? 'text-red-600' : 'text-slate-800'}`}>
                                            {d.glasgow?.total || 'N/A'} / 15
                                        </div>
                                        <span className="text-xs text-slate-500">
                                            (O: {d.glasgow?.eyeOpening || '-'} | V: {d.glasgow?.verbalResponse || '-'} | M: {d.glasgow?.motorResponse || '-'})
                                        </span>
                                    </div>
                                    </div>
                                    <div>
                                    <h5 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-2">Hallazgos Críticos</h5>
                                    <div className="space-y-1">
                                        {Object.entries(d.checklist || {}).filter(([_, val]) => val).length > 0 ? (
                                            Object.entries(d.checklist || {}).filter(([_, val]) => val).map(([key, _]) => (
                                                <div key={key} className="flex items-center gap-2 text-xs bg-red-50 text-red-700 px-2 py-1 rounded border border-red-100">
                                                    <AlertTriangle className="w-3 h-3" />
                                                    {key.replace(/([A-Z])/g, ' $1').trim()}
                                                </div>
                                            ))
                                        ) : <div className="text-xs text-slate-400 italic">Sin hallazgos críticos.</div>}
                                    </div>
                                    </div>
                                    <div>
                                    <h5 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-1">Motivo Consulta (Paciente)</h5>
                                    <p className="text-slate-600 italic mb-2">"{d.symptoms}"</p>
                                    
                                    <h5 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-1">Enfermedad Actual (Médico)</h5>
                                    <p className="text-slate-800 text-sm">{d.currentIllness || "No registrado"}</p>
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
                        
                        <div className={`bg-white p-3 rounded border ${isTampered ? 'border-red-300 bg-red-50' : 'border-slate-200'}`}>
                           <div className="text-xs text-slate-400 uppercase mb-1">Huella Digital Actual (Calculada)</div>
                           <div className={`font-mono text-xs break-all ${isTampered ? 'text-red-600 font-bold' : 'text-slate-600'}`}>
                              {calculatedHash || "Calculando..."}
                           </div>
                           {isTampered && (
                             <div className="mt-2 text-[10px] text-red-600 font-bold flex items-center gap-1">
                               <AlertTriangle className="w-3 h-3" />
                               {reasonMap[rec._id] === 'NO_ANCLADO' || !reasonMap[rec._id]
                                 ? '¡ALERTA DE SEGURIDAD! EL HASH ACTUAL NO ESTÁ ANCLADO EN LA BLOCKCHAIN: LOS DATOS HAN SIDO ALTERADOS'
                                 : `¡ALERTA DE SEGURIDAD! ${REASON_TEXT[reasonMap[rec._id]].toUpperCase()}`}
                             </div>
                           )}
                           {integrity === 'NO_VERIFICADO' && (
                             <div className="mt-2 text-[10px] text-amber-700 font-bold flex items-center gap-1">
                               <Info className="w-3 h-3" />
                               {reasonMap[rec._id] === 'TX_NO_CONSULTADA'
                                 ? 'No se pudo consultar la transacción del registro: integridad sin verificar'
                                 : 'No se pudo consultar la blockchain: integridad sin verificar'}
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
      )}
    </div>
  );
};