import { describe, expect, it } from 'vitest';
import {
  materializeArtifacts,
  materializeBoardCards,
  parseStudyResponse,
} from '../server/services/artifactParser.js';

describe('artifactParser', () => {
  it('parses 3d-scene, formula-lab, quiz, and study-board-action blocks cleanly', () => {
    const raw = `Harika bir soru! İşte 3D model ve formül açıklaması:

\`\`\`study-artifact type="3d-scene" title="3D Vektör Modeli"
<!doctype html><html><body><canvas></canvas></body></html>
\`\`\`

\`\`\`study-artifact type="formula-lab" title="Newton 2. Yasası"
{"latex":"F = m \\\\cdot a","summary":"Kuvvet = kütle × ivme","terms":[{"id":"f","symbol":"F","label":"Kuvvet","color":"#f43f5e","meaning":"Net kuvvet"}]}
\`\`\`

\`\`\`study-artifact type="quiz" title="Mini Test"
{"topic":"Dinamik","questions":[{"id":"q1","type":"mcq","prompt":"F=ma?","options":["Evet","Hayır"],"correctIndex":0,"hints":["Temel yasa"],"explanation":"Doğru"}]}
\`\`\`

\`\`\`study-board-action
{"kind":"hint","title":"Sokratik İpucu","content":"Önce serbest cisim diyagramını çiz.","latex":"\\\\sum F = ma"}
\`\`\`

Başka sorun var mı?`;

    const parsed = parseStudyResponse(raw);
    expect(parsed.artifactDrafts).toHaveLength(3);
    expect(parsed.artifactDrafts[0].type).toBe('3d-scene');
    expect(parsed.artifactDrafts[0].title).toBe('3D Vektör Modeli');
    expect(parsed.artifactDrafts[1].type).toBe('formula-lab');
    expect(parsed.artifactDrafts[1].parsedData).toBeDefined();
    expect(parsed.artifactDrafts[2].type).toBe('quiz');
    expect(parsed.artifactDrafts[2].parsedData).toBeDefined();

    expect(parsed.boardActions).toHaveLength(1);
    expect(parsed.boardActions[0].kind).toBe('hint');
    expect(parsed.displayContent).toContain('Harika bir soru!');
    expect(parsed.displayContent).toContain('Başka sorun var mı?');
    expect(parsed.displayContent).not.toContain('study-artifact');
    expect(parsed.displayContent).not.toContain('study-board-action');
  });

  it('increments version numbers for artifacts with matching title and type', () => {
    const parsed = parseStudyResponse(
      '```study-artifact type="2d-canvas" title="Dalga Simülasyonu"\n<canvas></canvas>\n```',
    );
    const v1 = materializeArtifacts('ws-1', parsed.artifactDrafts, []);
    expect(v1[0].version).toBe(1);

    const v2 = materializeArtifacts('ws-1', parsed.artifactDrafts, v1);
    expect(v2[0].version).toBe(2);
  });

  it('positions materialized board cards without overlap', () => {
    const cards = materializeBoardCards(
      [
        { kind: 'hint', title: 'İpucu 1', content: 'A' },
        { kind: 'feedback', title: 'Kontrol', content: 'B' },
      ],
      [],
    );
    expect(cards).toHaveLength(2);
    expect(cards[0].author).toBe('ai');
    expect(cards[0].x).not.toBe(cards[1].x);
  });
});
