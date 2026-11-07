// Veille de https://kardplay.com/sante, lancée par GitHub Actions.
// Node 20 ou plus, aucune dépendance.
// Les journaux d'un dépôt public sont publics : on n'y écrit jamais
// le jeton, l'adresse de l'API Telegram ni la réponse de Telegram.

import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const ADRESSE_SITE = 'https://kardplay.com/sante';
export const SEUIL_ECHECS = 2;
export const DELAI_SONDE_MS = 20_000;
export const DELAI_TELEGRAM_MS = 15_000;
export const JOURS_ENTRETIEN = 30;
const JOUR_MS = 24 * 60 * 60 * 1000;

export function etatNeuf() {
  return {
    echecsDeSuite: 0,
    enPanne: false,
    debutPanne: null,
    finPanne: null,
    derniereAlerte: null,
    dernierCommit: null,
  };
}

// Un état venu du fichier : on garde seulement les champs connus et bien typés.
export function lireEtatBrut(texte) {
  let brut;
  try {
    brut = JSON.parse(texte);
  } catch {
    return etatNeuf();
  }
  if (!brut || typeof brut !== 'object' || Array.isArray(brut)) return etatNeuf();
  const etat = etatNeuf();
  if (Number.isInteger(brut.echecsDeSuite) && brut.echecsDeSuite >= 0) {
    etat.echecsDeSuite = Math.min(brut.echecsDeSuite, SEUIL_ECHECS);
  }
  if (typeof brut.enPanne === 'boolean') etat.enPanne = brut.enPanne;
  for (const champ of ['debutPanne', 'finPanne', 'dernierCommit']) {
    if (typeof brut[champ] === 'string' && !Number.isNaN(Date.parse(brut[champ]))) {
      etat[champ] = brut[champ];
    }
  }
  if (brut.derniereAlerte === 'panne' || brut.derniereAlerte === 'retour') {
    etat.derniereAlerte = brut.derniereAlerte;
  }
  return etat;
}

export function formaterDuree(ms) {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const heures = Math.floor(minutes / 60);
  const reste = minutes % 60;
  if (heures < 24) return `${heures} h ${String(reste).padStart(2, '0')} min`;
  const jours = Math.floor(heures / 24);
  return `${jours} j ${heures % 24} h`;
}

function heureDeParis(iso) {
  return new Intl.DateTimeFormat('fr-FR', {
    timeZone: 'Europe/Paris',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));
}

function memesChamps(a, b) {
  return (
    a.echecsDeSuite === b.echecsDeSuite &&
    a.enPanne === b.enPanne &&
    a.debutPanne === b.debutPanne &&
    a.finPanne === b.finPanne &&
    a.derniereAlerte === b.derniereAlerte
  );
}

// Note la date du commit : maintenant si l'état a changé,
// ou si le dernier commit a plus de 30 jours (commit d'entretien).
function dater(ancien, nouveau, maintenant, journal) {
  if (!memesChamps(ancien, nouveau)) {
    return { ...nouveau, dernierCommit: maintenant.toISOString() };
  }
  const dernier = ancien.dernierCommit ? Date.parse(ancien.dernierCommit) : null;
  if (dernier === null || maintenant.getTime() - dernier >= JOURS_ENTRETIEN * JOUR_MS) {
    journal.push("commit d'entretien");
    return { ...nouveau, dernierCommit: maintenant.toISOString() };
  }
  return { ...nouveau, dernierCommit: ancien.dernierCommit };
}

// Logique pure. resultat = { ok: true } ou { ok: false, raison: '...' }.
// Rend le nouvel état, le message à envoyer (ou null) et les lignes du journal.
// Le message n'est noté envoyé que par noterEnvoi, après un « ok » de Telegram.
export function decider(etat, resultat, maintenant) {
  const journal = [];
  const iso = maintenant.toISOString();
  const nouveau = { ...etat };
  let message = null;

  if (resultat.ok) {
    journal.push('site ok');
    nouveau.echecsDeSuite = 0;
    nouveau.enPanne = false;
    if (etat.derniereAlerte === 'panne') {
      // L'alerte de panne est partie : il faut dire que le site est revenu.
      nouveau.finPanne = etat.finPanne ?? iso;
      const debut = Date.parse(nouveau.debutPanne ?? nouveau.finPanne);
      const duree = formaterDuree(Date.parse(nouveau.finPanne) - debut);
      message = {
        type: 'retour',
        texte: `Kardplay est revenu, après ${duree} de panne.`,
      };
    } else {
      nouveau.debutPanne = null;
      nouveau.finPanne = null;
    }
  } else {
    const compte = Math.min(etat.echecsDeSuite + 1, SEUIL_ECHECS);
    nouveau.echecsDeSuite = compte;
    nouveau.debutPanne = etat.debutPanne ?? iso;
    nouveau.finPanne = null;
    nouveau.enPanne = compte >= SEUIL_ECHECS;
    if (nouveau.enPanne && etat.enPanne) {
      const depuis = formaterDuree(maintenant.getTime() - Date.parse(nouveau.debutPanne));
      journal.push(`échec (${resultat.raison}), panne depuis ${depuis}`);
    } else {
      journal.push(`échec ${compte} (${resultat.raison})`);
    }
    if (nouveau.enPanne && etat.derniereAlerte !== 'panne') {
      message = {
        type: 'panne',
        texte:
          `Kardplay ne répond plus (${resultat.raison}). ` +
          `Premier échec le ${heureDeParis(nouveau.debutPanne)}, heure de Paris.`,
      };
    }
  }

  return { etat: dater(etat, nouveau, maintenant, journal), message, journal };
}

// À appeler seulement quand Telegram a répondu ok.
export function noterEnvoi(etat, type, maintenant) {
  const nouveau = { ...etat, derniereAlerte: type, dernierCommit: maintenant.toISOString() };
  if (type === 'retour') {
    nouveau.debutPanne = null;
    nouveau.finPanne = null;
  }
  return nouveau;
}

export async function sonder(adresse = ADRESSE_SITE, delaiMs = DELAI_SONDE_MS) {
  let reponse;
  try {
    reponse = await fetch(adresse, {
      signal: AbortSignal.timeout(delaiMs),
      headers: { 'user-agent': 'kardplay-veille', 'cache-control': 'no-cache' },
    });
  } catch (erreur) {
    const nom = erreur?.name;
    if (nom === 'TimeoutError' || nom === 'AbortError') return { ok: false, raison: 'délai dépassé' };
    return { ok: false, raison: 'erreur réseau' };
  }
  if (reponse.status !== 200) return { ok: false, raison: `statut ${reponse.status}` };
  let corps;
  try {
    corps = await reponse.json();
  } catch (erreur) {
    const nom = erreur?.name;
    if (nom === 'TimeoutError' || nom === 'AbortError') return { ok: false, raison: 'délai dépassé' };
    return { ok: false, raison: 'réponse illisible' };
  }
  if (!corps || typeof corps !== 'object' || !('version' in corps)) {
    return { ok: false, raison: 'champ version absent' };
  }
  return { ok: true };
}

// Rend true seulement si Telegram a répondu ok. Ne journalise rien de Telegram.
export async function envoyerTelegram(texte, env = process.env, delaiMs = DELAI_TELEGRAM_MS) {
  const jeton = env.TELEGRAM_JETON;
  const chat = env.TELEGRAM_CHAT;
  if (!jeton || !chat) return false;
  try {
    const reponse = await fetch(`https://api.telegram.org/bot${jeton}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text: texte }),
      signal: AbortSignal.timeout(delaiMs),
    });
    if (!reponse.ok) return false;
    const corps = await reponse.json();
    return corps?.ok === true;
  } catch {
    return false;
  }
}

// Un passage : lire l'état, sonder, envoyer au plus un message, écrire l'état.
export async function passage({ lireEtat, sonde, envoyer, ecrireEtat, maintenant, journaliser }) {
  const etat = await lireEtat();
  const resultat = await sonde();
  const decision = decider(etat, resultat, maintenant);
  for (const ligne of decision.journal) journaliser(ligne);
  let nouveau = decision.etat;
  if (decision.message) {
    const envoye = await envoyer(decision.message.texte);
    if (envoye) {
      nouveau = noterEnvoi(nouveau, decision.message.type, maintenant);
      journaliser(decision.message.type === 'panne' ? 'alerte envoyée' : 'retour envoyé');
    } else {
      journaliser('envoi Telegram raté, nouvel essai au passage suivant');
    }
  }
  await ecrireEtat(nouveau);
  return nouveau;
}

const FICHIER_ETAT = new URL('./etat.json', import.meta.url);

async function lireEtatFichier() {
  try {
    return lireEtatBrut(await readFile(FICHIER_ETAT, 'utf8'));
  } catch {
    return etatNeuf();
  }
}

async function ecrireEtatFichier(etat) {
  await writeFile(FICHIER_ETAT, `${JSON.stringify(etat, null, 2)}\n`);
}

const lanceDirect = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (lanceDirect) {
  if (!process.env.TELEGRAM_JETON || !process.env.TELEGRAM_CHAT) {
    console.log('secrets Telegram absents : aucun message ne pourra partir');
  }
  await passage({
    lireEtat: lireEtatFichier,
    sonde: () => sonder(),
    envoyer: (texte) => envoyerTelegram(texte),
    ecrireEtat: ecrireEtatFichier,
    maintenant: new Date(),
    journaliser: (ligne) => console.log(ligne),
  });
}
