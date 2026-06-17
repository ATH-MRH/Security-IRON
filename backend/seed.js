const bcrypt = require('bcryptjs');
const db     = require('./database');

const uid        = (p = 'ID') => p + '-' + Math.random().toString(36).slice(2, 8).toUpperCase();
const now        = () => new Date().toISOString();
const rand       = a => a[Math.floor(Math.random() * a.length)];
const randInt    = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;
const generePlaque = () => {
  const L = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  return L[randInt(0,23)] + L[randInt(0,23)] + '-' + randInt(100,999) + '-' + L[randInt(0,23)] + L[randInt(0,23)];
};

async function main() {
  await db.init();
  console.log('[SEED] Initialisation des données de démo...');

  // Réinitialiser toutes les tables (CASCADE gère la FK parking_places→parking_zones)
  const client = await db.pool.connect();
  try {
    await client.query(`
      TRUNCATE TABLE
        parking_places, parking_mouvements, parking_zones,
        lapi_lectures, main_courante, badges, incidents,
        pietons, vehicules, visiteurs, employes, parametres, users
      RESTART IDENTITY CASCADE
    `);
  } finally {
    client.release();
  }

  // === Utilisateurs ===
  await db.query(`INSERT INTO users (username, password_hash, nom_complet, role) VALUES ($1,$2,$3,$4)`,
    ['admin',        await bcrypt.hash('securisite',   10), 'Administrateur',         'admin']);
  await db.query(`INSERT INTO users (username, password_hash, nom_complet, role) VALUES ($1,$2,$3,$4)`,
    ['system_admin', await bcrypt.hash('securisite2026',10), 'Administrateur système', 'admin']);
  await db.query(`INSERT INTO users (username, password_hash, nom_complet, role) VALUES ($1,$2,$3,$4)`,
    ['agent',        await bcrypt.hash('agent',        10), 'Agent de sûreté',        'agent']);
  console.log('  ✓ Utilisateurs : admin/securisite, system_admin/securisite2026, agent/agent');

  // === Employés ===
  const services = ['Direction','Production','Logistique','Maintenance','Administration','Sûreté'];
  const noms = [
    ['Marie','Dubois'],  ['Pierre','Martin'],  ['Sophie','Bernard'], ['Julien','Moreau'],
    ['Camille','Laurent'],['Thomas','Petit'],  ['Léa','Roux'],       ['Antoine','Garnier'],
    ['Sarah','Faure'],   ['Lucas','Mercier'],  ['Emma','Leroy'],      ['Hugo','Girard'],
    ['Chloé','Bonnet'],  ['Maxime','Dupont'],  ['Inès','Fontaine']
  ];
  const employes = [];
  for (let i = 0; i < noms.length; i++) {
    const n = noms[i];
    const e = {
      id: uid('EMP'), matricule: 'M' + (1000 + i),
      prenom: n[0], nom: n[1],
      service: rand(services),
      fonction: rand(['Responsable','Technicien','Opérateur','Assistant','Manager',"Chef d'équipe"]),
      badge: 'BDG-' + (2000 + i),
      niveau: rand(['N1','N2','N3','N4']),
      statut: Math.random() > 0.15 ? 'actif' : rand(['absent','suspendu']),
      creation: now(),
    };
    await db.query(
      `INSERT INTO employes (id, matricule, prenom, nom, service, fonction, badge, niveau, statut, creation)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [e.id, e.matricule, e.prenom, e.nom, e.service, e.fonction, e.badge, e.niveau, e.statut, e.creation]
    );
    employes.push(e);
  }
  console.log(`  ✓ ${employes.length} employés`);

  // === Visiteurs ===
  const societes = ['Acme SAS','TechCorp','Logistique Express','Maintenance Plus','Audit & Co','Fournitures Industrielles'];
  for (let i = 0; i < 8; i++) {
    const n = rand(noms);
    await db.query(
      `INSERT INTO visiteurs (id, prenom, nom, societe, hote, motif, arrivee, badge, statut)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [uid('VIS'), n[0], n[1], rand(societes), rand(employes).nom,
       rand(['Réunion','Livraison','Maintenance','Audit','Visite commerciale','Formation']),
       new Date(Date.now() + randInt(-2, 6) * 3600 * 1000).toISOString(),
       i < 5 ? 'V-' + (7000 + i) : null,
       rand(['attendu','present','present','parti'])]
    );
  }
  console.log('  ✓ 8 visiteurs');

  // === Véhicules ===
  const plaques = ['AB-123-CD','EF-456-GH','IJ-789-KL','MN-012-OP','QR-345-ST','UV-678-WX','YZ-901-AB','CD-234-EF'];
  for (const p of plaques) {
    const entree    = new Date(Date.now() - randInt(0, 24) * 3600 * 1000).toISOString();
    const dansSite  = Math.random() > 0.4;
    await db.query(
      `INSERT INTO vehicules (id, plaque, type, conducteur, societe, motif, entree, sortie, statut, place_parking, lapi_photo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [uid('VEH'), p, rand(['VL','PL','utilitaire','2R']), rand(noms).join(' '), rand(societes),
       rand(['Livraison','Visite','Maintenance','Personnel']), entree,
       dansSite ? null : new Date(new Date(entree).getTime() + randInt(1, 8) * 3600 * 1000).toISOString(),
       dansSite ? 'dans' : 'dehors',
       dansSite && Math.random() > 0.3 ? 'A' + randInt(1, 40) : null, null]
    );
  }
  console.log('  ✓ 8 véhicules');

  // === Piétons ===
  for (let i = 0; i < 25; i++) {
    const n     = rand(noms);
    const isEmp = Math.random() > 0.4;
    await db.query(
      `INSERT INTO pietons (id, datetime, nom, badge, type, point, sens, resultat, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [uid('PED'), new Date(Date.now() - randInt(0, 48) * 3600 * 1000).toISOString(),
       n.join(' '), isEmp ? 'BDG-' + randInt(2000, 2014) : 'V-' + randInt(7000, 7099),
       isEmp ? 'Employé' : 'Visiteur',
       rand(['Tourniquet Principal','Porte Nord','Porte Sud','Sas Visiteurs']),
       rand(['entree','sortie']), Math.random() > 0.05 ? 'autorise' : 'refus', '']
    );
  }
  console.log('  ✓ 25 passages piétons');

  // === Incidents ===
  const typesInc     = ["Tentative d'intrusion",'Badge invalide','Véhicule non autorisé','Comportement suspect','Alarme déclenchée','Objet abandonné','Conflit interpersonnel','Effraction supposée'];
  const lieux        = ['Tourniquet Principal','Parking A','Parking B','Porte Nord','Quai logistique','Hall accueil','Périmètre Est','Bâtiment R&D'];
  const surete       = employes.filter(e => e.service === 'Sûreté');
  const agentsSurete = surete.length > 0 ? surete : [employes[0]];
  for (let i = 0; i < 14; i++) {
    await db.query(
      `INSERT INTO incidents (id, ref, datetime, type, lieu, gravite, statut, agent, description, actions)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [uid('INC'), 'INC-' + (2026000 + i),
       new Date(Date.now() - randInt(0, 30 * 24) * 3600 * 1000).toISOString(),
       rand(typesInc), rand(lieux),
       rand(['critique','majeur','majeur','mineur','mineur']),
       rand(['ouvert','encours','resolu','resolu']),
       rand(agentsSurete).nom,
       'Incident détecté par système de surveillance.', '']
    );
  }
  console.log('  ✓ 14 incidents');

  // === Parking ===
  const zones = [
    { zone:'A', nom:'Parking Visiteurs',      total:20, reserve:3, handicap:2 },
    { zone:'B', nom:'Parking Employés Nord',  total:60, reserve:5, handicap:3 },
    { zone:'C', nom:'Parking Employés Sud',   total:60, reserve:5, handicap:3 },
    { zone:'D', nom:'Quai Logistique',        total:12, reserve:0, handicap:0 },
  ];
  for (const z of zones) {
    await db.query(
      `INSERT INTO parking_zones (zone, nom, total, reserve, handicap) VALUES ($1,$2,$3,$4,$5)`,
      [z.zone, z.nom, z.total, z.reserve, z.handicap]
    );
    for (let i = 0; i < z.total; i++) {
      let etat;
      if (i < z.handicap)                 etat = 'handicap';
      else if (i < z.handicap + z.reserve) etat = Math.random() > 0.5 ? 'reserve' : 'libre';
      else                                  etat = Math.random() > 0.5 ? 'occupe'  : 'libre';
      await db.query(
        `INSERT INTO parking_places (num, zone, etat, plaque) VALUES ($1,$2,$3,$4)`,
        [z.zone + (i + 1), z.zone, etat, etat === 'occupe' ? generePlaque() : null]
      );
    }
  }
  console.log(`  ✓ ${zones.length} zones de parking`);

  for (let i = 0; i < 18; i++) {
    await db.query(
      `INSERT INTO parking_mouvements (id, datetime, plaque, place, zone, action, duree) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [uid('MVT'), new Date(Date.now() - randInt(0, 12) * 3600 * 1000).toISOString(),
       generePlaque(), rand(['A1','A5','B12','B25','C8','C30','D2']),
       rand(['A','B','C','D']), rand(['entree','sortie']), randInt(15, 480)]
    );
  }
  console.log('  ✓ 18 mouvements parking');

  // === Badges ===
  for (const e of employes.slice(0, 10)) {
    await db.query(
      `INSERT INTO badges (ref, nom, type, niveau, emis, validite, etat, societe) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [e.badge, e.prenom + ' ' + e.nom, 'E', e.niveau,
       new Date(Date.now() - randInt(30, 365) * 24 * 3600 * 1000).toISOString(),
       new Date(Date.now() + randInt(30, 365) * 24 * 3600 * 1000).toISOString(),
       'actif', 'Interne']
    );
  }
  console.log('  ✓ 10 badges employés');

  // === Main courante ===
  const postes      = ['PC Sûreté','Poste 1','Poste 2','Poste 3','Rondier 1','Rondier 2','Rondier 3','Chef de poste'];
  const agentsNoms  = agentsSurete.map(e => e.prenom + ' ' + e.nom);
  const lieuxMC     = ['Tourniquet principal','Parking A','Parking B','Quai logistique','Hall accueil','Périmètre Nord','Périmètre Sud','Périmètre Est','Bâtiment R&D','Salle PC','Atelier 1','Salle réunion'];
  const eventModeles = [
    { type:'Relève',       desc:'Prise de service. Consignes reçues. RAS sur passation.',                              prio:'normale'    },
    { type:'Ronde',        desc:'Ronde de surveillance secteur Nord effectuée. Tout est conforme.',                    prio:'normale'    },
    { type:'Ronde',        desc:'Ronde périmètre Est. Aucune anomalie détectée.',                                      prio:'normale'    },
    { type:'Information',  desc:'Réception du courrier du matin par le coursier habituel.',                            prio:'normale'    },
    { type:'Communication',desc:'Appel reçu de la direction. Information transmise au Poste 1.',                       prio:'normale'    },
    { type:'Contrôle',     desc:'Contrôle aléatoire véhicule sortant. Conforme.',                                     prio:'normale'    },
    { type:'Anomalie',     desc:'Éclairage défaillant zone parking B. Maintenance prévenue.',                          prio:'importante' },
    { type:'Anomalie',     desc:'Porte coupe-feu mal fermée niveau 2. Refermée et signalée.',                          prio:'importante' },
    { type:'Incident',     desc:"Tentative d'accès avec badge périmé. Personne refoulée et identifiée.",               prio:'importante' },
    { type:'Intervention', desc:'Assistance demandée par accueil pour livreur sans rendez-vous. Résolu.',              prio:'normale'    },
    { type:'Visite',       desc:"Visite officielle de la délégation. Escorte assurée jusqu'au bureau direction.",      prio:'importante' },
    { type:'Information',  desc:'Test alarme incendie planifié à 14h00. Personnel informé.',                           prio:'normale'    },
    { type:'Ronde',        desc:'Ronde quai logistique. Camion stationné identifié et autorisé.',                      prio:'normale'    },
    { type:'Communication',desc:'Liaison radio testée avec tous les postes. Fonctionnement nominal.',                  prio:'normale'    },
    { type:'Contrôle',     desc:'Vérification fermeture des accès en fin de journée. Tout est sécurisé.',              prio:'normale'    },
  ];
  for (let i = 0; i < 35; i++) {
    const m = rand(eventModeles);
    await db.query(
      `INSERT INTO main_courante (id, datetime, poste, agent, type, lieu, description, priorite)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [uid('MC'),
       new Date(Date.now() - randInt(0, 7 * 24) * 3600 * 1000 - randInt(0, 59) * 60 * 1000).toISOString(),
       rand(postes), rand(agentsNoms.length ? agentsNoms : ['Agent PC']),
       m.type, rand(lieuxMC), m.desc, m.prio]
    );
  }
  console.log('  ✓ 35 entrées de main courante');

  // === Paramètres ===
  for (const [cle, valeur] of [['site','Site Industriel Principal'],['adresse','Zone Industrielle'],['tel','+33 1 00 00 00 00']]) {
    await db.query(`INSERT INTO parametres (cle, valeur) VALUES ($1,$2)`, [cle, valeur]);
  }
  console.log('  ✓ Paramètres');

  console.log('\n✅ Base de données initialisée avec succès.\n');
  process.exit(0);
}

main().catch(err => {
  console.error('[SEED] Erreur :', err);
  process.exit(1);
});
