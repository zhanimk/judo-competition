'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useLanguage } from '../../shared/i18n/provider';
import Link from 'next/link';
import { useAdministrationCommand } from './use-administration-command';
export function TournamentCreate() {
  const { text } = useLanguage();
  const router = useRouter();
  const [step, setStep] = useState(1),
    [error, setError] = useState('');
  const [form, setForm] = useState({
    name: '',
    city: '',
    venue: '',
    startDate: '',
    endDate: '',
    tatamiCount: 2,
  });
  const administration = useAdministrationCommand('new', (_command, receipt) => {
    router.push(`/tournaments/${receipt.id}`);
  });
  const busy = administration.blocked;
  async function submit(e: React.FormEvent) {
    if (busy) {
      e.preventDefault();
      return;
    }
    e.preventDefault();
    if (step === 1) {
      if (form.endDate < form.startDate) {
        setError(
          text(
            'Дата окончания не может быть раньше начала',
            'Аяқталу күні басталу күнінен ерте болмауы керек',
          ),
        );
        return;
      }
      setError('');
      setStep(2);
      return;
    }
    await administration.send('CREATE', form);
  }
  return (
    <>
      {administration.notice}
      <Link className="back-link" href="/tournaments">
        {text('← К турнирам', '← Турнирлерге')}
      </Link>
      <div className="page-heading">
        <div>
          <h1>{text('Создать турнир', 'Турнир құру')}</h1>
          <p>
            {text(
              'Сначала основные данные. Категории и спортсменов добавим следующим шагом.',
              'Алдымен негізгі деректер. Санаттар мен спортшыларды келесі қадамда қосамыз.',
            )}
          </p>
        </div>
      </div>
      <div className="form-layout">
        <form className="panel form-panel" onSubmit={submit}>
          <fieldset disabled={busy} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
            <div className="steps">
              <span className={step === 1 ? 'current' : ''}>
                {text('01 Основные данные', '01 Негізгі деректер')}
              </span>
              <span className={step === 2 ? 'current' : ''}>
                {text('02 Проверка', '02 Тексеру')}
              </span>
            </div>
            {step === 1 ? (
              <>
                <h2>{text('Информация о турнире', 'Турнир туралы ақпарат')}</h2>
                <label>
                  {text('Название турнира', 'Турнир атауы')}
                  <input
                    required
                    minLength={3}
                    maxLength={120}
                    placeholder={text('Например, Кубок Алматы', 'Мысалы, Алматы кубогы')}
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                  />
                </label>
                <div className="form-two">
                  <label>
                    {text('Город', 'Қала')}
                    <input
                      required
                      minLength={2}
                      maxLength={80}
                      value={form.city}
                      onChange={(e) => setForm({ ...form, city: e.target.value })}
                    />
                  </label>
                  <label>
                    {text('Место проведения', 'Өтетін орын')}
                    <input
                      required
                      minLength={2}
                      maxLength={160}
                      value={form.venue}
                      onChange={(e) => setForm({ ...form, venue: e.target.value })}
                    />
                  </label>
                </div>
                <div className="form-two">
                  <label>
                    {text('Дата начала', 'Басталу күні')}
                    <input
                      type="date"
                      required
                      value={form.startDate}
                      onChange={(e) => setForm({ ...form, startDate: e.target.value })}
                    />
                  </label>
                  <label>
                    {text('Дата окончания', 'Аяқталу күні')}
                    <input
                      type="date"
                      required
                      min={form.startDate}
                      value={form.endDate}
                      onChange={(e) => setForm({ ...form, endDate: e.target.value })}
                    />
                  </label>
                </div>
                <label>
                  {text('Количество татами', 'Татами саны')}
                  <input
                    type="number"
                    min={1}
                    max={32}
                    required
                    value={form.tatamiCount}
                    onChange={(e) => setForm({ ...form, tatamiCount: Number(e.target.value) })}
                  />
                </label>
              </>
            ) : (
              <>
                <h2>{text('Проверьте данные', 'Деректерді тексеріңіз')}</h2>
                <dl className="review">
                  <dt>{text('Турнир', 'Турнир')}</dt>
                  <dd>{form.name}</dd>
                  <dt>{text('Место', 'Орын')}</dt>
                  <dd>
                    {form.city}, {form.venue}
                  </dd>
                  <dt>{text('Даты', 'Күндер')}</dt>
                  <dd>
                    {form.startDate} — {form.endDate}
                  </dd>
                  <dt>{text('Татами', 'Татами')}</dt>
                  <dd>{form.tatamiCount}</dd>
                  <dt>{text('Часовой пояс', 'Уақыт белдеуі')}</dt>
                  <dd>Asia/Almaty</dd>
                  <dt>{text('Статус', 'Мәртебе')}</dt>
                  <dd>{text('Черновик · не опубликован', 'Жоба · жарияланбаған')}</dd>
                </dl>
                <button type="button" disabled={busy} onClick={() => setStep(1)}>
                  {text('Изменить данные', 'Деректерді өзгерту')}
                </button>
              </>
            )}
            {error && (
              <p className="error-box" role="alert">
                {error}
              </p>
            )}
            <div className="form-actions">
              <button className="solid-button" disabled={busy}>
                {busy
                  ? text('Сохраняем…', 'Сақталуда…')
                  : step === 1
                    ? text('Продолжить →', 'Жалғастыру →')
                    : text('Создать турнир', 'Турнир құру')}
              </button>
            </div>
          </fieldset>
        </form>
        <aside className="help-card">
          <span>{text('ПОДГОТОВКА', 'ДАЙЫНДЫҚ')}</span>
          <h3>
            {text('Один турнир.', 'Бір турнир.')}
            <br />
            {text('Все процессы.', 'Барлық үдерістер.')}
          </h3>
          <p>
            {text(
              'После создания откроется рабочая область с категориями, заявками и этапами подготовки.',
              'Құрылғаннан кейін санаттар, өтінімдер және дайындық кезеңдері бар жұмыс кеңістігі ашылады.',
            )}
          </p>
          <hr />
          <p>
            {text(
              'Доступен настраиваемый режим. Официальные профили IJF появятся после проверки регламентов.',
              'Бапталатын режим қолжетімді. IJF ресми профильдері ережелер тексерілгеннен кейін қосылады.',
            )}
          </p>
        </aside>
      </div>
    </>
  );
}
