# Veille de Kardplay

Une tâche GitHub Actions lit https://kardplay.com/sante toutes les 5 minutes.

- Après 2 échecs de suite : un seul message Telegram « Kardplay ne répond plus ».
- Quand le site répond de nouveau : un seul message « Kardplay est revenu », avec la durée de la panne.
- Jamais de rafale : rien de plus tant que l'état ne change pas.

Un échec, c'est : délai dépassé (20 s), erreur réseau, statut autre que 200, ou JSON sans champ `version`.

## Fichiers

- `veille.mjs` : la veille. Node 20 ou plus, aucune dépendance.
- `etat.json` : l'état entre deux passages. Écrit et commité par la tâche quand il change.
- `.github/workflows/veille.yml` : la tâche planifiée.
- `veille.test.mjs` : les tests (`npm test`).

## Les deux secrets

Dans Settings, Secrets and variables, Actions :

- `TELEGRAM_JETON` : le jeton du bot.
- `TELEGRAM_CHAT` : l'identifiant de la conversation.

Sans eux, la veille tourne mais aucun message ne part. Un message raté est retenté au passage suivant.
Les journaux du dépôt sont publics : ils ne montrent jamais le jeton ni la réponse de Telegram.

## Lancer un passage à la main

```
gh workflow run veille.yml -R Axosss/kardplay-veille
```

Essai des secrets (un message de test, l'état ne bouge pas) :

```
gh workflow run veille.yml -R Axosss/kardplay-veille -f essai=true
```

## La règle des 60 jours

Dans un dépôt public, GitHub coupe les tâches planifiées après 60 jours sans activité.
La parade : la tâche commite `etat.json` à chaque changement, et fait un commit d'entretien si le dernier a plus de 30 jours.
Si la tâche est coupée quand même : onglet Actions, workflow « veille », bouton « Enable workflow ».
