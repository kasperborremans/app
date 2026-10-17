# Mijn Vermogen

Persoonlijk dashboard om al je geld in één oogopslag te zien — op je gsm én op je computer.

- **Argenta, Revolut** (en andere banken): saldo automatisch via open banking (Enable Banking, enkel leestoegang)
- **VT Markets** (en andere MT4/MT5-brokers): saldo automatisch via Myfxbook (gratis, investor password, enkel lezen)
- **Lightyear** (en andere brokers zonder API): je vult je posities één keer in, de koersen worden automatisch opgehaald
- Wisselkoersen automatisch van de ECB, alles omgerekend naar euro
- Verloop van je vermogen over tijd, verdeling per categorie en per instelling
- Beveiligd met een wachtwoord, te installeren als app op je gsm

Saldi worden 4× per dag automatisch opgehaald (het maximum dat banken toelaten zonder dat je zelf inlogt). Met de ↻-knop vernieuw je meteen.

## Installeren (eenmalig, ±20 minuten)

Alles is gratis. Het dashboard draait als **Cloudflare Worker**.

### 1. Online zetten via Cloudflare

1. Maak een gratis account op [dash.cloudflare.com](https://dash.cloudflare.com/sign-up).
2. Ga naar **Workers & Pages → Create → Import a repository**, koppel GitHub en kies deze repository (`kasperborremans/app`) en de juiste branch.
3. Laat de instellingen staan en klik **Deploy**. Cloudflare maakt automatisch de opslag (KV) aan.
4. Je krijgt een adres zoals `https://vermogen.<jouwnaam>.workers.dev`. Noteer het.

### 2. Wachtwoord instellen

In Cloudflare: open je Worker → **Settings → Variables and Secrets → Add** en voeg toe, telkens als type **Secret**:

| Naam | Waarde |
|---|---|
| `DASHBOARD_PASSWORD` | een sterk wachtwoord om in te loggen |
| `SESSION_SECRET` | een lange willekeurige tekst (bv. 40 tekens, mag je verzinnen) |

Open nu je adres: je kan inloggen. Zelf bijgehouden rekeningen (zoals Lightyear) werken meteen.

### 3. Argenta en Revolut koppelen (Enable Banking)

1. Maak een gratis account op [enablebanking.com](https://enablebanking.com) en open het **Control Panel**.
2. **API applications → Register new application**:
   - Environment: **Production**
   - Redirect URL: `https://<jouw-adres>.workers.dev/api/eb/callback` (staat ook in het dashboard onder ⚙ Instellingen)
   - Laat de sleutel in je browser genereren → er wordt een `.pem`-bestand gedownload. **Bewaar dit goed en deel het met niemand.**
3. Activeer de app door je **eigen rekeningen te koppelen** (zo werkt het gratis: je krijgt enkel toegang tot je eigen rekeningen).
4. Voeg in Cloudflare twee secrets toe:
   - `EB_APP_ID` = het application-ID (de naam van het `.pem`-bestand, zonder `.pem`)
   - `EB_PRIVATE_KEY` = de volledige inhoud van het `.pem`-bestand (inclusief de `-----BEGIN…`-regels)
5. In het dashboard: **+ Rekening → 🏦 Bank → Argenta**. Je logt in bij Argenta (app of itsme) en wordt teruggestuurd. Herhaal voor **Revolut** (staat onder België of Litouwen).

De toestemming geldt 180 dagen. Het dashboard waarschuwt je 2 weken op voorhand; dan tik je op **Opnieuw koppelen**.

### 4. VT Markets koppelen (Myfxbook, gratis)

1. Stel in MetaTrader een **investor password** in (enkel lezen): *Extra → Opties → Server → Wijzigen → investor password*.
2. Maak een gratis account op [myfxbook.com](https://www.myfxbook.com) en kies **Add account → MetaTrader 4/5 → Auto update**. Vul je VT Markets-login, server en het **investor password** in.
3. Voeg in Cloudflare twee secrets toe: `MYFXBOOK_EMAIL` en `MYFXBOOK_PASSWORD` (je Myfxbook-login).
4. In het dashboard: **+ Rekening → 📈 MetaTrader-broker via Myfxbook → Koppelen**.

Het dashboard toont de **equity** (saldo + open winst/verlies). Demo-accounts worden standaard verborgen.

*Alternatief:* via [MetaApi](https://app.metaapi.cloud) (betalend) met secret `METAAPI_TOKEN`.

### 5. Lightyear

Lightyear heeft geen API. Kies **+ Rekening → ✍️ Zelf bijhouden**, categorie *Beleggingen / broker*, en voeg je posities toe met hun Yahoo Finance-ticker (bv. `VWCE.DE`, `IWDA.AS`, `AAPL`). Vul ook je cash in. De koersen worden automatisch bijgewerkt; enkel bij aan- of verkopen pas je het aantal aan.

### 6. Op je gsm als app

Open je adres in Safari (iPhone) of Chrome (Android) → **Deel → Zet op beginscherm**. Je krijgt een app-icoon en blijft 30 dagen ingelogd.

## Ontwikkelen

```bash
npm install
cp .dev.vars.example .dev.vars   # wachtwoord en sleutels voor lokaal testen
npm run dev                      # http://localhost:8787
npm test
```

- `public/` — de website (HTML/CSS/JS, geen build nodig)
- `worker/` — de server: login, opslag, koppelingen, automatisch ophalen
- `wrangler.toml` — Cloudflare-configuratie (opslag en schema voor automatisch ophalen)

## Privacy & veiligheid

- Alle koppelingen geven **enkel leestoegang**: er kan nooit geld verplaatst of gehandeld worden.
- Je gegevens staan in je eigen Cloudflare-account; enkel jij kan inloggen.
- Sleutels (`EB_PRIVATE_KEY`, `METAAPI_TOKEN`) staan als versleutelde secrets in Cloudflare en komen nooit in de code of in de browser.
- Na 10 foute wachtwoordpogingen wordt inloggen een uur geblokkeerd.
