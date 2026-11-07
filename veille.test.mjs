import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  decider,
  noterEnvoi,
  etatNeuf,
  lireEtatBrut,
  formaterDuree,
  passage,
  sonder,
} from './veille.mjs';

const ECHEC = { ok: false, raison: 'statut 502' };
const OK = { ok: true };
const T0 = Date.parse('2026-11-07T20:02:00Z');
const minutes = (n) => new Date(T0 + n * 60_000);

// Simule un passage avec un Telegram qui répond ok, sauf si refuse = true.
function suite(resultats, { refuse = () => false } = {}) {
  let etat = etatNeuf();
  const messages = [];
  resultats.forEach((resultat, i) => {
    const maintenant = minutes(i * 5);
    const decision = decider(etat, resultat, maintenant);
    etat = decision.etat;
    if (decision.message) {
      messages.push({ passage: i, ...decision.message });
      if (!refuse(i)) etat = noterEnvoi(etat, decision.message.type, maintenant);
    }
  });
  return { etat, messages };
}

test('1 échec : pas de message', () => {
  const { messages, etat } = suite([ECHEC]);
  assert.equal(messages.length, 0);
  assert.equal(etat.echecsDeSuite, 1);
  assert.equal(etat.enPanne, false);
});

test('2 échecs de suite : 1 message « ne répond plus »', () => {
  const { messages, etat } = suite([ECHEC, ECHEC]);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, 'panne');
  assert.match(messages[0].texte, /^Kardplay ne répond plus/);
  assert.match(messages[0].texte, /statut 502/);
  assert.equal(etat.enPanne, true);
  assert.equal(etat.derniereAlerte, 'panne');
});

test('3e et 4e échec : rien de plus, et l’état ne change plus', () => {
  const { messages } = suite([ECHEC, ECHEC, ECHEC, ECHEC]);
  assert.equal(messages.length, 1);
  const apres2 = suite([ECHEC, ECHEC]).etat;
  const d3 = decider(apres2, ECHEC, minutes(10));
  assert.equal(d3.message, null);
  assert.deepEqual(d3.etat, apres2);
});

test('retour après une panne : 1 message « revenu » avec la durée', () => {
  // Échecs à 0, 5, 10 min ; le site répond à 15 min.
  const { messages, etat } = suite([ECHEC, ECHEC, ECHEC, OK, OK]);
  assert.equal(messages.length, 2);
  assert.equal(messages[1].type, 'retour');
  assert.equal(messages[1].texte, 'Kardplay est revenu, après 15 min de panne.');
  assert.equal(etat.enPanne, false);
  assert.equal(etat.debutPanne, null);
  assert.equal(etat.derniereAlerte, 'retour');
});

test('retour après un seul échec : rien', () => {
  const { messages, etat } = suite([ECHEC, OK, OK]);
  assert.equal(messages.length, 0);
  assert.equal(etat.echecsDeSuite, 0);
  assert.equal(etat.debutPanne, null);
});

test('nouvelle panne après un retour : une nouvelle alerte', () => {
  const { messages } = suite([ECHEC, ECHEC, OK, ECHEC, ECHEC]);
  assert.deepEqual(
    messages.map((m) => m.type),
    ['panne', 'retour', 'panne'],
  );
});

test('Telegram en échec : retenté au passage suivant, une seule fois par passage', async () => {
  const resultats = [ECHEC, ECHEC, ECHEC, ECHEC];
  const reponsesTelegram = [false, true];
  let etat = etatNeuf();
  const appelsParPassage = [];
  const journaux = [];
  for (let i = 0; i < resultats.length; i++) {
    let appels = 0;
    await passage({
      lireEtat: async () => etat,
      sonde: async () => resultats[i],
      envoyer: async () => {
        appels++;
        return reponsesTelegram.shift() ?? true;
      },
      ecrireEtat: async (e) => {
        etat = e;
      },
      maintenant: minutes(i * 5),
      journaliser: (ligne) => journaux.push(ligne),
    });
    appelsParPassage.push(appels);
  }
  // Passage 2 : raté. Passage 3 : retenté et réussi. Passage 4 : rien.
  assert.deepEqual(appelsParPassage, [0, 1, 1, 0]);
  assert.equal(etat.derniereAlerte, 'panne');
  assert.ok(journaux.includes('envoi Telegram raté, nouvel essai au passage suivant'));
  assert.ok(journaux.includes('alerte envoyée'));
});

test('Telegram en échec au retour : « revenu » retenté, durée inchangée', () => {
  // Panne de 0 à 10 min, retour vu à 10 min, Telegram refuse ce passage-là.
  const { messages, etat } = suite([ECHEC, ECHEC, OK, OK], { refuse: (i) => i === 2 });
  assert.deepEqual(
    messages.map((m) => [m.passage, m.type]),
    [
      [1, 'panne'],
      [2, 'retour'],
      [3, 'retour'],
    ],
  );
  assert.equal(messages[2].texte, 'Kardplay est revenu, après 10 min de panne.');
  assert.equal(etat.derniereAlerte, 'retour');
});

test('alerte de panne jamais partie puis retour : rien', () => {
  const { messages, etat } = suite([ECHEC, ECHEC, OK], { refuse: () => true });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, 'panne');
  assert.equal(etat.derniereAlerte, null);
  assert.equal(etat.debutPanne, null);
});

test('état illisible ou absent : état neuf, sans message', async () => {
  for (const texte of ['', '{pas du json', 'null', '[]', '42']) {
    assert.deepEqual(lireEtatBrut(texte), etatNeuf());
  }
  let ecrit = null;
  let appels = 0;
  await passage({
    lireEtat: async () => lireEtatBrut('{cassé'),
    sonde: async () => OK,
    envoyer: async () => {
      appels++;
      return true;
    },
    ecrireEtat: async (e) => {
      ecrit = e;
    },
    maintenant: minutes(0),
    journaliser: () => {},
  });
  assert.equal(appels, 0);
  assert.equal(ecrit.echecsDeSuite, 0);
  assert.equal(ecrit.derniereAlerte, null);
});

test('état lu : champs inconnus ou mal typés ignorés', () => {
  const etat = lireEtatBrut(
    JSON.stringify({ echecsDeSuite: 'trois', enPanne: true, derniereAlerte: 'autre', jeton: 'x' }),
  );
  assert.equal(etat.echecsDeSuite, 0);
  assert.equal(etat.enPanne, true);
  assert.equal(etat.derniereAlerte, null);
  assert.equal('jeton' in etat, false);
});

test('entretien : commit après 30 jours sans changement, pas avant', () => {
  const base = { ...etatNeuf(), dernierCommit: minutes(0).toISOString() };
  const a29 = decider(base, OK, new Date(T0 + 29 * 24 * 3600 * 1000));
  assert.equal(a29.etat.dernierCommit, base.dernierCommit);
  assert.ok(!a29.journal.includes("commit d'entretien"));

  const quand = new Date(T0 + 30 * 24 * 3600 * 1000);
  const a30 = decider(base, OK, quand);
  assert.equal(a30.etat.dernierCommit, quand.toISOString());
  assert.ok(a30.journal.includes("commit d'entretien"));
  assert.equal(a30.message, null);
});

test('entretien : un changement d’état date aussi le commit', () => {
  const base = { ...etatNeuf(), dernierCommit: minutes(0).toISOString() };
  const d = decider(base, ECHEC, minutes(5));
  assert.equal(d.etat.dernierCommit, minutes(5).toISOString());
  assert.ok(!d.journal.includes("commit d'entretien"));
});

test('durées lisibles', () => {
  assert.equal(formaterDuree(0), '0 min');
  assert.equal(formaterDuree(7 * 60_000), '7 min');
  assert.equal(formaterDuree(72 * 60_000), '1 h 12 min');
  assert.equal(formaterDuree((26 * 60 + 5) * 60_000), '1 j 2 h');
});

// Sonde contre un petit serveur local : statut, JSON, champ version, délai.
test('sonde : ok, statut, JSON illisible, version absente, délai', async () => {
  const serveur = createServer((req, res) => {
    if (req.url === '/ok') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"version":"c1eda62","rooms":0}');
    } else if (req.url === '/sans-version') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"rooms":0}');
    } else if (req.url === '/html') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html></html>');
    } else if (req.url === '/lent') {
      setTimeout(() => res.end('{}'), 500);
    } else {
      res.writeHead(502);
      res.end();
    }
  });
  await new Promise((r) => serveur.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${serveur.address().port}`;
  try {
    assert.deepEqual(await sonder(`${base}/ok`), { ok: true });
    assert.deepEqual(await sonder(`${base}/sans-version`), { ok: false, raison: 'champ version absent' });
    assert.deepEqual(await sonder(`${base}/html`), { ok: false, raison: 'réponse illisible' });
    assert.deepEqual(await sonder(`${base}/autre`), { ok: false, raison: 'statut 502' });
    assert.deepEqual(await sonder(`${base}/lent`, 100), { ok: false, raison: 'délai dépassé' });
  } finally {
    serveur.closeAllConnections();
    await new Promise((r) => serveur.close(r));
  }
  assert.deepEqual(await sonder('http://127.0.0.1:1/'), { ok: false, raison: 'erreur réseau' });
});
