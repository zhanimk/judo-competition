import { drawFormat } from '@judo/engine/draw';
import {
  categoryResults,
  slotName,
  teamStandings,
  titles,
  type ProtocolKind,
  type ProtocolCategory,
  type ProtocolTournament,
} from './protocol-model.js';
import { ProtocolPdf } from './pdf-document.js';
import { renderDraw } from './render-draw.js';
import { renderBouts } from './render-bouts.js';
/** Renders an immutable snapshot; authorization and database reads remain in the service. */
export function renderProtocol(t: ProtocolTournament, kind: ProtocolKind, lang: 'ru' | 'kk') {
  const text = (ru: string, kk: string) => (lang === 'kk' ? kk : ru);
  const pdf = new ProtocolPdf(t, text, text(...titles[kind]), lang);
  const formats: Record<string, [string, string]> = {
    SINGLE_ELIMINATION: ['Выбывание без утешения', 'Жұбанышсыз шығару'],
    REPECHAGE: ['Выбывание с утешением', 'Жұбаныш белдесулерімен шығару'],
    ROUND_ROBIN: ['Круговая', 'Айналмалы'],
    MIXED: ['Группы и плей-офф', 'Топтар және плей-офф'],
  };
  const metadata = (c: ProtocolCategory) =>
    [
      text(...formats[categoryResults(c) ? drawFormat(categoryResults(c)!.draw) : c.format]),
      `${c.birthYearFrom}-${c.birthYearTo} · ${c.maxWeightGrams === null ? '+' + (c.minWeightGrams ?? 0) / 1000 + ' кг' : '-' + c.maxWeightGrams / 1000 + ' кг'} · ${c.durationSeconds} с`,
      `${t.startDate} - ${t.endDate} · ${t.venue}`,
      c.draw
        ? `${text('Версия жребия', 'Жеребе нұсқасы')} ${c.draw.version} · ${c.draw.status === 'CONFIRMED' ? text('Подтверждён', 'Расталған') : text('ПРЕДВАРИТЕЛЬНО', 'АЛДЫН АЛА')} · ${c.draw.publishedAt ? text('Опубликован', 'Жарияланған') : text('Не опубликован', 'Жарияланбаған')}`
        : text('Без жеребьёвки', 'Жеребесіз'),
    ].join(' · ');
  const custom = () =>
    pdf.line(
      text(
        'Пользовательский регламент. Соответствие IJF не подтверждено.',
        'Бапталатын ережелер. IJF сәйкестігі расталмаған.',
      ),
      9,
    );
  const section = (k: ProtocolKind, c: ProtocolCategory, landscape = false) => {
    pdf.section(`${text(...titles[k])} · ${c.name}`, metadata(c), landscape);
    custom();
  };
  const kinds: ProtocolKind[] =
    kind === 'ALL' ? ['DRAW', 'PARTICIPANTS', 'BOUTS', 'RESULTS', 'TEAMS', 'MEDALS'] : [kind];
  for (const k of kinds) {
    if (k === 'TEAMS' || k === 'MEDALS') {
      const summary = teamStandings(t.categories);
      pdf.section(text(...titles[k]), `${t.startDate} - ${t.endDate} · ${t.venue}`);
      pdf.notice(
        summary.complete === t.categories.length && t.categories.length > 0
          ? text('ИТОГОВЫЙ ЗАЧЁТ', 'ҚОРЫТЫНДЫ ЕСЕП')
          : text('ПРЕДВАРИТЕЛЬНЫЙ ЗАЧЁТ', 'АЛДЫН АЛА ЕСЕП'),
        summary.complete === t.categories.length && t.categories.length > 0,
      );
      pdf.line(
        text(
          'Порядок: золото, серебро, бронза. Равные показатели — общее место. Баллы не применяются.',
          'Рет: алтын, күміс, қола. Көрсеткіштер тең болса — ортақ орын. Ұпайлар қолданылмайды.',
        ),
      );
      pdf.line(
        `${text('Завершено категорий', 'Аяқталған санаттар')}: ${summary.complete}/${t.categories.length}. ${text('Учитываются только полностью подтверждённые категории.', 'Тек толық расталған санаттар есепке алынады.')}`,
      );
      pdf.metrics([
        { label: text('Команд', 'Командалар'), value: summary.teams.length },
        {
          label: text('Завершено категорий', 'Аяқталған санаттар'),
          value: `${summary.complete}/${t.categories.length}`,
        },
        {
          label: text('Разыграно медалей', 'Берілген медальдар'),
          value: summary.teams.reduce((n, t) => n + t.gold + t.silver + t.bronze, 0),
        },
      ]);
      pdf.table(
        [
          text('Место', 'Орын'),
          text('Команда', 'Команда'),
          text('Золото', 'Алтын'),
          text('Серебро', 'Күміс'),
          text('Бронза', 'Қола'),
          text('Всего', 'Барлығы'),
        ],
        summary.teams.map((team) => [
          team.rank ? String(team.rank) : '—',
          team.club,
          String(team.gold),
          String(team.silver),
          String(team.bronze),
          String(team.gold + team.silver + team.bronze),
        ]),
        [0.09, 0.39, 0.13, 0.13, 0.13, 0.13],
        { medals: true },
      );
      if (!summary.teams.length) pdf.line(text('Участников пока нет.', 'Қатысушылар әлі жоқ.'));
      pdf.line(text('Категории, включённые в документ', 'Құжатқа енгізілген санаттар'), 12);
      pdf.table(
        [
          text('Категория', 'Санат'),
          text('Состояние', 'Күйі'),
          text('Версия жребия', 'Жеребе нұсқасы'),
        ],
        t.categories.map((c) => [
          c.name,
          categoryResults(c)?.places
            ? text('Итог подтверждён', 'Қорытынды расталған')
            : text('Не завершена — медали не учтены', 'Аяқталмаған — медальдар есептелмеді'),
          String(c.draw?.version ?? '—'),
        ]),
        [0.45, 0.4, 0.15],
      );
      if (k === 'TEAMS')
        for (const team of summary.teams) {
          pdf.section(
            `${text('Состав команды', 'Команда құрамы')} · ${team.club}`,
            text('Золото / серебро / бронза', 'Алтын / күміс / қола') +
              `: ${team.gold} / ${team.silver} / ${team.bronze}`,
          );
          pdf.table(
            [text('Участник', 'Қатысушы'), text('Категория', 'Санат'), text('Результат', 'Нәтиже')],
            team.members.map((m) => [
              `${m.entry.lastName} ${m.entry.firstName}`,
              m.category,
              m.place
                ? `${m.place} ${text('место', 'орын')}`
                : m.complete
                  ? text('Без присуждённого места', 'Орын берілмеген')
                  : text('Категория не завершена', 'Санат аяқталмаған'),
            ]),
            [0.38, 0.35, 0.27],
          );
        }
      continue;
    }
    for (const c of t.categories) {
      if (k === 'DRAW') {
        renderDraw(
          pdf,
          c,
          [
            `${c.entries.length} ${text('участников', 'қатысушы')}`,
            `${c.birthYearFrom}-${c.birthYearTo}`,
            t.startDate,
            c.draw?.status === 'CONFIRMED'
              ? text('Жребий подтверждён', 'Жеребе расталған')
              : text('Предварительный жребий', 'Алдын ала жеребе'),
            c.draw?.publishedAt
              ? text('Опубликован', 'Жарияланған')
              : text('Не опубликован', 'Жарияланбаған'),
          ].join(' · '),
        );
        continue;
      }
      if (k === 'PARTICIPANTS') {
        pdf.section(
          `${text(...titles[k])} · ${c.name}`,
          `${c.birthYearFrom}-${c.birthYearTo} · ${t.startDate} · ${t.venue}`,
        );
        pdf.metrics([
          { label: text('Участников', 'Қатысушылар'), value: c.entries.length },
          {
            label: text('Клубов', 'Клубтар'),
            value: new Set(
              c.entries.map((e) =>
                e.club.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('ru'),
              ),
            ).size,
          },
          {
            label: text('Годы рождения', 'Туған жылдары'),
            value: `${c.birthYearFrom}-${c.birthYearTo}`,
          },
        ]);
        pdf.table(
          [
            '№',
            text('Фамилия, имя', 'Тегі, аты'),
            text('Год рождения', 'Туған жылы'),
            text('Клуб / команда', 'Клуб / команда'),
          ],
          c.entries.map((e, i) => [
            String(i + 1),
            `${e.lastName} ${e.firstName}`,
            String(e.birthYear),
            e.club,
          ]),
          [0.07, 0.42, 0.14, 0.37],
        );
        continue;
      }
      section(k, c, k === 'BOUTS');
      const data = categoryResults(c),
        name = slotName(c, text);
      if (k === 'RESULTS') {
        if (!data?.places) {
          pdf.notice(
            text(
              'Категория не завершена. Итоговые места пока не присуждены.',
              'Санат аяқталмаған. Қорытынды орындар әлі берілмеген.',
            ),
          );
          continue;
        }
        pdf.notice(text('ИТОГ ПОДТВЕРЖДЁН', 'ҚОРЫТЫНДЫ РАСТАЛҒАН'), true);
        pdf.podium(
          data.places.map((p) => ({ place: p.place, name: name({ entryId: p.entryId }) })),
        );
        pdf.line(text('Итоговая таблица', 'Қорытынды кесте'), 12);
        pdf.table(
          [text('Место', 'Орын'), text('Участник / клуб', 'Қатысушы / клуб')],
          data.places.map((p) => [String(p.place), name({ entryId: p.entryId })]),
          [0.12, 0.88],
          { places: true },
        );
        pdf.line(
          text(
            'Указаны только места, определяемые выбранной системой проведения.',
            'Тек таңдалған өткізу жүйесі анықтайтын орындар көрсетілген.',
          ),
          9,
        );
        continue;
      }
      renderBouts(pdf, c);
    }
    if (!t.categories.length) {
      pdf.section(text(...titles[k]));
      pdf.line(text('В турнире пока нет категорий.', 'Турнирде әзірге санаттар жоқ.'));
    }
  }
  return pdf.end();
}
