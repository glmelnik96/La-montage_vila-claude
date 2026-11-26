// Editor's view of map.json. Keep stored notes and source-frame evidence identifiable.
import { relative, resolve, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const roles = { broll: 'перебивка', interview: 'интервью', card: 'карточка', unknown: 'не определено' };
const types = { 'different-interval': 'разные отрезки', 'same-interval': 'повтор отрезка',
  'partial-overlap': 'частичное пересечение', 'unknown': 'время не установлено', 'same-still': 'то же изображение' };
const markdown = value => String(value ?? '').replace(/[\\`*_\[\]<>|]/g, '\\$&').replace(/[\r\n]+/g, ' ');
const num = value => Number(value.toFixed(4)).toString();
function localLink(dir, path) {
  const target = relative(dir, path);
  return isAbsolute(target) ? pathToFileURL(path).href :
    target.replaceAll('\\','/').split('/').map(encodeURIComponent).join('/');
}
const span = (a, b) => `[${num(a)}, ${num(b)})`;

const evidenceLabels = {
  'excluded-overlay': 'служебный или графический слой сверху',
  'composite-unverified': 'несколько слоёв, итоговый композит требует просмотра',
  'transition': 'переход', 'same-track-overlap': 'перекрытие на одной дорожке',
  'mask-opacity-unresolved': 'маска или прозрачность', 'still-image': 'статика',
  'source-bounds-missing': 'нет границ источника', 'source-unidentified': 'источник неизвестен',
  'reverse-source-unresolved': 'реверс', 'time-remapping-unresolved': 'неизвестная кривая ретайма',
  'source-timing-unresolved': 'исходное время требует проверки',
  'source-timing-assumed': 'время рассчитано по линейной модели, скорость или направление не записаны',
  'picture-gap': 'пробел на выбранных дорожках', 'empty-nest': 'пустое вложение',
  'nest-missing': 'содержимое вложения отсутствует', 'nest-cycle': 'циклическое вложение',
  'nested-frame-sampling-unverified': 'у вложения другая частота кадров',
  'nested-frame-rate-missing': 'частота кадров вложения неизвестна',
  'nested-id-inferred-from-name': 'вложение сопоставлено по имени',
  'ambiguous-nested-sequence-name': 'неоднозначное имя вложения',
};

const differences = {
  'source-mismatch': 'Разное исходное время',
  'source-unverified': 'Исходное время не установлено',
  'still-no-time-axis': 'Статичное изображение, время неприменимо',
  'kind-mismatch': 'Разная редакционная роль',
  'missing-range': 'У интервала списка нет точного соответствия',
  'extra-range': 'Диапазон карты отсутствует в списке',
  'picture-mismatch': 'Отличается источник, название или дорожка',
};

function time(frame, fd) {
  const ms = Math.round(frame * fd * 1000);
  return `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2,'0')}.${String(ms % 1000).padStart(3,'0').replace(/0$/,'')}`;
}

export function renderMap(map, dir) {
  const { sequence: s, rows, comparison: c, usage, notes } = map;
  const timeline = row => time(row.startFrame, s.fd) + '–' + time(row.endFrame, s.fd);
  const counts = labels => [...new Set(labels)].map(label => [label, labels.filter(x => x === label).length]);
  const relationCounts = counts(usage.relations.map(pair => pair.type));
  const out = [
    '# Монтажная карта · ' + markdown(s.name), '',
    `${num(s.fps)} кадр/с · ${timeline(s)} · кадры [${s.startFrame}, ${s.endFrame}) · ID \`${s.id}\``, '',
    `**${rows.length} диапазонов.** ${counts(rows.map(row => row.kind)).map(([k,n]) => roles[k] + ' — ' + n).join(', ')}. Источников перебивок — ${usage.sources.length}.`, '',
    'Монтажное время отсчитано от нуля секвенции. Правая граница каждого интервала открыта. Дорожка относится к основной секвенции. Цепочка имён ведёт к исходнику внутри вложения.', '',
  ];
  if (Object.keys(map.rules).length) out.push('Правила отбора и ролей из параметров запуска — ' +
    Object.entries(map.rules).map(([k,v]) => `\`--${k} ${v}\``).join(', ') + '.', '');
  if (c) {
    out.push(`С первичным списком совпали монтажные границы, дорожка и источник у **${c.matched} из ${c.referenceCount}** строк. У ${c.sourceMatched} совпало также исходное время. Привязано JPG — ${c.framesMatched}. Каждый JPG взят из исходника.`, '');
    if (c.differences.length) {
      out.push('### Сверка исходников', '',
        'Полный перечень с монтажными кадрами и обоими интервалами есть в [map.json](map.json).', '',
        '| Расхождение | Строк | Пример по монтажу |', '|---|---:|---|');
      for (const [code,n] of counts(c.differences.map(diff => diff.code))) {
        const items = c.differences.filter(diff => diff.code === code);
        out.push(`| ${markdown(differences[code] ?? code)} | ${n} | ${items.slice(0,4).map(timeline).join(', ')} |`);
      }
      out.push('');
    }
  }
  out.push('### Использование перебивок', '');
  const reused = usage.sources.filter(file => file.rows.length > 1);
  out.push(`Файлов с несколькими появлениями — ${reused.length}. ` +
    (relationCounts.length ? 'Пары появлений по одному пути — ' + relationCounts.map(([k,n]) => types[k] + ' ' + n).join(', ') + '.' : 'Пар для сравнения нет.'), '');
  const assumed = usage.relations.filter(p => p.linearAssumption).length;
  if (assumed) out.push(`У ${assumed} пар расчёт включает линейное воспроизведение там, где скорость или направление не записаны. Эти пары отмечены в JSON полем \`linearAssumption\`.`, '');
  for (const source of reused) {
    out.push(`- ${markdown(source.path.split(/[\\/]/).at(-1))} — ${source.rows.join(', ')}`);
  }
  if (reused.length) out.push('');
  const repeats = usage.relations.filter(p => ['partial-overlap','same-interval','same-still'].includes(p.type));
  if (repeats.length) {
    out.push('| Повтор | Строки карты | Общий исходный интервал, с |', '|---|---|---|');
    for (const pair of repeats) out.push(`| ${types[pair.type]} | ${pair.rows.join(', ')} | ${pair.overlap ? span(...pair.overlap) : 'изображение'} |`);
    out.push('');
  }
  out.push('### Границы проверки', '', ...map.limitations.map(x => '- ' + markdown(x)),
    '- Для подбора неиспользованного архива нужен каталог доступных исходников с идентификаторами, длительностями, исходной шкалой времени, кадрами и описаниями действий по интервалам. Подтверждение события и происхождения кадра следует хранить с указанием источника. Использованные интервалы можно сопоставить с этим каталогом.', '',
    '### Карта по монтажу', '',
    'ID строки включает первый кадр диапазона. Время источника дано в секундах. «Проверить время» у JPG означает, что фаза движения по снимку не подтверждена. У статичного изображения одна иллюстрация на весь план.', '');
  const issues = [...new Set(rows.flatMap(r => r.issues))];
  if (issues.length) out.push('Пометки проверки действуют внутри диапазона. Точные окна указаны в `issueRanges` в JSON. ' +
    issues.map((k,i) => `**${i+1}** — ${markdown(evidenceLabels[k] ?? k)}`).join('. ') + '.', '');
  out.push('| ID | Монтаж | Роль | Дорожка и источник | Исходный интервал, с | Кадр | Пометки | Проверка |',
    '|---|---|---|---|---|---|---|---|');
  const noteNumbers = new Map(notes.map((note,i) => [note.id,i+1]));
  for (const row of rows) {
    const src = Number.isFinite(row.sourceStart) && Number.isFinite(row.sourceEnd)
      ? span(row.sourceStart,row.sourceEnd) : row.still ? 'статичное изображение' : 'не установлено';
    const frame = row.reference?.frame;
    const link = frame ? `[${row.reference.index}](${localLink(dir,frame)})` +
      (!row.reference.frameTimeVerified && !row.still ? ' · проверить время' : '') : '—';
    const links = (row.notes ?? []).map(id => {
      const n = noteNumbers.get(id);
      return `[#${n}](#note-${n})`;
    });
    out.push(`| <a id="${row.id}"></a>${row.id} | ${timeline(row)} | ${roles[row.kind]} | ${row.track >= 0 && row.track != null ? 'V' + (row.track+1) + ' · ' : ''}${markdown(row.label || 'нет изображения')} | ${src} | ${link} | ${links.join(', ')} | ${row.issues.map(k => issues.indexOf(k)+1).join(', ')} |`);
  }
  out.push('', '### Реплики и редакторские пометки', '',
    'Точка привязана к содержащему её кадру. Для протяжённой пометки перечислены все пересечённые строки. Содержание сохранено в формулировке источника.', '');
  for (const [i,note] of notes.entries()) {
    if (!note.rows.length) continue;
    const when = note.startFrame === note.endFrame ? time(note.startFrame, s.fd) : timeline(note);
    const name = [note.name, note.speaker, note.language].filter(Boolean).map(markdown).join(' · ');
    const links = note.rows.map(id => `[${id}](#${id})`);
    out.push(`- <a id="note-${i+1}"></a>**#${i+1}** · ${when} · ${links.join(', ')} · ${markdown(note.source)}${name ? ' · ' + name : ''}. ${markdown(note.text)}`);
  }
  if (!notes.some(n => n.rows.length)) out.push('В пределах монтажа нет привязанных реплик или пометок.');
  out.push('', 'В [map.json](map.json) доступны точные номера кадров, пути, парные сравнения, пометки вне In/Out и ограничения каждого диапазона.', '');
  const skill = fileURLToPath(new URL('../../', import.meta.url));
  const quote = arg => "'" + String(arg).replaceAll("'", "''") + "'";
  const pathArg = path => relative(skill, path).replaceAll('\\','/');
  const args = ['--sequence', quote(s.id)];
  for (const [option,value] of Object.entries(map.inputs)) args.push('--' + option, quote(pathArg(resolve(dir,value))));
  for (const [option,value] of Object.entries(map.rules)) args.push('--' + option, quote(value));
  args.push('--out', quote(pathArg(dir + '-rerun')));
  out.push('### Повторить из корня скилла в PowerShell', '', '```powershell', 'node scripts/docmap.mjs ' + args.join(' '), '```', '');
  return out.join('\n');
}
