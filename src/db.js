const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Ajoutez ceci si vous utilisez une base distante avec SSL (ex: Render, Supabase)
  ssl: { rejectUnauthorized: false } 
});

module.exports = {
  query: (text, params) => pool.query(text, params),
};
