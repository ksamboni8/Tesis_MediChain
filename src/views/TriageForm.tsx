import React, { useState, useEffect } from 'react';
import { Card } from '../components/Card';
import { ESILevel } from '../types';
import type { PatientData, VitalSigns, ESIChecklist, HybridRecord } from '../types';
import { BluetoothDeviceController, simulateIoTReadings } from '../services/bluetoothService';
import { Activity, Thermometer, Bluetooth, Save, RefreshCw, AlertTriangle, ShieldAlert, Stethoscope, Check, FileWarning } from 'lucide-react';
import { ESIBadge } from '../components/Badge';
import { dbService } from '../services/databaseService';
import { web3Service } from '../services/web3Service';
import { generateHash } from '../services/cryptoService';
import { addMinutes } from 'date-fns';

interface TriageFormProps {
  walletAddress: string;
  initialData?: HybridRecord; // For Correction Mode
  onSuccess?: () => void;
}

const RESOURCES_LIST = [
  "Laboratorio (Sangre/Orina)", "ECG", "Rayos X", "TAC / Escáner", 
  "Ecografía", "Medicación IV/IM", "Nebulización", 
  "Interconsulta Especialista", "Procedimiento Complejo (Sutura, etc)"
];

export const TriageForm: React.FC<TriageFormProps> = ({ walletAddress, initialData, onSuccess }) => {
  const [isScanning, setIsScanning] = useState(false);
  const isCorrectionMode = !!initialData;
  
  // 1. Patient Data
  const [patientInfo, setPatientInfo] = useState({
    cedula: '', name: '', age: '', gender: 'M', symptoms: ''
  });
  
  // 2. Vitals (IoT)
  const [vitals, setVitals] = useState<VitalSigns>({
    heartRate: 0, spo2: 0, temperature: 0, respiratoryRate: 0, 
    bloodPressureSys: 0, bloodPressureDia: 0, painLevel: 0
  });

  // 3. ESI Logic State
  const [checklist, setChecklist] = useState<ESIChecklist>({
    cardiacArrest: false, airwayCompromise: false, severeRespiratoryDistress: false,
    shockSigns: false, unresponsive: false,
    confusedLethargic: false, severePainDistress: false, highRiskCondition: false
  });
  
  const [selectedResources, setSelectedResources] = useState<string[]>([]);
  
  // 4. Results & Override
  const [suggestedLevel, setSuggestedLevel] = useState<ESILevel>(ESILevel.FIVE);
  const [finalLevel, setFinalLevel] = useState<ESILevel>(ESILevel.FIVE);
  const [overrideReason, setOverrideReason] = useState('');
  
  // 5. Correction Specifics
  const [correctionReason, setCorrectionReason] = useState('');

  const [dangerZoneHit, setDangerZoneHit] = useState<string[]>([]);
  const [status, setStatus] = useState<'IDLE' | 'HASHING' | 'MINING' | 'SUCCESS' | 'ERROR'>('IDLE');
  const [statusMsg, setStatusMsg] = useState('');
  const [bleController] = useState(() => new BluetoothDeviceController());

  // Load Initial Data if Correcting
  useEffect(() => {
    if (initialData) {
      const d = initialData.patientData;
      setPatientInfo({
        cedula: d.cedula, name: d.name, age: d.age.toString(), gender: d.gender, symptoms: d.symptoms
      });
      setVitals(d.vitals);
      setChecklist(d.checklist);
      setSelectedResources(d.selectedResources);
      // We don't set finalLevel immediately to allow re-calculation, 
      // but we could set overrideReason if it existed.
      if (d.overrideReason) setOverrideReason(d.overrideReason);
    }
  }, [initialData]);

  // --- ALGORITHM: ESI v4 ENGINE ---
  useEffect(() => {
    const runESIAlgorithm = () => {
      let level: ESILevel = ESILevel.FIVE;
      let dangers: string[] = [];

      // A. IMMEDIATE (ESI 1)
      if (checklist.cardiacArrest || checklist.airwayCompromise || 
          checklist.severeRespiratoryDistress || checklist.shockSigns || 
          checklist.unresponsive || (vitals.spo2 > 0 && vitals.spo2 < 85)) {
        setSuggestedLevel(ESILevel.ONE);
        setDangerZoneHit([]);
        return;
      }

      // B. HIGH RISK / EMERGENT (ESI 2)
      if (checklist.highRiskCondition || checklist.confusedLethargic || 
          checklist.severePainDistress || vitals.painLevel >= 7) {
        setSuggestedLevel(ESILevel.TWO);
        setDangerZoneHit([]);
        return;
      }

      // C. RESOURCES (ESI 3, 4, 5)
      const resCount = selectedResources.length;
      let provisional: ESILevel = ESILevel.FIVE;
      
      if (resCount === 0) provisional = ESILevel.FIVE;
      else if (resCount === 1) provisional = ESILevel.FOUR;
      else provisional = ESILevel.THREE; // >= 2 resources

      // D. DANGER ZONE VITALS
      if (provisional === ESILevel.THREE) {
        if (vitals.heartRate > 100) dangers.push(`Taquicardia (${vitals.heartRate} bpm)`);
        if (vitals.spo2 > 0 && vitals.spo2 < 92) dangers.push(`Hipoxia (${vitals.spo2}%)`);
        if (vitals.respiratoryRate > 20) dangers.push(`Taquipnea (${vitals.respiratoryRate} rpm)`);
        if (vitals.temperature > 39 || vitals.temperature < 36) dangers.push(`Temp anormal (${vitals.temperature}°C)`);

        if (dangers.length > 0) level = ESILevel.TWO;
        else level = ESILevel.THREE;
      } else {
        level = provisional;
      }

      setSuggestedLevel(level);
      setDangerZoneHit(dangers);
    };

    runESIAlgorithm();
  }, [checklist, vitals, selectedResources, patientInfo.age]);

  // Sync Final Level if not overriden
  useEffect(() => {
    if (!overrideReason && !isCorrectionMode) {
       setFinalLevel(suggestedLevel);
    }
  }, [suggestedLevel, isCorrectionMode, overrideReason]);

  const handleIoTConnect = async () => {
    setIsScanning(true);
    try {
      const data = await bleController.requestDevice() ? await bleController.connect() : simulateIoTReadings();
      if (data) setVitals(prev => ({ ...prev, ...data }));
    } catch (e) {
      setVitals(prev => ({ ...prev, ...simulateIoTReadings() }));
    } finally {
      setIsScanning(false);
    }
  };

  const toggleResource = (res: string) => {
    if (selectedResources.includes(res)) setSelectedResources(prev => prev.filter(r => r !== res));
    else setSelectedResources(prev => [...prev, res]);
  };

  const getAttentionTime = (level: ESILevel) => {
    const now = new Date();
    const map = {1: 0, 2: 10, 3: 60, 4: 120, 5: 180};
    return addMinutes(now, map[level as keyof typeof map]);
  };

  const handleSubmit = async () => {
    if (suggestedLevel !== finalLevel && !overrideReason.trim()) {
      alert("⚠️ REQUERIDO: Debe justificar por qué cambió el nivel sugerido por el sistema.");
      return;
    }

    if (isCorrectionMode && !correctionReason.trim()) {
      alert("⚠️ REQUERIDO: Para corregir un registro existente, debe explicar la razón del cambio (Error de digitación, Re-evaluación, etc.)");
      return;
    }

    setStatus('HASHING');
    setStatusMsg("Calculando SHA-256 (Inmutabilidad)...");

    const recordId = crypto.randomUUID();
    const newPatientData: PatientData = {
      id: recordId,
      cedula: patientInfo.cedula,
      name: patientInfo.name,
      age: parseInt(patientInfo.age),
      gender: patientInfo.gender as 'M'|'F'|'O',
      symptoms: patientInfo.symptoms,
      vitals,
      checklist,
      selectedResources,
      resourcesCount: selectedResources.length,
      suggestedEsiLevel: suggestedLevel,
      finalEsiLevel: finalLevel,
      overrideReason: overrideReason || "Concordancia con Algoritmo",
      triageTimestamp: Date.now(),
      estimatedAttentionTime: getAttentionTime(finalLevel).getTime(),
      doctorId: walletAddress,
      
      // Fields for Correction Traceability
      parentRecordHash: initialData ? initialData.blockchainHash : undefined,
      correctionReason: isCorrectionMode ? correctionReason : undefined
    };

    try {
      // 1. Generate Hash (Now includes parentRecordHash)
      const dataHash = await generateHash(newPatientData);

      // 2. Blockchain
      setStatus('MINING');
      setStatusMsg("Firmando en Blockchain (Polygon)...");
      
      const logicSignature = isCorrectionMode ? `CORRECTION:${correctionReason.substring(0,10)}` : (suggestedLevel === finalLevel ? "ALGO_MATCH" : "MD_OVERRIDE");

      // web3Service returns the Transaction Response object
      const tx = await web3Service.registerTriage(
        patientInfo.cedula,
        dataHash,
        finalLevel,
        logicSignature
      );

      // CAPTURE THE REAL TRANSACTION HASH
      const txHash = tx.hash;

      setStatusMsg("Guardando en Base de Datos...");

      // 3. Database (Send txHash to backend)
      await dbService.insertRecord(newPatientData, walletAddress, txHash);

      setStatus('SUCCESS');
      setStatusMsg("Registro Completado.");
      
      setTimeout(() => {
        setStatus('IDLE');
        if (onSuccess) onSuccess();
      }, 2000);

    } catch (error: any) {
      console.error(error);
      setStatus('ERROR');
      setStatusMsg(error.message || "Error Crítico");
    }
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 relative">
      
      {isCorrectionMode && (
        <div className="lg:col-span-12 bg-amber-50 border border-amber-200 p-4 rounded-xl flex items-center justify-between">
           <div className="flex items-center gap-3">
              <FileWarning className="w-8 h-8 text-amber-600" />
              <div>
                <h2 className="font-bold text-amber-800 text-lg">Modo de Corrección de Triage</h2>
                <p className="text-sm text-amber-700">Está editando un registro ya existente. Se generará un nuevo bloque enlazado al anterior.</p>
              </div>
           </div>
           <div className="text-xs font-mono text-amber-800/60 hidden md:block">
              Hash Padre: {initialData?.blockchainHash.substring(0, 15)}...
           </div>
        </div>
      )}

      {/* LEFT COLUMN: DATA ENTRY (7/12) */}
      <div className="lg:col-span-7 space-y-6">
        
        {/* 1. DATOS PACIENTE */}
        <Card title="1. Datos del Paciente">
          <div className="grid grid-cols-2 gap-4">
            <input 
              className="px-3 py-2 border rounded-lg" placeholder="Cédula / ID"
              value={patientInfo.cedula} onChange={e => setPatientInfo({...patientInfo, cedula: e.target.value})}
              disabled={isCorrectionMode} // ID shouldn't change in correction usually
            />
            <input 
              className="px-3 py-2 border rounded-lg" placeholder="Nombre Completo"
              value={patientInfo.name} onChange={e => setPatientInfo({...patientInfo, name: e.target.value})}
              disabled={isCorrectionMode}
            />
            <div className="grid grid-cols-2 gap-2">
               <input 
                type="number" className="px-3 py-2 border rounded-lg" placeholder="Edad"
                value={patientInfo.age} onChange={e => setPatientInfo({...patientInfo, age: e.target.value})}
              />
              <select 
                className="px-3 py-2 border rounded-lg"
                value={patientInfo.gender} onChange={e => setPatientInfo({...patientInfo, gender: e.target.value})}
              >
                <option value="M">Masculino</option>
                <option value="F">Femenino</option>
              </select>
            </div>
            <textarea 
              rows={1} className="px-3 py-2 border rounded-lg col-span-2" placeholder="Motivo de Consulta / Síntomas"
              value={patientInfo.symptoms} onChange={e => setPatientInfo({...patientInfo, symptoms: e.target.value})}
            />
          </div>
        </Card>

        {/* 2. ESI STEP A & B Checklists */}
        <Card title="2. Evaluación Crítica (A & B)">
          <div className="space-y-4">
            <div className="bg-red-50 p-4 rounded-lg border border-red-100">
              <h4 className="text-sm font-bold text-red-800 mb-2 flex items-center gap-2">
                <ShieldAlert className="w-4 h-4"/> A. ¿Requiere Intervención Inmediata? (ESI 1)
              </h4>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-sm">
                {[
                  ['cardiacArrest', 'Paro Cardiorrespiratorio'],
                  ['airwayCompromise', 'Compromiso Vía Aérea'],
                  ['severeRespiratoryDistress', 'Dificultad Resp. Severa / Apnea'],
                  ['shockSigns', 'Signos de Shock / Hipoperfusión'],
                  ['unresponsive', 'Inconsciente (Glasgow < 8)']
                ].map(([key, label]) => (
                  <label key={key} className="flex items-center gap-2 cursor-pointer hover:bg-red-100 p-1 rounded">
                    <input 
                      type="checkbox" 
                      checked={checklist[key as keyof ESIChecklist]}
                      onChange={e => setChecklist({...checklist, [key]: e.target.checked})}
                      className="w-4 h-4 text-red-600 rounded focus:ring-red-500"
                    />
                    <span className="text-slate-700">{label}</span>
                  </label>
                ))}
              </div>
            </div>

            <div className="bg-orange-50 p-4 rounded-lg border border-orange-100">
              <h4 className="text-sm font-bold text-orange-800 mb-2 flex items-center gap-2">
                <AlertTriangle className="w-4 h-4"/> B. ¿Alto Riesgo / Situación Emergente? (ESI 2)
              </h4>
               <div className="grid grid-cols-1 gap-2 text-sm">
                  <label className="flex items-center gap-2 cursor-pointer hover:bg-orange-100 p-1 rounded">
                    <input type="checkbox" checked={checklist.highRiskCondition} onChange={e => setChecklist({...checklist, highRiskCondition: e.target.checked})} className="w-4 h-4 text-orange-600 rounded"/>
                    <span className="text-slate-700">Alto Riesgo Clínico (Sepsis, ACV, Dolor Torácico, Sangrado)</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer hover:bg-orange-100 p-1 rounded">
                    <input type="checkbox" checked={checklist.confusedLethargic} onChange={e => setChecklist({...checklist, confusedLethargic: e.target.checked})} className="w-4 h-4 text-orange-600 rounded"/>
                    <span className="text-slate-700">Estado Mental Alterado (Confuso / Letárgico)</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer hover:bg-orange-100 p-1 rounded">
                    <input type="checkbox" checked={checklist.severePainDistress} onChange={e => setChecklist({...checklist, severePainDistress: e.target.checked})} className="w-4 h-4 text-orange-600 rounded"/>
                    <span className="text-slate-700">Dolor Severo / Sufrimiento Intenso (Manual)</span>
                  </label>
              </div>
            </div>
          </div>
        </Card>

        {/* 3. ESI STEP C: Resources */}
        <Card title="3. Estimación de Recursos (Paso C)">
           <div className="mb-3 text-xs text-slate-500 flex gap-2">
              <span className="bg-slate-100 px-2 py-1 rounded">Ninguno = ESI 5</span>
              <span className="bg-slate-100 px-2 py-1 rounded">Uno = ESI 4</span>
              <span className="bg-slate-100 px-2 py-1 rounded">Dos o más = ESI 3</span>
           </div>
           <div className="grid grid-cols-2 gap-2">
              {RESOURCES_LIST.map(res => (
                <button
                  key={res}
                  onClick={() => toggleResource(res)}
                  className={`text-left text-sm p-2 rounded border transition-colors flex items-center gap-2
                    ${selectedResources.includes(res) ? 'bg-blue-50 border-blue-500 text-blue-700 font-medium' : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'}
                  `}
                >
                  <div className={`w-4 h-4 rounded border flex items-center justify-center ${selectedResources.includes(res) ? 'bg-blue-600 border-blue-600' : 'border-slate-300'}`}>
                    {selectedResources.includes(res) && <Check className="w-3 h-3 text-white" />}
                  </div>
                  {res}
                </button>
              ))}
           </div>
           <div className="mt-4 pt-3 border-t border-slate-100">
              <p className="text-xs text-slate-400">Recursos Seleccionados: <span className="font-bold text-slate-800">{selectedResources.length}</span></p>
           </div>
        </Card>
      </div>

      {/* RIGHT COLUMN: VITALS & RESULTS (5/12) */}
      <div className="lg:col-span-5 space-y-6">
        
        {/* 4. IoT VITALS (Danger Zone Logic) */}
        <Card title="4. Signos Vitales (IoT)" action={
           <button 
            onClick={handleIoTConnect} disabled={isScanning}
            className="flex items-center gap-1 bg-indigo-600 text-white px-3 py-1.5 rounded text-xs font-medium hover:bg-indigo-700"
          >
            {isScanning ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Bluetooth className="w-3 h-3" />}
            {isScanning ? '...' : 'Sensor'}
          </button>
        }>
          <div className="space-y-4">
             {/* HR & SpO2 */}
             <div className="grid grid-cols-2 gap-4">
                <div className={`p-3 rounded-xl border text-center ${vitals.heartRate > 100 ? 'bg-red-50 border-red-200' : 'bg-slate-50 border-slate-100'}`}>
                  <div className="text-xs text-slate-500 font-bold mb-1">Frec. Cardíaca</div>
                  <div className="flex items-center justify-center gap-1">
                    <Activity className="w-4 h-4 text-rose-500"/>
                    <span className="text-xl font-bold">{vitals.heartRate || '--'}</span>
                    <span className="text-[10px]">bpm</span>
                  </div>
                </div>
                <div className={`p-3 rounded-xl border text-center ${vitals.spo2 > 0 && vitals.spo2 < 92 ? 'bg-red-50 border-red-200' : 'bg-slate-50 border-slate-100'}`}>
                  <div className="text-xs text-slate-500 font-bold mb-1">SpO2</div>
                  <div className="flex items-center justify-center gap-1">
                    <Activity className="w-4 h-4 text-blue-500"/>
                    <span className="text-xl font-bold">{vitals.spo2 || '--'}</span>
                    <span className="text-[10px]">%</span>
                  </div>
                </div>
             </div>

             {/* Temp & Manual Inputs */}
             <div className="grid grid-cols-2 gap-4">
               <div className="bg-slate-50 p-3 rounded-xl border border-slate-100 text-center">
                  <div className="text-xs text-slate-500 font-bold mb-1">Temperatura</div>
                  <div className="flex items-center justify-center gap-1">
                    <Thermometer className="w-4 h-4 text-orange-500"/>
                    <span className="text-xl font-bold">{vitals.temperature || '--'}</span>
                    <span className="text-[10px]">°C</span>
                  </div>
               </div>
               <div className="bg-slate-50 p-3 rounded-xl border border-slate-100 relative">
                  <label className="text-[10px] text-slate-500 font-bold block mb-1">Frec. Resp (Manual)</label>
                  <input 
                    type="number" className="w-full bg-transparent font-bold text-center border-b border-slate-300 focus:border-blue-500 outline-none" placeholder="16"
                    value={vitals.respiratoryRate || ''} onChange={e => setVitals({...vitals, respiratoryRate: parseInt(e.target.value)})}
                  />
                  <span className="absolute right-2 bottom-3 text-[10px] text-slate-400">rpm</span>
               </div>
             </div>

             {/* Manual BP Inputs */}
             <div className="grid grid-cols-2 gap-4">
                <div className="bg-slate-50 p-3 rounded-xl border border-slate-100 relative">
                   <label className="text-[10px] text-slate-500 font-bold block mb-1">Presión Sistólica</label>
                   <input 
                     type="number" className="w-full bg-transparent font-bold text-center border-b border-slate-300 focus:border-blue-500 outline-none" placeholder="120"
                     value={vitals.bloodPressureSys || ''} onChange={e => setVitals({...vitals, bloodPressureSys: parseInt(e.target.value)})}
                   />
                   <span className="absolute right-2 bottom-3 text-[10px] text-slate-400">mmHg</span>
                </div>
                <div className="bg-slate-50 p-3 rounded-xl border border-slate-100 relative">
                   <label className="text-[10px] text-slate-500 font-bold block mb-1">Presión Diastólica</label>
                   <input 
                     type="number" className="w-full bg-transparent font-bold text-center border-b border-slate-300 focus:border-blue-500 outline-none" placeholder="80"
                     value={vitals.bloodPressureDia || ''} onChange={e => setVitals({...vitals, bloodPressureDia: parseInt(e.target.value)})}
                   />
                   <span className="absolute right-2 bottom-3 text-[10px] text-slate-400">mmHg</span>
                </div>
             </div>

             <div className="bg-slate-50 p-3 rounded-xl border border-slate-100">
                <div className="flex justify-between text-xs mb-2">
                  <span className="font-bold text-slate-500">Nivel de Dolor (EVA)</span>
                  <span className={`font-bold ${vitals.painLevel >= 7 ? 'text-red-600' : 'text-slate-800'}`}>{vitals.painLevel}/10</span>
                </div>
                <input 
                  type="range" min="0" max="10" className="w-full accent-blue-600 cursor-pointer"
                  value={vitals.painLevel} onChange={e => setVitals({...vitals, painLevel: parseInt(e.target.value)})}
                />
             </div>
          </div>
        </Card>

        {/* 5. DECISION ENGINE & OVERRIDE */}
        <Card title="Resultado ESI v4" className="bg-blue-50/50 border-blue-200">
           <div className="space-y-4">
              
              {/* Suggested */}
              <div className="flex justify-between items-center bg-white p-4 rounded-lg border border-slate-200 shadow-sm">
                 <div>
                    <p className="text-xs text-slate-400 uppercase font-bold tracking-wider">Algoritmo Sugiere</p>
                    {dangerZoneHit.length > 0 && (
                      <div className="text-[10px] text-red-600 font-medium mt-1 flex flex-col">
                        {dangerZoneHit.map((d, i) => <span key={i}>⚠️ {d}</span>)}
                      </div>
                    )}
                 </div>
                 <div className="scale-110">
                    <ESIBadge level={suggestedLevel} />
                 </div>
              </div>

              {/* Final Decision (Override) */}
              <div>
                <label className="block text-sm font-bold text-slate-700 mb-2 flex items-center gap-2">
                   <Stethoscope className="w-4 h-4"/> Clasificación de Triage (Seleccione Nivel)
                </label>
                <div className="space-y-2">
                  {[
                    {
                      level: 1, color: 'bg-red-600', text: 'text-white', title: 'NIVEL 1 - EMERGENCIA', time: 'ATENCIÓN INMEDIATA',
                      symptoms: "Condición que amenaza la vida, Intervención médica inmediata, Dificultad respiratoria severa, Estado de inconsciencia, Ausencia de signos vitales, Trauma mayor, Hemorragia masiva, Problemas cardiorespiratorios o neurológicos severos, Pérdida de una extremidad, Quemaduras de II y III grado extensas."
                    },
                    {
                      level: 2, color: 'bg-orange-500', text: 'text-white', title: 'NIVEL 2 - URGENCIA', time: 'DENTRO DE 30 MINUTOS',
                      symptoms: "Riesgo potencial que amenaza la vida, Estabilidad ventilatoria, Dolores musculares severos, Pérdida de una extremidad u órgano, Agitación psicomotora, Dolor toráxico y abdominal severo, Diabetes descompensada, Quemaduras de II y III grado extensas del 10% al 20%."
                    },
                    {
                      level: 3, color: 'bg-yellow-400', text: 'text-slate-900', title: 'NIVEL 3 - URGENCIA', time: 'DENTRO DE LAS 3 HORAS',
                      symptoms: "Condiciones que puedan progresar a violencia, Estabilidad ventilatoria/hemodinámica/neurológica, Molestias que interfieren en el trabajo, Cefalea, Dolor toráxico, Asma leve/moderada, Sangrado leve/moderado, Sistemas asociados a diálisis, Dolor moderado, Quemaduras del 10% de grado 2."
                    },
                    {
                      level: 4, color: 'bg-green-600', text: 'text-white', title: 'NIVEL 4 - CONSULTA PRIORITARIA', time: 'DENTRO DE LAS 24 HORAS',
                      symptoms: "Patologías relacionadas a la edad, Deterioro potencial, Dolor toráxico no sugestivo de coronario agudo, Dolor muscular leve sin deficit neurológico, Cefalea leve, Dolor abdominal leve, Depresión."
                    },
                    {
                      level: 5, color: 'bg-blue-600', text: 'text-white', title: 'NIVEL 5 - CONSULTA EXTERNA', time: 'DENTRO DE LAS 72 HORAS',
                      symptoms: "Condición aguda que no compromete el estado general, Problemas crónicos sin deterioro, Trauma menor, Estrés emocional, Faringitis, Amigdalitis, Quemaduras I grado."
                    }
                  ].map((opt) => (
                    <div 
                      key={opt.level}
                      onClick={() => setFinalLevel(opt.level as ESILevel)}
                      className={`
                        cursor-pointer rounded-lg border-2 transition-all p-3
                        ${finalLevel === opt.level ? `${opt.color} ${opt.text} border-transparent ring-2 ring-offset-2 ring-slate-400` : 'bg-white border-slate-200 hover:bg-slate-50'}
                      `}
                    >
                      <div className="flex justify-between items-center mb-1">
                        <span className="font-bold text-sm uppercase">{opt.title}</span>
                        <span className={`text-[10px] px-2 py-0.5 rounded-full ${finalLevel === opt.level ? 'bg-white/20' : 'bg-slate-100 text-slate-500'}`}>
                          {opt.time}
                        </span>
                      </div>
                      <p className={`text-xs leading-relaxed ${finalLevel === opt.level ? 'opacity-90' : 'text-slate-500'}`}>
                        {opt.symptoms}
                      </p>
                    </div>
                  ))}
                </div>
              </div>

              {/* Correction Reason Box */}
              {isCorrectionMode && (
                <div className="animate-in fade-in slide-in-from-top-2 bg-amber-50 p-3 rounded-lg border border-amber-200">
                   <label className="block text-xs font-bold text-amber-800 mb-1 flex items-center gap-1">
                      <FileWarning className="w-3 h-3"/> Motivo de la Corrección (Quedará en Blockchain)
                   </label>
                   <textarea 
                      className="w-full p-2 bg-white rounded border border-amber-300 focus:ring-2 focus:ring-amber-500 outline-none text-sm"
                      rows={2}
                      placeholder="Ej: Error en lectura de saturación, se actualiza valor..."
                      value={correctionReason}
                      onChange={e => setCorrectionReason(e.target.value)}
                   />
                </div>
              )}

              {/* Standard Override Reason */}
              {(!isCorrectionMode && suggestedLevel !== finalLevel) && (
                <div className="animate-in fade-in slide-in-from-top-2">
                   <label className="block text-xs font-bold text-amber-700 mb-1">
                      Justificación Clínica Obligatoria (Trazabilidad)
                   </label>
                   <textarea 
                      className="w-full p-3 rounded-lg border border-amber-300 focus:ring-2 focus:ring-amber-500 outline-none text-sm"
                      rows={2}
                      placeholder="Escriba el motivo médico para reclasificar al paciente..."
                      value={overrideReason}
                      onChange={e => setOverrideReason(e.target.value)}
                   />
                </div>
              )}

              <div className="pt-2">
                 <button
                    onClick={handleSubmit}
                    disabled={!patientInfo.cedula || !patientInfo.name || status !== 'IDLE'}
                    className={`w-full py-4 rounded-xl font-bold text-white shadow-lg flex items-center justify-center gap-2 transition-all
                      ${status === 'SUCCESS' ? 'bg-green-600' : 'bg-blue-600 hover:bg-blue-700'}
                      disabled:opacity-50 disabled:cursor-not-allowed
                    `}
                 >
                    {status === 'IDLE' && <><Save className="w-5 h-5"/> {isCorrectionMode ? 'Registrar Corrección' : 'Registrar en Blockchain'}</>}
                    {status !== 'IDLE' && <><RefreshCw className="w-5 h-5 animate-spin"/> {statusMsg}</>}
                 </button>
              </div>
           </div>
        </Card>

      </div>
    </div>
  );
};