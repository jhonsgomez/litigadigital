// =================== Variables de entorno ===================
require('dotenv').config();

// =================== Librerías y dependencias ===================
const express = require('express');
const cors = require('cors');
const http = require('http');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');

// =================== Configuración de la base de datos ===================
const pool = require('./config/db'); // Conexión a PostgreSQL

// =================== Configuración de Deepgram ===================
const { DeepgramClient } = require('@deepgram/sdk');
const deepgram = new DeepgramClient({
    apiKey: process.env.DEEPGRAM_API_KEY
});

// =================== Configuración del LLM (Ollama) ===================
const ollama = require('./config/ollama');

const LLM_CONFIG = {
    model: process.env.OLLAMA_MODEL || 'qwen3.5:4b',
    timeoutMs: 60000,            // Tiempo máximo de espera por respuesta del modelo
    minNewChars: 150,            // Texto nuevo mínimo para volver a evaluar
    maxPromptChars: 2500,        // Máximo de texto "nuevo" enviado al modelo
    recentContextChars: 1000,    // Cola de contexto ya revisado, solo como referencia
    maxQuestionHistory: 15,      // Preguntas previas que se le recuerdan al modelo
    minQuestionWords: 4,
    maxQuestionWords: 40,
    maxQuestionChars: 300,
    similarityThreshold: 0.7,    // Similitud (Jaccard) a partir de la cual es duplicada
    noContextToken: 'SIN_CONTEXTO'
};

// =================== Configuración de autenticación ===================
const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET || JWT_SECRET.length < 16) {
    console.error('[BACKEND] Define JWT_SECRET en el .env (mínimo 16 caracteres) antes de iniciar.');
    process.exit(1);
}

const AUTH_CONFIG = {
    jwtExpiresIn: process.env.JWT_EXPIRES_IN || '8h',
    bcryptRounds: 12,
    timezone: process.env.APP_TIMEZONE || 'America/Bogota', // Zona para evaluar el vencimiento
    loginMaxAttempts: 8,                                    // Intentos fallidos permitidos...
    loginWindowMs: 15 * 60 * 1000                           // ...dentro de esta ventana de tiempo
};

// -- Administrador inicial: se inserta solo si aún no existe ninguno --
const DEFAULT_ADMIN = {
    nombre: process.env.ADMIN_NAME || 'Administrador',
    correo: (process.env.ADMIN_EMAIL || 'admin@asistente.com').toLowerCase(),
    password: process.env.ADMIN_PASSWORD || 'Admin123*'
};

// Hash falso para igualar tiempos de respuesta cuando el correo no existe.
const DUMMY_HASH = bcrypt.hashSync('contraseña-inexistente', AUTH_CONFIG.bcryptRounds);

// =================== Errores controlados ===================
/**
 * Error con un mensaje seguro de mostrar al cliente y su código HTTP.
 */
class AppError extends Error {
    constructor(message, status = 400) {
        super(message);
        this.status = status;
    }
}

/**
 * Responde un error: los controlados con su mensaje, el resto como error genérico.
 */
const handleError = (res, error, fallbackMessage) => {
    if (error instanceof AppError) {
        return res.status(error.status).json({ error: error.message });
    }

    // Violación de unicidad (correo repetido).
    if (error?.code === '23505') {
        return res.status(409).json({ error: 'Ya existe un usuario con ese correo.' });
    }

    console.error(`[BACKEND] ${fallbackMessage}:`, error);
    return res.status(500).json({ error: fallbackMessage });
};

// =================== Prompt del LLM ===================
// -- Instrucciones fijas: el modelo responde SOLO con la pregunta o con el token de "sin contexto" --
const SYSTEM_PROMPT = `Eres un asistente de apoyo para un abogado que participa en una audiencia judicial.
Recibes fragmentos de la transcripción automática de la audiencia. Pueden contener errores de reconocimiento y no indican quién habla.

Tu única tarea es proponer UNA pregunta que el abogado pueda formular a continuación.

Reglas:
1. Responde únicamente con la pregunta, en una sola línea, en español y entre signos de interrogación. No incluyas saludos, numeración, comillas, explicaciones ni formato.
2. Basa la pregunta solo en hechos, afirmaciones o contradicciones presentes en el texto NUEVO. El texto de CONTEXTO PREVIO es solo referencia. Nunca inventes nombres, fechas, lugares ni hechos.
3. La pregunta debe ser concreta y útil: aclarar, precisar, verificar o cuestionar lo dicho (tiempo, modo, lugar, fuente del conocimiento, coherencia). Prefiere preguntas abiertas.
4. No repitas ni reformules ninguna de las preguntas ya sugeridas.
5. Si el texto NUEVO solo tiene saludos, identificaciones, trámites, frases sueltas o información que no permita una pregunta útil, responde exactamente: ${LLM_CONFIG.noContextToken}
6. Máximo ${LLM_CONFIG.maxQuestionWords} palabras.`;

/**
 * Construye el mensaje de usuario con el contexto actual de la audiencia.
 * Se arma con un arreglo para que la indentación del código no ensucie el prompt.
 */
const buildUserPrompt = ({ caseName, caseDescription, recentContext, askedQuestions, newText }) => {
    const previous = askedQuestions.length
        ? askedQuestions.map((q) => `- ${q}`).join('\n')
        : '(ninguna)';

    return [
        `CASO: ${caseName || 'Sin título'}`,
        caseDescription ? `DESCRIPCIÓN: ${caseDescription}` : null,
        `CONTEXTO PREVIO: ${recentContext || '(ninguno)'}`,
        'PREGUNTAS YA SUGERIDAS:',
        previous,
        `TEXTO NUEVO: ${newText}`
    ].filter(Boolean).join('\n');
};

// -- Ejemplos de comportamiento esperado (few-shot) para mantener el formato estable --
const FEW_SHOT_MESSAGES = [
    {
        role: 'user',
        content: buildUserPrompt({
            caseName: 'Hurto en establecimiento comercial',
            recentContext: '',
            askedQuestions: [],
            newText: 'Buenos días, señoría. Me presento, soy el testigo, vivo en el barrio San José y fui citado para declarar en esta audiencia.'
        })
    },
    { role: 'assistant', content: LLM_CONFIG.noContextToken },
    {
        role: 'user',
        content: buildUserPrompt({
            caseName: 'Hurto en establecimiento comercial',
            recentContext: '',
            askedQuestions: [],
            newText: 'Yo vi cuando el señor salió corriendo de la tienda con una caja en la mano. Eso fue como a las nueve de la noche, yo estaba en la esquina esperando un bus y no alcancé a verle bien la cara.'
        })
    },
    {
        role: 'assistant',
        content: '¿Qué características físicas o de vestimenta pudo observar en la persona que salió corriendo, aunque no alcanzara a ver su rostro?'
    }
];

// =================== Utilidades del LLM ===================

/**
 * Normaliza un texto a un conjunto de palabras relevantes (sin tildes ni signos).
 */
const toWordSet = (text) =>
    new Set(
        text
            .toLowerCase()
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/[^a-z0-9\s]/g, ' ')
            .split(/\s+/)
            .filter((word) => word.length > 3)
    );

/**
 * Indica si una pregunta es casi idéntica a alguna ya sugerida.
 */
const isDuplicateQuestion = (question, history) => {
    const candidate = toWordSet(question);
    if (!candidate.size) return false;

    return history.some((previous) => {
        const other = toWordSet(previous);
        const intersection = [...candidate].filter((word) => other.has(word)).length;
        const union = new Set([...candidate, ...other]).size;
        return union > 0 && intersection / union >= LLM_CONFIG.similarityThreshold;
    });
};

/**
 * Limpia la salida del modelo y devuelve una pregunta válida o null.
 */
const cleanQuestion = (raw = '') => {
    let text = String(raw)
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/```/g, '')
        .trim();

    if (!text || text.toUpperCase().includes(LLM_CONFIG.noContextToken)) return null;

    // Primera línea que contenga una pregunta.
    const line = text.split('\n').map((l) => l.trim()).find((l) => l.includes('?'));
    if (!line) return null;

    text = line
        .replace(/^(\d+[.)]|[-*•])\s*/, '')
        .replace(/^pregunta\s*:\s*/i, '')
        .replace(/^["'“«]+/, '')
        .trim();

    // Quedarse únicamente con la pregunta: desde el primer "¿" hasta el primer "?".
    const start = text.indexOf('¿');
    if (start > 0) text = text.slice(start);

    const end = text.indexOf('?');
    text = text.slice(0, end + 1);

    if (!text.startsWith('¿')) text = `¿${text}`;

    const words = text.split(/\s+/).length;
    if (
        words < LLM_CONFIG.minQuestionWords ||
        words > LLM_CONFIG.maxQuestionWords ||
        text.length > LLM_CONFIG.maxQuestionChars
    ) {
        return null;
    }

    return text;
};

/**
 * Llama a Ollama con un tiempo límite y devuelve el texto generado.
 */
const requestFromLLM = async (messages) => {
    let timer;

    const call = ollama.chat({
        model: LLM_CONFIG.model,
        messages,
        stream: false,
        think: false,       // Sin "razonamiento": respuesta directa y mucho más rápida
        keep_alive: '30m',  // Mantiene el modelo cargado en memoria
        options: {
            temperature: 0.3,
            top_p: 0.9,
            repeat_penalty: 1.1,
            num_ctx: 4096,
            num_predict: 120
        }
    });

    // Evita un "unhandled rejection" si el timeout gana la carrera.
    call.catch(() => { });

    const timeout = new Promise((_, reject) => {
        timer = setTimeout(
            () => reject(new Error('Tiempo de espera agotado en Ollama')),
            LLM_CONFIG.timeoutMs
        );
    });

    try {
        const result = await Promise.race([call, timeout]);
        return result?.message?.content || '';
    } finally {
        clearTimeout(timer);
    }
};

// =================== Motor de preguntas en vivo ===================
/**
 * Un motor por conexión. Recibe la transcripción final fragmento a fragmento,
 * acumula contexto y, cada vez que hay texto nuevo suficiente, le pide al LLM
 * UNA pregunta. Si el modelo considera que aún falta contexto, el texto sigue
 * acumulándose para la siguiente evaluación.
 *
 * @param {object}   options
 * @param {string}   options.caseName        Nombre del caso.
 * @param {string}   options.caseDescription Descripción del caso.
 * @param {Function} options.onStatus        Callback ({ state, message }).
 * @param {Function} options.onQuestion      Callback async (question) que persiste y emite.
 */
const createQuestionEngine = ({ caseName, caseDescription, onStatus, onQuestion }) => {
    let pendingSegments = [];   // Texto aún no "consumido" por una pregunta
    let recentContext = '';     // Cola de lo ya consumido, solo como referencia
    let charsSinceEvaluation = 0;
    let isProcessing = false;
    let isActive = true;

    const askedQuestions = [];

    const evaluate = async () => {
        if (!isActive || isProcessing) return;
        if (charsSinceEvaluation < LLM_CONFIG.minNewChars) return;

        isProcessing = true;
        charsSinceEvaluation = 0;

        // Instantánea: el texto que llegue durante el análisis no se pierde.
        const snapshotCount = pendingSegments.length;
        const newText = pendingSegments.join(' ').slice(-LLM_CONFIG.maxPromptChars);

        onStatus({ state: 'thinking', message: 'Analizando lo último que se dijo...' });

        try {
            const raw = await requestFromLLM([
                { role: 'system', content: SYSTEM_PROMPT },
                ...FEW_SHOT_MESSAGES,
                {
                    role: 'user',
                    content: buildUserPrompt({
                        caseName,
                        caseDescription,
                        recentContext,
                        askedQuestions: askedQuestions.slice(-LLM_CONFIG.maxQuestionHistory),
                        newText
                    })
                }
            ]);

            const question = cleanQuestion(raw);

            if (!isActive) return;

            if (!question || isDuplicateQuestion(question, askedQuestions)) {
                console.log('[IA] Sin pregunta útil. Respuesta cruda:', JSON.stringify(raw));
                onStatus({ state: 'listening', message: 'Escuchando. Aún falta contexto para la siguiente pregunta.' });
                return;
            }

            await onQuestion(question);

            askedQuestions.push(question);
            recentContext = `${recentContext} ${newText}`.trim().slice(-LLM_CONFIG.recentContextChars);
            pendingSegments = pendingSegments.slice(snapshotCount);

            console.log(`[IA] Pregunta generada: ${question}`);
            onStatus({ state: 'listening', message: 'Escuchando la audiencia...' });

        } catch (error) {
            console.error('[IA] Error generando pregunta:', error.message || error);
            onStatus({
                state: 'error',
                message: 'El modelo local no respondió. Verifica que Ollama esté en ejecución.'
            });
        } finally {
            isProcessing = false;

            // Si mientras se analizaba llegó suficiente texto nuevo, evaluar de nuevo.
            if (isActive && charsSinceEvaluation >= LLM_CONFIG.minNewChars) {
                void evaluate();
            }
        }
    };

    return {
        /** Agrega una intervención final de la transcripción. */
        addTranscript(text) {
            if (!isActive) return;

            const clean = String(text || '').trim();
            if (!clean) return;

            pendingSegments.push(clean);
            charsSinceEvaluation += clean.length;

            // Evita que el buffer crezca sin límite si el modelo no encuentra contexto.
            if (!isProcessing) {
                while (
                    pendingSegments.length > 1 &&
                    pendingSegments.join(' ').length > LLM_CONFIG.maxPromptChars * 2
                ) {
                    pendingSegments.shift();
                }
            }

            void evaluate();
        },

        /** Detiene el motor (fin de sesión o desconexión). */
        stop() {
            isActive = false;
        }
    };
};

// =================== Usuarios: utilidades ===================

// -- Columnas públicas. El vencimiento se devuelve como texto YYYY-MM-DD para evitar desfases de zona horaria --
const USER_COLUMNS = `id, nombre, correo, rol, to_char(vencimiento, 'YYYY-MM-DD') AS vencimiento, activo, created_at`;

/**
 * Fecha de hoy (YYYY-MM-DD) en la zona horaria configurada.
 */
const getToday = () =>
    new Intl.DateTimeFormat('en-CA', {
        timeZone: AUTH_CONFIG.timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).format(new Date());

/**
 * Un administrador nunca depende de suscripción. Un cliente la tiene vigente
 * hasta el final del día de su vencimiento.
 */
const hasActiveSubscription = (user) => {
    if (user.rol === 'admin') return true;
    return Boolean(user.vencimiento) && user.vencimiento >= getToday();
};

/**
 * Convierte una fila de la BD en el objeto que se expone al frontend (nunca incluye el hash).
 */
const toPublicUser = (row) => ({
    id: row.id,
    nombre: row.nombre,
    correo: row.correo,
    rol: row.rol,
    vencimiento: row.vencimiento,
    activo: row.activo,
    created_at: row.created_at,
    suscripcion_activa: hasActiveSubscription(row)
});

const findUserById = async (id) => {
    const result = await pool.query(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [id]);
    return result.rows[0] || null;
};

const findUserByEmail = async (correo) => {
    const result = await pool.query(
        `SELECT ${USER_COLUMNS}, password_hash FROM users WHERE LOWER(correo) = $1`,
        [correo]
    );
    return result.rows[0] || null;
};

/**
 * Genera una contraseña aleatoria y segura (12 caracteres con mayúscula,
 * minúscula, número y símbolo) usando el generador criptográfico del sistema.
 */
const generatePassword = (length = 12) => {
    const sets = [
        'ABCDEFGHJKLMNPQRSTUVWXYZ',
        'abcdefghijkmnopqrstuvwxyz',
        '23456789',
        '!@#$%*?'
    ];
    const all = sets.join('');

    // Garantiza al menos un carácter de cada grupo.
    const chars = sets.map((set) => set[crypto.randomInt(set.length)]);

    while (chars.length < length) {
        chars.push(all[crypto.randomInt(all.length)]);
    }

    // Mezcla Fisher-Yates para no dejar un patrón predecible.
    for (let i = chars.length - 1; i > 0; i--) {
        const j = crypto.randomInt(i + 1);
        [chars[i], chars[j]] = [chars[j], chars[i]];
    }

    return chars.join('');
};

/**
 * Valida y normaliza los datos de un cliente (crear / editar).
 */
const validateUserPayload = (body = {}) => {
    const nombre = String(body.nombre || '').trim();
    const correo = String(body.correo || '').trim().toLowerCase();
    const vencimiento = String(body.vencimiento || '').trim();
    const activo = typeof body.activo === 'boolean' ? body.activo : true;

    if (nombre.length < 2 || nombre.length > 120) {
        throw new AppError('El nombre debe tener entre 2 y 120 caracteres.');
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo) || correo.length > 160) {
        throw new AppError('Ingresa un correo válido.');
    }

    // Formato YYYY-MM-DD y fecha real (descarta, por ejemplo, 2026-02-31).
    const parsed = new Date(`${vencimiento}T00:00:00Z`);
    if (
        !/^\d{4}-\d{2}-\d{2}$/.test(vencimiento) ||
        Number.isNaN(parsed.getTime()) ||
        parsed.toISOString().slice(0, 10) !== vencimiento
    ) {
        throw new AppError('Ingresa una fecha de vencimiento válida.');
    }

    return { nombre, correo, vencimiento, activo };
};

const parseId = (value) => {
    const id = Number.parseInt(value, 10);
    if (!Number.isInteger(id) || id <= 0) throw new AppError('Identificador no válido.');
    return id;
};

// =================== Autenticación: utilidades y middlewares ===================

const signToken = (user) =>
    jwt.sign({ sub: String(user.id), rol: user.rol }, JWT_SECRET, {
        algorithm: 'HS256',
        expiresIn: AUTH_CONFIG.jwtExpiresIn
    });

/**
 * Valida un token y devuelve el usuario ACTUAL de la BD (así, desactivar a un
 * cliente surte efecto de inmediato). Devuelve null si el token no es válido.
 */
const getUserFromToken = async (token) => {
    if (!token) return null;

    let payload;
    try {
        payload = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
    } catch {
        return null;
    }

    const user = await findUserById(payload.sub);
    return user && user.activo ? user : null;
};

/** Exige un token válido y deja el usuario en req.user. */
const authenticate = async (req, res, next) => {
    try {
        const header = req.headers.authorization || '';
        const token = header.startsWith('Bearer ') ? header.slice(7) : null;

        const user = await getUserFromToken(token);
        if (!user) {
            return res.status(401).json({ error: 'Tu sesión no es válida. Inicia sesión de nuevo.' });
        }

        req.user = user;
        next();
    } catch (error) {
        handleError(res, error, 'Error validando la sesión');
    }
};

/** Solo administradores. */
const requireAdmin = (req, res, next) => {
    if (req.user?.rol !== 'admin') {
        return res.status(403).json({ error: 'No tienes permisos para esta acción.' });
    }
    next();
};

/** Solo clientes con suscripción vigente (los administradores siempre pasan). */
const requireActiveSubscription = (req, res, next) => {
    if (!hasActiveSubscription(req.user)) {
        return res.status(403).json({
            error: 'Tu suscripción no está vigente. Contacta al administrador para renovarla.'
        });
    }
    next();
};

// -- Límite de intentos de login (en memoria; suficiente para un login básico) --
const loginAttempts = new Map();

const isLoginBlocked = (key) => {
    const entry = loginAttempts.get(key);
    if (!entry) return false;

    if (Date.now() > entry.resetAt) {
        loginAttempts.delete(key);
        return false;
    }

    return entry.count >= AUTH_CONFIG.loginMaxAttempts;
};

const registerFailedLogin = (key) => {
    const entry = loginAttempts.get(key);

    if (!entry || Date.now() > entry.resetAt) {
        loginAttempts.set(key, { count: 1, resetAt: Date.now() + AUTH_CONFIG.loginWindowMs });
    } else {
        entry.count += 1;
    }
};

// Limpieza periódica para que el mapa no crezca indefinidamente.
setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of loginAttempts) {
        if (now > entry.resetAt) loginAttempts.delete(key);
    }
}, 10 * 60 * 1000).unref();

// =================== Base de datos: esquema y administrador inicial ===================
const initializeDatabase = async () => {
    // -- Tabla de usuarios --
    await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
            id            SERIAL PRIMARY KEY,
            nombre        VARCHAR(120) NOT NULL,
            correo        VARCHAR(160) NOT NULL,
            password_hash TEXT         NOT NULL,
            rol           VARCHAR(10)  NOT NULL DEFAULT 'cliente' CHECK (rol IN ('admin', 'cliente')),
            vencimiento   DATE,
            activo        BOOLEAN      NOT NULL DEFAULT TRUE,
            created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
        )
    `);

    // -- El correo es único sin importar mayúsculas --
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS users_correo_unique ON users (LOWER(correo))`);

    // -- Cada audiencia pertenece al usuario que la creó --
    await pool.query(`
        ALTER TABLE sessions
        ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE SET NULL
    `);

    // -- Administrador inicial --
    const existingAdmin = await pool.query(`SELECT 1 FROM users WHERE rol = 'admin' LIMIT 1`);

    if (existingAdmin.rows.length === 0) {
        const hash = await bcrypt.hash(DEFAULT_ADMIN.password, AUTH_CONFIG.bcryptRounds);

        await pool.query(
            `INSERT INTO users (nombre, correo, password_hash, rol, activo)
             VALUES ($1, $2, $3, 'admin', TRUE)`,
            [DEFAULT_ADMIN.nombre, DEFAULT_ADMIN.correo, hash]
        );

        console.log(`[BACKEND] Administrador inicial creado: ${DEFAULT_ADMIN.correo}`);

        if (!process.env.ADMIN_PASSWORD) {
            console.warn('[BACKEND] Usa ADMIN_PASSWORD en el .env y cambia la contraseña por defecto.');
        }
    }
};

// =================== Inicialización de Express ===================
const app = express();
app.disable('x-powered-by');

// =================== 1. MIDDLEWARES HTTP ===================
app.use(cors({ origin: process.env.CLIENT_ORIGIN || '*' }));
app.use(express.json({ limit: '100kb' }));

// =================== 2. RUTAS PÚBLICAS: AUTENTICACIÓN ===================
// -- 2.1 Iniciar sesión --
app.post('/api/auth/login', async (req, res) => {
    try {
        const correo = String(req.body?.correo || '').trim().toLowerCase();
        const password = String(req.body?.password || '');

        if (!correo || !password) {
            throw new AppError('Ingresa tu correo y tu contraseña.');
        }

        const attemptKey = `${req.ip}|${correo}`;

        if (isLoginBlocked(attemptKey)) {
            throw new AppError('Demasiados intentos. Espera unos minutos e inténtalo de nuevo.', 429);
        }

        const user = await findUserByEmail(correo);

        // Siempre se compara contra un hash para que el tiempo no revele si el correo existe.
        const passwordMatches = await bcrypt.compare(password, user?.password_hash || DUMMY_HASH);

        if (!user || !passwordMatches) {
            registerFailedLogin(attemptKey);
            throw new AppError('Correo o contraseña incorrectos.', 401);
        }

        if (!user.activo) {
            throw new AppError('Tu cuenta está desactivada. Contacta al administrador.', 403);
        }

        loginAttempts.delete(attemptKey);

        res.status(200).json({
            token: signToken(user),
            user: toPublicUser(user)
        });

    } catch (error) {
        handleError(res, error, 'Error iniciando sesión');
    }
});

// -- 2.2 Datos del usuario autenticado (para restaurar la sesión al recargar) --
app.get('/api/auth/me', authenticate, (req, res) => {
    res.status(200).json({ user: toPublicUser(req.user) });
});

// =================== 3. RUTAS PROTEGIDAS: USUARIOS (SOLO ADMIN) ===================
// -- 3.1 Listar clientes con búsqueda y paginación --
app.get('/api/users', authenticate, requireAdmin, async (req, res) => {
    try {
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 10));
        const search = String(req.query.search || '').trim();
        const offset = (page - 1) * limit;
        const searchTerm = `%${search}%`;

        const countResult = await pool.query(
            `SELECT COUNT(*) AS total
             FROM users
             WHERE rol = 'cliente' AND (nombre ILIKE $1 OR correo ILIKE $1)`,
            [searchTerm]
        );

        const result = await pool.query(
            `SELECT ${USER_COLUMNS}
             FROM users
             WHERE rol = 'cliente' AND (nombre ILIKE $1 OR correo ILIKE $1)
             ORDER BY created_at DESC, id DESC
             LIMIT $2 OFFSET $3`,
            [searchTerm, limit, offset]
        );

        const total = parseInt(countResult.rows[0].total, 10);

        res.status(200).json({
            data: result.rows.map(toPublicUser),
            pagination: { page, limit, total, totalPages: Math.ceil(total / limit) }
        });

    } catch (error) {
        handleError(res, error, 'Error obteniendo los clientes');
    }
});

// -- 3.2 Crear un cliente (la contraseña se genera automáticamente) --
app.post('/api/users', authenticate, requireAdmin, async (req, res) => {
    try {
        const { nombre, correo, vencimiento, activo } = validateUserPayload(req.body);

        const temporaryPassword = generatePassword();
        const hash = await bcrypt.hash(temporaryPassword, AUTH_CONFIG.bcryptRounds);

        const result = await pool.query(
            `INSERT INTO users (nombre, correo, password_hash, rol, vencimiento, activo)
             VALUES ($1, $2, $3, 'cliente', $4, $5)
             RETURNING ${USER_COLUMNS}`,
            [nombre, correo, hash, vencimiento, activo]
        );

        // La contraseña en texto plano solo se devuelve en esta respuesta.
        res.status(201).json({
            user: toPublicUser(result.rows[0]),
            temporaryPassword
        });

    } catch (error) {
        handleError(res, error, 'Error creando el cliente');
    }
});

// -- 3.3 Editar un cliente --
app.put('/api/users/:id', authenticate, requireAdmin, async (req, res) => {
    try {
        const id = parseId(req.params.id);
        const { nombre, correo, vencimiento, activo } = validateUserPayload(req.body);

        const result = await pool.query(
            `UPDATE users
             SET nombre = $1, correo = $2, vencimiento = $3, activo = $4
             WHERE id = $5 AND rol = 'cliente'
             RETURNING ${USER_COLUMNS}`,
            [nombre, correo, vencimiento, activo, id]
        );

        if (result.rows.length === 0) throw new AppError('El cliente no existe.', 404);

        res.status(200).json({ user: toPublicUser(result.rows[0]) });

    } catch (error) {
        handleError(res, error, 'Error actualizando el cliente');
    }
});

// -- 3.4 Activar o desactivar un cliente --
app.patch('/api/users/:id/status', authenticate, requireAdmin, async (req, res) => {
    try {
        const id = parseId(req.params.id);

        if (typeof req.body?.activo !== 'boolean') {
            throw new AppError('Indica si el cliente debe quedar activo o inactivo.');
        }

        const result = await pool.query(
            `UPDATE users SET activo = $1
             WHERE id = $2 AND rol = 'cliente'
             RETURNING ${USER_COLUMNS}`,
            [req.body.activo, id]
        );

        if (result.rows.length === 0) throw new AppError('El cliente no existe.', 404);

        res.status(200).json({ user: toPublicUser(result.rows[0]) });

    } catch (error) {
        handleError(res, error, 'Error cambiando el estado del cliente');
    }
});

// -- 3.5 Generar una nueva contraseña para un cliente --
app.post('/api/users/:id/reset-password', authenticate, requireAdmin, async (req, res) => {
    try {
        const id = parseId(req.params.id);

        const temporaryPassword = generatePassword();
        const hash = await bcrypt.hash(temporaryPassword, AUTH_CONFIG.bcryptRounds);

        const result = await pool.query(
            `UPDATE users SET password_hash = $1
             WHERE id = $2 AND rol = 'cliente'
             RETURNING ${USER_COLUMNS}`,
            [hash, id]
        );

        if (result.rows.length === 0) throw new AppError('El cliente no existe.', 404);

        res.status(200).json({
            user: toPublicUser(result.rows[0]),
            temporaryPassword
        });

    } catch (error) {
        handleError(res, error, 'Error generando la nueva contraseña');
    }
});

// =================== 4. RUTAS PROTEGIDAS: AUDIENCIAS ===================
// -- 4.1 Listar audiencias (el cliente ve las suyas; el admin ve todas) --
app.get('/api/sessions', authenticate, async (req, res) => {
    try {
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 10));
        const search = String(req.query.search || '').trim();
        const offset = (page - 1) * limit;

        const params = [`%${search}%`];
        let ownerClause = '';

        if (req.user.rol !== 'admin') {
            params.push(req.user.id);
            ownerClause = `AND s.user_id = $${params.length}`;
        }

        const filters = `
            (s.case_name ILIKE $1 OR COALESCE(s.case_description, '') ILIKE $1)
            ${ownerClause}`;

        const countResult = await pool.query(
            `SELECT COUNT(*) AS total FROM sessions s WHERE ${filters}`,
            params
        );

        const result = await pool.query(
            `SELECT s.id, s.case_name, s.case_description, s.status, s.created_at,
                    u.nombre AS owner_name
             FROM sessions s
             LEFT JOIN users u ON u.id = s.user_id
             WHERE ${filters}
             ORDER BY s.created_at DESC
             LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
            [...params, limit, offset]
        );

        const total = parseInt(countResult.rows[0].total, 10);

        res.status(200).json({
            data: result.rows,
            pagination: { page, limit, total, totalPages: Math.ceil(total / limit) }
        });

    } catch (error) {
        handleError(res, error, 'Error obteniendo el historial');
    }
});

// -- 4.2 Crear una audiencia (requiere suscripción vigente) --
app.post('/api/sessions', authenticate, requireActiveSubscription, async (req, res) => {
    try {
        const { case_name, case_description } = req.body;

        const result = await pool.query(
            `INSERT INTO sessions (case_name, case_description, user_id)
             VALUES ($1, $2, $3)
             RETURNING id, case_name, case_description, status, created_at`,
            [
                String(case_name || '').trim().slice(0, 200) || 'Audiencia sin título',
                String(case_description || '').trim().slice(0, 2000),
                req.user.id
            ]
        );

        res.status(201).json({
            message: 'Sesión creada exitosamente',
            session: result.rows[0]
        });

    } catch (error) {
        handleError(res, error, 'Error interno al crear la sesión');
    }
});

// -- 4.3 Detalle de una audiencia --
app.get('/api/sessions/:id', authenticate, async (req, res) => {
    try {
        const { id } = req.params;

        const sessionResult = await pool.query(
            `SELECT s.id, s.case_name, s.case_description, s.status, s.created_at, s.user_id,
                    u.nombre AS owner_name
             FROM sessions s
             LEFT JOIN users u ON u.id = s.user_id
             WHERE s.id = $1`,
            [id]
        );

        const session = sessionResult.rows[0];

        // Para un cliente ajeno se responde "no existe" y no "prohibido", para no revelar datos.
        if (!session || (req.user.rol !== 'admin' && session.user_id !== req.user.id)) {
            throw new AppError('La audiencia solicitada no existe.', 404);
        }

        const transcriptionResult = await pool.query(
            `SELECT id, transcript, created_at
             FROM transcriptions
             WHERE session_id = $1
             ORDER BY created_at ASC, id ASC`,
            [id]
        );

        const questionsResult = await pool.query(
            `SELECT id, question, created_at
             FROM ai_questions
             WHERE session_id = $1
             ORDER BY created_at ASC, id ASC`,
            [id]
        );

        res.status(200).json({
            session,
            transcriptions: transcriptionResult.rows,
            ai_questions: questionsResult.rows,
            statistics: {
                total_transcriptions: transcriptionResult.rows.length,
                total_questions: questionsResult.rows.length
            }
        });

    } catch (error) {
        handleError(res, error, 'Error consultando los detalles de la audiencia.');
    }
});

// -- 4.4 Verificar que Ollama y el modelo respondan (solo admin) --
app.get('/api/llm/health', authenticate, requireAdmin, async (req, res) => {
    const start = Date.now();

    try {
        const response = await requestFromLLM([
            { role: 'user', content: 'Responde únicamente con la palabra: ok' }
        ]);

        res.json({
            success: true,
            model: LLM_CONFIG.model,
            duration_ms: Date.now() - start,
            response: response.trim()
        });

    } catch (error) {
        console.error('[BACKEND] Ollama no disponible:', error.message);
        res.status(500).json({ success: false, model: LLM_CONFIG.model, error: error.message });
    }
});

// =================== 5. SERVIDOR HTTP Y WEBSOCKETS ===================
const server = http.createServer(app);

const io = new Server(server, {
    cors: {
        origin: process.env.CLIENT_ORIGIN || '*',
        methods: ['GET', 'POST']
    }
});

// -- Solo se aceptan conexiones con un token válido --
io.use(async (socket, next) => {
    try {
        const user = await getUserFromToken(socket.handshake.auth?.token);

        if (!user) return next(new Error('Tu sesión no es válida. Inicia sesión de nuevo.'));

        socket.data.userId = user.id;
        next();
    } catch (error) {
        console.error('[BACKEND] Error validando el socket:', error);
        next(new Error('No fue posible validar tu sesión.'));
    }
});

// =================== 6. LÓGICA DE EVENTOS DEL SOCKET ===================
io.on('connection', (socket) => {
    console.log(`[BACKEND] Socket conectado (ID: ${socket.id}, usuario: ${socket.data.userId})`);

    // -- Estado propio de cada conexión --
    let deepgramLive = null;
    let currentSessionId = null;
    let isConnecting = false;
    let isStopping = false;
    let questionEngine = null;
    let transcriptionQueue = Promise.resolve();

    /**
     * Guarda una transcripción en orden, sin bloquear la recepción de nuevas.
     */
    const saveTranscription = (text) => {
        const sessionId = currentSessionId;

        transcriptionQueue = transcriptionQueue
            .then(() =>
                pool.query(
                    'INSERT INTO transcriptions (session_id, transcript) VALUES ($1, $2)',
                    [sessionId, text]
                )
            )
            .catch((error) => {
                console.error('[BACKEND] Error guardando transcripción:', error);
            });

        return transcriptionQueue;
    };

    /**
     * Guarda una pregunta generada y la envía a todos los clientes de la sesión.
     */
    const saveAndEmitQuestion = async (question) => {
        const result = await pool.query(
            `INSERT INTO ai_questions (session_id, question)
             VALUES ($1, $2)
             RETURNING id, question, created_at`,
            [currentSessionId, question]
        );

        io.to(currentSessionId).emit('new_question', result.rows[0]);
    };

    /**
     * Detiene el motor de preguntas.
     */
    const releaseResources = () => {
        if (questionEngine) {
            questionEngine.stop();
            questionEngine = null;
        }
    };

    // -- Iniciar sesión: valida permisos, abre Deepgram y prepara el motor de preguntas --
    socket.on('join_session', async (sessionId) => {
        if (isConnecting || deepgramLive) return;

        isConnecting = true;

        try {
            // 1. Revalidar usuario y suscripción con datos frescos de la BD.
            const user = await findUserById(socket.data.userId);

            if (!user || !user.activo) {
                throw new AppError('Tu cuenta está desactivada.', 403);
            }

            if (!hasActiveSubscription(user)) {
                throw new AppError('Tu suscripción no está vigente. Contacta al administrador.', 403);
            }

            // 2. Verificar que la audiencia exista y pertenezca al usuario.
            const caseResult = await pool.query(
                'SELECT case_name, case_description, user_id FROM sessions WHERE id = $1',
                [sessionId]
            );
            const caseInfo = caseResult.rows[0];

            if (!caseInfo || (user.rol !== 'admin' && caseInfo.user_id !== user.id)) {
                throw new AppError('La audiencia no existe.', 404);
            }

            currentSessionId = String(sessionId);
            socket.join(currentSessionId);
            console.log(`[BACKEND] Transmitiendo audio para la sesión: ${currentSessionId}`);

            // 3. Motor de preguntas con el contexto del caso.
            questionEngine = createQuestionEngine({
                caseName: caseInfo.case_name,
                caseDescription: caseInfo.case_description,
                onStatus: (status) => socket.emit('ai_status', status),
                onQuestion: saveAndEmitQuestion
            });

            // 4. Deepgram SDK v5 - Flux
            deepgramLive = await deepgram.listen.v2.connect({
                model: 'flux-general-multi',
                language_hint: 'es'
            });

            deepgramLive.on('open', () => {
                console.log('[BACKEND] Conexión abierta con Deepgram');
            });

            // -- Recibir transcripciones --
            deepgramLive.on('message', (data) => {
                // Deepgram confirmó que está listo para recibir audio.
                if (data.type === 'Connected') {
                    console.log('[BACKEND] Deepgram listo para recibir audio.');
                    socket.emit('session_ready', { message: 'Motor de transcripción listo' });
                    socket.emit('ai_status', { state: 'listening', message: 'Escuchando la audiencia...' });
                    return;
                }

                if (data.type !== 'TurnInfo') return;

                const transcript = (data.transcript || '').trim();
                if (!transcript) return;

                const isFinal = data.event === 'EndOfTurn';

                // Enviar la transcripción (parcial o final) a React.
                io.to(currentSessionId).emit('new_transcription', {
                    text: transcript,
                    isFinal
                });

                // Solo las intervenciones definitivas se guardan y alimentan al LLM.
                if (isFinal) {
                    saveTranscription(transcript);
                    questionEngine?.addTranscript(transcript);
                }
            });

            deepgramLive.on('error', (error) => {
                console.error('[BACKEND] Error en Deepgram:', error);
                socket.emit('session_error', { message: 'Error en Deepgram' });
            });

            deepgramLive.on('close', async () => {
                await transcriptionQueue;
                console.log('[BACKEND] Deepgram desconectado correctamente');

                releaseResources();
                socket.emit('session_stopped');

                deepgramLive = null;
                isConnecting = false;
                isStopping = false;
            });

            deepgramLive.connect();
            await deepgramLive.waitForOpen();

            console.log(`[IA] Motor de preguntas activo. Modelo: ${LLM_CONFIG.model}`);

        } catch (error) {
            console.error('[BACKEND] Error iniciando la sesión:', error.message || error);

            isConnecting = false;
            releaseResources();

            if (deepgramLive) {
                deepgramLive.close();
                deepgramLive = null;
            }

            socket.emit('session_error', {
                message: error instanceof AppError
                    ? error.message
                    : 'No se pudo conectar con Deepgram'
            });
        }
    });

    // -- Recibir audio desde React --
    socket.on('audio_chunk', ({ sessionId, data } = {}) => {
        try {
            if (!deepgramLive || deepgramLive.readyState !== 1) return;
            if (String(sessionId) !== currentSessionId) return;

            let audioBuffer;

            if (Buffer.isBuffer(data)) {
                audioBuffer = data;
            } else if (data instanceof ArrayBuffer) {
                audioBuffer = Buffer.from(data);
            } else if (ArrayBuffer.isView(data)) {
                audioBuffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
            } else {
                console.warn('[AUDIO] Formato de fragmento no reconocido');
                return;
            }

            if (!audioBuffer.length) return;

            deepgramLive.sendMedia(audioBuffer);

        } catch (error) {
            console.error('[BACKEND] Error enviando audio:', error);
        }
    });

    // -- Finalizar transmisión --
    socket.on('stop_session', () => {
        if (!deepgramLive || isStopping) return;

        try {
            isStopping = true;
            console.log(`[BACKEND] Finalizando sesión ${currentSessionId}`);

            // Se pide el cierre a Deepgram; el motor se detiene cuando llegue el evento "close".
            deepgramLive.sendCloseStream({ type: 'CloseStream' });

        } catch (error) {
            console.error('[BACKEND] Error finalizando Deepgram:', error);

            releaseResources();
            deepgramLive.close();
            deepgramLive = null;
            isStopping = false;
        }
    });

    // -- Desconexión del cliente --
    socket.on('disconnect', () => {
        console.log(`[BACKEND] Socket desconectado: ${socket.id}`);

        releaseResources();

        if (deepgramLive) {
            try {
                deepgramLive.sendCloseStream({ type: 'CloseStream' });
                deepgramLive.close();
            } catch (error) {
                console.error('[BACKEND] Error al cerrar Deepgram:', error);
            }

            deepgramLive = null;
        }
    });
});

// =================== 7. ARRANQUE DEL SERVIDOR ===================
const PORT = process.env.PORT || 3000;

const startServer = async () => {
    try {
        await initializeDatabase();

        server.listen(PORT, () => {
            console.log(`[BACKEND] Servidor corriendo en http://localhost:${PORT}`);
        });
    } catch (error) {
        console.error('[BACKEND] No se pudo preparar la base de datos:', error);
        process.exit(1);
    }
};

startServer();