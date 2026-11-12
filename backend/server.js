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

// OPTIMIZACIÓN: Ajustes drásticos de contexto y memoria para equipos de bajos recursos.
// Menos tokens enviados = menor uso de CPU y mayor velocidad de inferencia.
const LLM_CONFIG = {
    model: process.env.OLLAMA_MODEL || 'qwen3:0.6b',
    fastModel: process.env.OLLAMA_FAST_MODEL || process.env.OLLAMA_MODEL || 'qwen3:0.6b',
    timeoutMs: 60000,            // Aumentado: da más margen en caso de peticiones encoladas
    keepAlive: '15m',            // Reducido: libera la RAM (8GB max) más rápido si no hay audiencias
    numCtx: 1024,                // Reducido (antes 2048): acelera muchísimo el procesamiento del prompt en CPU
    similarityThreshold: 0.7,
    noContextToken: 'SIN_CONTEXTO',
    nothingToken: 'NADA',

    // -- Carril de preguntas --
    questions: {
        minNewChars: 70,
        maxNewChars: 1200,       // Reducido (antes 1800): envía menos texto nuevo a la vez
        recentContextChars: 800, // Reducido (antes 1500): menos historial para procesar
        maxHistory: 4,           // Reducido (antes 15): alivia fuertemente la carga cognitiva del modelo
        numPredict: 200,         // Ajustado
        temperature: 0.3,
        minWords: 4,
        maxWords: 40,
        maxChars: 300
    },

    // -- Carril de objeciones (el más sensible al tiempo) --
    objections: {
        minChars: 20,
        earlyMinChars: 25,
        recentContextChars: 400, // Reducido (antes 700)
        maxTextChars: 400,       // Reducido (antes 700)
        maxPerTurn: 2,
        numPredict: 100,
        temperature: 0.1
    },

    // -- Carril de contradicciones y datos clave --
    insights: {
        minNewChars: 90,
        maxNewChars: 1000,       // Reducido (antes 1500)
        historyChars: 1200,      // Reducido (antes 2500): crítico para evitar cuellos de botella en CPU
        maxReported: 4,          // Reducido (antes 10)
        maxPerTurn: 2,
        numPredict: 120,
        temperature: 0.2
    }
};

// =================== Configuración de autenticación ===================
const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET || JWT_SECRET.length < 16) {
    console.error('[BACKEND] Define JWT_SECRET en el .env (mínimo 16 caracteres) antes de iniciar.');
    process.exit(1);
}

const AUTH_CONFIG = {
    jwtExpiresIn: process.env.JWT_EXPIRES_IN || '8h',
    bcryptRounds: 10,                                       // Optimizado (antes 12): 10 es seguro y reduce picos de CPU
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

// =================== Tipos de audiencia ===================
const AUDIENCE_TYPES = ['penal', 'civil', 'laboral', 'administrativo'];
const DEFAULT_AUDIENCE_TYPE = 'penal';
const JURISDICTION = process.env.APP_JURISDICTION || 'Colombia';

// =================== Prompts base por tipo de audiencia ===================
const PROMPTS_POR_TIPO = {
    penal: `Eres un asistente de apoyo en tiempo real para un abogado que participa en una audiencia PENAL en ${JURISDICTION} (fiscalía, defensa, víctima, testigos, peritos y juez).
Tu enfoque: los hechos y sus circunstancias de tiempo, modo y lugar; la fuente del conocimiento del testigo (si vio, oyó o le contaron); la coherencia y credibilidad de los testimonios; la identificación de personas y objetos; la cadena de custodia y las pruebas; la teoría del caso (tipicidad, antijuridicidad, culpabilidad) y las garantías procesales.`,

    civil: `Eres un asistente de apoyo en tiempo real para un abogado que participa en una audiencia CIVIL en ${JURISDICTION} (demandante, demandado, apoderados, testigos, peritos y juez).
Tu enfoque: la existencia y el contenido de la obligación o del contrato; el incumplimiento y sus causas; los pagos y los documentos que los acreditan; los daños y su cuantía; el nexo causal; la carga de la prueba; las excepciones (prescripción, pago, mala fe) y las pretensiones y defensas de cada parte.`,

    laboral: `Eres un asistente de apoyo en tiempo real para un abogado que participa en una audiencia LABORAL en ${JURISDICTION} (trabajador, empleador, apoderados, testigos y juez).
Tu enfoque: la existencia de la relación laboral y sus elementos (prestación personal del servicio, subordinación, salario); la jornada y las horas extras; el pago de salarios, prestaciones y aportes a seguridad social; la terminación del contrato (justa causa, despido, indemnización); los accidentes y riesgos laborales; y la prueba de cada punto (documentos y testigos).`,

    administrativo: `Eres un asistente de apoyo en tiempo real para un abogado que participa en una audiencia ADMINISTRATIVA en ${JURISDICTION} (particular o demandante, entidad pública, apoderados, testigos, peritos y juez o magistrado).
Tu enfoque: el acto, hecho, omisión u operación administrativa discutida; la competencia y la legalidad (motivación, debido proceso, desviación de poder); la falla del servicio, el daño antijurídico y el nexo causal; la actuación de la entidad y los documentos del expediente administrativo; la oportunidad (caducidad) y las pretensiones (nulidad y restablecimiento del derecho, reparación directa, controversias contractuales).`
};

// -- Nota común sobre la calidad de la transcripción (aplica a todos los tipos y carriles) --
const TRANSCRIPTION_NOTES = `Sobre la transcripción:
- Es automática, en vivo y no indica quién habla. Puede tener palabras mal reconocidas (homófonos, nombres propios deformados, cifras o fechas mal escritas, frases cortadas o sin puntuación).
- Interpreta por el sentido del contexto y deduce quién habla (juez, fiscal o abogado, testigo, parte) a partir de lo que dice. Haz el mayor esfuerzo por entender lo que se quiso decir.
- Si una palabra dudosa cambia el sentido de un hecho importante, no la des por cierta.
- Nunca inventes nombres, fechas, lugares ni hechos que no estén en el texto.`;

// -- Instrucciones de formato por carril: no dependen del tipo de audiencia --
const INSTRUCCIONES_PREGUNTAS = `Tu tarea: proponer UNA pregunta que el abogado pueda formular a continuación, junto con dos versiones alternativas.

Responde con UNA sola línea JSON, sin markdown ni texto adicional:
{"q":"<mejor versión>","directa":"<versión más directa o cerrada>","abierta":"<versión más abierta>","enfoque":"<aclarar|precisar|verificar|cuestionar|profundizar>","porque":"<motivo en máximo 12 palabras>"}

Reglas:
1. Cada pregunta va en español, entre signos de interrogación, y es UNA sola pregunta (nunca compuesta). Máximo ${LLM_CONFIG.questions.maxWords} palabras cada una.
2. Basa las preguntas solo en hechos, afirmaciones o contradicciones presentes en el TEXTO NUEVO. El CONTEXTO PREVIO es solo referencia.
3. Deben ser concretas y útiles: aclarar, precisar, verificar o cuestionar lo dicho (tiempo, modo, lugar, fuente del conocimiento, coherencia). No uses preguntas capciosas ni especulativas, y evita las sugestivas.
4. "q" es la mejor de las tres. Las tres deben ser realmente distintas entre sí.
5. No repitas ni reformules ninguna de las PREGUNTAS YA SUGERIDAS.
6. Si el TEXTO NUEVO solo tiene saludos, identificaciones, trámites, frases sueltas o información que no permita una pregunta útil, responde exactamente: ${LLM_CONFIG.noContextToken}`;

const INSTRUCCIONES_OBJECIONES = `Tu tarea: detectar, en la ÚLTIMA INTERVENCIÓN, preguntas formuladas en voz alta que merezcan una objeción. Solo evalúas preguntas (no respuestas ni afirmaciones).

Tipos de objeción (usa exactamente el identificador):
- capciosa: utiliza engaño, artificio o inducción a error para lograr que el testigo responda algo que no desea o que es falso.
- sugestiva: sugiere o insinúa la respuesta dentro de la misma pregunta.
- impertinente: no guarda relación con los hechos del debate ni con la teoría del caso.
- ambigua: es tan imprecisa, confusa o vaga que el testigo no puede entender qué se le pregunta.
- compuesta: contiene dos o más preguntas en una sola.
- repetitiva: insiste sobre un punto que ya fue respondido.
- especulativa: pide al testigo suponer, imaginar o conjeturar sobre hechos que no le constan.

Responde con una línea JSON por objeción (máximo ${LLM_CONFIG.objections.maxPerTurn}), sin markdown ni texto adicional:
{"t":"<identificador>","cita":"<la pregunta tal como se transcribió, máximo 25 palabras>","motivo":"<por qué procede, máximo 14 palabras>"}

Reglas:
1. Señala solo cuando sea claro. Ante la duda, responde exactamente: ${LLM_CONFIG.nothingToken}
2. Si la intervención no contiene ninguna pregunta objetable, responde exactamente: ${LLM_CONFIG.nothingToken}
3. Un error de transcripción no es motivo de objeción.`;

const INSTRUCCIONES_HALLAZGOS = `Tu tarea: revisar el TEXTO NUEVO, comparándolo con el HISTORIAL, para detectar:
- contradiccion: el texto nuevo contradice o es inconsistente con algo dicho antes.
- dato: un dato importante para el caso que el abogado debe tener presente.

Responde con una línea JSON por hallazgo (máximo ${LLM_CONFIG.insights.maxPerTurn}), sin markdown ni texto adicional:
{"k":"contradiccion","titulo":"<máximo 6 palabras>","antes":"<lo dicho antes>","ahora":"<lo dicho ahora>","detalle":"<por qué se contradicen, máximo 20 palabras>"}
{"k":"dato","titulo":"<tipo de dato, máximo 4 palabras>","detalle":"<el dato concreto, máximo 20 palabras>"}

Reglas:
1. Reporta contradicciones solo si son reales. Una diferencia por posible error de transcripción NO es contradicción.
2. Reporta únicamente datos relevantes para el caso; ignora saludos, trámites y frases sin contenido.
3. No repitas los HALLAZGOS YA REPORTADOS.
4. Si no hay nada que reportar, responde exactamente: ${LLM_CONFIG.nothingToken}`;

/**
 * Arma el prompt de sistema de cada carril
 */
const buildSystemPrompts = (tipo) => {
    const domain = PROMPTS_POR_TIPO[tipo] || PROMPTS_POR_TIPO[DEFAULT_AUDIENCE_TYPE];
    const compose = (instructions) => `${domain}\n\n${TRANSCRIPTION_NOTES}\n\n${instructions}`;

    return {
        questions: compose(INSTRUCCIONES_PREGUNTAS),
        objections: compose(INSTRUCCIONES_OBJECIONES),
        insights: compose(INSTRUCCIONES_HALLAZGOS)
    };
};

// =================== Mensajes de usuario por carril ===================
const caseHeader = (caseName, caseDescription) => [
    `CASO: ${caseName || 'Sin título'}`,
    caseDescription ? `DESCRIPCIÓN: ${String(caseDescription).slice(0, 600)}` : null
];

const buildQuestionsPrompt = ({ caseName, caseDescription, recentContext, askedQuestions, newText }) =>
    [
        ...caseHeader(caseName, caseDescription),
        `CONTEXTO PREVIO: ${recentContext || '(ninguno)'}`,
        'PREGUNTAS YA SUGERIDAS:',
        askedQuestions.length ? askedQuestions.map((q) => `- ${q}`).join('\n') : '(ninguna)',
        `TEXTO NUEVO: ${newText}`
    ].filter(Boolean).join('\n');

const buildObjectionsPrompt = ({ caseName, caseDescription, recentContext, lastTurn }) =>
    [
        ...caseHeader(caseName, caseDescription),
        `CONTEXTO RECIENTE: ${recentContext || '(ninguno)'}`,
        `ÚLTIMA INTERVENCIÓN: ${lastTurn}`
    ].filter(Boolean).join('\n');

const buildInsightsPrompt = ({ caseName, caseDescription, history, reported, newText }) =>
    [
        ...caseHeader(caseName, caseDescription),
        `HISTORIAL: ${history || '(ninguno)'}`,
        'HALLAZGOS YA REPORTADOS:',
        reported.length ? reported.map((r) => `- ${r}`).join('\n') : '(ninguno)',
        `TEXTO NUEVO: ${newText}`
    ].filter(Boolean).join('\n');

// -- Ejemplos (few-shot) por carril --
const EXAMPLE_CASE = 'Caso de ejemplo';

const QUESTIONS_FEW_SHOT = [
    {
        role: 'user',
        content: buildQuestionsPrompt({
            caseName: EXAMPLE_CASE,
            recentContext: '',
            askedQuestions: [],
            newText: 'Buenos días, señoría. Me presento, soy el testigo, vivo en el barrio San José y fui citado para declarar en esta audiencia.'
        })
    },
    { role: 'assistant', content: LLM_CONFIG.noContextToken },
    {
        role: 'user',
        content: buildQuestionsPrompt({
            caseName: EXAMPLE_CASE,
            recentContext: '',
            askedQuestions: [],
            newText: 'Yo vi cuando el señor salió corriendo de la tienda con una caja en la mano. Eso fue como a las nueve de la noche, yo estaba en la esquina esperando un bus y no alcancé a verle bien la cara.'
        })
    },
    {
        role: 'assistant',
        content: JSON.stringify({
            q: '¿Qué características físicas o de vestimenta pudo observar en la persona que salió corriendo, aunque no alcanzara a ver su rostro?',
            directa: '¿Recuerda de qué color era la ropa de la persona que salió corriendo?',
            abierta: '¿Cómo describiría a la persona que vio salir de la tienda?',
            enfoque: 'precisar',
            porque: 'Dijo que no vio la cara; falta saber cómo identificó a la persona.'
        })
    }
];

const OBJECTIONS_FEW_SHOT = [
    {
        role: 'user',
        content: buildObjectionsPrompt({
            caseName: EXAMPLE_CASE,
            recentContext: '',
            lastTurn: 'Buenos días, señor testigo. ¿Podría decirnos su nombre completo y a qué se dedica?'
        })
    },
    { role: 'assistant', content: LLM_CONFIG.nothingToken },
    {
        role: 'user',
        content: buildObjectionsPrompt({
            caseName: EXAMPLE_CASE,
            recentContext: 'Yo estaba en la esquina esperando un bus.',
            lastTurn: '¿Es cierto que usted vio al señor salir corriendo de la tienda a las nueve de la noche con la caja en la mano?'
        })
    },
    {
        role: 'assistant',
        content: JSON.stringify({
            t: 'sugestiva',
            cita: '¿Es cierto que usted vio al señor salir corriendo de la tienda a las nueve de la noche con la caja en la mano?',
            motivo: 'La pregunta ya trae incluida la respuesta que se espera.'
        })
    }
];

const INSIGHTS_FEW_SHOT = [
    {
        role: 'user',
        content: buildInsightsPrompt({
            caseName: EXAMPLE_CASE,
            history: 'Yo vi al señor salir de la tienda como a las nueve de la noche.',
            reported: [],
            newText: 'Cuando eso pasó yo ya estaba en mi casa desde las siete, me enteré al otro día por una vecina.'
        })
    },
    {
        role: 'assistant',
        content: JSON.stringify({
            k: 'contradiccion',
            titulo: 'Presencia en el lugar',
            antes: 'Vio al señor salir de la tienda a las nueve de la noche.',
            ahora: 'Estaba en su casa desde las siete y se enteró al día siguiente.',
            detalle: 'Primero dice haberlo visto y luego dice que no estaba allí.'
        })
    }
];

// =================== Utilidades del LLM ===================

/** Texto en minúsculas, sin tildes ni signos (para comparar). */
const canon = (text = '') =>
    String(text)
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

/** Identificador en solo letras. */
const normalizeKey = (value = '') => canon(value).replace(/[^a-z]/g, '');

/** Recorta un texto a un máximo de caracteres. */
const clip = (value, max) => {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    return text.length > max ? `${text.slice(0, max - 1).trim()}…` : text;
};

/** Conjunto de palabras relevantes. */
const toWordSet = (text) => new Set(canon(text).split(' ').filter((word) => word.length > 3));

/** Similitud de Jaccard entre dos textos (0 a 1). */
const similarity = (a, b) => {
    const first = toWordSet(a);
    const second = toWordSet(b);
    if (!first.size || !second.size) return 0;

    const intersection = [...first].filter((word) => second.has(word)).length;
    const union = new Set([...first, ...second]).size;
    return union > 0 ? intersection / union : 0;
};

/** Indica si un texto es casi idéntico a alguno del historial. */
const isDuplicateQuestion = (question, history, threshold = LLM_CONFIG.similarityThreshold) =>
    history.some((previous) => similarity(question, previous) >= threshold);

/**
 * Limpia un texto generado por el modelo.
 */
const cleanQuestion = (raw = '') => {
    const cfg = LLM_CONFIG.questions;

    let text = String(raw)
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/```/g, '')
        .trim();

    if (!text || text.toUpperCase().includes(LLM_CONFIG.noContextToken)) return null;

    const line = text.split('\n').map((l) => l.trim()).find((l) => l.includes('?'));
    if (!line) return null;

    text = line
        .replace(/^(\d+[.)]|[-*•])\s*/, '')
        .replace(/^pregunta\s*:\s*/i, '')
        .replace(/^["'“«]+/, '')
        .trim();

    const start = text.indexOf('¿');
    if (start > 0) text = text.slice(start);

    const end = text.indexOf('?');
    text = text.slice(0, end + 1);

    if (!text.startsWith('¿')) text = `¿${text}`;

    const words = text.split(/\s+/).length;
    if (words < cfg.minWords || words > cfg.maxWords || text.length > cfg.maxChars) return null;

    return text;
};

const OBJECTION_TYPES = {
    capciosa: { label: 'Pregunta capciosa', say: 'Objeción, señoría: la pregunta es capciosa, induce al testigo a error.', note: null },
    sugestiva: { label: 'Pregunta sugestiva', say: 'Objeción, señoría: la pregunta es sugestiva, insinúa la respuesta.', note: 'Procede en el interrogatorio directo; en el contrainterrogatorio está permitida.' },
    impertinente: { label: 'Pregunta impertinente o irrelevante', say: 'Objeción, señoría: la pregunta es impertinente, no guarda relación con los hechos del debate.', note: null },
    ambigua: { label: 'Pregunta ambigua, confusa o vaga', say: 'Objeción, señoría: la pregunta es ambigua y confusa; solicito que se formule con claridad.', note: null },
    compuesta: { label: 'Pregunta compuesta', say: 'Objeción, señoría: la pregunta es compuesta; solicito que se formule una a la vez.', note: null },
    repetitiva: { label: 'Pregunta repetitiva', say: 'Objeción, señoría: la pregunta es repetitiva, ya fue respondida por el testigo.', note: null },
    especulativa: { label: 'Pregunta especulativa', say: 'Objeción, señoría: la pregunta es especulativa, pide al testigo suponer sobre hechos que no le constan.', note: null }
};

const QUESTION_CATEGORIES = ['aclarar', 'precisar', 'verificar', 'cuestionar', 'profundizar'];

/** Convierte lo que devolvió el modelo en una pregunta. */
const parseQuestion = (obj, askedAll) => {
    const main = cleanQuestion(obj?.q);
    if (!main) return { status: 'invalid' };
    if (isDuplicateQuestion(main, askedAll)) return { status: 'duplicate' };

    const variants = [];
    const taken = [main];

    [['Más directa', obj.directa], ['Más abierta', obj.abierta]].forEach(([label, raw]) => {
        const text = cleanQuestion(raw);
        if (!text || isDuplicateQuestion(text, taken, 0.8)) return;

        taken.push(text);
        variants.push({ label, text });
    });

    const key = normalizeKey(obj.enfoque);

    return {
        status: 'ok',
        data: {
            question: main,
            variants,
            category: QUESTION_CATEGORIES.find((category) => key.includes(category)) || null,
            reason: clip(obj.porque, 160) || null
        }
    };
};

/** Convierte lo que devolvió el modelo en una objeción. */
const parseObjection = (obj) => {
    const key = normalizeKey(obj?.t);
    const type = Object.keys(OBJECTION_TYPES).find((name) => key === name || key.includes(name));
    if (!type) return null;

    const quote = clip(obj.cita, 240);
    if (quote.length < 8) return null;

    const config = OBJECTION_TYPES[type];

    return {
        kind: 'objection',
        subtype: type,
        title: config.label,
        quote,
        quote_prev: null,
        detail: clip(obj.motivo, 180) || null,
        say: config.say,
        note: config.note,
        compareText: quote
    };
};

/** Convierte lo que devolvió el modelo en una contradicción o en un dato clave. */
const parseInsight = (obj) => {
    const key = normalizeKey(obj?.k);

    if (key.includes('contradic')) {
        const before = clip(obj.antes, 240);
        const now = clip(obj.ahora, 240);
        if (before.length < 5 || now.length < 5) return null;

        return {
            kind: 'contradiction',
            subtype: 'contradiccion',
            title: clip(obj.titulo, 80) || 'Posible contradicción',
            quote: now,
            quote_prev: before,
            detail: clip(obj.detalle, 200) || null,
            say: null,
            note: null,
            compareText: `${before} ${now}`
        };
    }

    if (key.includes('dato')) {
        const detail = clip(obj.detalle, 220);
        if (detail.length < 5) return null;

        return {
            kind: 'key_data',
            subtype: 'dato',
            title: clip(obj.titulo, 60) || 'Dato importante',
            quote: null,
            quote_prev: null,
            detail,
            say: null,
            note: null,
            compareText: detail
        };
    }

    return null;
};

const isDuplicateAlert = (alert, history) =>
    history.some(
        (previous) =>
            previous.kind === alert.kind &&
            previous.subtype === alert.subtype &&
            similarity(previous.compareText, alert.compareText) >= 0.6
    );

// =================== Gestor de concurrencia del LLM ===================
// OPTIMIZACIÓN: Para un equipo de 2 núcleos y memoria limitada, lanzar múltiples
// inferencias de LLM en paralelo genera saturación (thrashing) y caídas de CPU.
// Se implementa un Mutex global para procesar cada petición secuencialmente, 
// lo cual es radicalmente más rápido en entornos constreñidos.
const llmMutex = {
    current: Promise.resolve(),
    lock() {
        let release;
        const next = new Promise(resolve => { release = resolve; });
        const wait = this.current;
        this.current = wait.then(() => next, () => next); // Continuar incluso si la anterior falla
        return { wait, release };
    }
};

/**
 * Llama a Ollama en streaming respetando el encolamiento secuencial.
 */
const streamFromLLM = async ({ model = LLM_CONFIG.model, messages, numPredict, temperature = 0.2 }, onObject) => {
    // 1. Esperar el turno en la cola (Mutex)
    const { wait, release } = llmMutex.lock();
    await wait;

    let stream = null;
    let timer;
    let timedOut = false;

    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
            timedOut = true;
            if (stream?.abort) stream.abort();
            reject(new Error('Tiempo de espera agotado en Ollama'));
        }, LLM_CONFIG.timeoutMs);
    });
    timeout.catch(() => { });

    // 2. Realizar la llamada, explotando los 2 hilos disponibles (ya que es la única ejecutándose)
    const call = ollama.chat({
        model,
        messages,
        stream: true,
        // think: true,
        keep_alive: LLM_CONFIG.keepAlive,
        options: {
            temperature,
            top_p: 0.9,
            repeat_penalty: 1.1,
            num_ctx: LLM_CONFIG.numCtx,
            num_predict: numPredict,
            num_thread: 1, // Optimización crítica: forzar exactamente 2 hilos para usar el CPU eficientemente
        }
    });
    call.catch(() => { });

    let full = '';
    let buffer = '';

    try {
        stream = await Promise.race([call, timeout]);

        for await (const part of stream) {
            const chunk = part?.message?.content || '';
            if (!chunk) continue;

            full += chunk;
            buffer += chunk;

            // Extrae objetos JSON conforme se generan
            let match;
            while ((match = /\{[^{}]*\}/.exec(buffer))) {
                buffer = buffer.slice(match.index + match[0].length);

                let parsed = null;
                try {
                    parsed = JSON.parse(match[0]);
                } catch {
                    // Objeto mal formado: se ignora.
                }

                if (parsed && onObject) await onObject(parsed);
            }
        }
    } catch (error) {
        if (timedOut) throw new Error('Tiempo de espera agotado en Ollama');
        throw error;
    } finally {
        clearTimeout(timer);
        release(); // 3. Liberar el bloqueo para la siguiente tarea en la cola
    }

    return full.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
};

// =================== Motor del asistente en vivo ===================
/**
 * Un motor por conexión. Recibe la transcripción (parcial y final) y, en tres
 * carriles lógicos, genera: objeciones, contradicciones / datos clave y
 * preguntas sugeridas. (Físicamente encolados por llmMutex).
 */
const createAssistantEngine = ({ tipo, caseName, caseDescription, onStatus, onQuestion, onAlert }) => {
    const prompts = buildSystemPrompts(tipo);

    const segments = [];
    const askedMain = [];
    const askedAll = [];
    const reportedAlerts = [];

    let isActive = true;

    // -- Preguntas --
    let questionCursor = 0;
    let questionChars = 0;
    let questionOutcome = 'idle';

    // -- Contradicciones y datos --
    let insightCursor = 0;
    let insightChars = 0;

    // -- Objeciones --
    let lastObjectionText = '';

    // -- Estado --
    let heavyInFlight = 0;
    let hasError = false;
    let lastStatusKey = '';

    const publishStatus = () => {
        if (!isActive) return;

        let status;
        if (heavyInFlight > 0) {
            status = { state: 'thinking', message: 'Analizando lo último que se dijo...' };
        } else if (hasError) {
            status = { state: 'error', message: 'El modelo local no respondió. Verifica que Ollama esté en ejecución.' };
        } else if (questionOutcome === 'no_context') {
            status = { state: 'no_context', message: 'Aún no hay contexto suficiente para sugerir preguntas.' };
        } else {
            status = { state: 'listening', message: 'Escuchando la audiencia...' };
        }

        const key = `${status.state}|${status.message}`;
        if (key === lastStatusKey) return;

        lastStatusKey = key;
        onStatus(status);
    };

    /**
     * Un carril ejecuta una tarea a la vez. Las peticiones a LLM se enviarán
     * al mutex central automáticamente.
     */
    const createLane = ({ name, heavy, canRun, execute }) => {
        let running = false;
        let queued = null;

        const run = async (payload) => {
            if (!isActive) return;

            if (running) {
                queued = { payload };
                return;
            }

            if (canRun && !canRun(payload)) return;

            running = true;
            if (heavy) {
                heavyInFlight += 1;
                publishStatus();
            }

            try {
                await execute(payload);
                hasError = false;
            } catch (error) {
                console.error(`[IA:${name}] Error:`, error.message || error);
                hasError = true;
            } finally {
                running = false;
                if (heavy) heavyInFlight -= 1;
                publishStatus();

                if (isActive && queued) {
                    const next = queued;
                    queued = null;
                    void run(next.payload);
                }
            }
        };

        return run;
    };

    // ---------- Carril 1: objeciones ----------
    const runObjections = createLane({
        name: 'objeciones',
        heavy: false,
        execute: async ({ text, contextEnd }) => {
            const cfg = LLM_CONFIG.objections;

            const lastTurn = text.slice(-cfg.maxTextChars);
            const recentContext = segments.slice(0, contextEnd).join(' ').slice(-cfg.recentContextChars);

            let count = 0;

            await streamFromLLM(
                {
                    model: LLM_CONFIG.fastModel,
                    numPredict: cfg.numPredict,
                    temperature: cfg.temperature,
                    messages: [
                        { role: 'system', content: prompts.objections },
                        ...OBJECTIONS_FEW_SHOT,
                        {
                            role: 'user',
                            content: buildObjectionsPrompt({ caseName, caseDescription, recentContext, lastTurn })
                        }
                    ]
                },
                async (obj) => {
                    if (!isActive || count >= cfg.maxPerTurn) return;

                    const alert = parseObjection(obj);
                    if (!alert || isDuplicateAlert(alert, reportedAlerts)) return;

                    reportedAlerts.push(alert);
                    count += 1;

                    await onAlert(alert);
                    console.log(`[IA] Objeción (${alert.subtype}): ${alert.quote}`);
                }
            );
        }
    });

    // ---------- Carril 2: contradicciones y datos clave ----------
    const runInsights = createLane({
        name: 'hallazgos',
        heavy: true,
        canRun: () => insightChars >= LLM_CONFIG.insights.minNewChars,
        execute: async () => {
            const cfg = LLM_CONFIG.insights;

            insightChars = 0;

            const snapshot = segments.length;
            const newText = segments.slice(insightCursor, snapshot).join(' ').slice(-cfg.maxNewChars);
            const history = segments.slice(0, insightCursor).join(' ').slice(-cfg.historyChars);
            const reported = reportedAlerts
                .filter((alert) => alert.kind !== 'objection')
                .slice(-cfg.maxReported)
                .map((alert) => `${alert.title}: ${alert.detail || alert.quote}`);

            let count = 0;

            await streamFromLLM(
                {
                    numPredict: cfg.numPredict,
                    temperature: cfg.temperature,
                    messages: [
                        { role: 'system', content: prompts.insights },
                        ...INSIGHTS_FEW_SHOT,
                        {
                            role: 'user',
                            content: buildInsightsPrompt({ caseName, caseDescription, history, reported, newText })
                        }
                    ]
                },
                async (obj) => {
                    if (!isActive || count >= cfg.maxPerTurn) return;

                    const alert = parseInsight(obj);
                    if (!alert || isDuplicateAlert(alert, reportedAlerts)) return;

                    reportedAlerts.push(alert);
                    count += 1;

                    await onAlert(alert);
                    console.log(`[IA] Hallazgo (${alert.subtype}): ${alert.title}`);
                }
            );

            if (isActive) insightCursor = snapshot;
        }
    });

    // ---------- Carril 3: preguntas sugeridas ----------
    const runQuestions = createLane({
        name: 'preguntas',
        heavy: true,
        canRun: () => questionChars >= LLM_CONFIG.questions.minNewChars,
        execute: async () => {
            const cfg = LLM_CONFIG.questions;

            questionChars = 0;

            const snapshot = segments.length;
            const newText = segments.slice(questionCursor, snapshot).join(' ').slice(-cfg.maxNewChars);
            const recentContext = segments.slice(0, questionCursor).join(' ').slice(-cfg.recentContextChars);

            let emitted = false;
            let sawDuplicate = false;

            const raw = await streamFromLLM(
                {
                    numPredict: cfg.numPredict,
                    temperature: cfg.temperature,
                    messages: [
                        { role: 'system', content: prompts.questions },
                        ...QUESTIONS_FEW_SHOT,
                        {
                            role: 'user',
                            content: buildQuestionsPrompt({
                                caseName,
                                caseDescription,
                                recentContext,
                                askedQuestions: askedMain.slice(-cfg.maxHistory),
                                newText
                            })
                        }
                    ]
                },
                async (obj) => {
                    if (!isActive || emitted) return;

                    const result = parseQuestion(obj, askedAll);

                    if (result.status === 'duplicate') {
                        sawDuplicate = true;
                        return;
                    }

                    if (result.status !== 'ok') return;

                    emitted = true;
                    askedMain.push(result.data.question);
                    askedAll.push(result.data.question, ...result.data.variants.map((variant) => variant.text));

                    await onQuestion(result.data);
                    console.log(`[IA] Pregunta generada: ${result.data.question}`);
                }
            );

            if (!isActive) return;

            if (emitted) {
                questionOutcome = 'ready';
                questionCursor = snapshot;
            } else if (sawDuplicate) {
                questionOutcome = 'idle';
                questionCursor = snapshot;
            } else {
                questionOutcome = 'no_context';
                console.log('[IA] Sin pregunta útil. Respuesta cruda:', JSON.stringify(raw));
            }
        }
    });

    return {
        addTranscript(text) {
            if (!isActive) return;

            const clean = String(text || '').trim();
            if (!clean) return;

            segments.push(clean);
            questionChars += clean.length;
            insightChars += clean.length;

            const objectionCfg = LLM_CONFIG.objections;

            if (clean.length >= objectionCfg.minChars && canon(clean) !== canon(lastObjectionText)) {
                lastObjectionText = clean;
                void runObjections({ text: clean, contextEnd: segments.length - 1 });
            }

            void runInsights();
            void runQuestions();
        },

        addInterim(text) {
            if (!isActive) return;

            const clean = String(text || '').trim();
            const cfg = LLM_CONFIG.objections;

            if (clean.length < cfg.earlyMinChars || !/[?？]\s*$/.test(clean)) return;
            if (canon(clean) === canon(lastObjectionText)) return;

            lastObjectionText = clean;
            void runObjections({ text: clean, contextEnd: segments.length });
        },

        stop() {
            isActive = false;
        }
    };
};

// =================== Usuarios: utilidades ===================

const USER_COLUMNS = `id, nombre, correo, rol, to_char(vencimiento, 'YYYY-MM-DD') AS vencimiento, activo, created_at`;

const getToday = () =>
    new Intl.DateTimeFormat('en-CA', {
        timeZone: AUTH_CONFIG.timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).format(new Date());

const hasActiveSubscription = (user) => {
    if (user.rol === 'admin') return true;
    return Boolean(user.vencimiento) && user.vencimiento >= getToday();
};

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

const generatePassword = (length = 12) => {
    const sets = [
        'ABCDEFGHJKLMNPQRSTUVWXYZ',
        'abcdefghijkmnopqrstuvwxyz',
        '23456789',
        '!@#$%*?'
    ];
    const all = sets.join('');

    const chars = sets.map((set) => set[crypto.randomInt(set.length)]);

    while (chars.length < length) {
        chars.push(all[crypto.randomInt(all.length)]);
    }

    for (let i = chars.length - 1; i > 0; i--) {
        const j = crypto.randomInt(i + 1);
        [chars[i], chars[j]] = [chars[j], chars[i]];
    }

    return chars.join('');
};

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

const requireAdmin = (req, res, next) => {
    if (req.user?.rol !== 'admin') {
        return res.status(403).json({ error: 'No tienes permisos para esta acción.' });
    }
    next();
};

const requireActiveSubscription = (req, res, next) => {
    if (!hasActiveSubscription(req.user)) {
        return res.status(403).json({
            error: 'Tu suscripción no está vigente. Contacta al administrador para renovarla.'
        });
    }
    next();
};

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

setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of loginAttempts) {
        if (now > entry.resetAt) loginAttempts.delete(key);
    }
}, 10 * 60 * 1000).unref();

// =================== Base de datos: esquema y administrador inicial ===================
const initializeDatabase = async () => {
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

    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS users_correo_unique ON users (LOWER(correo))`);

    await pool.query(`
        ALTER TABLE sessions
        ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE SET NULL
    `);

    await pool.query(`
        ALTER TABLE sessions
        ADD COLUMN IF NOT EXISTS tipo VARCHAR(20) NOT NULL DEFAULT 'penal'
        CHECK (tipo IN ('penal', 'civil', 'laboral', 'administrativo'))
    `);

    await pool.query(`ALTER TABLE ai_questions ADD COLUMN IF NOT EXISTS variants JSONB NOT NULL DEFAULT '[]'::jsonb`);
    await pool.query(`ALTER TABLE ai_questions ADD COLUMN IF NOT EXISTS category VARCHAR(30)`);
    await pool.query(`ALTER TABLE ai_questions ADD COLUMN IF NOT EXISTS reason TEXT`);

    const sessionIdTypeResult = await pool.query(
        `SELECT format_type(atttypid, atttypmod) AS type
         FROM pg_attribute
         WHERE attrelid = 'sessions'::regclass AND attname = 'id'`
    );
    const sessionIdType = sessionIdTypeResult.rows[0]?.type || 'integer';

    await pool.query(`
        CREATE TABLE IF NOT EXISTS ai_alerts (
            id         SERIAL PRIMARY KEY,
            session_id ${sessionIdType} NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
            kind       VARCHAR(20)  NOT NULL CHECK (kind IN ('objection', 'contradiction', 'key_data')),
            subtype    VARCHAR(30),
            title      TEXT         NOT NULL,
            quote      TEXT,
            quote_prev TEXT,
            detail     TEXT,
            say        TEXT,
            note       TEXT,
            created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
        )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS ai_alerts_session_idx ON ai_alerts (session_id, created_at)`);

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

app.get('/api/auth/me', authenticate, (req, res) => {
    res.status(200).json({ user: toPublicUser(req.user) });
});

// =================== 3. RUTAS PROTEGIDAS: USUARIOS (SOLO ADMIN) ===================
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

        res.status(201).json({
            user: toPublicUser(result.rows[0]),
            temporaryPassword
        });

    } catch (error) {
        handleError(res, error, 'Error creando el cliente');
    }
});

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
            `SELECT s.id, s.case_name, s.case_description, s.tipo, s.status, s.created_at,
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

app.post('/api/sessions', authenticate, requireActiveSubscription, async (req, res) => {
    try {
        const { case_name, case_description } = req.body;
        const tipo = String(req.body?.tipo || '').trim().toLowerCase();

        if (!AUDIENCE_TYPES.includes(tipo)) {
            throw new AppError('Selecciona el tipo de audiencia: penal, civil, laboral o administrativo.');
        }

        const result = await pool.query(
            `INSERT INTO sessions (case_name, case_description, tipo, user_id)
             VALUES ($1, $2, $3, $4)
             RETURNING id, case_name, case_description, tipo, status, created_at`,
            [
                String(case_name || '').trim().slice(0, 200) || 'Audiencia sin título',
                String(case_description || '').trim().slice(0, 2000),
                tipo,
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

app.get('/api/sessions/:id', authenticate, async (req, res) => {
    try {
        const { id } = req.params;

        const sessionResult = await pool.query(
            `SELECT s.id, s.case_name, s.case_description, s.tipo, s.status, s.created_at, s.user_id,
                    u.nombre AS owner_name
             FROM sessions s
             LEFT JOIN users u ON u.id = s.user_id
             WHERE s.id = $1`,
            [id]
        );

        const session = sessionResult.rows[0];

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
            `SELECT id, question, variants, category, reason, created_at
             FROM ai_questions
             WHERE session_id = $1
             ORDER BY created_at ASC, id ASC`,
            [id]
        );

        const alertsResult = await pool.query(
            `SELECT id, kind, subtype, title, quote, quote_prev, detail, say, note, created_at
             FROM ai_alerts
             WHERE session_id = $1
             ORDER BY created_at ASC, id ASC`,
            [id]
        );

        res.status(200).json({
            session,
            transcriptions: transcriptionResult.rows,
            ai_questions: questionsResult.rows,
            ai_alerts: alertsResult.rows,
            statistics: {
                total_transcriptions: transcriptionResult.rows.length,
                total_questions: questionsResult.rows.length,
                total_alerts: alertsResult.rows.length
            }
        });

    } catch (error) {
        handleError(res, error, 'Error consultando los detalles de la audiencia.');
    }
});

app.get('/api/llm/health', authenticate, requireAdmin, async (req, res) => {
    const start = Date.now();

    try {
        const response = await streamFromLLM({
            messages: [{ role: 'user', content: 'Responde únicamente con la palabra: ok' }],
            numPredict: 10,
            temperature: 0
        });

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

    let deepgramLive = null;
    let currentSessionId = null;
    let isConnecting = false;
    let isStopping = false;
    let assistantEngine = null;
    let transcriptionQueue = Promise.resolve();

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

    const saveAndEmitQuestion = async ({ question, variants, category, reason }) => {
        const result = await pool.query(
            `INSERT INTO ai_questions (session_id, question, variants, category, reason)
             VALUES ($1, $2, $3::jsonb, $4, $5)
             RETURNING id, question, variants, category, reason, created_at`,
            [currentSessionId, question, JSON.stringify(variants || []), category, reason]
        );

        io.to(currentSessionId).emit('new_question', result.rows[0]);
    };

    const saveAndEmitAlert = async (alert) => {
        const result = await pool.query(
            `INSERT INTO ai_alerts (session_id, kind, subtype, title, quote, quote_prev, detail, say, note)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             RETURNING id, kind, subtype, title, quote, quote_prev, detail, say, note, created_at`,
            [
                currentSessionId,
                alert.kind,
                alert.subtype,
                alert.title,
                alert.quote,
                alert.quote_prev,
                alert.detail,
                alert.say,
                alert.note
            ]
        );

        io.to(currentSessionId).emit('new_alert', result.rows[0]);
    };

    const releaseResources = () => {
        if (assistantEngine) {
            assistantEngine.stop();
            assistantEngine = null;
        }
    };

    socket.on('join_session', async (sessionId) => {
        if (isConnecting || deepgramLive) return;

        isConnecting = true;

        try {
            const user = await findUserById(socket.data.userId);

            if (!user || !user.activo) {
                throw new AppError('Tu cuenta está desactivada.', 403);
            }

            if (!hasActiveSubscription(user)) {
                throw new AppError('Tu suscripción no está vigente. Contacta al administrador.', 403);
            }

            const caseResult = await pool.query(
                'SELECT case_name, case_description, tipo, user_id FROM sessions WHERE id = $1',
                [sessionId]
            );
            const caseInfo = caseResult.rows[0];

            if (!caseInfo || (user.rol !== 'admin' && caseInfo.user_id !== user.id)) {
                throw new AppError('La audiencia no existe.', 404);
            }

            currentSessionId = String(sessionId);
            socket.join(currentSessionId);
            console.log(`[BACKEND] Transmitiendo audio para la sesión: ${currentSessionId}`);

            assistantEngine = createAssistantEngine({
                tipo: caseInfo.tipo,
                caseName: caseInfo.case_name,
                caseDescription: caseInfo.case_description,
                onStatus: (status) => socket.emit('ai_status', status),
                onQuestion: saveAndEmitQuestion,
                onAlert: saveAndEmitAlert
            });

            deepgramLive = await deepgram.listen.v2.connect({
                model: 'flux-general-multi',
                language_hint: 'es'
            });

            deepgramLive.on('open', () => {
                console.log('[BACKEND] Conexión abierta con Deepgram');
            });

            deepgramLive.on('message', (data) => {
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

                io.to(currentSessionId).emit('new_transcription', {
                    text: transcript,
                    isFinal
                });

                if (isFinal) {
                    saveTranscription(transcript);
                    assistantEngine?.addTranscript(transcript);
                } else {
                    assistantEngine?.addInterim(transcript);
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

            console.log(`[IA] Asistente activo (${caseInfo.tipo}). Modelo: ${LLM_CONFIG.model}`);

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

    socket.on('stop_session', () => {
        if (!deepgramLive || isStopping) return;

        try {
            isStopping = true;
            console.log(`[BACKEND] Finalizando sesión ${currentSessionId}`);

            deepgramLive.sendCloseStream({ type: 'CloseStream' });

        } catch (error) {
            console.error('[BACKEND] Error finalizando Deepgram:', error);

            releaseResources();
            deepgramLive.close();
            deepgramLive = null;
            isStopping = false;
        }
    });

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