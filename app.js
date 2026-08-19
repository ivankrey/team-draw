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
  // равенство команд по силе - главное, ради чего вообще нужны корзины
  const avgRank = teams.reduce((n, t) => n + t.rank, 0) / T;
  for (const t of teams) s += 10 * Math.pow(t.rank - avgRank, 2);

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
function pairCost(ta, tb, avgG, avgR, avgB, spreadGirls){
  let s = 100000 * (teamConflicts(ta) + teamConflicts(tb));
  if (spreadGirls) s += 100 * (Math.pow(ta.girls - avgG, 2) + Math.pow(tb.girls - avgG, 2));
  s += 10 * (Math.pow(ta.rank - avgR, 2) + Math.pow(tb.rank - avgR, 2));
  for (let bi = 0; bi < avgB.length; bi++)
    s += Math.pow(ta.byBin[bi] - avgB[bi], 2) + Math.pow(tb.byBin[bi] - avgB[bi], 2);
  return s;
}

function improve(teams, spreadGirls){
  const T = teams.length;
  const avgG = teams.reduce((n, t) => n + t.girls, 0) / T;
  const avgR = teams.reduce((n, t) => n + t.rank, 0) / T;
  const avgB = teams[0].byBin.map((_, bi) => teams.reduce((n, t) => n + t.byBin[bi], 0) / T);

  let guard = 0, moved = true;
  while (moved && guard++ < 12){
    moved = false;
    for (let i = 0; i < T; i++){
      for (let j = i + 1; j < T; j++){
        const ta = teams[i], tb = teams[j];
        let before = pairCost(ta, tb, avgG, avgR, avgB, spreadGirls);
        if (before === 0) continue;
        for (let a = 0; a < ta.players.length; a++){
          for (let b = 0; b < tb.players.length; b++){
            const pa = ta.players[a], pb = tb.players[b];
            if (pa.bin === pb.bin && pa.female === pb.female && !pa.enemies && !pb.enemies) continue;
            swapPlayers(ta, tb, a, b);
            const after = pairCost(ta, tb, avgG, avgR, avgB, spreadGirls);
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

function renderResult(teams, bins){
  const usedBins = bins.map((b, i) => b.length ? i : -1).filter(i => i >= 0);

  const wrap = document.createElement('div');
  wrap.className = 'teams';
  teams.forEach((t, i) => {
    const card = document.createElement('div');
    card.className = 'team';

    const h = document.createElement('h3');
    h.textContent = 'Команда ' + (i + 1);
    const n = document.createElement('span');
    n.className = 'n';
    n.textContent = t.players.length + ' чел.' + (t.girls ? ' · ♀ ' + t.girls : '');
    h.appendChild(n);
    card.appendChild(h);

    const ol = document.createElement('ol');
    t.players.forEach(p => {
      const li = document.createElement('li');
      if (p.female) li.className = 'f';
      li.textContent = p.name + (p.female ? ' ♀' : '');
      ol.appendChild(li);
    });
    card.appendChild(ol);

    if (usedBins.length > 1){
      const line = document.createElement('div');
      line.className = 'bins-line';
      line.textContent = usedBins.map(bi => LETTERS[bi] + ': ' + t.byBin[bi]).join(' · ');
      const pw = document.createElement('b');
      pw.textContent = ' · Сила: ' + power(t, bins.length);
      line.appendChild(pw);
      card.appendChild(line);
    }
    wrap.appendChild(card);
  });

  const panel = document.createElement('div');
  panel.className = 'panel';
  panel.innerHTML =
    '<div class="exp">' +
      '<button id="btnAgain">Перебросить</button>' +
      '<button id="btnCopy" class="ghost">Копировать</button>' +
      '<button id="btnTxt" class="ghost">TXT</button>' +
      '<button id="btnCsv" class="ghost">CSV</button>' +
    '</div>';

  const tbl = document.createElement('table');
  tbl.className = 'sum';
  tbl.style.marginTop = '12px';
  const head = document.createElement('tr');
  head.appendChild(th('Команда'));
  usedBins.forEach(i => head.appendChild(th(LETTERS[i])));
  head.appendChild(th('♀'));
  head.appendChild(th('Всего'));
  if (usedBins.length > 1) head.appendChild(th('Сила'));
  tbl.appendChild(head);
  teams.forEach((t, i) => {
    const tr = document.createElement('tr');
    const c0 = td(String(i + 1)); c0.className = 'name'; tr.appendChild(c0);
    usedBins.forEach(bi => tr.appendChild(td(String(t.byBin[bi]))));
    tr.appendChild(td(String(t.girls)));
    tr.appendChild(td(String(t.players.length)));
    if (usedBins.length > 1) tr.appendChild(td(String(power(t, bins.length))));
    tbl.appendChild(tr);
  });
  panel.appendChild(tbl);

  el.result.innerHTML = '';
  el.result.appendChild(wrap);
  el.result.appendChild(panel);

  $('#btnAgain').onclick = doDraw;
  $('#btnCopy').onclick = () => {
    navigator.clipboard.writeText(asText(teams, bins.length)).then(() => {
      const b = $('#btnCopy');
      b.textContent = 'Скопировано';
      setTimeout(() => { b.textContent = 'Копировать'; }, 1200);
    });
  };
  $('#btnTxt').onclick = () => download('teams.txt', asText(teams, bins.length));
  $('#btnCsv').onclick = () => download('teams.csv', asCsv(teams, bins.length));
}

function th(text){ const e = document.createElement('th'); e.textContent = text; return e; }
function td(text){ const e = document.createElement('td'); e.textContent = text; return e; }

function asText(teams, nBins){
  return teams.map((t, i) =>
    'Команда ' + (i + 1) + ' (' + t.players.length + ' чел., сила ' + power(t, nBins) + ')\n' +
    t.players.map(p => '  ' + p.name + (p.female ? ' ♀' : '')).join('\n')
  ).join('\n\n');
}

function asCsv(teams, nBins){
  const rows = [['Команда', 'Игрок', 'Пол', 'Корзина', 'Баллы', 'Сила команды']];
  teams.forEach((t, i) => t.players.forEach(p =>
    rows.push([i + 1, p.name, p.female ? 'ж' : 'м', LETTERS[p.bin], nBins - p.bin, power(t, nBins)])));
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
    bins: binTexts, teams: el.teams.value, girls: el.girls.checked
  }));
}

function load(){
  try {
    const d = JSON.parse(localStorage.getItem(STORE));
    if (!d) return;
    if (Array.isArray(d.bins) && d.bins.length){ binTexts = d.bins; el.binsN.value = d.bins.length; }
    if (d.teams) el.teams.value = d.teams;
    el.girls.checked = d.girls !== false;
  } catch (e) {}
}

/* ---------- старт ---------- */

el.binsN.addEventListener('input', () => { renderBins(); save(); });
el.teams.addEventListener('input', () => { updateStats(); save(); });
el.girls.addEventListener('change', save);
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
