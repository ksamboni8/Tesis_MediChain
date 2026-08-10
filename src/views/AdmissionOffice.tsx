import React, { useState, useEffect } from 'react';
import { dbService } from '../services/databaseService';
import { UserPlus, Users, Trash2, Clock, User, Fingerprint, Calendar } from 'lucide-react';
import { PendingPatient } from '../types';
import { format } from 'date-fns';

export const AdmissionOffice: React.FC = () => {
  const [cedula, setCedula] = useState('');
  const [name, setName] = useState('');
  const [age, setAge] = useState('');
  const [gender, setGender] = useState<'M' | 'F' | 'O'>('M');
  const [eps, setEps] = useState('');
  const [pending, setPending] = useState<PendingPatient[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    loadPending();
  }, []);

  const loadPending = async () => {
    try {
      const data = await dbService.getPendingPatients();
      setPending(data);
    } catch (error) {
      console.error(error);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!cedula || !name || !age || !eps) return;

    setLoading(true);
    try {
      await dbService.addPendingPatient({
        cedula,
        name,
        age: parseInt(age),
        gender,
        eps
      });
      setCedula('');
      setName('');
      setAge('');
      setEps('');
      loadPending();
    } catch (error) {
      alert("Error al registrar paciente");
    } finally {
      setLoading(false);
    }
  };

  const handleRemove = async (id: string) => {
    if (!confirm("¿Eliminar de la lista de espera?")) return;
    try {
      await dbService.removePendingPatient(id);
      loadPending();
    } catch (error) {
      alert("Error al eliminar");
    }
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
      {/* Formulario de Registro */}
      <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6">
        <div className="flex items-center gap-3 mb-6">
          <div className="p-2 bg-blue-100 text-blue-600 rounded-lg">
            <UserPlus className="w-6 h-6" />
          </div>
          <h2 className="text-xl font-bold text-slate-800">Admisión de Pacientes</h2>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Cédula / ID</label>
            <div className="relative">
              <Fingerprint className="absolute left-3 top-3 w-4 h-4 text-slate-400" />
              <input
                type="text"
                value={cedula}
                onChange={(e) => setCedula(e.target.value)}
                className="w-full pl-10 pr-4 py-2 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500 outline-none transition-all"
                placeholder="Ej: 12345678"
                required
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Nombre Completo</label>
            <div className="relative">
              <User className="absolute left-3 top-3 w-4 h-4 text-slate-400" />
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full pl-10 pr-4 py-2 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500 outline-none transition-all"
                placeholder="Nombre y Apellidos"
                required
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Edad</label>
              <div className="relative">
                <Calendar className="absolute left-3 top-3 w-4 h-4 text-slate-400" />
                <input
                  type="number"
                  value={age}
                  onChange={(e) => setAge(e.target.value)}
                  className="w-full pl-10 pr-4 py-2 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500 outline-none transition-all"
                  placeholder="Años"
                  required
                />
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Sexo</label>
              <select
                value={gender}
                onChange={(e) => setGender(e.target.value as any)}
                className="w-full px-4 py-2 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500 outline-none transition-all appearance-none bg-white"
              >
                <option value="M">Masculino</option>
                <option value="F">Femenino</option>
              </select>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">EPS (Aseguradora)</label>
            <input
              type="text"
              value={eps}
              onChange={(e) => setEps(e.target.value)}
              className="w-full px-4 py-2 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500 outline-none transition-all"
              placeholder="Ej: SURA, Sanitas, Nueva EPS, Coosalud"
              required
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-blue-600 text-white py-3 rounded-xl font-bold hover:bg-blue-700 transition-all flex items-center justify-center gap-2 disabled:opacity-50"
          >
            {loading ? 'Registrando...' : 'Ingresar a Lista de Espera'}
          </button>
        </form>
      </div>

      {/* Lista de Espera Actual */}
      <div className="bg-slate-50 rounded-2xl border border-slate-200 p-6">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-indigo-100 text-indigo-600 rounded-lg">
              <Users className="w-6 h-6" />
            </div>
            <h2 className="text-xl font-bold text-slate-800">Sala de Espera</h2>
          </div>
          <span className="bg-indigo-600 text-white text-xs font-bold px-2.5 py-1 rounded-full">
            {pending.length} Pendientes
          </span>
        </div>

        <div className="space-y-3">
          {pending.length === 0 ? (
            <div className="text-center py-12 text-slate-400">
              <Clock className="w-12 h-12 mx-auto mb-3 opacity-20" />
              <p>No hay pacientes esperando triage</p>
            </div>
          ) : (
            pending.map((p) => (
              <div key={p.id} className="bg-white p-4 rounded-xl border border-slate-200 flex items-center justify-between group hover:border-indigo-300 transition-all">
                <div>
                  <h3 className="font-bold text-slate-800">{p.name}</h3>
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500 mt-1 items-center">
                    <span>ID: {p.cedula}</span>
                    <span>{p.age} años</span>
                    <span>{p.gender}</span>
                    {p.eps && (
                      <span className="bg-blue-50 text-blue-600 px-1.5 py-0.5 rounded text-[10px] font-semibold">
                        EPS: {p.eps}
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-4">
                  <span className="text-[10px] bg-slate-100 px-2 py-1 rounded uppercase font-bold text-slate-500">
                    {format(p.admissionTimestamp, 'HH:mm')}
                  </span>
                  <button
                    onClick={() => handleRemove(p.id)}
                    className="p-2 text-slate-300 hover:text-red-500 transition-colors"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
};
