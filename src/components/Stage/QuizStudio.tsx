import React, { useMemo, useState } from 'react';
import {
  Box,
  CheckCircle2,
  HelpCircle,
  Lightbulb,
  RotateCcw,
  Sparkles,
  XCircle,
} from 'lucide-react';
import {
  highlightCodeSnippet,
  looksLikeCode,
  renderLatex,
  renderQuizText,
} from '../../lib/markdown';
import type { QuizData, StudyArtifact } from '../../types/study';

interface QuizStudioProps {
  artifact: StudyArtifact;
  onAskQuestion: (prompt: string) => void;
}

export const QuizStudio: React.FC<QuizStudioProps> = ({ artifact, onAskQuestion }) => {
  const data = useMemo<QuizData | null>(() => {
    if (artifact.parsedData && 'questions' in artifact.parsedData) {
      return artifact.parsedData as QuizData;
    }
    try {
      return JSON.parse(artifact.content) as QuizData;
    } catch {
      return null;
    }
  }, [artifact]);

  const [selectedAnswers, setSelectedAnswers] = useState<Record<string, number>>({});
  const [shortAnswers, setShortAnswers] = useState<Record<string, string>>({});
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const [hintLevel, setHintLevel] = useState<Record<string, number>>({});

  if (!data || !Array.isArray(data.questions)) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-sm text-slate-400">
        Alıştırma verisi okunamadı.
      </div>
    );
  }

  const totalCount = data.questions.length;
  const answeredCount = Object.keys(revealed).filter((k) => revealed[k]).length;
  const correctCount = data.questions.filter((q) => {
    if (!revealed[q.id]) return false;
    if (q.type === 'mcq') return selectedAnswers[q.id] === q.correctIndex;
    return false;
  }).length;

  const wrongQuestions = data.questions.filter(
    (q) => revealed[q.id] && q.type === 'mcq' && selectedAnswers[q.id] !== q.correctIndex,
  );

  const handleReset = () => {
    setSelectedAnswers({});
    setShortAnswers({});
    setRevealed({});
    setHintLevel({});
  };

  return (
    <div className="flex h-full flex-col overflow-y-auto bg-slate-950">
      {/* Header */}
      <div className="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-2 border-b border-slate-800/90 bg-slate-900/95 px-5 py-2.5 backdrop-blur">
        <div className="flex items-center gap-2">
          <span className="flex h-6 w-6 items-center justify-center rounded-md bg-amber-500/20 text-amber-300">
            <HelpCircle className="h-3.5 w-3.5" />
          </span>
          <div>
            <h3 className="text-xs font-semibold text-white">{artifact.title}</h3>
            <p className="text-[11px] text-slate-400">
              {data.topic} {data.difficulty ? `• Zorluk: ${data.difficulty}` : ''}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <span className="rounded-full bg-slate-800 px-3 py-1 text-xs font-semibold text-indigo-300">
            Skor: {correctCount} / {totalCount} ({answeredCount} çözüldü)
          </span>
          {wrongQuestions.length > 0 && (
            <button
              type="button"
              onClick={() =>
                onAskQuestion(
                  `"${data.topic}" testinde şu sorularda hata yaptım: ${wrongQuestions
                    .map((q) => q.prompt)
                    .join(' | ')}. Bu kavramları farklı ve görsel bir yaklaşımla tekrar anlatır mısın?`,
                )
              }
              className="flex items-center gap-1 rounded-lg bg-rose-500/20 px-2.5 py-1.5 text-xs font-semibold text-rose-200 ring-1 ring-rose-500/40 hover:bg-rose-500/30"
            >
              <Sparkles className="h-3.5 w-3.5" /> Yanlışlarımı Anlat
            </button>
          )}
          <button
            type="button"
            onClick={handleReset}
            className="flex items-center gap-1 rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-1.5 text-xs text-slate-200 hover:bg-slate-700"
          >
            <RotateCcw className="h-3.5 w-3.5" /> Sıfırla
          </button>
        </div>
      </div>

      {/* Questions */}
      <div className="mx-auto w-full max-w-3xl space-y-4 p-5">
        {data.questions.map((q, idx) => {
          const isRevealed = Boolean(revealed[q.id]);
          const chosen = selectedAnswers[q.id];
          const isCorrect = q.type === 'mcq' && chosen === q.correctIndex;
          const hintsShown = hintLevel[q.id] || 0;

          return (
            <div
              key={q.id}
              className="rounded-2xl border border-slate-800 bg-slate-900/75 p-5 shadow-md"
            >
              <div className="mb-3 flex items-start justify-between gap-3">
                <span className="rounded-md bg-indigo-500/20 px-2 py-0.5 text-[11px] font-bold text-indigo-300">
                  Soru {idx + 1}
                </span>
                <div className="flex items-center gap-1.5">
                  {q.hints && q.hints.length > 0 && hintsShown < q.hints.length && !isRevealed && (
                    <button
                      type="button"
                      onClick={() =>
                        setHintLevel((prev) => ({ ...prev, [q.id]: (prev[q.id] || 0) + 1 }))
                      }
                      className="flex items-center gap-1 rounded-lg bg-amber-500/15 px-2.5 py-1 text-[11px] font-medium text-amber-200 hover:bg-amber-500/25"
                    >
                      <Lightbulb className="h-3 w-3" /> İpucu Al ({hintsShown}/{q.hints.length})
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() =>
                      onAskQuestion(
                        `Şu soruyu anlamak için etkileşimli bir 2D veya 3D görselleştirme yapabilir misin?\n\nSoru: ${q.prompt}`,
                      )
                    }
                    className="flex items-center gap-1 rounded-lg bg-cyan-500/15 px-2.5 py-1 text-[11px] font-medium text-cyan-200 hover:bg-cyan-500/25"
                  >
                    <Box className="h-3 w-3" /> Görselleştir
                  </button>
                </div>
              </div>

              <div className="text-sm font-medium text-slate-100">
                <div
                  className="study-prose quiz-prose"
                  dangerouslySetInnerHTML={{ __html: renderQuizText(q.prompt) }}
                />
              </div>

              {q.latex && (
                <div
                  className="my-3 overflow-x-auto rounded-xl bg-slate-950/70 px-3 py-2 text-center text-white"
                  dangerouslySetInnerHTML={{ __html: renderLatex(q.latex, true) }}
                />
              )}

              {/* Progressive Hints */}
              {hintsShown > 0 && q.hints && (
                <div className="my-3 space-y-1.5">
                  {q.hints.slice(0, hintsShown).map((hint, hIdx) => (
                    <div
                      key={hIdx}
                      className="flex items-start gap-2 rounded-xl bg-amber-500/10 px-3 py-2 text-xs text-amber-100 ring-1 ring-amber-500/25"
                    >
                      <Lightbulb className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400" />
                      <div className="min-w-0 flex-1">
                        <strong>İpucu {hIdx + 1}:</strong>
                        <div
                          className="study-prose quiz-prose text-amber-100"
                          dangerouslySetInnerHTML={{ __html: renderQuizText(hint) }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* MCQ Options */}
              {q.type === 'mcq' && q.options && (
                <div className="mt-3 space-y-2">
                  {q.options.map((opt, optIdx) => {
                    const picked = chosen === optIdx;
                    const rightOption = optIdx === q.correctIndex;
                    let cls =
                      'border-slate-800 bg-slate-950/70 text-slate-200 hover:border-slate-600';
                    if (isRevealed) {
                      if (rightOption) {
                        cls = 'border-emerald-500/70 bg-emerald-500/15 text-emerald-100';
                      } else if (picked && !rightOption) {
                        cls = 'border-rose-500/70 bg-rose-500/15 text-rose-100';
                      }
                    } else if (picked) {
                      cls = 'border-indigo-500 bg-indigo-500/20 text-white';
                    }

                    return (
                      <button
                        key={optIdx}
                        type="button"
                        disabled={isRevealed}
                        onClick={() =>
                          setSelectedAnswers((prev) => ({ ...prev, [q.id]: optIdx }))
                        }
                        className={`flex w-full items-center justify-between rounded-xl border px-3.5 py-2.5 text-left text-xs transition ${cls}`}
                      >
                        <span className="flex min-w-0 items-center gap-2.5">
                          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-slate-800 text-[11px] font-bold">
                            {String.fromCharCode(65 + optIdx)}
                          </span>
                          {looksLikeCode(opt) ? (
                            <code
                              className="hljs min-w-0 overflow-x-auto whitespace-pre rounded-md bg-slate-900/80 px-2 py-1 font-mono text-[12px]"
                              dangerouslySetInnerHTML={{ __html: highlightCodeSnippet(opt) }}
                            />
                          ) : (
                            <span
                              className="study-prose quiz-prose min-w-0"
                              dangerouslySetInnerHTML={{ __html: renderQuizText(opt) }}
                            />
                          )}
                        </span>
                        {isRevealed && rightOption && (
                          <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                        )}
                        {isRevealed && picked && !rightOption && (
                          <XCircle className="h-4 w-4 text-rose-400" />
                        )}
                      </button>
                    );
                  })}
                </div>
              )}

              {/* Short Answer */}
              {q.type === 'short-answer' && (
                <div className="mt-3">
                  <textarea
                    rows={2}
                    disabled={isRevealed}
                    value={shortAnswers[q.id] || ''}
                    onChange={(e) =>
                      setShortAnswers((prev) => ({ ...prev, [q.id]: e.target.value }))
                    }
                    placeholder="Kendi çözümünü veya cevabını buraya yaz..."
                    className="w-full rounded-xl border border-slate-700 bg-slate-950 p-3 text-xs text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
                  />
                </div>
              )}

              {/* Check Button */}
              {!isRevealed ? (
                <div className="mt-4 flex justify-end">
                  <button
                    type="button"
                    disabled={q.type === 'mcq' && chosen === undefined}
                    onClick={() => setRevealed((prev) => ({ ...prev, [q.id]: true }))}
                    className="rounded-xl bg-indigo-600 px-4 py-2 text-xs font-semibold text-white transition hover:bg-indigo-500 disabled:opacity-40"
                  >
                    Cevabı Kontrol Et
                  </button>
                </div>
              ) : (
                <div
                  className={`mt-4 rounded-xl border p-3.5 text-xs leading-relaxed ${
                    q.type === 'mcq'
                      ? isCorrect
                        ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-100'
                        : 'border-rose-500/40 bg-rose-500/10 text-rose-100'
                      : 'border-indigo-500/40 bg-indigo-500/10 text-indigo-100'
                  }`}
                >
                  <p className="mb-1 font-bold">
                    {q.type === 'mcq'
                      ? isCorrect
                        ? 'Doğru! Harika gidiyorsun.'
                        : 'Tam olmadı — açıklamayı inceleyelim:'
                      : `Beklenen Cevap: ${q.expectedAnswer || ''}`}
                  </p>
                  <div
                    className="study-prose quiz-prose"
                    dangerouslySetInnerHTML={{ __html: renderQuizText(q.explanation) }}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};
