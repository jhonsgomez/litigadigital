// =================== Librerías y dependencias ===================
import { useState, useRef, useEffect, useCallback } from 'react';
import { io } from 'socket.io-client';
import Swal from 'sweetalert2';

// =================== Configuración ===================
const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3000';
const MAX_SESSION_MINUTES = Number(import.meta.env.VITE_MAX_SESSION_MINUTES) || 30;
const MAX_SESSION_MS = MAX_SESSION_MINUTES * 60 * 1000;
const PAGE_SIZE = 5;
const TOKEN_KEY = 'asistente_token';
const DEFAULT_SUBSCRIPTION_DAYS = 30;
const TYPING_SPEED_MS = 28;

const BLUE = '#0A57A7';
const INITIAL_FORM = { case_name: '', case_description: '', audioSource: 'mic' };
const INITIAL_AI_STATUS = { state: 'idle', message: 'Esperando el inicio de la audiencia' };

// -- Casos de ejemplo que se simulan en la portada --
const DEMO_SCENARIOS = [
  {
    id: 'hurto',
    label: 'Hurto',
    transcript:
      'Yo vi cuando el señor salió corriendo de la tienda con una caja en la mano. Eso fue como a las nueve de la noche.',
    question: '¿Qué características físicas o de vestimenta pudo observar en la persona que salió corriendo?'
  },
  {
    id: 'contrato',
    label: 'Contrato',
    transcript:
      'Firmamos el contrato en marzo, pero la entrega del inmueble nunca se hizo. Yo ya había pagado la mitad del precio acordado.',
    question: '¿Qué documento o comprobante acredita el pago de la mitad del precio y en qué fecha se hizo?'
  },
  {
    id: 'accidente',
    label: 'Accidente',
    transcript:
      'El semáforo estaba en verde para mí. La moto apareció de la nada por el carril izquierdo y no alcancé a frenar.',
    question: '¿A qué velocidad aproximada iba su vehículo al momento del impacto y cómo la estimó?'
  }
];

// =================== Clases reutilizables (Tailwind) ===================
const CARD = 'bg-white border border-gray-200 rounded-lg';
const INPUT =
  'w-full bg-white border border-gray-300 rounded-lg px-4 py-3 text-base placeholder:text-gray-400 ' +
  'focus:outline-none focus:border-legalBlue focus:ring-2 focus:ring-blue-100';
const BTN =
  'inline-flex items-center justify-center rounded-lg px-5 py-3 text-base font-medium transition-colors ' +
  'focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:opacity-40 disabled:cursor-not-allowed';
const BTN_PRIMARY = `${BTN} bg-legalBlue text-white hover:bg-blue-800 focus-visible:ring-legalBlue`;
const BTN_GREEN = `${BTN} bg-emerald-600 text-white hover:bg-emerald-700 focus-visible:ring-emerald-600`;
const BTN_OUTLINE = `${BTN} border border-gray-300 text-gray-700 bg-white hover:bg-gray-100 focus-visible:ring-gray-400`;
const BTN_DANGER = `${BTN} bg-red-600 text-white hover:bg-red-700 focus-visible:ring-red-600`;
const BTN_SMALL =
  'inline-flex items-center justify-center rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-700 ' +
  'transition-colors hover:bg-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-legalBlue';
const NAV_LINK =
  'rounded-lg px-3 py-2 text-base text-gray-600 transition-colors hover:bg-gray-100 hover:text-gray-900 ' +
  'focus:outline-none focus-visible:ring-2 focus-visible:ring-legalBlue';

// Color del indicador según el estado del asistente.
const STATUS_DOT = {
  idle: 'bg-gray-300',
  listening: 'bg-emerald-500',
  thinking: 'bg-legalBlue animate-pulse',
  error: 'bg-red-500'
};

// =================== Utilidades ===================
const formatDateTime = (value) => new Date(value).toLocaleString('es-CO');
const formatTime = (value) => new Date(value).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' });

/** Formatea una fecha "YYYY-MM-DD" sin que la zona horaria la desplace un día. */
const formatDateOnly = (value) => {
  if (!value) return 'Sin fecha';
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year, month - 1, day).toLocaleDateString('es-CO', {
    day: 'numeric',
    month: 'short',
    year: 'numeric'
  });
};

/** Devuelve la fecha de hoy + N días en formato "YYYY-MM-DD" (para <input type="date">). */
const getDateInputValue = (daysFromToday = 0) => {
  const date = new Date();
  date.setDate(date.getDate() + daysFromToday);

  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');

  return `${date.getFullYear()}-${month}-${day}`;
};

const readToken = () => {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
};

const saveToken = (token) => {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // El almacenamiento puede estar bloqueado; la sesión seguirá en memoria.
  }
};

const showToast = (title, icon = 'success') =>
  Swal.fire({ toast: true, title, icon, position: 'top-end', timer: 3000, showConfirmButton: false });

// =================== Hooks ===================

/** Indica si el usuario prefiere menos movimiento (accesibilidad). */
function usePrefersReducedMotion() {
  const [reduced] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
  return reduced;
}

/** Escribe un texto letra por letra. Con "instant" lo muestra completo de una vez. */
function useTypewriter(text, instant) {
  const [state, setState] = useState({ text, length: 0 });

  // Si cambió el texto, se empieza de cero sin esperar a un efecto.
  const length = instant ? text.length : state.text === text ? state.length : 0;

  useEffect(() => {
    if (instant || length >= text.length) return undefined;

    const timer = setTimeout(() => setState({ text, length: length + 1 }), TYPING_SPEED_MS);
    return () => clearTimeout(timer);
  }, [text, length, instant]);

  return { shown: text.slice(0, length), done: length >= text.length };
}

// =================== Componentes de presentación ===================

/** Tarjeta de una pregunta sugerida por el asistente. */
function QuestionCard({ question }) {
  return (
    <article className="bg-emerald-50 border border-emerald-100 rounded-lg p-4">
      <p className="text-lg leading-snug text-gray-900">{question.question}</p>
      <p className="text-sm text-emerald-700 mt-2">{formatTime(question.created_at)}</p>
    </article>
  );
}

/** Mensaje para listas vacías. */
function EmptyState({ title, text }) {
  return (
    <div className="h-full min-h-40 flex flex-col items-center justify-center text-center px-6 py-10">
      <p className="text-lg text-gray-600">{title}</p>
      {text && <p className="text-base text-gray-400 mt-1 max-w-sm">{text}</p>}
    </div>
  );
}

/** Paginación reutilizable (historial y clientes). */
function Pagination({ page, totalPages, onChange }) {
  return (
    <div className="mt-8 pt-5 border-t border-gray-200 flex flex-col sm:flex-row items-center justify-between gap-4">
      <p className="text-base text-gray-500">
        Página {page} de {totalPages}
      </p>

      <div className="flex w-full sm:w-auto gap-2">
        <button disabled={page <= 1} onClick={() => onChange(page - 1)} className={`${BTN_OUTLINE} flex-1 sm:flex-none`}>
          Anterior
        </button>
        <button
          disabled={page >= totalPages}
          onClick={() => onChange(page + 1)}
          className={`${BTN_PRIMARY} flex-1 sm:flex-none`}
        >
          Siguiente
        </button>
      </div>
    </div>
  );
}

/** Campo de búsqueda reutilizable. */
function SearchInput({ value, onChange, placeholder, label }) {
  return (
    <div className="relative">
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={label}
        className={`${INPUT} pl-12 pr-12`}
      />

      <svg
        className="w-5 h-5 text-gray-400 absolute left-4 top-1/2 -translate-y-1/2"
        viewBox="0 0 24 24"
        aria-hidden="true"
      >
        <path
          fill="currentColor"
          d="m19.6 21l-6.3-6.3q-.75.6-1.725.95T9.5 16q-2.725 0-4.612-1.888T3 9.5t1.888-4.612T9.5 3t4.613 1.888T16 9.5q0 1.1-.35 2.075T14.7 13.3l6.3 6.3zM9.5 14q1.875 0 3.188-1.312T14 9.5t-1.312-3.187T9.5 5T6.313 6.313T5 9.5t1.313 3.188T9.5 14"
        />
      </svg>

      {value && (
        <button
          type="button"
          onClick={() => onChange('')}
          aria-label="Limpiar búsqueda"
          className="absolute right-3 top-1/2 -translate-y-1/2 w-8 h-8 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100"
        >
          ✕
        </button>
      )}
    </div>
  );
}

/** Ventana modal accesible: se cierra con Escape o al hacer clic fuera. */
function Modal({ title, onClose, children }) {
  useEffect(() => {
    const handleKey = (event) => {
      if (event.key === 'Escape') onClose();
    };

    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-40 flex items-end sm:items-center justify-center bg-black/40 sm:p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="w-full sm:max-w-lg max-h-[90vh] overflow-y-auto bg-white rounded-t-lg sm:rounded-lg p-6 sm:p-8"
      >
        <h2 className="text-xl sm:text-2xl font-semibold text-gray-800 mb-6">{title}</h2>
        {children}
      </div>
    </div>
  );
}

// =================== Portada: navegación + hero + login ===================

/** Simulación de la transcripción en vivo con la pregunta que sugiere el asistente. */
function HeroDemo() {
  const reducedMotion = usePrefersReducedMotion();
  const [index, setIndex] = useState(0);
  const [showQuestion, setShowQuestion] = useState(false);

  const scenario = DEMO_SCENARIOS[index];
  const { shown, done } = useTypewriter(scenario.transcript, reducedMotion);

  // Cuando termina de "escucharse" el texto: aparece la pregunta y, después, pasa al siguiente caso.
  useEffect(() => {
    setShowQuestion(false);
    if (!done) return undefined;

    const reveal = setTimeout(() => setShowQuestion(true), reducedMotion ? 0 : 800);
    const next = reducedMotion
      ? null
      : setTimeout(() => setIndex((current) => (current + 1) % DEMO_SCENARIOS.length), 6500);

    return () => {
      clearTimeout(reveal);
      if (next) clearTimeout(next);
    };
  }, [done, index, reducedMotion]);

  const status = showQuestion
    ? { state: 'listening', message: 'Pregunta lista' }
    : done
      ? { state: 'thinking', message: 'Analizando lo último que se dijo...' }
      : { state: 'listening', message: 'Escuchando la audiencia...' };

  return (
    <div>
      <div className="bg-white text-gray-800 rounded-lg p-5 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
          <p className="text-sm text-gray-500">Transcripción en vivo</p>

          <p className="flex items-center gap-2 text-sm text-gray-500" aria-live="polite">
            <span className={`w-2 h-2 rounded-full shrink-0 ${STATUS_DOT[status.state]}`} />
            {status.message}
          </p>
        </div>

        <p className="text-lg leading-relaxed min-h-32">
          {shown}
          {!done && <span className="inline-block w-0.5 h-5 bg-legalBlue ml-0.5 align-middle animate-pulse" />}
        </p>

        <div
          className={`mt-3 rounded-lg border border-emerald-100 bg-emerald-50 p-4 transition-all duration-500 ${showQuestion ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-2'
            }`}
          aria-hidden={!showQuestion}
        >
          <p className="text-lg leading-snug text-gray-900">{scenario.question}</p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 mt-5">
        <span className="text-base text-blue-100 mr-1">Prueba con otro caso:</span>

        {DEMO_SCENARIOS.map((item, itemIndex) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setIndex(itemIndex)}
            aria-pressed={itemIndex === index}
            className={`rounded-lg border px-4 py-2 text-base transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-white ${itemIndex === index
                ? 'bg-white text-legalBlue border-white'
                : 'border-white/40 text-white hover:bg-white/10'
              }`}
          >
            {item.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Portada pública: barra de navegación y hero dividido en bienvenida + login. */
function LandingPage({ onLogin }) {
  const [form, setForm] = useState({ correo: '', password: '' });
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const emailRef = useRef(null);
  const demoRef = useRef(null);

  const handleSubmit = async (event) => {
    event.preventDefault();
    setError('');
    setLoading(true);

    try {
      await onLogin(form.correo.trim(), form.password);
    } catch (err) {
      setError(err.message);
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex flex-col bg-white">

      {/* Barra de navegación */}
      {/* <nav className="border-b border-gray-200 bg-white" aria-label="Principal">
        <div className="mx-auto max-w-7xl px-4 sm:px-8 h-16 flex items-center justify-between gap-4">
          <button
            type="button"
            onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
            className="text-lg sm:text-xl font-semibold text-legalBlue truncate"
          >
            Asistente de audiencias
          </button>

          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
              className={`${NAV_LINK} hidden sm:inline-flex`}
            >
              Inicio
            </button>
            <button
              type="button"
              onClick={() => demoRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })}
              className={`${NAV_LINK} hidden sm:inline-flex`}
            >
              Cómo funciona
            </button>
            <button
              type="button"
              onClick={() => emailRef.current?.focus()}
              className="rounded-lg px-4 py-2 text-base font-medium text-legalBlue border border-legalBlue hover:bg-blue-50 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-legalBlue"
            >
              Acceso
            </button>
          </div>
        </div>
      </nav> */}

      {/* Hero dividido en dos mitades */}
      <main className="flex-1 grid lg:grid-cols-2">

        {/* Mitad izquierda: bienvenida */}
        <section className="bg-legalBlue text-white px-6 sm:px-12 lg:px-16 py-12 lg:py-16 flex items-center">
          <div className="w-full max-w-xl mx-auto">
            <h1 className="text-4xl sm:text-5xl font-semibold leading-tight tracking-tight">
              Bienvenido a LitigaDigital
            </h1>

            <p className="mt-5 text-lg sm:text-xl text-blue-100 leading-relaxed">
              Escucha la audiencia en vivo y te sugiere la siguiente pregunta, mientras tú te concentras en el caso.
            </p>

            <div ref={demoRef} className="mt-10">
              <HeroDemo />
            </div>
          </div>
        </section>

        {/* Mitad derecha: login */}
        <section className="bg-gray-50 px-6 sm:px-12 lg:px-16 py-12 lg:py-16 flex items-center justify-center">
          <div className={`${CARD} w-full max-w-md p-6 sm:p-8`}>
            <h2 className="text-2xl font-semibold text-gray-800">Iniciar sesión</h2>
            <p className="text-base text-gray-500 mt-1 mb-6">
              Ingresa con la cuenta que te asignó el administrador.
            </p>

            <form onSubmit={handleSubmit} className="space-y-5" noValidate>
              <div>
                <label htmlFor="login_correo" className="block text-base font-medium text-gray-700 mb-2">
                  Correo
                </label>
                <input
                  id="login_correo"
                  ref={emailRef}
                  type="email"
                  autoComplete="username"
                  required
                  value={form.correo}
                  onChange={(e) => setForm({ ...form, correo: e.target.value })}
                  className={INPUT}
                  placeholder="Ingrese su correo electrónico"
                />
              </div>

              <div>
                <label htmlFor="login_password" className="block text-base font-medium text-gray-700 mb-2">
                  Contraseña
                </label>
                <div className="relative">
                  <input
                    id="login_password"
                    type={showPassword ? 'text' : 'password'}
                    autoComplete="current-password"
                    required
                    value={form.password}
                    onChange={(e) => setForm({ ...form, password: e.target.value })}
                    className={`${INPUT} pr-24`}
                    placeholder="Ingrese su contraseña"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((prev) => !prev)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg px-3 py-2 text-sm text-gray-500 hover:text-gray-800 hover:bg-gray-100"
                  >
                    {showPassword ? 'Ocultar' : 'Mostrar'}
                  </button>
                </div>
              </div>

              {error && (
                <p role="alert" className="rounded-lg border border-red-100 bg-red-50 px-4 py-3 text-base text-red-700">
                  {error}
                </p>
              )}

              <button type="submit" disabled={loading} className={`${BTN_GREEN} w-full`}>
                {loading ? 'Ingresando...' : 'Ingresar'}
              </button>
            </form>

            <p className="text-sm text-gray-500 mt-6 leading-relaxed">
              ¿No tiene cuenta? Solicítela al administrador.
            </p>
          </div>
        </section>
      </main>
    </div>
  );
}

// =================== Encabezado de la aplicación (autenticado) ===================
function AppHeader({ user, currentView, isLive, caseName, onNavigate, onLogout }) {
  const isAdmin = user.rol === 'admin';
  const isUsersTab = currentView === 'users';

  const tabClass = (active) =>
    `rounded-lg px-4 py-2 text-base transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-legalBlue ${active ? 'bg-blue-50 text-legalBlue font-medium' : 'text-gray-600 hover:bg-gray-100'
    }`;

  return (
    <header className="mb-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl sm:text-3xl font-semibold text-legalBlue tracking-tight">Asistente de audiencias</h1>

        <div className="flex items-center gap-3 min-w-0">
          <p className="text-base text-gray-600 truncate">
            {user.nombre}
            {isAdmin && <span className="text-gray-400"> (administrador)</span>}
          </p>

          <button onClick={onLogout} className={BTN_SMALL}>
            Cerrar sesión
          </button>
        </div>
      </div>

      {isLive ? (
        <p className="inline-flex items-center gap-2 text-base text-gray-600 mt-4 min-w-0">
          <span className="w-2.5 h-2.5 rounded-full bg-red-500 shrink-0" />
          <span className="truncate">Grabando: {caseName}</span>
        </p>
      ) : (
        <nav className="flex gap-2 mt-5" aria-label="Secciones">
          <button onClick={() => onNavigate('list')} className={tabClass(!isUsersTab)}>
            Audiencias
          </button>
          {isAdmin && (
            <button onClick={() => onNavigate('users')} className={tabClass(isUsersTab)}>
              Clientes
            </button>
          )}
        </nav>
      )}
    </header>
  );
}

// =================== Panel de clientes (solo administrador) ===================

/** Insignias de estado y suscripción de un cliente. */
function UserBadges({ user }) {
  return (
    <div className="flex flex-wrap gap-2">
      <span
        className={`rounded-lg border px-2.5 py-1 text-sm ${user.activo
            ? 'bg-emerald-50 border-emerald-100 text-emerald-700'
            : 'bg-gray-100 border-gray-200 text-gray-600'
          }`}
      >
        {user.activo ? 'Activo' : 'Inactivo'}
      </span>

      {!user.suscripcion_activa && (
        <span className="rounded-lg border border-red-100 bg-red-50 px-2.5 py-1 text-sm text-red-700">Vencida</span>
      )}
    </div>
  );
}

/** Acciones disponibles para un cliente. */
function UserActions({ user, onEdit, onToggle, onResetPassword }) {
  return (
    <div className="flex flex-wrap gap-2">
      <button onClick={() => onEdit(user)} className={BTN_SMALL}>
        Editar
      </button>
      <button onClick={() => onToggle(user)} className={`${BTN_SMALL} ${user.activo ? 'text-red-700' : 'text-emerald-700'}`}>
        {user.activo ? 'Desactivar' : 'Activar'}
      </button>
      <button onClick={() => onResetPassword(user)} className={BTN_SMALL}>
        Nueva contraseña
      </button>
    </div>
  );
}

/** Formulario (en modal) para crear o editar un cliente. */
function UserFormModal({ mode, user, onSubmit, onClose }) {
  const isEdit = mode === 'edit';

  const [form, setForm] = useState(() =>
    isEdit
      ? { nombre: user.nombre, correo: user.correo, vencimiento: user.vencimiento || '', activo: user.activo }
      : { nombre: '', correo: '', vencimiento: getDateInputValue(DEFAULT_SUBSCRIPTION_DAYS), activo: true }
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (event) => {
    event.preventDefault();
    setSaving(true);
    setError('');

    try {
      await onSubmit(form); // Si sale bien, el padre cierra el modal.
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  };

  return (
    <Modal title={isEdit ? 'Editar cliente' : 'Nuevo cliente'} onClose={onClose}>
      <form onSubmit={handleSubmit} className="space-y-5">
        <div>
          <label htmlFor="user_nombre" className="block text-base font-medium text-gray-700 mb-2">
            Nombre
          </label>
          <input
            id="user_nombre"
            type="text"
            required
            autoFocus
            maxLength={120}
            value={form.nombre}
            onChange={(e) => setForm({ ...form, nombre: e.target.value })}
            className={INPUT}
            placeholder="Nombre completo"
          />
        </div>

        <div>
          <label htmlFor="user_correo" className="block text-base font-medium text-gray-700 mb-2">
            Correo
          </label>
          <input
            id="user_correo"
            type="email"
            required
            maxLength={160}
            value={form.correo}
            onChange={(e) => setForm({ ...form, correo: e.target.value })}
            className={INPUT}
            placeholder="cliente@correo.com"
          />
        </div>

        <div>
          <label htmlFor="user_vencimiento" className="block text-base font-medium text-gray-700 mb-2">
            Vencimiento de la suscripción
          </label>
          <input
            id="user_vencimiento"
            type="date"
            required
            value={form.vencimiento}
            onChange={(e) => setForm({ ...form, vencimiento: e.target.value })}
            className={INPUT}
          />
          <p className="text-sm text-gray-500 mt-2">El cliente podrá crear audiencias hasta el final de este día.</p>
        </div>

        <label className="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={form.activo}
            onChange={(e) => setForm({ ...form, activo: e.target.checked })}
            className="mt-1 w-5 h-5 accent-emerald-600"
          />
          <span className="text-base text-gray-700">
            Cliente activo
            <span className="block text-sm text-gray-500">Si está inactivo, no puede iniciar sesión.</span>
          </span>
        </label>

        {!isEdit && (
          <p className="rounded-lg bg-gray-50 border border-gray-200 px-4 py-3 text-sm text-gray-600 leading-relaxed">
            La contraseña se genera automáticamente y se mostrará una sola vez al guardar.
          </p>
        )}

        {error && (
          <p role="alert" className="rounded-lg border border-red-100 bg-red-50 px-4 py-3 text-base text-red-700">
            {error}
          </p>
        )}

        <div className="flex flex-col-reverse sm:flex-row gap-3 pt-2">
          <button type="button" onClick={onClose} className={BTN_OUTLINE}>
            Cancelar
          </button>
          <button type="submit" disabled={saving} className={`${BTN_PRIMARY} sm:flex-1`}>
            {saving ? 'Guardando...' : isEdit ? 'Guardar cambios' : 'Crear cliente'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** Muestra la contraseña generada (solo se ve una vez). */
function CredentialsModal({ credentials, onClose }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(credentials.password);
      setCopied(true);
    } catch {
      setCopied(false);
      Swal.fire('No se pudo copiar', 'Selecciona la contraseña y cópiala manualmente.', 'info');
    }
  };

  return (
    <Modal title={credentials.title} onClose={onClose}>
      <p className="text-base text-gray-600 leading-relaxed mb-5">
        Entrega estos datos a <strong className="font-medium text-gray-800">{credentials.nombre}</strong>. Por seguridad,
        la contraseña no se volverá a mostrar.
      </p>

      <dl className="rounded-lg border border-gray-200 divide-y divide-gray-200 text-base">
        <div className="px-4 py-3">
          <dt className="text-sm text-gray-400">Correo</dt>
          <dd className="text-gray-800 mt-1 break-all">{credentials.correo}</dd>
        </div>
        <div className="px-4 py-3">
          <dt className="text-sm text-gray-400">Contraseña</dt>
          <dd className="text-gray-900 mt-1 text-xl font-mono tracking-wide break-all select-all">
            {credentials.password}
          </dd>
        </div>
      </dl>

      <div className="flex flex-col-reverse sm:flex-row gap-3 mt-6">
        <button onClick={onClose} className={BTN_OUTLINE}>
          Cerrar
        </button>
        <button onClick={handleCopy} className={`${BTN_GREEN} sm:flex-1`}>
          {copied ? 'Contraseña copiada' : 'Copiar contraseña'}
        </button>
      </div>
    </Modal>
  );
}

/** Gestión completa de clientes: tabla, búsqueda, paginación y CRUD. */
function UsersPanel({ apiFetch }) {
  const [users, setUsers] = useState([]);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [pagination, setPagination] = useState({ total: 0, totalPages: 1 });
  const [loading, setLoading] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const [formModal, setFormModal] = useState(null); // null | { mode: 'create' } | { mode: 'edit', user }
  const [credentials, setCredentials] = useState(null);

  const reload = () => setRefreshKey((key) => key + 1);

  // Cargar clientes (con una pequeña espera para no consultar en cada tecla).
  useEffect(() => {
    let cancelled = false;

    const timer = setTimeout(async () => {
      try {
        setLoading(true);

        const params = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE), search });
        const data = await apiFetch(`/api/users?${params}`);

        if (cancelled) return;

        setUsers(data.data);
        setPagination({ total: data.pagination.total, totalPages: data.pagination.totalPages || 1 });

      } catch (error) {
        if (!cancelled) Swal.fire('Error', error.message, 'error');

      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 300);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [apiFetch, page, search, refreshKey]);

  // -- Crear o editar --
  const handleSave = async (form) => {
    const isEdit = formModal.mode === 'edit';

    const data = await apiFetch(isEdit ? `/api/users/${formModal.user.id}` : '/api/users', {
      method: isEdit ? 'PUT' : 'POST',
      body: JSON.stringify(form)
    });

    setFormModal(null);
    reload();

    if (isEdit) {
      showToast('Cliente actualizado');
    } else {
      setCredentials({
        title: 'Cliente creado',
        nombre: data.user.nombre,
        correo: data.user.correo,
        password: data.temporaryPassword
      });
    }
  };

  // -- Activar / desactivar --
  const handleToggle = async (user) => {
    const nextActive = !user.activo;

    const result = await Swal.fire({
      title: nextActive ? '¿Activar cliente?' : '¿Desactivar cliente?',
      text: nextActive
        ? `${user.nombre} podrá iniciar sesión de nuevo.`
        : `${user.nombre} no podrá iniciar sesión hasta que lo actives.`,
      icon: 'question',
      showCancelButton: true,
      confirmButtonColor: BLUE,
      cancelButtonColor: '#6b7280',
      confirmButtonText: nextActive ? 'Activar' : 'Desactivar',
      cancelButtonText: 'Cancelar'
    });

    if (!result.isConfirmed) return;

    try {
      await apiFetch(`/api/users/${user.id}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ activo: nextActive })
      });

      reload();
      showToast(nextActive ? 'Cliente activado' : 'Cliente desactivado');

    } catch (error) {
      Swal.fire('Error', error.message, 'error');
    }
  };

  // -- Nueva contraseña --
  const handleResetPassword = async (user) => {
    const result = await Swal.fire({
      title: '¿Generar nueva contraseña?',
      text: `La contraseña actual de ${user.nombre} dejará de funcionar.`,
      icon: 'warning',
      showCancelButton: true,
      confirmButtonColor: BLUE,
      cancelButtonColor: '#6b7280',
      confirmButtonText: 'Generar',
      cancelButtonText: 'Cancelar'
    });

    if (!result.isConfirmed) return;

    try {
      const data = await apiFetch(`/api/users/${user.id}/reset-password`, { method: 'POST' });

      setCredentials({
        title: 'Nueva contraseña',
        nombre: data.user.nombre,
        correo: data.user.correo,
        password: data.temporaryPassword
      });

    } catch (error) {
      Swal.fire('Error', error.message, 'error');
    }
  };

  const actions = {
    onEdit: (user) => setFormModal({ mode: 'edit', user }),
    onToggle: handleToggle,
    onResetPassword: handleResetPassword
  };

  return (
    <section className={`${CARD} p-5 sm:p-8`}>
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6">
        <div>
          <h2 className="text-xl sm:text-2xl font-semibold text-gray-800">Clientes</h2>
          <p className="text-base text-gray-500 mt-1">Crea cuentas y controla su suscripción.</p>
        </div>

        <button onClick={() => setFormModal({ mode: 'create' })} className={`${BTN_PRIMARY} w-full sm:w-auto`}>
          Nuevo cliente
        </button>
      </div>

      <div className="mb-6">
        <SearchInput
          value={search}
          onChange={(value) => {
            setSearch(value);
            setPage(1);
          }}
          placeholder="Buscar por nombre o correo"
          label="Buscar clientes"
        />
        <p className="text-sm text-gray-500 mt-2">{pagination.total} cliente(s) encontrado(s)</p>
      </div>

      {loading ? (
        <p className="py-12 text-center text-base text-gray-500">Cargando clientes...</p>
      ) : users.length === 0 ? (
        <div className="border border-dashed border-gray-300 rounded-lg">
          <EmptyState
            title={search ? 'No hay clientes con ese dato' : 'Aún no hay clientes'}
            text={search ? 'Prueba con otro nombre o correo.' : 'Crea el primero con el botón «Nuevo cliente».'}
          />
        </div>
      ) : (
        <>
          {/* Tabla en pantallas medianas y grandes */}
          <div className="hidden md:block overflow-x-auto border border-gray-200 rounded-lg">
            <table className="w-full text-left text-base">
              <thead className="bg-gray-50 text-sm text-gray-500">
                <tr>
                  <th scope="col" className="px-5 py-3 font-medium">Cliente</th>
                  <th scope="col" className="px-5 py-3 font-medium">Vencimiento</th>
                  <th scope="col" className="px-5 py-3 font-medium">Estado</th>
                  <th scope="col" className="px-5 py-3 font-medium">Acciones</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {users.map((user) => (
                  <tr key={user.id} className="align-middle">
                    <td className="px-5 py-4">
                      <p className="font-medium text-gray-800">{user.nombre}</p>
                      <p className="text-sm text-gray-500 break-all">{user.correo}</p>
                    </td>
                    <td className={`px-5 py-4 whitespace-nowrap ${user.suscripcion_activa ? 'text-gray-700' : 'text-red-700'}`}>
                      {formatDateOnly(user.vencimiento)}
                    </td>
                    <td className="px-5 py-4">
                      <UserBadges user={user} />
                    </td>
                    <td className="px-5 py-4">
                      <UserActions user={user} {...actions} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Tarjetas en móvil */}
          <div className="md:hidden space-y-3">
            {users.map((user) => (
              <article key={user.id} className="border border-gray-200 rounded-lg p-4 space-y-3">
                <div>
                  <p className="text-lg font-medium text-gray-800 break-words">{user.nombre}</p>
                  <p className="text-base text-gray-500 break-all">{user.correo}</p>
                </div>

                <p className={`text-base ${user.suscripcion_activa ? 'text-gray-600' : 'text-red-700'}`}>
                  Vence: {formatDateOnly(user.vencimiento)}
                </p>

                <UserBadges user={user} />
                <UserActions user={user} {...actions} />
              </article>
            ))}
          </div>

          <Pagination page={page} totalPages={pagination.totalPages} onChange={setPage} />
        </>
      )}

      {formModal && (
        <UserFormModal
          mode={formModal.mode}
          user={formModal.user}
          onSubmit={handleSave}
          onClose={() => setFormModal(null)}
        />
      )}

      {credentials && <CredentialsModal credentials={credentials} onClose={() => setCredentials(null)} />}
    </section>
  );
}

// =================== Componente Principal ===================
function App() {
  // -- Autenticación --
  const [authUser, setAuthUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);

  // -- Navegación --
  const [currentView, setCurrentView] = useState('list');

  // -- Historial --
  const [sessionsList, setSessionsList] = useState([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [totalSessions, setTotalSessions] = useState(0);
  const [loadingSessions, setLoadingSessions] = useState(false);

  // -- Sesión en vivo --
  const [session, setSession] = useState(null);
  const [transcription, setTranscription] = useState([]);
  const [interimTranscript, setInterimTranscript] = useState('');
  const [aiQuestions, setAiQuestions] = useState([]);
  const [aiStatus, setAiStatus] = useState(INITIAL_AI_STATUS);

  // -- Detalle de una audiencia pasada --
  const [selectedSession, setSelectedSession] = useState(null);
  const [sessionDetails, setSessionDetails] = useState([]);
  const [sessionAiQuestions, setSessionAiQuestions] = useState([]);
  const [loadingDetails, setLoadingDetails] = useState(false);

  // -- Formulario --
  const [formData, setFormData] = useState(INITIAL_FORM);

  // -- Referencias mutables (no provocan re-render) --
  const tokenRef = useRef(readToken());
  const logoutRef = useRef(null);
  const socketRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const streamRef = useRef(null);
  const timerRef = useRef(null);
  const isStoppingRef = useRef(false);
  const transcriptEndRef = useRef(null);

  // Un cliente solo puede crear audiencias con la suscripción vigente (el admin siempre puede).
  const canStartSessions = authUser?.rol === 'admin' || Boolean(authUser?.suscripcion_activa);

  // =================== Comunicación con el backend ===================
  /**
   * fetch con el token incluido. Si el servidor responde 401, la sesión
   * expiró o el usuario fue desactivado: se cierra la sesión automáticamente.
   * Es estable (useCallback) para poder usarla como dependencia de efectos.
   */
  const apiFetch = useCallback(async (path, options = {}) => {
    const response = await fetch(`${BACKEND_URL}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(tokenRef.current ? { Authorization: `Bearer ${tokenRef.current}` } : {}),
        ...options.headers
      }
    });

    const data = await response.json().catch(() => ({}));

    if (response.status === 401 && tokenRef.current) {
      logoutRef.current?.({ expired: true });
      throw new Error(data.error || 'Tu sesión expiró. Inicia sesión de nuevo.');
    }

    if (!response.ok) {
      throw new Error(data.error || 'Ocurrió un error inesperado.');
    }

    return data;
  }, []);

  // =================== Efectos ===================

  // Restaurar la sesión si hay un token guardado.
  useEffect(() => {
    const restoreSession = async () => {
      if (!tokenRef.current) {
        setAuthLoading(false);
        return;
      }

      try {
        const data = await apiFetch('/api/auth/me');
        setAuthUser(data.user);
      } catch {
        tokenRef.current = null;
        saveToken(null);
      } finally {
        setAuthLoading(false);
      }
    };

    restoreSession();
  }, [apiFetch]);

  // Liberar recursos si el componente se desmonta inesperadamente.
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);

      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        mediaRecorderRef.current.stop();
      }

      if (socketRef.current) {
        socketRef.current.emit('stop_session');
        socketRef.current.disconnect();
      }

      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
      }
    };
  }, []);

  // Cargar el historial (con pequeña espera para no consultar en cada tecla).
  useEffect(() => {
    if (!authUser || currentView !== 'list') return;

    const timeoutId = setTimeout(() => {
      fetchSessions(currentPage, searchTerm);
    }, 300);

    return () => clearTimeout(timeoutId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authUser, currentView, currentPage, searchTerm]);

  // Mantener visible lo último que se transcribió.
  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [transcription, interimTranscript]);

  // =================== Autenticación ===================
  const iniciarSesion = async (correo, password) => {
    const data = await apiFetch('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ correo, password })
    });

    tokenRef.current = data.token;
    saveToken(data.token);

    setCurrentView('list');
    setAuthUser(data.user);
  };

  // =================== Historial ===================
  const fetchSessions = async (page = currentPage, search = searchTerm) => {
    try {
      setLoadingSessions(true);

      const params = new URLSearchParams({
        page: String(page),
        limit: String(PAGE_SIZE),
        search
      });

      const response = await apiFetch(`/api/sessions?${params}`);

      setSessionsList(response.data);
      setTotalPages(response.pagination.totalPages || 1);
      setTotalSessions(response.pagination.total);

    } catch (error) {
      console.error('[FRONTEND] Error cargando historial:', error);
      Swal.fire('Error', 'No fue posible cargar el historial.', 'error');

    } finally {
      setLoadingSessions(false);
    }
  };

  const verDetalles = async (sessionId) => {
    try {
      setLoadingDetails(true);
      setSessionDetails([]);
      setSessionAiQuestions([]);
      setSelectedSession(null);

      const data = await apiFetch(`/api/sessions/${sessionId}`);

      setSelectedSession(data.session);
      setSessionDetails(data.transcriptions);
      setSessionAiQuestions(data.ai_questions || []);
      setCurrentView('detail');

    } catch (error) {
      console.error('[FRONTEND] Error consultando audiencia:', error);
      Swal.fire('Error', error.message, 'error');

    } finally {
      setLoadingDetails(false);
    }
  };

  // =================== Temporizador de límite de sesión ===================
  const iniciarTemporizador = () => {
    if (timerRef.current) clearTimeout(timerRef.current);

    timerRef.current = setTimeout(() => {
      Swal.fire({
        title: 'Límite de tiempo alcanzado',
        text: `Han pasado ${MAX_SESSION_MINUTES} minutos. ¿Quieres seguir grabando? Si no respondes, se detendrá.`,
        icon: 'warning',
        showCancelButton: true,
        confirmButtonColor: BLUE,
        cancelButtonColor: '#6b7280',
        confirmButtonText: 'Seguir grabando',
        cancelButtonText: 'Detener',
        timer: 15000,
        timerProgressBar: true
      }).then((result) => {
        if (result.isConfirmed) {
          iniciarTemporizador();
        } else {
          detenerAudiencia();
        }
      });
    }, MAX_SESSION_MS);
  };

  // =================== Captura de audio ===================
  const capturarAudio = async (source) => {
    if (source === 'mic') {
      return navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });
    }

    return navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: { suppressLocalAudioPlayback: false },
      systemAudio: 'include',
      windowAudio: 'system',
      selfBrowserSurface: 'exclude',
      surfaceSwitching: 'include'
    });
  };

  /** Conecta Socket.IO (enviando el token) y registra los eventos del asistente. */
  const conectarSocket = () => {
    const socket = io(BACKEND_URL, {
      auth: { token: tokenRef.current },
      transports: ['websocket', 'polling']
    });
    socketRef.current = socket;

    // -- Transcripción en vivo --
    socket.on('new_transcription', ({ text, isFinal }) => {
      if (isFinal) {
        setTranscription((prev) => [...prev, text]);
        setInterimTranscript('');
      } else {
        setInterimTranscript(text);
      }
    });

    // -- Estado del asistente: { state, message } --
    socket.on('ai_status', (status) => {
      setAiStatus({
        state: status.state || 'listening',
        message: status.message
      });
    });

    // -- Nueva pregunta generada por el LLM (la más reciente va primero) --
    socket.on('new_question', (newQuestion) => {
      setAiQuestions((prev) => {
        // Evitar duplicados si el servidor reenvía el evento.
        if (newQuestion?.id && prev.some((q) => q.id === newQuestion.id)) return prev;
        return [newQuestion, ...prev];
      });
    });

    // -- Errores durante la sesión --
    socket.on('session_error', (err) => {
      console.error('[FRONTEND] Error de sesión:', err);
      setAiStatus({ state: 'error', message: err.message });
    });

    return socket;
  };

  /** Espera a que el backend confirme que Deepgram está listo. */
  const esperarSesionLista = (socket) =>
    new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Tiempo de espera agotado al conectar con Deepgram.'));
      }, 20000);

      socket.once('session_ready', (msg) => {
        clearTimeout(timeout);
        resolve(msg);
      });

      socket.once('session_error', (err) => {
        clearTimeout(timeout);
        reject(new Error(err.message));
      });

      socket.once('connect_error', (err) => {
        clearTimeout(timeout);
        reject(new Error(err.message || 'No fue posible conectar con el servidor.'));
      });
    });

  // =================== Iniciar audiencia ===================
  const iniciarAudiencia = async (e) => {
    e.preventDefault();

    if (!canStartSessions) {
      return Swal.fire(
        'Suscripción vencida',
        'Tu suscripción no está vigente. Contacta al administrador para renovarla.',
        'warning'
      );
    }

    if (!formData.case_name.trim()) {
      return Swal.fire('Falta el nombre', 'Escribe el nombre de la audiencia.', 'error');
    }

    let stream = null;

    try {
      // 1. Pedir la captura primero: debe ocurrir antes de cualquier await de red.
      stream = await capturarAudio(formData.audioSource);
      streamRef.current = stream;

      // 2. Comprobar que exista una pista de audio.
      const audioTracks = stream.getAudioTracks();

      if (!audioTracks.length) {
        throw new Error(
          'No se detectó audio. Comparte una pestaña de Chrome con audio y activa la opción "Compartir audio".'
        );
      }

      // 3. Crear la sesión en PostgreSQL.
      const data = await apiFetch('/api/sessions', {
        method: 'POST',
        body: JSON.stringify({
          case_name: formData.case_name,
          case_description: formData.case_description
        })
      });

      const newSession = data.session;

      setSession(newSession);
      setTranscription([]);
      setInterimTranscript('');
      setAiQuestions([]);
      setAiStatus({ state: 'idle', message: 'Conectando con el motor de transcripción' });

      // 4. Conectar Socket.IO y esperar a Deepgram.
      const socket = conectarSocket();
      const readyPromise = esperarSesionLista(socket);

      socket.emit('join_session', newSession.id);
      await readyPromise;

      // 5. Grabar únicamente audio y enviarlo por fragmentos.
      const mimeType = ['audio/webm;codecs=opus', 'audio/webm'].find((type) =>
        MediaRecorder.isTypeSupported(type)
      );

      if (!mimeType) throw new Error('El navegador no soporta grabación WebM.');

      const mediaRecorder = new MediaRecorder(new MediaStream(audioTracks), {
        mimeType,
        audioBitsPerSecond: 128000
      });

      mediaRecorderRef.current = mediaRecorder;

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0 && socket.connected) {
          socket.emit('audio_chunk', { sessionId: newSession.id, data: event.data });
        }
      };

      mediaRecorder.onerror = (event) => {
        console.error('[AUDIO] Error MediaRecorder:', event.error);
      };

      mediaRecorder.start(250);

      isStoppingRef.current = false;
      setCurrentView('session');
      iniciarTemporizador();

      showToast('Audiencia iniciada');

    } catch (error) {
      console.error('[FRONTEND] Error iniciando audiencia:', error);

      // Cerrar todos los recursos si algo falla.
      if (mediaRecorderRef.current) {
        if (mediaRecorderRef.current.state !== 'inactive') mediaRecorderRef.current.stop();
        mediaRecorderRef.current = null;
      }

      if (stream) stream.getTracks().forEach((track) => track.stop());
      streamRef.current = null;

      if (socketRef.current) {
        socketRef.current.disconnect();
        socketRef.current = null;
      }

      Swal.fire('No se pudo iniciar', error.message, 'error');
    }
  };

  // =================== Finalizar audiencia ===================
  const limpiarRecursos = async () => {
    // 1. Detener el MediaRecorder y esperar su último fragmento.
    if (mediaRecorderRef.current) {
      const recorder = mediaRecorderRef.current;

      if (recorder.state !== 'inactive') {
        await new Promise((resolve) => {
          recorder.addEventListener('stop', resolve, { once: true });
          recorder.stop();
        });
      }

      mediaRecorderRef.current = null;
    }

    // 2. Avisar al backend que debe cerrar Deepgram.
    if (socketRef.current?.connected) {
      const socket = socketRef.current;
      socket.emit('stop_session');

      // Dar tiempo al backend para procesar el cierre y las últimas preguntas.
      await new Promise((resolve) => setTimeout(resolve, 1500));
      socket.disconnect();
    }

    socketRef.current = null;

    // 3. Apagar todas las pistas de audio.
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
  };

  const detenerAudiencia = async () => {
    if (isStoppingRef.current) return;
    isStoppingRef.current = true;

    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }

    await limpiarRecursos();

    setAiStatus(INITIAL_AI_STATUS);
    setCurrentView('list');

    Swal.fire({
      toast: true,
      title: 'Audiencia finalizada',
      text: 'Quedó guardada en el historial.',
      icon: 'info',
      position: 'top-end',
      timer: 3500,
      showConfirmButton: false
    });
  };

  // =================== Cerrar sesión ===================
  const cerrarSesion = async ({ expired = false } = {}) => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }

    // Si había una audiencia grabando, se detiene antes de salir.
    await limpiarRecursos();
    isStoppingRef.current = false;

    tokenRef.current = null;
    saveToken(null);

    setAuthUser(null);
    setCurrentView('list');
    setSessionsList([]);
    setSearchTerm('');
    setCurrentPage(1);
    setSession(null);
    setAiStatus(INITIAL_AI_STATUS);

    if (expired) showToast('Tu sesión expiró. Inicia sesión de nuevo.', 'info');
  };

  // Permite que apiFetch cierre la sesión sin depender de la versión actual de esta función.
  logoutRef.current = cerrarSesion;

  // =================== Formulario ===================
  const abrirFormulario = () => {
    setFormData(INITIAL_FORM);
    setCurrentView('form');
  };

  const cancelarFormulario = () => {
    setFormData(INITIAL_FORM);
    setCurrentView('list');
  };

  // =================== Render ===================

  // -- Comprobando si hay una sesión guardada --
  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <p className="text-lg text-gray-500">Cargando...</p>
      </div>
    );
  }

  // -- Sin sesión: portada con login --
  if (!authUser) {
    return <LandingPage onLogin={iniciarSesion} />;
  }

  return (
    <div className="min-h-screen bg-gray-50 text-gray-800">
      <div className="mx-auto w-full max-w-6xl px-4 sm:px-8 py-6 sm:py-10">

        <AppHeader
          user={authUser}
          currentView={currentView}
          isLive={currentView === 'session' && !!session}
          caseName={session?.case_name}
          onNavigate={setCurrentView}
          onLogout={cerrarSesion}
        />

        {/* ===================== VISTA 1: HISTORIAL ===================== */}
        {currentView === 'list' && (
          <section className={`${CARD} p-5 sm:p-8`}>

            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6">
              <div>
                <h2 className="text-xl sm:text-2xl font-semibold text-gray-800">Audiencias</h2>
                <p className="text-base text-gray-500 mt-1">
                  Revisa las audiencias anteriores o empieza una nueva.
                </p>
              </div>

              <button
                onClick={abrirFormulario}
                disabled={!canStartSessions}
                className={`${BTN_PRIMARY} w-full sm:w-auto`}
              >
                Nueva audiencia
              </button>
            </div>

            {/* Estado de la suscripción (solo clientes) */}
            {authUser.rol === 'cliente' && (
              <p
                role="status"
                className={`mb-6 rounded-lg border px-4 py-3 text-base ${authUser.suscripcion_activa
                    ? 'border-emerald-100 bg-emerald-50 text-emerald-800'
                    : 'border-red-100 bg-red-50 text-red-700'
                  }`}
              >
                {authUser.suscripcion_activa
                  ? `Tu suscripción está vigente hasta el ${formatDateOnly(authUser.vencimiento)}.`
                  : `Tu suscripción venció el ${formatDateOnly(authUser.vencimiento)}. Contacta al administrador para renovarla.`}
              </p>
            )}

            {/* Buscador */}
            <div className="mb-6">
              <SearchInput
                value={searchTerm}
                onChange={(value) => {
                  setSearchTerm(value);
                  setCurrentPage(1);
                }}
                placeholder="Buscar por nombre o descripción"
                label="Buscar audiencias"
              />
              <p className="text-sm text-gray-500 mt-2">{totalSessions} audiencia(s) encontrada(s)</p>
            </div>

            {/* Resultados */}
            <div className="space-y-3">
              {loadingSessions ? (
                <p className="py-12 text-center text-base text-gray-500">Cargando audiencias...</p>
              ) : sessionsList.length === 0 ? (
                <div className="border border-dashed border-gray-300 rounded-lg">
                  <EmptyState
                    title={searchTerm ? 'No hay audiencias con ese nombre' : 'Aún no hay audiencias'}
                    text={searchTerm ? 'Prueba con otro término de búsqueda.' : 'Cuando inicies una, aparecerá aquí.'}
                  />
                </div>
              ) : (
                sessionsList.map((s) => (
                  <article
                    key={s.id}
                    className="border border-gray-200 rounded-lg p-5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 hover:border-gray-300 transition-colors"
                  >
                    <div className="min-w-0">
                      <h3 className="text-lg font-semibold text-legalBlue break-words">{s.case_name}</h3>
                      <p className="text-base text-gray-600 mt-1 break-words">
                        {s.case_description || 'Sin descripción'}
                      </p>
                      <p className="text-sm text-gray-400 mt-2">
                        {formatDateTime(s.created_at)}
                        {authUser.rol === 'admin' && s.owner_name && ` · ${s.owner_name}`}
                      </p>
                    </div>

                    <button onClick={() => verDetalles(s.id)} className={`${BTN_OUTLINE} w-full sm:w-auto shrink-0`}>
                      Ver detalles
                    </button>
                  </article>
                ))
              )}
            </div>

            {!loadingSessions && totalSessions > 0 && (
              <Pagination page={currentPage} totalPages={totalPages} onChange={setCurrentPage} />
            )}
          </section>
        )}

        {/* ===================== VISTA 2: FORMULARIO ===================== */}
        {currentView === 'form' && (
          <section className={`${CARD} p-5 sm:p-8 max-w-2xl mx-auto`}>
            <h2 className="text-xl sm:text-2xl font-semibold text-gray-800 mb-6">Nueva audiencia</h2>

            <form onSubmit={iniciarAudiencia} className="space-y-6">
              <div>
                <label htmlFor="case_name" className="block text-base font-medium text-gray-700 mb-2">
                  Nombre de la audiencia
                </label>
                <input
                  id="case_name"
                  type="text"
                  required
                  value={formData.case_name}
                  onChange={(e) => setFormData({ ...formData, case_name: e.target.value })}
                  className={INPUT}
                  placeholder="Ej. Audiencia preparatoria, Rad. 1234"
                />
              </div>

              <div>
                <label htmlFor="case_description" className="block text-base font-medium text-gray-700 mb-2">
                  Descripción del caso <span className="text-gray-400 font-normal">(opcional)</span>
                </label>
                <textarea
                  id="case_description"
                  rows={4}
                  value={formData.case_description}
                  onChange={(e) => setFormData({ ...formData, case_description: e.target.value })}
                  className={INPUT}
                  placeholder="Partes, delito o asunto, y lo que quieras que el asistente tenga presente."
                />
              </div>

              <fieldset>
                <legend className="text-base font-medium text-gray-700 mb-3">Fuente de audio</legend>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {[
                    { value: 'mic', label: 'Micrófono' },
                    { value: 'system', label: 'Audio del equipo' }
                  ].map((option) => (
                    <label
                      key={option.value}
                      className={`flex items-center gap-3 rounded-lg border px-4 py-3 text-base cursor-pointer transition-colors ${formData.audioSource === option.value
                          ? 'border-legalBlue bg-blue-50 text-legalBlue'
                          : 'border-gray-300 hover:bg-gray-50'
                        }`}
                    >
                      <input
                        type="radio"
                        name="audioSource"
                        value={option.value}
                        checked={formData.audioSource === option.value}
                        onChange={(e) => setFormData({ ...formData, audioSource: e.target.value })}
                        className="accent-legalBlue w-4 h-4"
                      />
                      {option.label}
                    </label>
                  ))}
                </div>

                {formData.audioSource === 'system' && (
                  <p className="text-sm text-gray-500 mt-3 leading-relaxed">
                    El navegador te pedirá compartir pantalla. Elige la pestaña de la reunión y marca la
                    casilla «Compartir audio».
                  </p>
                )}
              </fieldset>

              <div className="flex flex-col-reverse sm:flex-row gap-3 pt-2">
                <button type="button" onClick={cancelarFormulario} className={`${BTN_OUTLINE} sm:w-auto`}>
                  Cancelar
                </button>
                <button type="submit" className={`${BTN_GREEN} sm:flex-1`}>
                  Iniciar audiencia
                </button>
              </div>
            </form>
          </section>
        )}

        {/* ===================== VISTA 3: SESIÓN EN VIVO ===================== */}
        {currentView === 'session' && (
          <div className="flex flex-col gap-6">

            <div className={`${CARD} p-5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4`}>
              <div className="min-w-0">
                <h2 className="text-xl font-semibold text-gray-800 break-words">{session?.case_name}</h2>
                {session?.case_description && (
                  <p className="text-base text-gray-500 mt-1 break-words">{session.case_description}</p>
                )}
              </div>

              <button onClick={detenerAudiencia} className={`${BTN_DANGER} w-full sm:w-auto shrink-0`}>
                Finalizar audiencia
              </button>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

              {/* Panel izquierdo: transcripción */}
              <section className={`${CARD} flex flex-col`}>
                <div className="px-5 py-4 border-b border-gray-200">
                  <h2 className="text-lg font-semibold text-gray-800">Transcripción</h2>
                </div>

                <div className="h-[50vh] lg:h-[65vh] overflow-y-auto p-5 space-y-4">
                  {transcription.length === 0 && !interimTranscript ? (
                    <EmptyState title="Esperando audio" text="Lo que se diga en la audiencia aparecerá aquí." />
                  ) : (
                    <>
                      {transcription.map((line, index) => (
                        <p key={index} className="text-lg leading-relaxed text-gray-700">{line}</p>
                      ))}
                      {interimTranscript && (
                        <p className="text-lg leading-relaxed text-gray-400 italic">{interimTranscript}</p>
                      )}
                      <div ref={transcriptEndRef} />
                    </>
                  )}
                </div>
              </section>

              {/* Panel derecho: preguntas sugeridas */}
              <section className="bg-white border border-emerald-200 rounded-lg flex flex-col">
                <div className="px-5 py-4 border-b border-emerald-100">
                  <h2 className="text-lg font-semibold text-emerald-800">Preguntas sugeridas</h2>

                  <p className="flex items-center gap-2 text-sm text-gray-500 mt-1" aria-live="polite">
                    <span className={`w-2 h-2 rounded-full shrink-0 ${STATUS_DOT[aiStatus.state] || STATUS_DOT.idle}`} />
                    {aiStatus.message}
                  </p>
                </div>

                <div className="h-[50vh] lg:h-[65vh] overflow-y-auto p-5 space-y-3">
                  {aiQuestions.length === 0 ? (
                    <EmptyState
                      title="Aún no hay preguntas"
                      text="Aparecerán aquí en cuanto la audiencia aporte contexto suficiente."
                    />
                  ) : (
                    aiQuestions.map((q) => <QuestionCard key={q.id} question={q} />)
                  )}
                </div>
              </section>
            </div>
          </div>
        )}

        {/* ===================== VISTA 4: DETALLE ===================== */}
        {currentView === 'detail' && (
          <section className={`${CARD} p-5 sm:p-8`}>

            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-8">
              <div>
                <h2 className="text-xl sm:text-2xl font-semibold text-gray-800">Detalle de la audiencia</h2>
                <p className="text-base text-gray-500 mt-1">Información, transcripción y preguntas sugeridas.</p>
              </div>

              <button onClick={() => setCurrentView('list')} className={`${BTN_OUTLINE} w-full sm:w-auto`}>
                Volver al historial
              </button>
            </div>

            {loadingDetails ? (
              <p className="py-16 text-center text-base text-gray-500">Cargando información...</p>
            ) : !selectedSession ? (
              <p className="py-16 text-center text-base text-gray-500">No se encontró la audiencia.</p>
            ) : (
              <div className="space-y-8">

                {/* Información general */}
                <div className="border border-gray-200 rounded-lg p-5 sm:p-6">
                  <h3 className="text-xl font-semibold text-legalBlue break-words">{selectedSession.case_name}</h3>

                  <p className="text-base text-gray-600 mt-3 leading-relaxed">
                    {selectedSession.case_description || 'Sin descripción registrada.'}
                  </p>

                  <dl className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mt-6 pt-5 border-t border-gray-200 text-base">
                    <div>
                      <dt className="text-sm text-gray-400">Código</dt>
                      <dd className="text-gray-700 mt-1">#{selectedSession.id}</dd>
                    </div>
                    <div>
                      <dt className="text-sm text-gray-400">Fecha</dt>
                      <dd className="text-gray-700 mt-1">{formatDateTime(selectedSession.created_at)}</dd>
                    </div>
                    <div>
                      <dt className="text-sm text-gray-400">Estado</dt>
                      <dd className="text-gray-700 mt-1">{selectedSession.status || 'Sin estado'}</dd>
                    </div>
                    {selectedSession.owner_name && (
                      <div>
                        <dt className="text-sm text-gray-400">Cliente</dt>
                        <dd className="text-gray-700 mt-1 break-words">{selectedSession.owner_name}</dd>
                      </div>
                    )}
                  </dl>
                </div>

                {/* Transcripción */}
                <div>
                  <h3 className="text-lg font-semibold text-gray-800 mb-4">Transcripción</h3>

                  <div className="border border-gray-200 rounded-lg max-h-[60vh] overflow-y-auto p-5 sm:p-6">
                    {sessionDetails.length === 0 ? (
                      <EmptyState title="Sin transcripciones" text="Esta audiencia no tiene intervenciones guardadas." />
                    ) : (
                      <div className="space-y-5">
                        {sessionDetails.map((item) => (
                          <div key={item.id}>
                            <p className="text-sm text-gray-400">{formatDateTime(item.created_at)}</p>
                            <p className="text-lg text-gray-700 leading-relaxed whitespace-pre-wrap break-words mt-1">
                              {item.transcript}
                            </p>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                {/* Preguntas sugeridas */}
                <div>
                  <h3 className="text-lg font-semibold text-emerald-800 mb-4">Preguntas sugeridas</h3>

                  {sessionAiQuestions.length === 0 ? (
                    <div className="border border-dashed border-gray-300 rounded-lg">
                      <EmptyState title="Sin preguntas" text="No se generaron preguntas en esta audiencia." />
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {sessionAiQuestions.map((q) => (
                        <QuestionCard key={q.id} question={q} />
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}
          </section>
        )}

        {/* ===================== VISTA 5: CLIENTES (SOLO ADMIN) ===================== */}
        {currentView === 'users' && authUser.rol === 'admin' && <UsersPanel apiFetch={apiFetch} />}
      </div>
    </div>
  );
}

export default App;