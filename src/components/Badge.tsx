import React from 'react';
import { ESILevel } from '../types';

export const ESIBadge: React.FC<{ level: ESILevel }> = ({ level }) => {
  const getStyles = (l: ESILevel) => {
    switch (l) {
      case ESILevel.ONE: return 'bg-red-100 text-red-700 border-red-200';
      case ESILevel.TWO: return 'bg-orange-100 text-orange-700 border-orange-200';
      case ESILevel.THREE: return 'bg-yellow-100 text-yellow-700 border-yellow-200';
      case ESILevel.FOUR: return 'bg-green-100 text-green-700 border-green-200';
      case ESILevel.FIVE: return 'bg-blue-100 text-blue-700 border-blue-200';
      default: return 'bg-slate-100 text-slate-600';
    }
  };

  const getLabel = (l: ESILevel) => {
    switch (l) {
      case ESILevel.ONE: return 'TRIAGE 1 - EMERGENCIA';
      case ESILevel.TWO: return 'TRIAGE 2 - URGENCIA';
      case ESILevel.THREE: return 'TRIAGE 3 - URGENCIA';
      case ESILevel.FOUR: return 'TRIAGE 4 - CONSULTA PRIORITARIA';
      case ESILevel.FIVE: return 'TRIAGE 5 - CONSULTA EXTERNA';
    }
  };

  return (
    <span className={`px-3 py-1 rounded-full text-xs font-bold border ${getStyles(level)}`}>
      {getLabel(level)}
    </span>
  );
};
