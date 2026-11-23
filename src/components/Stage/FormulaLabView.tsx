import React, { useMemo, useState } from 'react';
import {
  HelpCircle,
  Lightbulb,
  Pencil,
  Sigma,
  Sliders,
  Sparkles,
} from 'lucide-react';
import { renderLatex } from '../../lib/markdown';
import type { FormulaLabData, StudyArtifact } from '../../types/study';

interface FormulaLabViewProps {
  artifact: StudyArtifact;
  onAskQuestion: (prompt: string) => void;
  onStartAnnotate: () => void;
}

function safeEvalFormula(expression: string, vars: Record<string, number>): number | null {
  try {
    const names = Object.keys(vars);
    const values = Object.values(vars);
    // Allow Math.* and arithmetic only
    if (/(window|document|globalThis|fetch|eval|Function|import|process|require)/i.test(expression)) {
      return null;
    }
    // eslint-disable-next-line no-new-func
    const fn = new Function(...names, `"use strict"; return (${expression});`);
    const out = fn(...values);
    return typeof out === 'number' && Number.isFinite(out) ? out : null;
  } catch {
    return null;
  }
}

export const FormulaLabView: React.FC<FormulaLabViewProps> = ({
  artifact,
  onAskQuestion,
  onStartAnnotate,
}) => {
  const data = useMemo<FormulaLabData | null>(() => {
    if (artifact.parsedData && 'latex' in artifact.parsedData) {
      return artifact.parsedData as FormulaLabData;
    }
    try {
      return JSON.parse(artifact.content) as FormulaLabData;
    } catch {
      return null;
    }
  }, [artifact]);

  const [selectedTermId, setSelectedTermId] = useState<string | null>(
    data?.terms?.[0]?.id ?? null,
  );

  const [paramValues, setParamValues] = useState<Record<string, number>>(() => {
    const init: Record<string, number> = {};
    for (const p of data?.parameters || []) {
      init[p.name] = p.defaultValue;
    }
    return init;
  });

  if (!data) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-sm text-slate-400">
        Formül Laboratuvarı verisi okunamadı.
      </div>
    );
  }

  const activeTerm = data.terms.find((t) => t.id === selectedTermId) || data.terms[0];
  const computedResult =
    data.expression && data.parameters?.length
      ? safeEvalFormula(data.expression, paramValues)
      : null;

  return (
    <div className="flex h-full flex-col overflow-y-auto bg-slate-950">
      {/* Header Bar */}
      <div className="sticky top-0 z-10 flex items-center justify-between border-b border-slate-800/90 bg-slate-900/95 px-5 py-2.5 backdrop-blur">
        <div className="flex items-center gap-2">
          <span className="flex h-6 w-6 items-center justify-center rounded-md bg-pink-500/20 text-pink-300">
            <Sigma className="h-3.5 w-3.5" />
          </span>
          <div>
            <h3 className="text-xs font-semibold text-white">{artifact.title}</h3>
            {data.subtitle && <p className="text-[11px] text-slate-400">{data.subtitle}</p>}
          </div>
        </div>
        <button
          type="button"
          onClick={onStartAnnotate}
          className="flex items-center gap-1.5 rounded-lg bg-rose-500/20 px-2.5 py-1.5 text-xs font-semibold text-rose-200 ring-1 ring-rose-500/40 hover:bg-rose-500/30"
        >
          <Pencil className="h-3.5 w-3.5" /> Formül Üzerini İşaretle
        </button>
      </div>

      <div className="mx-auto w-full max-w-4xl space-y-5 p-5">
        {/* Main Formula Hero */}
        <div className="rounded-2xl border border-indigo-500/30 bg-gradient-to-br from-slate-900 via-slate-900 to-indigo-950/50 p-6 text-center shadow-xl">
          <div
            className="overflow-x-auto py-2 text-2xl text-white"
            dangerouslySetInnerHTML={{ __html: renderLatex(data.latex, true) }}
          />
          <p className="mx-auto mt-3 max-w-2xl text-sm leading-relaxed text-slate-300">
            {data.summary}
          </p>
        </div>

        {/* Interactive Terms Grid */}
        <section>
          <div className="mb-2.5 flex items-center justify-between">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-400">
              Formül Parçaları — Detay için bir terime tıkla
            </h4>
          </div>

          <div className="flex flex-wrap gap-2">
            {data.terms.map((term) => {
              const selected = activeTerm?.id === term.id;
              return (
                <button
                  key={term.id}
                  type="button"
                  onClick={() => setSelectedTermId(term.id)}
                  className={`flex items-center gap-2 rounded-xl border px-3.5 py-2 text-left transition ${
                    selected
                      ? 'bg-slate-800/95 text-white shadow-lg'
                      : 'border-slate-800 bg-slate-900/70 text-slate-300 hover:border-slate-700'
                  }`}
                  style={{
                    borderColor: selected ? term.color : undefined,
                  }}
                >
                  <span
                    className="h-2.5 w-2.5 rounded-full"
                    style={{ backgroundColor: term.color }}
                  />
                  <span
                    className="text-base font-bold"
                    dangerouslySetInnerHTML={{ __html: renderLatex(term.symbol, false) }}
                  />
                  <span className="text-xs font-medium">{term.label}</span>
                </button>
              );
            })}
          </div>

          {activeTerm && (
            <div
              className="mt-3 rounded-2xl border bg-slate-900/80 p-4 transition"
              style={{ borderColor: `${activeTerm.color}55` }}
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="flex items-center gap-3">
                  <span
                    className="flex h-10 min-w-10 items-center justify-center rounded-xl px-2 text-lg font-bold text-white"
                    style={{ backgroundColor: `${activeTerm.color}30`, border: `1px solid ${activeTerm.color}` }}
                    dangerouslySetInnerHTML={{ __html: renderLatex(activeTerm.symbol, false) }}
                  />
                  <div>
                    <h5 className="text-sm font-bold text-white">{activeTerm.label}</h5>
                    {activeTerm.unit && (
                      <p className="text-xs text-slate-400">Birim: {activeTerm.unit}</p>
                    )}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() =>
                    onAskQuestion(
                      `"${artifact.title}" içindeki "${activeTerm.label}" (${activeTerm.symbol}) terimini daha detaylı ve farklı bir gerçek hayat örneğiyle açıklar mısın?`,
                    )
                  }
                  className="flex items-center gap-1 rounded-lg bg-indigo-500/20 px-2.5 py-1.5 text-xs font-medium text-indigo-200 hover:bg-indigo-500/30"
                >
                  <HelpCircle className="h-3.5 w-3.5" /> Bu Terimi Derinleştir
                </button>
              </div>
              <p className="mt-3 text-sm leading-relaxed text-slate-200">{activeTerm.meaning}</p>
              {activeTerm.analogy && (
                <div className="mt-3 flex items-start gap-2 rounded-xl bg-amber-500/10 p-3 text-xs text-amber-100 ring-1 ring-amber-500/25">
                  <Lightbulb className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
                  <span>
                    <strong>Benzetme:</strong> {activeTerm.analogy}
                  </span>
                </div>
              )}
            </div>
          )}
        </section>

        {/* Live Parameter Explorer */}
        {data.parameters && data.parameters.length > 0 && (
          <section className="rounded-2xl border border-slate-800 bg-slate-900/70 p-4">
            <div className="mb-3 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Sliders className="h-4 w-4 text-cyan-400" />
                <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-300">
                  Canlı Parametre Deneyimi
                </h4>
              </div>
              {computedResult !== null && (
                <div className="rounded-xl bg-cyan-500/15 px-3.5 py-1.5 text-sm font-bold text-cyan-200 ring-1 ring-cyan-500/40">
                  {data.resultLabel || 'Sonuç'}:{' '}
                  <span className="font-mono">
                    {Math.abs(computedResult) < 0.001 && computedResult !== 0
                      ? computedResult.toExponential(2)
                      : computedResult.toFixed(4)}
                  </span>{' '}
                  {data.resultUnit || ''}
                </div>
              )}
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              {data.parameters.map((param) => {
                const val = paramValues[param.name] ?? param.defaultValue;
                return (
                  <div key={param.name} className="rounded-xl border border-slate-800 bg-slate-950/70 p-3">
                    <div className="mb-1.5 flex items-center justify-between text-xs">
                      <span className="font-medium text-slate-200">
                        {param.label} ({param.symbol})
                      </span>
                      <span className="font-mono font-semibold text-indigo-300">
                        {val} {param.unit || ''}
                      </span>
                    </div>
                    <input
                      type="range"
                      min={param.min}
                      max={param.max}
                      step={param.step}
                      value={val}
                      onChange={(e) =>
                        setParamValues((prev) => ({
                          ...prev,
                          [param.name]: parseFloat(e.target.value),
                        }))
                      }
                      className="w-full accent-indigo-500"
                    />
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {/* Step-by-step Derivation */}
        {data.steps && data.steps.length > 0 && (
          <section className="space-y-2.5">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-400">
              Adım Adım Çözümleme
            </h4>
            {data.steps.map((step, idx) => (
              <div
                key={idx}
                className="rounded-2xl border border-slate-800 bg-slate-900/65 p-4"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h5 className="text-xs font-bold text-indigo-300">{step.title}</h5>
                  <button
                    type="button"
                    onClick={() =>
                      onAskQuestion(
                        `"${artifact.title}" formülündeki "${step.title}" adımını (${step.latex}) tam anlayamadım. Bu geçişin nereden geldiğini daha basit ve adım adım açıklar mısın?`,
                      )
                    }
                    className="flex items-center gap-1 rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-1 text-[11px] font-medium text-slate-200 hover:border-indigo-500 hover:text-indigo-200"
                  >
                    <Sparkles className="h-3 w-3 text-indigo-400" /> Bu Adımı Anlamadım
                  </button>
                </div>
                <div
                  className="my-2 overflow-x-auto rounded-xl bg-slate-950/70 px-3 py-2 text-center text-white"
                  dangerouslySetInnerHTML={{ __html: renderLatex(step.latex, true) }}
                />
                <p className="text-xs leading-relaxed text-slate-300">{step.explanation}</p>
              </div>
            ))}
          </section>
        )}
      </div>
    </div>
  );
};
