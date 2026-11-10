const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
});

// Verificación inicial de la conexión
pool.connect((err, client, release) => {
    if (err) {
        console.error('[BACKEND] Error conectando a PostgreSQL:', err.stack);
    } else {
        console.log('[BACKEND] Conexión exitosa a la base de datos:', process.env.DB_NAME);
        release();
    }
});

module.exports = pool;