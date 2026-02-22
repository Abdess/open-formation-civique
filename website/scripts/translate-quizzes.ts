import { readFileSync, readdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { OpenRouter } from '@openrouter/sdk';
import pLimit from 'p-limit';
import cliProgress from 'cli-progress';

const __dirname = dirname(fileURLToPath(import.meta.url));

const QUIZZES_DIR = join(__dirname, '../src/data/quizzes');
const MODEL = 'google/gemini-3-pro-preview';
const BATCH_SIZE = 20;

const QUESTIONS_SYSTEM_PROMPT = `You are a professional translator for French civic education content targeting English-speaking immigrants in France.

Translate the given French quiz questions to English.

Rules:
- Use simple, clear English (target audience: A1-A2 French learners)
- Keep iconic French terms in French with English in parentheses, e.g.: "Liberté, Égalité, Fraternité (Liberty, Equality, Fraternity)"
- Preserve the EXACT number of options and their EXACT order — this is critical for answer matching
- Keep explanations educational and accessible
- Do NOT add, remove, or reorder any options

Respond ONLY with a valid JSON array. Each element must have: questionEn, optionsEn (same length as original options), explanationEn.`;

const METADATA_SYSTEM_PROMPT =
  'Translate the following French quiz metadata to simple English. Respond ONLY with JSON: {"titleEn": "...", "descriptionEn": "..."}';

interface QuizQuestion {
  id: string;
  question: string;
  questionEn?: string;
  options: string[];
  optionsEn?: string[];
  correctAnswer: number;
  explanation: string;
  explanationEn?: string;
}

interface QuizFile {
  id: string;
  title: string;
  titleEn?: string;
  description: string;
  descriptionEn?: string;
  questions: QuizQuestion[];
}

interface QuestionTranslation {
  questionEn: string;
  optionsEn: string[];
  explanationEn: string;
}

function isFullyTranslated(quiz: QuizFile): boolean {
  if (!quiz.titleEn || !quiz.descriptionEn) return false;
  return quiz.questions.every((q) => q.questionEn && q.optionsEn && q.explanationEn);
}

function getUntranslatedIndices(questions: QuizQuestion[]): number[] {
  return questions.reduce<number[]>((indices, q, i) => {
    if (!q.questionEn || !q.optionsEn || !q.explanationEn) indices.push(i);
    return indices;
  }, []);
}

async function translateMetadata(
  openRouter: OpenRouter,
  title: string,
  description: string,
): Promise<{ titleEn: string; descriptionEn: string }> {
  const completion = await openRouter.chat.send({
    model: MODEL,
    messages: [
      { role: 'system', content: METADATA_SYSTEM_PROMPT },
      { role: 'user', content: JSON.stringify({ title, description }) },
    ],
    stream: false,
    temperature: 0.2,
    reasoning: { effort: 'medium' },
  });

  const raw = completion.choices[0].message.content!.trim();
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(`No JSON object found in metadata response: ${raw.substring(0, 200)}`);
  }

  const parsed = JSON.parse(jsonMatch[0]);
  if (!parsed.titleEn || !parsed.descriptionEn) {
    throw new Error(`Missing titleEn or descriptionEn in response: ${raw.substring(0, 200)}`);
  }

  return parsed;
}

async function translateQuestionBatch(
  openRouter: OpenRouter,
  questions: QuizQuestion[],
): Promise<QuestionTranslation[]> {
  const input = questions.map((q) => ({
    question: q.question,
    options: q.options,
    explanation: q.explanation,
  }));

  const completion = await openRouter.chat.send({
    model: MODEL,
    messages: [
      { role: 'system', content: QUESTIONS_SYSTEM_PROMPT },
      { role: 'user', content: JSON.stringify(input) },
    ],
    stream: false,
    temperature: 0.2,
    reasoning: { effort: 'medium' },
  });

  const raw = completion.choices[0].message.content!.trim();
  const jsonMatch = raw.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    throw new Error(`No JSON array found in response: ${raw.substring(0, 200)}`);
  }

  const translations: QuestionTranslation[] = JSON.parse(jsonMatch[0]);

  if (translations.length !== questions.length) {
    throw new Error(`Expected ${questions.length} translations, got ${translations.length}`);
  }

  for (let i = 0; i < translations.length; i++) {
    const t = translations[i];
    if (!t.questionEn || !Array.isArray(t.optionsEn) || !t.explanationEn) {
      throw new Error(`Invalid translation at index ${i}: ${JSON.stringify(t).substring(0, 200)}`);
    }
    if (t.optionsEn.length !== questions[i].options.length) {
      throw new Error(
        `Options count mismatch at index ${i}: expected ${questions[i].options.length}, got ${t.optionsEn.length}`,
      );
    }
  }

  return translations;
}

async function main() {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.error('OPENROUTER_API_KEY environment variable is required');
    process.exit(1);
  }

  const openRouter = new OpenRouter({ apiKey });
  const limit = pLimit(5);

  const files = readdirSync(QUIZZES_DIR).filter((f) => f.endsWith('.json'));
  const quizzes: { file: string; quiz: QuizFile; untranslated: number[] }[] = [];

  let totalQuestions = 0;
  let alreadyDone = 0;

  for (const file of files) {
    const quiz: QuizFile = JSON.parse(readFileSync(join(QUIZZES_DIR, file), 'utf-8'));

    if (isFullyTranslated(quiz)) {
      alreadyDone += quiz.questions.length;
      continue;
    }

    const untranslated = getUntranslatedIndices(quiz.questions);
    alreadyDone += quiz.questions.length - untranslated.length;
    totalQuestions += untranslated.length;
    quizzes.push({ file, quiz, untranslated });
  }

  console.log(
    `\n${files.length} quiz files, ${alreadyDone} questions already translated, ${totalQuestions} to translate\n`,
  );

  if (quizzes.length === 0) {
    console.log('Nothing to translate!');
    return;
  }

  const bar = new cliProgress.SingleBar({
    format: '{bar} {percentage}% | {value}/{total} | {status}',
    barCompleteChar: '\u2588',
    barIncompleteChar: '\u2591',
    hideCursor: true,
  });

  let processed = 0;
  let failed = 0;

  bar.start(totalQuestions, 0, { status: 'Starting...' });

  const tasks = quizzes.map(({ file, quiz, untranslated }) =>
    limit(async () => {
      const label = quiz.id;

      try {
        if (!quiz.titleEn || !quiz.descriptionEn) {
          const meta = await translateMetadata(openRouter, quiz.title, quiz.description);
          quiz.titleEn = meta.titleEn;
          quiz.descriptionEn = meta.descriptionEn;
        }

        for (let i = 0; i < untranslated.length; i += BATCH_SIZE) {
          const batchIndices = untranslated.slice(i, i + BATCH_SIZE);
          const batch = batchIndices.map((idx) => quiz.questions[idx]);

          const translations = await translateQuestionBatch(openRouter, batch);

          for (let j = 0; j < translations.length; j++) {
            const idx = batchIndices[j];
            quiz.questions[idx].questionEn = translations[j].questionEn;
            quiz.questions[idx].optionsEn = translations[j].optionsEn;
            quiz.questions[idx].explanationEn = translations[j].explanationEn;
          }

          processed += batch.length;
          bar.update(processed, { status: label });
        }

        writeFileSync(join(QUIZZES_DIR, file), JSON.stringify(quiz, null, 2) + '\n', 'utf-8');
      } catch (err) {
        failed += untranslated.length;
        bar.increment(untranslated.length, { status: `FAIL ${label}` });
        console.error(`\nFailed "${label}": ${err instanceof Error ? err.message : err}`);
      }
    }),
  );

  await Promise.all(tasks);
  bar.stop();

  console.log(`\nResults:`);
  console.log(`  Translated: ${processed}`);
  console.log(`  Already done: ${alreadyDone}`);
  console.log(`  Failed: ${failed}`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
