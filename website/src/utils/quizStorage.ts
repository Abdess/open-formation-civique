const RESULT_PREFIX = 'quiz_result_';
const PROGRESS_PREFIX = 'quiz_progress_';
const LANG_KEY = 'quiz_lang';

export type LanguageMode = 'fr' | 'fr-en' | 'en';

export function getLanguageMode(): LanguageMode {
  try {
    const mode = localStorage.getItem(LANG_KEY);
    if (mode === 'fr' || mode === 'fr-en' || mode === 'en') return mode;
  } catch {
    // localStorage unavailable
  }
  return 'fr-en';
}

export function setLanguageMode(mode: LanguageMode): void {
  try {
    localStorage.setItem(LANG_KEY, mode);
  } catch {
    // localStorage unavailable
  }
}

export interface QuizResult {
  quizId: string;
  score: number;
  total: number;
  date: string;
}

export interface QuizProgress {
  quizId: string;
  currentIndex: number;
  answers: (number | null)[];
  validated: boolean[];
}

export function saveQuizResult(quizId: string, score: number, total: number): void {
  try {
    const result: QuizResult = {
      quizId,
      score,
      total,
      date: new Date().toISOString(),
    };
    localStorage.setItem(`${RESULT_PREFIX}${quizId}`, JSON.stringify(result));
    localStorage.removeItem(`${PROGRESS_PREFIX}${quizId}`);
  } catch {
    // localStorage unavailable
  }
}

export function getQuizResult(quizId: string): QuizResult | null {
  try {
    const raw = localStorage.getItem(`${RESULT_PREFIX}${quizId}`);
    if (!raw) return null;
    return JSON.parse(raw) as QuizResult;
  } catch {
    return null;
  }
}

export function getAllQuizResults(): QuizResult[] {
  const results: QuizResult[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(RESULT_PREFIX)) {
        const raw = localStorage.getItem(key);
        if (raw) {
          results.push(JSON.parse(raw) as QuizResult);
        }
      }
    }
  } catch {
    // localStorage unavailable
  }
  return results;
}

export function getAllQuizProgress(): QuizProgress[] {
  const progress: QuizProgress[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(PROGRESS_PREFIX)) {
        const raw = localStorage.getItem(key);
        if (raw) {
          progress.push(JSON.parse(raw) as QuizProgress);
        }
      }
    }
  } catch {
    // localStorage unavailable
  }
  return progress;
}

export function saveQuizProgress(quizId: string, currentIndex: number, answers: (number | null)[], validated: boolean[]): void {
  try {
    const progress: QuizProgress = { quizId, currentIndex, answers, validated };
    localStorage.setItem(`${PROGRESS_PREFIX}${quizId}`, JSON.stringify(progress));
  } catch {
    // localStorage unavailable
  }
}

export function getQuizProgress(quizId: string): QuizProgress | null {
  try {
    const raw = localStorage.getItem(`${PROGRESS_PREFIX}${quizId}`);
    if (!raw) return null;
    return JSON.parse(raw) as QuizProgress;
  } catch {
    return null;
  }
}

export function resetQuizResult(quizId: string): void {
  try {
    localStorage.removeItem(`${RESULT_PREFIX}${quizId}`);
    localStorage.removeItem(`${PROGRESS_PREFIX}${quizId}`);
  } catch {
    // localStorage unavailable
  }
}

export function resetAllQuizzes(): void {
  try {
    const keysToRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(RESULT_PREFIX) || key?.startsWith(PROGRESS_PREFIX)) {
        keysToRemove.push(key);
      }
    }
    keysToRemove.forEach((key) => localStorage.removeItem(key));
  } catch {
    // localStorage unavailable
  }
}

const SR_PREFIX = 'quiz_sr_';

export interface SRItem {
  questionId: string;
  quizId: string;
  easeFactor: number;
  interval: number;
  repetitions: number;
  nextReview: string;
  lastGrade: number;
}

export function getSRItem(questionId: string): SRItem | null {
  try {
    const raw = localStorage.getItem(`${SR_PREFIX}${questionId}`);
    return raw ? (JSON.parse(raw) as SRItem) : null;
  } catch {
    return null;
  }
}

export function updateSR(questionId: string, quizId: string, isCorrect: boolean): void {
  try {
    const grade = isCorrect ? 4 : 1;
    const existing = getSRItem(questionId);
    const item: SRItem = existing ?? {
      questionId,
      quizId,
      easeFactor: 2.5,
      interval: 1,
      repetitions: 0,
      nextReview: new Date().toISOString(),
      lastGrade: 0,
    };

    if (isCorrect) {
      if (item.repetitions === 0) item.interval = 1;
      else if (item.repetitions === 1) item.interval = 3;
      else item.interval = Math.round(item.interval * item.easeFactor);
      item.repetitions++;
    } else {
      item.repetitions = 0;
      item.interval = 1;
    }

    item.easeFactor = Math.max(
      1.3,
      item.easeFactor + 0.1 - (5 - grade) * (0.08 + (5 - grade) * 0.02),
    );
    item.lastGrade = grade;

    const next = new Date();
    next.setDate(next.getDate() + item.interval);
    item.nextReview = next.toISOString();

    localStorage.setItem(`${SR_PREFIX}${questionId}`, JSON.stringify(item));
  } catch {
    // localStorage unavailable
  }
}

export function getDueQuestions(limit = 20): SRItem[] {
  const due: SRItem[] = [];
  const now = new Date().toISOString();
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(SR_PREFIX)) {
        const raw = localStorage.getItem(key);
        if (raw) {
          const item = JSON.parse(raw) as SRItem;
          if (item.nextReview <= now) due.push(item);
        }
      }
    }
  } catch {
    // localStorage unavailable
  }
  return due.sort((a, b) => a.nextReview.localeCompare(b.nextReview)).slice(0, limit);
}

export function getSRStats(): { total: number; due: number; mastered: number } {
  let total = 0;
  let due = 0;
  let mastered = 0;
  const now = new Date().toISOString();
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(SR_PREFIX)) {
        total++;
        const raw = localStorage.getItem(key);
        if (raw) {
          const item = JSON.parse(raw) as SRItem;
          if (item.nextReview <= now) due++;
          if (item.repetitions >= 5 && item.easeFactor >= 2.0) mastered++;
        }
      }
    }
  } catch {
    // localStorage unavailable
  }
  return { total, due, mastered };
}
