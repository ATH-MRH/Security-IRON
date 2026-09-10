'use strict';
/**
 * Crée le premier compte administrateur SécuriSite dans PostgreSQL.
 * Idempotent : ne modifie jamais un compte existant du même identifiant.
 * Le mot de passe n'est jamais codé en dur, ni affiché, ni journalisé.
 *
 * Usage :
 *   SECURISITE_ADMIN_PASSWORD='…' node backend/db/postgresql/create-admin.js [identifiant]
 *   node backend/db/postgresql/create-admin.js            # saisie masquée sur un TTY
 *
 * Connexion : DATABASE_URL ou PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD
 * (rôle MIGRATOR, ou tout rôle disposant d'INSERT sur public.users).
 */
const bcrypt = require('bcryptjs');
const { Client } = require('pg');
const { configuration } = require('../../database');

const MIN_PASSWORD = 12;
const USERNAME = /^[a-zA-Z0-9._-]{3,40}$/;

// Lecture masquée sur un vrai TTY ; sinon le mot de passe doit venir de l'environnement.
function readPasswordFromTty() {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) { reject(new Error('Aucun TTY : fournir SECURISITE_ADMIN_PASSWORD.')); return; }
    process.stdout.write('Mot de passe du compte admin (masqué) : ');
    stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8');
    let buf = '';
    const finish = (fn, arg) => {
      stdin.setRawMode(false); stdin.pause(); stdin.removeListener('data', onData);
      process.stdout.write('\n'); fn(arg);
    };
    const onData = ch => {
      if (ch === '\r' || ch === '\n' || ch === '\u0004') return finish(resolve, buf); // Entrée / EOF
      if (ch === '\u0003') return finish(reject, new Error('Interrompu.'));            // Ctrl-C
      if (ch === '\u007f' || ch === '\b') { buf = buf.slice(0, -1); return; }          // Retour arrière
      buf += ch;
    };
    stdin.on('data', onData);
  });
}

async function createAdmin(env, { username, password } = {}) {
  const user = username || env.SECURISITE_ADMIN_USERNAME || 'admin';
  if (!USERNAME.test(user)) throw new Error('Identifiant invalide : ' + user);
  const pass = password != null ? password : env.SECURISITE_ADMIN_PASSWORD;
  if (pass == null || pass === '') throw new Error('SECURISITE_ADMIN_PASSWORD manquant.');
  if (String(pass).length < MIN_PASSWORD) throw new Error(`Mot de passe trop court (minimum ${MIN_PASSWORD} caractères).`);

  const hash = await bcrypt.hash(String(pass), 10);
  const client = new Client({ ...configuration(env), application_name: 'securisite-create-admin' });
  await client.connect();
  try {
    const res = await client.query(
      `INSERT INTO public.users (username, password_hash, nom_complet, role)
       VALUES ($1, $2, $3, 'admin')
       ON CONFLICT (username) DO NOTHING
       RETURNING id`,
      [user, hash, user]);
    return { username: user, created: res.rowCount === 1 };
  } finally { await client.end(); }
}

async function main() {
  const username = process.argv[2];
  const password = process.env.SECURISITE_ADMIN_PASSWORD || await readPasswordFromTty();
  const { username: u, created } = await createAdmin(process.env, { username, password });
  console.log(created
    ? `[create-admin] compte administrateur « ${u} » créé.`
    : `[create-admin] le compte « ${u} » existe déjà : aucune modification.`);
}

if (require.main === module) {
  main().catch(err => { console.error('[create-admin]', err.message); process.exit(1); });
}

module.exports = { createAdmin, MIN_PASSWORD };
