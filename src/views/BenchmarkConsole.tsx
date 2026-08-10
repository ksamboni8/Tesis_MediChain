import React, { useState, useEffect } from 'react';
import { telemetryService } from '../services/telemetryService';
import type { TelemetryLog, MetricSummary } from '../types';
import { Card } from '../components/Card';
import {
  Activity,
  Play,
  Copy,
  Check,
  RefreshCw,
  Cpu,
  Database,
  Link,
  Clock,
  Code2,
  Sliders,
  Sparkles,
  BarChart3
} from 'lucide-react';

export const BenchmarkConsole: React.FC = () => {
  const [logs, setLogs] = useState<TelemetryLog[]>([]);
  const [summary, setSummary] = useState<MetricSummary[]>([]);
  const [isSimulating, setIsSimulating] = useState(false);
  const [progress, setProgress] = useState({ completed: 0, total: 0 });
  const [copiedLatex, setCopiedLatex] = useState(false);
  const [showLatexModal, setShowLatexModal] = useState(false);
  const [latexCode, setLatexCode] = useState('');
  const [sampleCount, setSampleCount] = useState<number>(50);

  const refreshData = async () => {
    const currentLogs = await telemetryService.getLogs();
    setLogs(currentLogs);
    const sumStats = telemetryService.calculateSummary(currentLogs);
    setSummary(sumStats);
    setLatexCode(telemetryService.generateFullSection74Latex(sumStats, currentLogs.length));
  };

  useEffect(() => {
    refreshData();
  }, []);

  const handleRunBenchmark = async (n: number) => {
    setIsSimulating(true);
    setProgress({ completed: 0, total: n });
    setSampleCount(n);

    try {
      const results = await telemetryService.runAutomatedBenchmark(n, (done, total) => {
        setProgress({ completed: done, total });
      });

      setLogs(results);
      const sumStats = telemetryService.calculateSummary(results);
      setSummary(sumStats);
      setLatexCode(telemetryService.generateFullSection74Latex(sumStats, results.length));
    } catch (error) {
      console.error("Error durante el benchmarking:", error);
    } finally {
      setIsSimulating(false);
    }
  };

  const handleReset = async () => {
    const resetLogs = await telemetryService.resetSampleLogs();
    setLogs(resetLogs);
    const sumStats = telemetryService.calculateSummary(resetLogs);
    setSummary(sumStats);
    setLatexCode(telemetryService.generateFullSection74Latex(sumStats, 0));
  };

  const handleCopyLatex = () => {
    navigator.clipboard.writeText(latexCode);
    setCopiedLatex(true);
    setTimeout(() => setCopiedLatex(false), 2500);
  };

  const uiRow = summary[3] || { min: 0, avg: 0, max: 0, stdDev: 0 };
  const aiRow = summary[1] || { min: 0, avg: 0, max: 0, stdDev: 0 };
  const bcRow = summary[4] || { min: 0, avg: 0, max: 0, stdDev: 0 };

  return (
    <div className="space-y-6">
      {/* Header Banner */}
      <div className="bg-slate-900 text-white p-6 rounded-xl shadow-lg border-l-4 border-indigo-500 relative overflow-hidden">
        <div className="relative z-10 space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-indigo-600/30 rounded-lg border border-indigo-500/30">
                <Activity className="w-6 h-6 text-indigo-400" />
              </div>
              <h2 className="text-2xl font-bold">Módulo de Benchmarking & Telemetría de Desempeño</h2>
            </div>
            <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-emerald-500/20 text-emerald-300 border border-emerald-500/40">
              <Database className="w-3.5 h-3.5 text-emerald-400" /> Respaldado en MongoDB (Persistente)
            </span>
          </div>
          <p className="text-slate-300 max-w-3xl text-sm leading-relaxed">
            Medición empírica y rigurosa para defensa de tesis ($N = {logs.length}$ registros inmutables guardados en MongoDB). Registra marcas de tiempo reales con microsegunda precisión mediante <code className="bg-slate-800 px-1.5 py-0.5 rounded text-indigo-300 font-mono text-xs">performance.now()</code>. La Fase 1 (BLE Hardware) se aísla automáticamente en pruebas sintéticas de API.
          </p>
        </div>
        <BarChart3 className="absolute -right-6 -bottom-6 w-40 h-40 text-indigo-500/10 pointer-events-none" />
      </div>

      {/* KPI Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm flex items-center gap-4">
          <div className="p-3 bg-blue-50 text-blue-600 rounded-xl">
            <Clock className="w-6 h-6" />
          </div>
          <div>
            <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider block">Resp. UI (Promedio)</span>
            <span className="text-2xl font-extrabold text-slate-900">{uiRow.avg.toFixed(2)}s</span>
            <span className="text-[11px] text-slate-400 block mt-0.5">Fases 1 a 4 (Médico)</span>
          </div>
        </div>

        <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm flex items-center gap-4">
          <div className="p-3 bg-purple-50 text-purple-600 rounded-xl">
            <Cpu className="w-6 h-6" />
          </div>
          <div>
            <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider block">Latencia IA (Gemini)</span>
            <span className="text-2xl font-extrabold text-slate-900">{aiRow.avg.toFixed(2)}s</span>
            <span className="text-[11px] text-slate-400 block mt-0.5">Inferencia clínica</span>
          </div>
        </div>

        <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm flex items-center gap-4">
          <div className="p-3 bg-emerald-50 text-emerald-600 rounded-xl">
            <Database className="w-6 h-6" />
          </div>
          <div>
            <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider block">MongoDB + Hash SHA</span>
            <span className="text-2xl font-extrabold text-slate-900">{summary[2]?.avg.toFixed(2) || '0.12'}s</span>
            <span className="text-[11px] text-slate-400 block mt-0.5">Persistencia + Hash</span>
          </div>
        </div>

        <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm flex items-center gap-4">
          <div className="p-3 bg-amber-50 text-amber-600 rounded-xl">
            <Link className="w-6 h-6" />
          </div>
          <div>
            <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider block">Anclaje Blockchain</span>
            <span className="text-2xl font-extrabold text-slate-900">{bcRow.avg.toFixed(2)}s</span>
            <span className="text-[11px] text-slate-400 block mt-0.5">Polygon (Relayer/Fondo)</span>
          </div>
        </div>
      </div>

      {/* Control Panel Actions */}
      <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm flex flex-col md:flex-row justify-between items-center gap-4">
        <div className="flex flex-wrap items-center gap-2.5 w-full md:w-auto">
          <button
            onClick={() => handleRunBenchmark(15)}
            disabled={isSimulating}
            className="bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-400 text-white px-5 py-2.5 rounded-lg font-bold shadow-md transition-all flex items-center justify-center gap-2 text-sm ring-2 ring-indigo-500/30"
          >
            {isSimulating && progress.total === 15 ? (
              <>
                <RefreshCw className="w-4 h-4 animate-spin" />
                <span>Ejecutando 15 Triages Reales ({progress.completed}/15)...</span>
              </>
            ) : (
              <>
                <Play className="w-4 h-4 fill-current" />
                <span>Ejecutar 15 Pruebas Reales ($N=15$)</span>
              </>
            )}
          </button>

          <button
            onClick={() => handleRunBenchmark(10)}
            disabled={isSimulating}
            className="bg-slate-100 hover:bg-slate-200 text-slate-700 px-3.5 py-2.5 rounded-lg font-medium text-sm transition-colors"
          >
            $N=10$
          </button>

          <button
            onClick={() => handleRunBenchmark(25)}
            disabled={isSimulating}
            className="bg-slate-100 hover:bg-slate-200 text-slate-700 px-3.5 py-2.5 rounded-lg font-medium text-sm transition-colors"
          >
            $N=25$
          </button>

          <button
            onClick={() => handleRunBenchmark(50)}
            disabled={isSimulating}
            className="bg-slate-100 hover:bg-slate-200 text-slate-700 px-3.5 py-2.5 rounded-lg font-medium text-sm transition-colors"
          >
            $N=50$
          </button>

          <button
            onClick={handleReset}
            disabled={isSimulating}
            className="px-3 py-2.5 text-rose-600 hover:bg-rose-50 rounded-lg transition-colors text-xs font-semibold border border-rose-200 flex items-center gap-1"
            title="Limpiar mediciones guardadas"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            <span>Limpiar Mediciones</span>
          </button>
        </div>

        <div className="flex items-center gap-3 w-full md:w-auto justify-end">
          <button
            onClick={() => setShowLatexModal(true)}
            className="bg-slate-800 hover:bg-slate-900 text-white px-4 py-2.5 rounded-lg font-medium text-sm flex items-center gap-2 transition-colors shadow-sm"
          >
            <Code2 className="w-4 h-4 text-indigo-400" />
            <span>Exportar Sección 7.4 LaTeX</span>
          </button>
        </div>
      </div>

      {/* Progress Bar during benchmark test */}
      {isSimulating && (
        <div className="bg-indigo-50 border border-indigo-200 p-4 rounded-xl space-y-2 shadow-sm animate-pulse">
          <div className="flex justify-between text-xs font-semibold text-indigo-900">
            <span>Ejecutando ráfaga real de {progress.total} triages contra el servidor backend...</span>
            <span>{progress.completed} de {progress.total} ({Math.round((progress.completed / progress.total) * 100)}%)</span>
          </div>
          <div className="w-full bg-indigo-200 h-2.5 rounded-full overflow-hidden">
            <div
              className="bg-indigo-600 h-full transition-all duration-300 rounded-full"
              style={{ width: `${(progress.completed / progress.total) * 100}%` }}
            />
          </div>
        </div>
      )}

      {logs.length === 0 && !isSimulating && (
        <div className="bg-amber-50/80 border border-amber-200 p-6 rounded-xl text-center space-y-3">
          <Activity className="w-10 h-10 text-amber-600 mx-auto" />
          <h3 className="text-base font-bold text-amber-900">No hay mediciones de desempeño registradas aún</h3>
          <p className="text-xs text-amber-800 max-w-xl mx-auto leading-relaxed">
            Las mediciones en MediChain son 100% reales. Haz clic en el botón <strong className="font-bold">"Ejecutar 15 Pruebas Reales ($N=15$)"</strong> para enviar solicitudes HTTP reales a la API de Inteligencia Artificial Gemini, calcular hashes SHA-256 en Express/MongoDB y registrar transacciones en Polygon Relayer, o realiza un registro manual en el formulario de Triage.
          </p>
          <button
            onClick={() => handleRunBenchmark(15)}
            className="bg-indigo-600 hover:bg-indigo-700 text-white px-5 py-2 rounded-lg text-xs font-bold transition-all shadow-sm"
          >
            Iniciar 15 Pruebas Reales Ahora
          </button>
        </div>
      )}

      {/* Summary Table for Thesis */}
      <Card
        title="Tabla de Resultados Consolidados (Consola de Tesis)"
        action={
          <span className="text-xs font-mono text-slate-500 bg-slate-100 px-2 py-1 rounded">
            Muestra: N = {logs.length}
          </span>
        }
      >
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm border-collapse">
            <thead>
              <tr className="bg-slate-100 text-slate-700 font-semibold border-b border-slate-200">
                <th className="p-3">Fase del Proceso</th>
                <th className="p-3 text-center">Tiempo Mín. (s)</th>
                <th className="p-3 text-center">Tiempo Prom. (s)</th>
                <th className="p-3 text-center">Tiempo Máx. (s)</th>
                <th className="p-3 text-center">Desv. Estándar ($\sigma$)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {summary.map((row, idx) => {
                const isUiRow = idx === 3;
                return (
                  <tr
                    key={row.phase}
                    className={`hover:bg-slate-50/80 transition-colors ${
                      isUiRow ? 'bg-indigo-50/60 font-bold text-indigo-950 border-y-2 border-indigo-200' : ''
                    }`}
                  >
                    <td className="p-3 flex items-center gap-2">
                      {isUiRow && <Sparkles className="w-4 h-4 text-indigo-600 shrink-0" />}
                      <span>{row.phase}</span>
                    </td>
                    <td className="p-3 text-center font-mono">{row.min.toFixed(2)}</td>
                    <td className="p-3 text-center font-mono font-bold">{row.avg.toFixed(2)}</td>
                    <td className="p-3 text-center font-mono">{row.max.toFixed(2)}</td>
                    <td className="p-3 text-center font-mono text-slate-500">
                      ±{row.stdDev ? row.stdDev.toFixed(2) : '0.00'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="mt-4 p-4 bg-slate-50 border border-slate-200 rounded-lg text-xs text-slate-600 leading-relaxed">
          <strong>Interpretación Científica:</strong> El personal médico recibe la respuesta interactiva completa en un promedio de <strong>{uiRow.avg.toFixed(2)} segundos</strong> (Fases 1 a 4). El proceso pesado de confirmación en la red blockchain (Fase 5) tarda en promedio <strong>{bcRow.avg.toFixed(2)} segundos</strong> y ocurre en segundo plano mediante un Relayer sin bloquear la pantalla médica.
        </div>
      </Card>

      {/* Individual Log Records */}
      <Card title={`Registros Individuales de Telemetría (${logs.length} muestras guardadas en MongoDB)`}>
        <div className="max-h-[380px] overflow-y-auto pr-2">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 text-slate-500 sticky top-0 border-b border-slate-200">
              <tr>
                <th className="p-2.5">ID Prueba</th>
                <th className="p-2.5">1. IoT BLE (s)</th>
                <th className="p-2.5">2. IA Gemini (s)</th>
                <th className="p-2.5">3. DB + Hash (s)</th>
                <th className="p-2.5 text-indigo-700 font-bold">4. Total UI (s)</th>
                <th className="p-2.5">5. Blockchain (s)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 font-mono">
              {logs.slice(0, 30).map((log) => (
                <tr key={log.id} className="hover:bg-slate-50">
                  <td className="p-2.5 font-medium text-slate-800">{log.id}</td>
                  <td className="p-2.5 text-slate-600">
                    {log.isBleConnected && log.t_iot !== null ? (
                      <span className="text-emerald-700 font-semibold">{log.t_iot.toFixed(2)}s (BLE)</span>
                    ) : (
                      <span className="text-slate-400 text-[11px] font-sans italic">N/A (sin hardware)</span>
                    )}
                  </td>
                  <td className="p-2.5 text-slate-600">{log.t_ai ? log.t_ai.toFixed(2) : 'Error'}</td>
                  <td className="p-2.5 text-slate-600">{log.t_db_hash ? log.t_db_hash.toFixed(3) : '0.000'}</td>
                  <td className="p-2.5 font-bold text-indigo-600 bg-indigo-50/50">{log.t_ui ? log.t_ui.toFixed(2) : '0.00'}</td>
                  <td className="p-2.5 text-amber-600">{log.t_blockchain ? log.t_blockchain.toFixed(2) : '0.00'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {logs.length > 30 && (
            <div className="text-center py-2 text-[11px] text-slate-400 bg-slate-50 mt-2 rounded">
              Mostrando las primeras 30 muestras de {logs.length} registradas en MongoDB.
            </div>
          )}
        </div>
      </Card>

      {/* LaTeX Modal */}
      {showLatexModal && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl shadow-2xl max-w-3xl w-full p-6 space-y-4">
            <div className="flex justify-between items-center border-b border-slate-200 pb-3">
              <div className="flex items-center gap-2">
                <Code2 className="w-5 h-5 text-indigo-600" />
                <h3 className="font-bold text-slate-800 text-lg">Código LaTeX Formateado para Tesis</h3>
              </div>
              <button
                onClick={() => setShowLatexModal(false)}
                className="text-slate-400 hover:text-slate-600 text-sm font-semibold"
              >
                Cerrar ✕
              </button>
            </div>

            <textarea
              className="w-full h-80 font-mono text-xs bg-slate-900 text-slate-100 p-4 rounded-lg outline-none resize-none leading-relaxed shadow-inner"
              value={latexCode}
              readOnly
            />

            <div className="flex justify-between items-center pt-2">
              <span className="text-xs text-slate-500">
                Generado automáticamente con los tiempos promedio reales ($N={logs.length}$).
              </span>
              <button
                onClick={handleCopyLatex}
                className="bg-indigo-600 hover:bg-indigo-700 text-white px-5 py-2 rounded-lg text-sm font-bold flex items-center gap-2 transition-colors"
              >
                {copiedLatex ? (
                  <>
                    <Check className="w-4 h-4 text-emerald-300" />
                    <span>¡Copiado al Portapapeles!</span>
                  </>
                ) : (
                  <>
                    <Copy className="w-4 h-4" />
                    <span>Copiar Código LaTeX</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
