'use strict';

const LETTERS = 'ABCDEFGHIJ'.split('');
const STORE = 'team-draw-v1';
const $ = s => document.querySelector(s);

// пары людей, которым нельзя в одну команду - задаются в conflicts.js
const CONFLICTS = window.CONFLICTS || [];

const el = {
  ambNote: $('#ambNote'),
  teams:   $('#teamsCount'),
  binsN:   $('#binsCount'),
  girls:   $('#spreadGirls'),
  bins:    $('#bins'),
  stats:   $('#stats'),
  warn:    $('#warnings'),
  result:  $('#result'),
  modal:   $('#modal'),
  modalBody: $('#modalBody'),
};

let binTexts = ['', '', ''];   // содержимое корзин
let lastDraw = null;
let lastBins = null;
let picked = null;   // выбранный игрок для ручного обмена: {ti, pi}
let teamNames = [];  // названия команд, заданные вручную

function teamName(i){
  const n = (teamNames[i] || '').trim();
  return n || 'Команда ' + (i + 1);
}

/* ---------- ключ человека (без учёта порядка слов и регистра) ---------- */

function personKey(name){
  return String(name).toLowerCase().replace(/ё/g, 'е')
    .split(/[\s.,-]+/).filter(Boolean).sort().join(' ');
}

// ключ -> множество ключей тех, с кем нельзя в одну команду
const ENEMIES = (() => {
  const m = new Map();
  CONFLICTS.forEach(pair => {
    const a = personKey(pair[0]), b = personKey(pair[1]);
    if (!a || !b || a === b) return;
    if (!m.has(a)) m.set(a, new Set());
    if (!m.has(b)) m.set(b, new Set());
    m.get(a).add(b);
    m.get(b).add(a);
  });
  return m;
})();

/* ---------- разбор участников ---------- */

// Явная пометка: "Аня*" / "Аня (ж)" - девушка, "Саша (м)" / "Саша#" - мужчина.
// Без пометки пол определяется по имени (gender.js).
function parsePlayer(raw){
  let s = raw.trim();
  if (!s) return null;

  const f = s.match(/^(.*?)\s*(\*|\(ж\)|\(f\)|\(g\))$/i);
  if (f && f[1].trim()) return mk(f[1].trim(), true, true, false);

  const m = s.match(/^(.*?)\s*(#|\(м\)|\(m\))$/i);
  if (m && m[1].trim()) return mk(m[1].trim(), false, true, false);

  const guess = detectFemale(s);
  return mk(s, guess.female, false, guess.ambiguous);
}

function mk(name, female, explicit, ambiguous){
  const key = personKey(name);
  return { name, female, explicit, ambiguous, key, enemies: ENEMIES.get(key) || null };
}

function parseBin(text){
  return text.split(/[\n,;]+/).map(parsePlayer).filter(Boolean);
}

// автоопределённый пол в текст не пишем - список остаётся чистым
function serializePlayer(p){
  if (!p.explicit) return p.name;
  return p.female ? p.name + '*' : p.name + ' (м)';
}

function allBins(){ return binTexts.map(parseBin); }

/* ---------- утилиты ---------- */

function shuffle(a){
  for (let i = a.length - 1; i > 0; i--){
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// лексикографическое сравнение ключей
function less(a, b){
  for (let i = 0; i < a.length; i++){
    if (a[i] !== b[i]) return a[i] < b[i];
  }
  return false;
}

/* ---------- жеребьёвка ---------- */

// размеры команд: делим максимально ровно, остаток - случайным командам
function makeTargets(total, T){
  const base = Math.floor(total / T);
  const rem = total % T;
  const t = new Array(T).fill(base);
  shuffle([...Array(T).keys()]).slice(0, rem).forEach(i => t[i]++);
  return t;
}

function attempt(bins, T, spreadGirls){
  const total = bins.reduce((s, b) => s + b.length, 0);
  const targets = makeTargets(total, T);

  // rank - суммарный уровень команды: игрок из A стоит 1, из B - 2, из C - 3...
  // Чем меньше сумма, тем сильнее команда. Выравнивая её, мы компенсируем недобор:
  // команда, которой не хватило сильного из A, получает лишнего из B, а не из D.
  const teams = Array.from({ length: T }, () => ({
    players: [], girls: 0, rank: 0, keys: new Set(), byBin: new Array(bins.length).fill(0)
  }));

  bins.forEach((bin, bi) => {
    const queue = shuffle(bin.slice());
    // вперёд идут те, кого сложнее разместить: с запретами, затем девушки
    queue.sort((a, b) => weight(b, spreadGirls) - weight(a, spreadGirls));

    for (const p of queue){
      let cand = shuffle([...Array(T).keys()])
        .filter(i => teams[i].players.length < targets[i]);
      if (!cand.length) continue;

      // убираем команды, где уже есть конфликтующий игрок
      if (p.enemies){
        const ok = cand.filter(i => !hasEnemy(teams[i], p));
        if (ok.length) cand = ok;   // если мест нет совсем - штраф начислит score()
      }

      let best = cand[0], bestKey = null;
      for (const i of cand){
        const t = teams[i];
        const key = [
          spreadGirls && p.female ? t.girls : 0,  // 1. меньше всего девушек
          t.rank,                                 // 2. самая «недокомплектованная» по уровню
          t.byBin[bi],                            // 3. меньше всего игроков из этой корзины
          t.players.length                        // 4. меньше всего игроков вообще
        ];
        if (bestKey === null || less(key, bestKey)){ best = i; bestKey = key; }
      }
      const t = teams[best];
      t.players.push(p);
      t.keys.add(p.key);
      if (p.female) t.girls++;
      t.rank += bi + 1;
      t.byBin[bi]++;
    }
  });

  return teams;
}

function weight(p, spreadGirls){
  return (p.enemies ? 2 : 0) + (spreadGirls && p.female ? 1 : 0);
}

function hasEnemy(team, p){
  if (!p.enemies) return false;
  for (const k of p.enemies) if (team.keys.has(k)) return true;
  return false;
}

function countConflicts(teams){
  if (!ENEMIES.size) return 0;
  let n = 0;
  teams.forEach(t => t.players.forEach(p => {
    if (!p.enemies) return;
    for (const k of p.enemies) if (t.keys.has(k)) n++;
  }));
  return n / 2;   // каждую пару считаем дважды
}

// чем меньше - тем ровнее раскладка; тот же критерий, по которому работает доводка
function score(teams, spreadGirls){
  const T = teams.length;
  let s = badness(teams, spreadGirls);
  const avgSize = teams.reduce((n, t) => n + t.players.length, 0) / T;
  for (const t of teams) s += Math.pow(t.players.length - avgSize, 2);
  return s;
}

/* Доводка обменами.
   Раздача идёт корзина за корзиной, поэтому к концу выбор сужается: свободные
   места остаются в одной-двух командах, и туда попадает кто придётся - две
   девушки разом или лишний слабый игрок. Лечится обменом: меняем местами двух
   игроков из разных команд, если от этого общий перекос уменьшается. Размер
   команд при обмене не меняется никогда, поэтому составы остаются равными. */

function badness(teams, spreadGirls){
  const T = teams.length;
  let s = 100000 * countConflicts(teams);

  if (spreadGirls){
    const avg = teams.reduce((n, t) => n + t.girls, 0) / T;
    for (const t of teams) s += 100 * Math.pow(t.girls - avg, 2);
  }
  // равенство команд по силе - главное, ради чего вообще нужны корзины.
  // Считаем силу НА ИГРОКА: если в одной команде 5 человек, а в другой 4,
  // сравнивать суммы бессмысленно - пятый игрок всегда даст перевес.
  const totalPlayers = teams.reduce((n, t) => n + t.players.length, 0);
  const perAvg = totalPlayers ? teams.reduce((n, t) => n + t.rank, 0) / totalPlayers : 0;
  const w = 10 * Math.pow(totalPlayers / T, 2);   // масштаб, чтобы вес не зависел от размера команд
  for (const t of teams){
    if (!t.players.length) continue;
    s += w * Math.pow(t.rank / t.players.length - perAvg, 2);
  }

  // и всё же стараемся не собирать в одной команде толпу из одной корзины
  for (let bi = 0; bi < teams[0].byBin.length; bi++){
    const avgB = teams.reduce((n, t) => n + t.byBin[bi], 0) / T;
    for (const t of teams) s += Math.pow(t.byBin[bi] - avgB, 2);
  }
  return s;
}

function swapPlayers(ta, tb, ia, ib){
  const pa = ta.players[ia], pb = tb.players[ib];
  ta.players[ia] = pb;
  tb.players[ib] = pa;
  ta.keys.delete(pa.key); ta.keys.add(pb.key);
  tb.keys.delete(pb.key); tb.keys.add(pa.key);
  if (pa.female !== pb.female){
    ta.girls += pb.female ? 1 : -1;
    tb.girls += pa.female ? 1 : -1;
  }
  if (pa.bin !== pb.bin){
    ta.rank += pb.bin - pa.bin;
    tb.rank += pa.bin - pb.bin;
    ta.byBin[pa.bin]--; ta.byBin[pb.bin]++;
    tb.byBin[pb.bin]--; tb.byBin[pa.bin]++;
  }
}

function teamConflicts(t){
  if (!ENEMIES.size) return 0;
  let n = 0;
  for (const p of t.players){
    if (!p.enemies) continue;
    for (const k of p.enemies) if (t.keys.has(k)) n++;
  }
  return n / 2;
}

/* Вклад двух команд в общий перекос. Обмен затрагивает только их, а средние
   не меняются (число девушек, сумма уровней и размеры корзин те же), поэтому
   сравнивать достаточно эти две команды - на порядок быстрее полного пересчёта. */
function pairCost(ta, tb, avgG, perAvg, w, avgB, spreadGirls){
  let s = 100000 * (teamConflicts(ta) + teamConflicts(tb));
  if (spreadGirls) s += 100 * (Math.pow(ta.girls - avgG, 2) + Math.pow(tb.girls - avgG, 2));
  if (ta.players.length) s += w * Math.pow(ta.rank / ta.players.length - perAvg, 2);
  if (tb.players.length) s += w * Math.pow(tb.rank / tb.players.length - perAvg, 2);
  for (let bi = 0; bi < avgB.length; bi++)
    s += Math.pow(ta.byBin[bi] - avgB[bi], 2) + Math.pow(tb.byBin[bi] - avgB[bi], 2);
  return s;
}

function improve(teams, spreadGirls){
  const T = teams.length;
  const avgG = teams.reduce((n, t) => n + t.girls, 0) / T;
  const totalPlayers = teams.reduce((n, t) => n + t.players.length, 0);
  const perAvg = totalPlayers ? teams.reduce((n, t) => n + t.rank, 0) / totalPlayers : 0;
  const w = 10 * Math.pow(totalPlayers / T, 2);
  const avgB = teams[0].byBin.map((_, bi) => teams.reduce((n, t) => n + t.byBin[bi], 0) / T);

  let guard = 0, moved = true;
  while (moved && guard++ < 12){
    moved = false;
    for (let i = 0; i < T; i++){
      for (let j = i + 1; j < T; j++){
        const ta = teams[i], tb = teams[j];
        let before = pairCost(ta, tb, avgG, perAvg, w, avgB, spreadGirls);
        if (before === 0) continue;
        for (let a = 0; a < ta.players.length; a++){
          for (let b = 0; b < tb.players.length; b++){
            const pa = ta.players[a], pb = tb.players[b];
            if (pa.bin === pb.bin && pa.female === pb.female && !pa.enemies && !pb.enemies) continue;
            swapPlayers(ta, tb, a, b);
            const after = pairCost(ta, tb, avgG, perAvg, w, avgB, spreadGirls);
            if (after < before - 1e-9){ before = after; moved = true; }
            else swapPlayers(ta, tb, a, b);   // откат
          }
        }
      }
    }
  }
}

function draw(bins, T, spreadGirls){
  const total = bins.reduce((s, b) => s + b.length, 0);
  const tries = total <= 40 ? 150 : total <= 120 ? 60 : 25;
  let best = null, bestScore = Infinity;
  for (let i = 0; i < tries; i++){
    const t = attempt(bins, T, spreadGirls);
    improve(t, spreadGirls);
    const sc = score(t, spreadGirls);
    if (sc < bestScore){ bestScore = sc; best = t; }
  }
  // внутри команды: сначала игроки из корзины A, потом B, C...
  // (сортировка стабильная, поэтому внутри одной корзины порядок остаётся случайным)
  best.forEach(t => { shuffle(t.players); t.players.sort((a, b) => a.bin - b.bin); });
  return best;
}

/* ---------- отрисовка корзин ---------- */

function renderBins(){
  const n = +el.binsN.value;
  while (binTexts.length < n) binTexts.push('');
  binTexts.length = n;

  el.bins.innerHTML = '';
  binTexts.forEach((text, i) => {
    const box = document.createElement('div');
    box.className = 'bin';
    box.innerHTML =
      '<div class="bin-head">' +
        '<b>Корзина ' + LETTERS[i] + '</b>' +
        '<span class="cnt"></span>' +
      '</div>' +
      '<textarea placeholder="Одно имя в строке&#10;Иван Крылов&#10;Алина Веселова"></textarea>' +
      '<div class="bin-tools">' +
        '<button class="mini" data-act="shuffle">Перемешать</button>' +
        '<button class="mini" data-act="sort">По алфавиту</button>' +
        '<button class="mini" data-act="clear">Очистить</button>' +
      '</div>';
    const ta = box.querySelector('textarea');
    ta.value = text;
    ta.addEventListener('input', () => { binTexts[i] = ta.value; save(); updateStats(); refreshCounts(); });
    box.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
      const list = parseBin(binTexts[i]);
      if (b.dataset.act === 'shuffle') shuffle(list);
      if (b.dataset.act === 'sort') list.sort((a, c) => a.name.localeCompare(c.name, 'ru'));
      if (b.dataset.act === 'clear') list.length = 0;
      binTexts[i] = list.map(serializePlayer).join('\n');
      renderBins(); save();
    }));
    el.bins.appendChild(box);
  });
  refreshCounts();
  updateStats();
}

function refreshCounts(){
  el.bins.querySelectorAll('.bin').forEach((box, i) => {
    const players = parseBin(binTexts[i]);
    const g = players.filter(p => p.female).length;
    box.querySelector('.cnt').textContent = players.length + ' чел.' + (g ? ' · ♀ ' + g : '');
  });
}

function updateStats(){
  const bins = allBins();
  const flat = bins.flat();
  const total = flat.length;
  const girls = flat.filter(p => p.female).length;
  const T = +el.teams.value;
  const base = Math.floor(total / T), rem = total % T;
  const sizes = total < T ? '-'
    : rem === 0 ? 'по ' + base
    : rem + ' × ' + (base + 1) + ' и ' + (T - rem) + ' × ' + base;
  el.stats.textContent = 'Всего ' + total + ' чел. (♀ ' + girls + ') · ' + T + ' команд · составы: ' + sizes;

  // спорные имена - предупреждаем, что пол мог определиться неверно
  const amb = flat.filter(p => p.ambiguous && !p.explicit).map(p => p.name);
  el.ambNote.textContent = amb.length
    ? 'Пол неочевиден: ' + [...new Set(amb)].join(', ') + ' - проверьте кнопкой «Проверить пол».'
    : '';
}

/* ---------- предупреждения ---------- */

function renderWarnings(bins, T, teams){
  const out = [];
  const flat = bins.flat();
  const total = flat.length;

  const seen = new Map();
  flat.forEach(p => {
    const rec = seen.get(p.key) || { n: 0, name: p.name };
    rec.n++;
    seen.set(p.key, rec);
  });
  const dups = [...seen.values()].filter(r => r.n > 1).map(r => r.name);
  if (dups.length) out.push('Дубли в списках: ' + dups.join(', ') + '. Нажмите «Убрать дубли».');

  if (total < T) out.push('Участников меньше, чем команд - часть команд останется пустой.');
  if (total % T !== 0) out.push(total + ' не делится на ' + T + ' - составы будут отличаться на одного игрока.');

  const uneven = bins.map((b, i) => b.length && b.length % T !== 0 ? LETTERS[i] + ' (' + b.length + ')' : null).filter(Boolean);
  if (uneven.length)
    out.push('Корзины ' + uneven.join(', ') + ' не кратны ' + T + ' - игроки из них разойдутся по командам с разницей в одного человека. Это нормально, общий баланс сохраняется.');

  if (teams && countConflicts(teams))
    out.push('Не удалось развести всех по персональным запретам - слишком мало команд или мест. Проверьте составы вручную.');

  el.warn.innerHTML = '';
  out.forEach(text => {
    const d = document.createElement('div');
    d.className = 'msg warn';
    d.textContent = text;
    el.warn.appendChild(d);
  });
}

/* ---------- отрисовка результата ---------- */

// Сила команды: игрок из первой корзины стоит столько баллов, сколько всего корзин.
// При четырёх корзинах A = 4, B = 3, C = 2, D = 1.
function power(t, nBins){
  return t.players.reduce((s, p) => s + (nBins - p.bin), 0);
}

// Если составы неравны, суммы несопоставимы - показываем силу на одного игрока.
function equalSizes(teams){
  const sizes = teams.map(t => t.players.length);
  return Math.max.apply(null, sizes) === Math.min.apply(null, sizes);
}

function powerText(t, nBins, equal){
  const p = power(t, nBins);
  if (equal) return String(p);
  if (!t.players.length) return '0';
  return (p / t.players.length).toFixed(1).replace('.', ',');
}

/* Ручной обмен: нажали на игрока, потом на игрока другой команды - меняются местами.
   Повторное нажатие на того же снимает выделение. */
function pickPlayer(ti, pi){
  if (picked && picked.ti === ti && picked.pi === pi) picked = null;
  else if (!picked || picked.ti === ti) picked = { ti: ti, pi: pi };
  else {
    const ta = lastDraw[picked.ti], tb = lastDraw[ti];
    swapPlayers(ta, tb, picked.pi, pi);
    [ta, tb].forEach(t => t.players.sort((a, b) => a.bin - b.bin));
    picked = null;
  }
  renderResult(lastDraw, lastBins);
}

/* ---------- картинка с составами ----------
   Рисуем на canvas вручную: PNG удобно кинуть в чат, его видно сразу,
   без переходов по ссылкам. */

const PNG = {
  bg: '#f5f7fa', card: '#ffffff', line: '#dde2ea',
  tx: '#1b1f27', mut: '#6b7484', girl: '#d6336c', acc: '#2563eb'
};

function fitText(ctx, text, max){
  if (ctx.measureText(text).width <= max) return text;
  let s = text;
  while (s.length > 1 && ctx.measureText(s + '…').width > max) s = s.slice(0, -1);
  return s + '…';
}

function drawImage(teams, bins){
  const T = teams.length;
  const cols = T <= 2 ? T : T <= 6 ? 3 : 4;
  const rows = Math.ceil(T / cols);
  const maxPlayers = Math.max.apply(null, teams.map(t => t.players.length));
  const equal = equalSizes(teams);
  const usedBins = bins.map((b, i) => b.length ? i : -1).filter(i => i >= 0);

  const pad = 36, gap = 18, cardW = 300;
  const cardH = 54 + 28 * maxPlayers + (usedBins.length > 1 ? 40 : 12);
  const W = pad * 2 + cardW * cols + gap * (cols - 1);

  const sched = $('#showSchedule').checked && T > 1
    ? roundRobin(T, $('#doubleRound').checked) : null;
  const schedH = sched ? 40 + 26 * sched.length + 16 : 0;

  const H = pad + 46 + rows * cardH + (rows - 1) * gap + schedH + pad;

  const scale = 2;
  const cv = document.createElement('canvas');
  cv.width = W * scale;
  cv.height = H * scale;
  const c = cv.getContext('2d');
  c.scale(scale, scale);
  c.textBaseline = 'top';

  c.fillStyle = PNG.bg;
  c.fillRect(0, 0, W, H);

  c.fillStyle = PNG.tx;
  c.font = '700 24px Arial';
  c.fillText('Составы команд', pad, pad);
  const total = teams.reduce((n, t) => n + t.players.length, 0);
  const girls = teams.reduce((n, t) => n + t.girls, 0);
  c.fillStyle = PNG.mut;
  c.font = '14px Arial';
  c.fillText(total + ' ' + plural(total, 'участник', 'участника', 'участников')
    + (girls ? ', из них ♀ ' + girls : ''), pad, pad + 30);

  const top0 = pad + 46;
  teams.forEach((t, i) => {
    const x = pad + (i % cols) * (cardW + gap);
    const y = top0 + Math.floor(i / cols) * (cardH + gap);

    c.fillStyle = PNG.card;
    c.strokeStyle = PNG.line;
    c.lineWidth = 1;
    c.beginPath();
    c.roundRect(x, y, cardW, cardH, 10);
    c.fill();
    c.stroke();

    c.fillStyle = PNG.tx;
    c.font = '700 17px Arial';
    c.fillText(fitText(c, teamName(i), cardW - 100), x + 14, y + 14);

    c.fillStyle = PNG.mut;
    c.font = '13px Arial';
    const cnt = t.players.length + ' чел.' + (t.girls ? ' · ♀' + t.girls : '');
    c.fillText(cnt, x + cardW - 14 - c.measureText(cnt).width, y + 16);

    c.font = '15px Arial';
    t.players.forEach((p, pi) => {
      const ty = y + 48 + pi * 28;
      c.fillStyle = PNG.mut;
      c.font = '13px Arial';
      c.fillText(String(pi + 1) + '.', x + 14, ty + 2);
      c.fillStyle = p.female ? PNG.girl : PNG.tx;
      c.font = '15px Arial';
      c.fillText(fitText(c, p.name + (p.female ? ' ♀' : ''), cardW - 50), x + 36, ty);
    });

    if (usedBins.length > 1){
      const fy = y + cardH - 26;
      c.strokeStyle = PNG.line;
      c.beginPath();
      c.moveTo(x + 14, fy - 8);
      c.lineTo(x + cardW - 14, fy - 8);
      c.stroke();
      c.fillStyle = PNG.mut;
      c.font = '12px Arial';
      c.fillText(usedBins.map(bi => LETTERS[bi] + ': ' + t.byBin[bi]).join(' · ')
        + ' · Сила: ' + powerText(t, bins.length, equal) + (equal ? '' : ' / игрок'), x + 14, fy);
    }
  });

  if (sched){
    let y = top0 + rows * cardH + (rows - 1) * gap + 28;
    c.fillStyle = PNG.tx;
    c.font = '700 18px Arial';
    c.fillText('Расписание игр', pad, y);
    y += 30;
    c.font = '14px Arial';
    sched.forEach((r, i) => {
      c.fillStyle = PNG.mut;
      c.fillText('Тур ' + (i + 1), pad, y);
      c.fillStyle = PNG.tx;
      const line = r.games.map(g => teamName(g[0]) + ' - ' + teamName(g[1])).join('   •   ')
        + (r.rest.length ? '   (отдыхает: ' + r.rest.map(teamName).join(', ') + ')' : '');
      c.fillText(fitText(c, line, W - pad * 2 - 70), pad + 70, y);
      y += 26;
    });
  }

  return cv;
}

function saveImage(teams, bins){
  drawImage(teams, bins).toBlob(blob => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'teams.png';
    a.click();
    URL.revokeObjectURL(a.href);
  });
}

/* ---------- ссылка на результат ----------
   Готовые составы упаковываются прямо в адрес страницы: ни сервера, ни базы,
   ссылка живёт столько же, сколько сам сайт. */

// на локальном файле ссылку отправлять некому - подставляем адрес опубликованного сайта
const SHARE_BASE = 'https://ivankrey.github.io/team-draw/';

function b64enc(str){
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  bytes.forEach(b => { bin += String.fromCharCode(b); });
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64dec(code){
  const b64 = code.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function encodeDraw(){
  const data = {
    v: 1,
    n: lastDraw.map((t, i) => (teamNames[i] || '').trim()),
    b: lastBins.length,
    t: lastDraw.map(t => t.players.map(p => [p.name, p.female ? 1 : 0, p.bin])),
    c: +$('#courts').value || 1,
    d: $('#doubleRound').checked ? 1 : 0,
    s: $('#showSchedule').checked ? 1 : 0
  };
  return b64enc(JSON.stringify(data));
}

function shareLink(){
  const base = location.protocol === 'file:'
    ? SHARE_BASE
    : location.origin + location.pathname;
  return base + '#r=' + encodeDraw();
}

// собираем команды и корзины обратно из данных ссылки
function applyShared(code){
  const d = JSON.parse(b64dec(code));
  const nBins = d.b || 1;

  const bins = [];
  for (let i = 0; i < nBins; i++) bins.push([]);

  const teams = d.t.map(list => {
    const t = { players: [], girls: 0, rank: 0, keys: new Set(), byBin: new Array(nBins).fill(0) };
    list.forEach(row => {
      const p = mk(row[0], !!row[1], true, false);
      p.bin = Math.min(row[2] || 0, nBins - 1);
      t.players.push(p);
      t.keys.add(p.key);
      if (p.female) t.girls++;
      t.rank += p.bin + 1;
      t.byBin[p.bin]++;
      bins[p.bin].push(p);
    });
    return t;
  });

  teamNames = d.n || [];
  binTexts = bins.map(b => b.map(serializePlayer).join('\n'));
  el.binsN.value = nBins;
  el.teams.value = teams.length;
  $('#courts').value = d.c || 1;
  $('#doubleRound').checked = !!d.d;
  $('#showSchedule').checked = d.s !== 0;

  renderBins();
  lastBins = bins;
  lastDraw = teams;
  picked = null;
  el.warn.innerHTML = '';
  renderResult(teams, bins);

  const note = document.createElement('div');
  note.className = 'msg info';
  note.textContent = 'Открыт готовый результат по ссылке. Списки участников подставлены в корзины - можно перегенерировать или поправить составы вручную.';
  el.result.insertBefore(note, el.result.firstChild);
}

/* ---------- расписание игр ---------- */

function plural(n, one, few, many){
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 > 20)) return few;
  return many;
}

/* Круговая система «карусель»: команда 1 стоит на месте, остальные сдвигаются по кругу.
   При нечётном числе команд добавляется фиктивный соперник - кто с ним «играет», тот отдыхает.
   Каждая команда встречается с каждой ровно один раз. */
/* Для четырёх команд используется привычное турнирное расписание - оно задано вручную,
   а не выведено «каруселью». Порядок игр при одной площадке получается такой:
   1-4, 3-2, 4-3, 1-2, 3-1, 2-4  и во втором круге  1-3, 4-2, 3-4, 2-1, 2-3, 4-1. */
const FIXED_4 = [
  [[0, 3], [2, 1]],
  [[3, 2], [0, 1]],
  [[2, 0], [1, 3]]
];
const FIXED_4_BACK = [
  [[0, 2], [3, 1]],
  [[2, 3], [1, 0]],
  [[1, 2], [3, 0]]
];

/* Для пяти команд - тоже готовый порядок. При одной площадке:
   1-5, 2-4, 3-5, 2-1, 3-4, 5-2, 4-1, 2-3, 4-5, 1-3.
   В каждом туре одна команда отдыхает, за круг отдыхают все по разу. */
const FIXED_5 = [
  [[0, 4], [1, 3]],
  [[2, 4], [1, 0]],
  [[2, 3], [4, 1]],
  [[3, 0], [1, 2]],
  [[3, 4], [0, 2]]
];

// flip - второй круг: та же пара, но хозяева и гости меняются местами
function fixedRounds(src, T, flip){
  return src.map(games => {
    const g = games.map(x => flip ? [x[1], x[0]] : x.slice());
    const playing = new Set();
    g.forEach(p => { playing.add(p[0]); playing.add(p[1]); });
    const rest = [];
    for (let i = 0; i < T; i++) if (!playing.has(i)) rest.push(i);
    return { games: g, rest: rest };
  });
}

function roundRobin(T, double){
  if (T === 4){
    const rounds = fixedRounds(FIXED_4, 4);
    return double ? rounds.concat(fixedRounds(FIXED_4_BACK, 4)) : rounds;
  }
  if (T === 5){
    const rounds = fixedRounds(FIXED_5, 5);
    return double ? rounds.concat(fixedRounds(FIXED_5, 5, true)) : rounds;
  }

  const ids = [];
  for (let i = 0; i < T; i++) ids.push(i);
  if (T % 2) ids.push(-1);          // -1 = отдых

  const n = ids.length;
  const rounds = [];
  for (let r = 0; r < n - 1; r++){
    const games = [], rest = [];
    for (let i = 0; i < n / 2; i++){
      const a = ids[i], b = ids[n - 1 - i];
      if (a < 0) rest.push(b);
      else if (b < 0) rest.push(a);
      else games.push([a, b]);
    }
    rounds.push({ games: games, rest: rest });
    ids.splice(1, 0, ids.pop());    // сдвиг по кругу
  }
  // второй круг - те же пары, но хозяева и гости меняются местами
  if (double){
    const back = rounds.map(r => ({
      games: r.games.map(g => [g[1], g[0]]),
      rest: r.rest.slice()
    }));
    return rounds.concat(back);
  }
  return rounds;
}

// раскладываем матчи по игровым окнам: за одно окно проходит столько игр, сколько площадок
function scheduleSlots(rounds, courts){
  const slots = [];
  rounds.forEach((r, ri) => {
    for (let i = 0; i < r.games.length; i += courts)
      slots.push({ round: ri + 1, games: r.games.slice(i, i + courts), rest: r.rest });
  });
  return slots;
}

function renderSchedule(T, courts, double){
  const rounds = roundRobin(T, double);
  const slots = scheduleSlots(rounds, courts);
  const hasRest = rounds.some(r => r.rest.length);
  const multi = courts > 1;

  const panel = document.createElement('div');
  panel.className = 'panel';
  const h = document.createElement('h3');
  h.className = 'sched-h';
  h.textContent = 'Расписание игр';
  const games = rounds.reduce((n, r) => n + r.games.length, 0);
  const sub = document.createElement('span');
  sub.className = 'muted';
  sub.textContent = ' каждая команда играет с каждой - ' + rounds.length + ' '
    + plural(rounds.length, 'тур', 'тура', 'туров')
    + ', всего ' + games + ' ' + plural(games, 'игра', 'игры', 'игр');
  h.appendChild(sub);
  panel.appendChild(h);

  const tbl = document.createElement('table');
  tbl.className = 'sum sched';
  const head = document.createElement('tr');
  head.appendChild(th(multi ? 'Тур' : '№'));
  if (multi) for (let c = 0; c < courts; c++) head.appendChild(th('Площадка ' + (c + 1)));
  else head.appendChild(th('Игра'));
  if (hasRest) head.appendChild(th('Отдыхает'));
  tbl.appendChild(head);

  slots.forEach((s, i) => {
    const tr = document.createElement('tr');
    const c0 = td(multi ? String(s.round) : String(i + 1));
    c0.className = 'name';
    tr.appendChild(c0);
    const cells = multi ? courts : 1;
    for (let c = 0; c < cells; c++){
      const g = s.games[c];
      tr.appendChild(td(g ? teamName(g[0]) + ' - ' + teamName(g[1]) : '-'));
    }
    if (hasRest) tr.appendChild(td(s.rest.length ? s.rest.map(teamName).join(', ') : '-'));
    tbl.appendChild(tr);
  });

  panel.appendChild(tbl);
  return panel;
}

function scheduleText(T, double){
  return 'РАСПИСАНИЕ\n' + roundRobin(T, double).map((r, i) =>
    'Тур ' + (i + 1) + ': ' + r.games.map(g => teamName(g[0]) + ' - ' + teamName(g[1])).join(', ')
    + (r.rest.length ? '  (отдыхает: ' + r.rest.map(teamName).join(', ') + ')' : '')
  ).join('\n');
}

function renderResult(teams, bins){
  const usedBins = bins.map((b, i) => b.length ? i : -1).filter(i => i >= 0);
  const equal = equalSizes(teams);

  const wrap = document.createElement('div');
  wrap.className = 'teams';
  teams.forEach((t, i) => {
    const card = document.createElement('div');
    card.className = 'team';

    const h = document.createElement('h3');
    const name = document.createElement('input');
    name.className = 'tname';
    name.value = teamNames[i] || '';
    name.placeholder = 'Команда ' + (i + 1);
    name.title = 'Название команды - можно вписать своё';
    name.addEventListener('input', () => {
      teamNames[i] = name.value;
      save();
      // точечно обновляем то, где встречается название - чтобы не терять фокус в поле
      const row = el.result.querySelectorAll('table.sum:not(.sched) tr')[i + 1];
      if (row) row.querySelector('td.name').textContent = teamName(i);
      const sched = el.result.querySelector('.sched');
      if (sched) sched.parentNode.replaceChild(
        renderSchedule(teams.length, +$('#courts').value || 1, $('#doubleRound').checked).querySelector('.sched'),
        sched);
    });
    h.appendChild(name);
    const n = document.createElement('span');
    n.className = 'n';
    n.textContent = t.players.length + ' чел.' + (t.girls ? ' · ♀ ' + t.girls : '');
    h.appendChild(n);
    card.appendChild(h);

    const ol = document.createElement('ol');
    t.players.forEach((p, pi) => {
      const li = document.createElement('li');
      li.className = (p.female ? 'f' : '') + (picked && picked.ti === i && picked.pi === pi ? ' pick' : '');
      li.textContent = p.name + (p.female ? ' ♀' : '');
      li.title = 'Нажмите, чтобы поменять местами с игроком другой команды';
      li.addEventListener('click', () => pickPlayer(i, pi));
      ol.appendChild(li);
    });
    card.appendChild(ol);

    if (usedBins.length > 1){
      const line = document.createElement('div');
      line.className = 'bins-line';
      line.textContent = usedBins.map(bi => LETTERS[bi] + ': ' + t.byBin[bi]).join(' · ');
      const pw = document.createElement('b');
      pw.textContent = ' · Сила: ' + powerText(t, bins.length, equal) + (equal ? '' : ' на игрока');
      line.appendChild(pw);
      card.appendChild(line);
    }
    wrap.appendChild(card);
  });

  const panel = document.createElement('div');
  panel.className = 'panel';
  panel.innerHTML =
    '<div class="exp">' +
      '<button id="btnAgain">Перегенерировать</button>' +
      '<button id="btnCopy" class="ghost">Копировать</button>' +
      '<button id="btnTxt" class="ghost">TXT</button>' +
      '<button id="btnCsv" class="ghost">CSV</button>' +
      '<button id="btnLink" class="ghost">Ссылка</button>' +
      '<button id="btnPng" class="ghost">Картинка</button>' +
    '</div>' +
    '<p class="hint">Игроков можно менять местами вручную: нажмите на игрока, затем на игрока из другой команды.</p>';

  const tbl = document.createElement('table');
  tbl.className = 'sum';
  tbl.style.marginTop = '12px';
  const head = document.createElement('tr');
  head.appendChild(th('Команда'));
  usedBins.forEach(i => head.appendChild(th(LETTERS[i])));
  head.appendChild(th('♀'));
  head.appendChild(th('Всего'));
  if (usedBins.length > 1) head.appendChild(th(equal ? 'Сила' : 'Сила / игрок'));
  tbl.appendChild(head);
  teams.forEach((t, i) => {
    const tr = document.createElement('tr');
    const c0 = td(teamName(i)); c0.className = 'name'; tr.appendChild(c0);
    usedBins.forEach(bi => tr.appendChild(td(String(t.byBin[bi]))));
    tr.appendChild(td(String(t.girls)));
    tr.appendChild(td(String(t.players.length)));
    if (usedBins.length > 1) tr.appendChild(td(powerText(t, bins.length, equal)));
    tbl.appendChild(tr);
  });
  panel.appendChild(tbl);

  el.result.innerHTML = '';

  el.result.appendChild(wrap);
  el.result.appendChild(panel);
  if ($('#showSchedule').checked && teams.length > 1)
    el.result.appendChild(renderSchedule(teams.length, +$('#courts').value || 1, $('#doubleRound').checked));

  $('#btnAgain').onclick = doDraw;
  $('#btnCopy').onclick = () => {
    navigator.clipboard.writeText(asText(teams, bins.length, equal)).then(() => {
      const b = $('#btnCopy');
      b.textContent = 'Скопировано';
      setTimeout(() => { b.textContent = 'Копировать'; }, 1200);
    });
  };
  $('#btnTxt').onclick = () => download('teams.txt', asText(teams, bins.length, equal));
  $('#btnCsv').onclick = () => download('teams.csv', asCsv(teams, bins.length, equal));
  $('#btnPng').onclick = () => saveImage(teams, bins);
  $('#btnLink').onclick = () => {
    const url = shareLink();
    const b = $('#btnLink');
    navigator.clipboard.writeText(url).then(() => {
      b.textContent = 'Ссылка скопирована';
      setTimeout(() => { b.textContent = 'Ссылка'; }, 1600);
    }).catch(() => {
      prompt('Скопируйте ссылку:', url);
    });
  };
}

function th(text){ const e = document.createElement('th'); e.textContent = text; return e; }
function td(text){ const e = document.createElement('td'); e.textContent = text; return e; }

function asText(teams, nBins, equal){
  const body = teams.map((t, i) =>
    teamName(i) + ' (' + t.players.length + ' чел., сила ' + powerText(t, nBins, equal) + (equal ? '' : ' на игрока') + ')\n' +
    t.players.map(p => '  ' + p.name + (p.female ? ' ♀' : '')).join('\n')
  ).join('\n\n');
  const withSched = $('#showSchedule').checked && teams.length > 1;
  return body + (withSched ? '\n\n' + scheduleText(teams.length, $('#doubleRound').checked) : '');
}

function asCsv(teams, nBins, equal){
  const rows = [['Команда', 'Игрок', 'Пол', 'Корзина', 'Баллы', equal ? 'Сила команды' : 'Сила на игрока']];
  teams.forEach((t, i) => t.players.forEach(p =>
    rows.push([teamName(i), p.name, p.female ? 'ж' : 'м', LETTERS[p.bin], nBins - p.bin, powerText(t, nBins, equal)])));
  return '﻿' + rows.map(r => r.map(v => '"' + String(v).replace(/"/g, '""') + '"').join(';')).join('\n');
}

function download(name, text){
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

/* ---------- действия ---------- */

function doDraw(){
  const bins = allBins();
  bins.forEach((bin, bi) => bin.forEach(p => { p.bin = bi; }));
  const T = +el.teams.value;
  const total = bins.reduce((s, b) => s + b.length, 0);

  if (!total){
    renderWarnings(bins, T, null);
    el.result.innerHTML = '';
    const d = document.createElement('div');
    d.className = 'msg warn';
    d.textContent = 'Список пуст - добавьте участников в корзины.';
    el.result.appendChild(d);
    return;
  }
  picked = null;
  lastBins = bins;
  // старая ссылка в адресе больше не отражает то, что на экране
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  lastDraw = draw(bins, T, el.girls.checked);
  renderWarnings(bins, T, lastDraw);
  renderResult(lastDraw, bins);
  el.result.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function openGender(){
  const bins = allBins();
  if (!bins.flat().length) return;
  el.modalBody.innerHTML = '';

  bins.forEach((bin, bi) => {
    if (!bin.length) return;
    const title = document.createElement('div');
    title.className = 'chipgroup';
    title.textContent = 'Корзина ' + LETTERS[bi];
    el.modalBody.appendChild(title);

    bin.forEach((p, pi) => {
      const chip = document.createElement('span');
      chip.className = 'chip' + (p.female ? ' f' : '') + (p.ambiguous && !p.explicit ? ' amb' : '');
      chip.textContent = p.name + (p.female ? ' ♀' : '');
      chip.addEventListener('click', () => {
        const list = parseBin(binTexts[bi]);
        list[pi].female = !list[pi].female;
        list[pi].explicit = true;
        binTexts[bi] = list.map(serializePlayer).join('\n');
        chip.classList.toggle('f');
        chip.classList.remove('amb');
        chip.textContent = list[pi].name + (list[pi].female ? ' ♀' : '');
        save();
      });
      el.modalBody.appendChild(chip);
    });
  });
  el.modal.classList.remove('hidden');
}

function dedup(){
  const seen = new Set();
  binTexts = binTexts.map(text => parseBin(text).filter(p => {
    if (seen.has(p.key)) return false;
    seen.add(p.key);
    return true;
  }).map(serializePlayer).join('\n'));
  renderBins();
  save();
}

const DEMO = [
  'Иван Крылов\nАртём Соколов\nМаксим Дорохов\nЕкатерина Жукова\nДмитрий Орлов\nОльга Белова\nПавел Титов\nСергей Гущин',
  'Николай Зимин\nАнна Пахомова\nЕгор Лапин\nМарина Кузьмина\nКирилл Носов\nСтепан Юдин\nЕлена Рогова\nТимур Ишаев\nРоман Дятлов',
  'Вадим Гончаров\nСофья Мирная\nГлеб Панин\nАлина Веселова\nАлексей Родин\nЮрий Шилов\nМихаил Ершов'
];

/* ---------- сохранение ---------- */

function save(){
  localStorage.setItem(STORE, JSON.stringify({
    bins: binTexts, teams: el.teams.value, girls: el.girls.checked,
    sched: $('#showSchedule').checked, courts: $('#courts').value,
    double: $('#doubleRound').checked, names: teamNames
  }));
}

function load(){
  try {
    const d = JSON.parse(localStorage.getItem(STORE));
    if (!d) return;
    if (Array.isArray(d.bins) && d.bins.length){ binTexts = d.bins; el.binsN.value = d.bins.length; }
    if (d.teams) el.teams.value = d.teams;
    el.girls.checked = d.girls !== false;
    $('#showSchedule').checked = d.sched !== false;
    $('#doubleRound').checked = !!d.double;
    if (d.courts) $('#courts').value = d.courts;
    if (Array.isArray(d.names)) teamNames = d.names;
  } catch (e) {}
}

/* ---------- старт ---------- */

el.binsN.addEventListener('input', () => { renderBins(); save(); });
el.teams.addEventListener('input', () => { updateStats(); save(); });
el.girls.addEventListener('change', save);
$('#showSchedule').addEventListener('change', () => { save(); if (lastDraw) renderResult(lastDraw, lastBins); });
$('#courts').addEventListener('input', () => { save(); if (lastDraw) renderResult(lastDraw, lastBins); });
$('#doubleRound').addEventListener('change', () => { save(); if (lastDraw) renderResult(lastDraw, lastBins); });
$('#btnDraw').onclick = doDraw;
$('#btnGender').onclick = openGender;
$('#btnDedup').onclick = dedup;
$('#modalClose').onclick = () => { el.modal.classList.add('hidden'); renderBins(); };
el.modal.addEventListener('click', e => {
  if (e.target === el.modal){ el.modal.classList.add('hidden'); renderBins(); }
});
$('#btnDemo').onclick = () => {
  binTexts = DEMO.slice();
  el.binsN.value = 3;
  el.teams.value = 4;
  renderBins();
  save();
};
$('#btnClear').onclick = () => {
  if (!confirm('Очистить все списки?')) return;
  binTexts = binTexts.map(() => '');
  el.result.innerHTML = '';
  el.warn.innerHTML = '';
  renderBins();
  save();
};

load();
renderBins();

// результат, открытый по ссылке
const shared = location.hash.match(/^#r=(.+)$/);
if (shared){
  try { applyShared(shared[1]); }
  catch (e){
    el.warn.innerHTML = '';
    const d = document.createElement('div');
    d.className = 'msg warn';
    d.textContent = 'Ссылка повреждена - не удалось прочитать составы.';
    el.warn.appendChild(d);
  }
}
