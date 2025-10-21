const { env } = require('../../config/env');

function toLowerSafe(s) {
  return String(s || '').toLowerCase();
}

function normalizeChars(s) {
  // замена ё→е, удаление лишней пунктуации, нормализация пробелов
  const replaced = toLowerSafe(s)
    .replace(/ё/g, 'е')
    .replace(/[\p{P}\p{S}]+/gu, ' '); // punctuation/symbols to space
  return replaced.replace(/\s+/g, ' ').trim();
}

function isCyrillic(token) {
  return /[\p{Script=Cyrillic}]/u.test(token);
}

function isLatin(token) {
  return /[A-Za-z]/.test(token);
}

// Наивный RU-стемминг: снимаем распространённые падежные окончания, если база ≥5
const RU_SUFFIXES = [
  'ами','ями','ями','ами','ах','ях','ов','ев','ью','ями','ами',
  'ом','ем','ым','им','ой','ей','ою','ею','ам','ям',
  'у','ю','а','я','ы','и','о','е'
];

function stemRu(token) {
  const t = toLowerSafe(token);
  if (t.length < 5) return t;
  for (const suf of RU_SUFFIXES) {
    if (t.endsWith(suf) && t.length - suf.length >= 4) {
      return t.slice(0, -suf.length);
    }
  }
  return t;
}

// Вспомогательные функции для EN-стемминга
function isVowel(ch) {
  return /[aeiou]/.test(ch);
}

function collapseDoubleConsonantEnding(s) {
  if (!s || s.length < 2) return s;
  const last = s[s.length - 1];
  const prev = s[s.length - 2];
  // Сжимаем удвоенную конечную согласную, кроме 's' и 'z'
  if (last === prev && /[bcdfghjklmnpqrtvwxy]/.test(last)) {
    const before = s[s.length - 3] || '';
    if (isVowel(before)) {
      return s.slice(0, -1);
    }
  }
  return s;
}

// Простой EN-стемминг: s/es/ed/ing + CVC-дублирование
function stemEn(token) {
  let t = toLowerSafe(token);
  if (t.length >= 5 && t.endsWith('ing')) t = t.slice(0, -3);
  if (t.length >= 4 && t.endsWith('ed')) t = t.slice(0, -2);
  if (t.length >= 4 && t.endsWith('es')) t = t.slice(0, -2);
  if (t.length >= 4 && t.endsWith('s')) t = t.slice(0, -1);
  t = collapseDoubleConsonantEnding(t);
  return t;
}

function normalizeQueryText(raw) {
  const cleaned = normalizeChars(raw);
  if (!cleaned) return '';
  const tokens = cleaned.split(' ').filter(Boolean);
  const out = [];
  for (const tok of tokens) {
    if (isCyrillic(tok)) out.push(stemRu(tok));
    else if (isLatin(tok)) out.push(stemEn(tok));
    else out.push(tok);
  }
  // дедупликация, сохранение порядка первых вхождений
  const seen = new Set();
  const final = [];
  for (const t of out) {
    if (!seen.has(t)) { seen.add(t); final.push(t); }
  }
  return final.join(' ');
}

module.exports = { normalizeQueryText, normalizeChars, stemRu, stemEn };