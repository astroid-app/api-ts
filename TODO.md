# API Rewrite: v2 (Python) vs v3 (Node)

Abgleich aller in `v2/src/api.py` definierten Endpunkte mit `api-js/src/index.ts`.

## Bereits in v3 vorhanden (direkt oder als funktionales Pendant)
- [x] `GET /viewlogs`
- [x] `GET /ga-test`
- [x] `GET /docs`
- [x] `GET /`
- [x] `GET /statistics`
- [x] `GET /allendpoints`
- [x] `GET /{endpoint}` -> `GET /:id`
- [x] `GET /healthcheck/{endpoint}` -> `GET /healthcheck/:id`
- [x] `POST /healthcheck/{endpoint}/repair` -> `POST /healthcheck/:id/repair`
- [x] `POST /create`
- [x] `DELETE /delete/{endpoint}` -> `DELETE /delete`
- [x] `GET /getendpoint/{platform}` -> `GET /getendpoint/:platform`
- [x] `POST /token/{endpoint}` -> `POST /newtoken` (abweichendes Request-Format)
- [x] `POST /update/{endpoint}` -> aufgeteilt in `POST /:id/messages` + `POST /:id/config` + `DELETE /:id/config`

## In v3 noch fehlend (aus v2 zu migrieren)

### GET
- [x] `GET /assets/{asset}`
- [x] `GET /invite/{platform}`
- [x] `GET /discord`
- [x] `GET /cdn/{assetId}`
- [x] `GET /getserverstructure`
- [x] `GET /bridges/{endpoint}`
- [x] `GET /healtcheck_summaries/{token}`
- [x] `GET /channel/name/{platform}`
- [x] `GET /contribution/contributors`
- [x] `GET /contribution/contributor`
- [x] `GET /contribution/contributor/avatar`
- [x] `GET /optout/{userid}`

### POST
- [x] `POST /update/{endpoint}/json`
- [x] `POST /read/{endpoint}`
- [x] `POST /createendpoint/{platform}`
- [x] `POST /contribution/addcontributor/{id}`
- [x] `POST /emojis/{endpoint}/add`
- [x] `POST /emojis/{endpoint}/update`
- [x] `POST /optout/{userid}`
- [x] `POST /optin/{userid}`

### PATCH
- [x] `PATCH /daily_endpoint_check`
- [x] `PATCH /syncserverrelations`
- [ ] `PATCH /emojis/{endpoint}/sync` (Route vorhanden, eigentliche Discord->Nerimity Sync-Logik noch offen)

### DELETE
- [x] `DELETE /tempattachments`
- [x] `DELETE /delete/data/{endpoint}`
- [x] `DELETE /emojis/{endpoint}/delete`

## Nachtraegliche API-Vertragsanpassung
- [x] Schreibende Endpunkte akzeptieren nur noch `token` als Query-Parameter.
- [x] Alle anderen Eingaben bei mutierenden Endpunkten werden aus JSON-Body gelesen.

## Noch offen (gesamt)
- [ ] `PATCH /emojis/{endpoint}/sync` echte Discord->Nerimity Sync-Logik implementieren.
