# DOM Analyzer MCP Server

## Introduzione

Il progetto `dom-analyzer-mcp` è un DOM Analyzer/E2E server MCP basato su Puppeteer per controllare un'app frontend in un URL configurabile.

- Percorso: `server.ts`
- Stack: Model Context Protocol (MCP) + Puppeteer
- Obiettivo: fornire comandi remoti di debug, test e ispezione DOM/CSS rete.

---

## Configurazione esterna

File: `config.json`

Esempio:
```json
{
  "targetUrl": "http://localhost:4200",
  "headless": true
}
```

- `targetUrl`: URL dell'app da esplorare (es. server dev locale)
- `headless`: booleano per avvio Puppeteer headless

---

## Struttura generale

Variabili di stato globali:
- `browser: Browser` (Puppeteer)
- `page: Page` (Puppeteer)
- `networkRequests: {url, method, status?, response?}[]`
- `consoleErrors: string[]`

Core:
- `initBrowser(url = 'http://localhost:4200')`: inizializza Puppeteer con retry, intercetta request/response.
- `main()`: avvia il server MCP, registra console errors e connette `StdioServerTransport`.

---

## Tool MCP disponibili

### 1) `take_screenshot`
Scatta uno screenshot della pagina o elemento selezionato.

Input:
- `selector` (opzionale): CSS selector dell'elemento.
- `navigateTo` (opzionale): URL da visitare prima di catturare.

Output:
- `content` con `text` e `image` (base64 PNG).

---

### 2) `read_dom`
Restituisce l'HTML (outerHTML) del `body` o elemento specificato.

Input:
- `selector` (opzionale): CSS selector.

Output:
- `content[0].text` = HTML.

---

### 3) `get_computed_styles`
Recupera gli stili computati di un elemento.

Input:
- `selector` (required)
- `properties` (array di string, opzionale)

Output:
- JSON con proprietà CSS richieste o tutte.

---

### 4) `get_network_requests`
Lista chiamate HTTP intercettate.

Input:
- `filterUrl` (opzionale)
- `filterMethod` (opzionale, GET/POST/PUT/DELETE/PATCH)
- `limit` (opzionale, default 50)

Output:
- JSON array richieste.

---

### 5) `execute_js`
Esegue JS nella pagina e ritorna il risultato.

Input:
- `script` (string)

Output:
- JSON value o errore.

---

### 6) `navigate_to`
Naviga a URL o route dell'app.

Input:
- `url` (obbligatorio)

Behaviour:
- `page.goto` + reset `networkRequests`.

---

### 7) `get_console_errors`
Recupera console error/warn catturati.

Output:
- lista errori (stringhe) o `Nessun errore in console`.

---

### 8) `click`
Simula click su elemento.

Input:
- `selector` (obbligatorio)

Behaviour:
- `page.waitForSelector(selector)` + `page.click(selector)`.

---

### 9) `type`
Inserisce testo in input.

Input:
- `selector` (obbligatorio)
- `text` (obbligatorio)

Behaviour:
- `page.waitForSelector(selector)` + `page.type(selector, text)`.

---

### 10) `wait_for_selector`
Attende elemento nel DOM.

Input:
- `selector` (obbligatorio)
- `timeout` (opzionale, default 10000ms)

---

### 11) `reset_app`
Resetta stato app e ricarica.

Behaviour:
- pulisce localStorage/sessionStorage/cookie
- `page.goto('http://localhost:4200')`
- reset `networkRequests`

---

### 12) `get_storage`
Legge local/sessionStorage.

Input:
- `type` (`localStorage`|`sessionStorage`, default `localStorage`)
- `key` (opzionale)

---

### 13) `set_storage`
Scrive local/sessionStorage.

Input:
- `type` (`localStorage`|`sessionStorage`, default `localStorage`)
- `key` (string)
- `value` (string)

---

### 14) `get_performance_metrics`
Restituisce metriche di performance Puppeteer + `window.performance`.

Output:
- JSON con `metrics` e `perfTiming`.

---

## Comandi consigliati per test e debug

- `reset_app` per stato deterministico.
- `wait_for_selector` prima di click/type su elementi dinamici.
- `get_network_requests` per validare API call.
- `get_console_errors` per errori JS.
- `get_computed_styles` per assertion visuale.

---

## Suggerimenti operativi (migliorie future)

- Aggiungere `assert_*` (assertElementVisible, assertText) come tool.
- Aggiungere opzione `headless`/`headful` dinamica.
- Implementare `screenshot_diff` e `page_trace`.
- Aggiungere supporto per multi-page `target` e `frame`.

---

## Esempio d'uso rapido (MCP request)

```json
{
  "name": "take_screenshot",
  "input": {"navigateTo": "http://localhost:4200"}
}
```

```json
{
  "name": "click",
  "input": {"selector": "button#submit"}
}
```

```json
{
  "name": "get_network_requests",
  "input": {"filterMethod": "GET", "limit": 20}
}
```

---

## Avvio server

Eseguire da terminale:

```bash
cd angular-mcp-server
npm install
npm run build (se presente)
npm start
```

Il server continua a leggere da stdin/stdout e risponde alle chiamate MCP.

----------

Made by Elia at 01:15am >:)  