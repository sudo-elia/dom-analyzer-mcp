import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import puppeteer, { Browser, Page } from "puppeteer";

const server = new McpServer({
  name: "dom-analyzer",
  version: "1.0.0",
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.resolve(__dirname, "..", "config.json");

interface ServerConfig {
  targetUrl: string;
  headless: boolean;
  executablePath?: string;
  initTimeout?: number;
}

function loadConfig(): ServerConfig {
  const defaultConfig: ServerConfig = { targetUrl: "http://localhost:4200", headless: true, initTimeout: 30000 };
  try {
    const raw = fs.readFileSync(configPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<ServerConfig>;
    return { ...defaultConfig, ...parsed };
  } catch (err: any) {
    console.error(`Impossibile leggere config ${configPath}, uso valori di default: ${err?.message ?? err}`);
    return defaultConfig;
  }
}

const config = loadConfig();

let browser: Browser;
let page: Page;
const networkRequests: { url: string; method: string; status?: number; response?: string }[] = [];

// Inizializza Puppeteer e connettiti all'app target (DOM Analyzer)
async function initBrowser(url = "http://localhost:4200") {
  if (browser && page && !page.isClosed()) {
    return;
  }

  if (browser) {
    try {
      await browser.close();
    } catch {}
  }

  browser = await puppeteer.launch({ headless: config.headless });
  page = await browser.newPage();

  // Intercetta le chiamate di rete
  networkRequests.length = 0;
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    networkRequests.push({ url: req.url(), method: req.method() });
    req.continue();
  });
  page.on("response", async (res) => {
    const entry = networkRequests.find(
      (r) => r.url === res.url() && !r.status
    );
    if (entry) {
      entry.status = res.status();
      try {
        entry.response = await res.text();
      } catch {}
    }
  });

  const maxAttempts = 3;
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await page.goto(url, { waitUntil: "networkidle2", timeout: 15000 });
      console.error(`Puppeteer connesso a ${url}`);
      return;
    } catch (err: any) {
      lastError = err;
      console.error(`initBrowser tentativo ${attempt} fallito: ${err.message}`);
      await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
    }
  }
  
  throw lastError;
}

// Wrap per init basato su config
async function initBrowserFromConfig() {
  await initBrowser(config.targetUrl);
}

// ─── TOOL 1: Screenshot della pagina ────────────────────────────────────────
server.tool(
  "take_screenshot",
  "Scatta uno screenshot della pagina Dom Analyzer corrente o di un elemento specifico",
  {
    selector: z.string().optional().describe("CSS selector dell'elemento (opzionale, default: intera pagina)"),
    navigateTo: z.string().optional().describe("URL da navigare prima dello screenshot"),
  },
  async ({ selector, navigateTo }) => {
    if (navigateTo) await page.goto(navigateTo, { waitUntil: "networkidle2" });

    let screenshot: string;
    if (selector) {
      const element = await page.$(selector);
      if (!element) return { content: [{ type: "text", text: `Elemento "${selector}" non trovato` }] };
      screenshot = (await element.screenshot({ encoding: "base64" })) as string;
    } else {
      screenshot = (await page.screenshot({ encoding: "base64", fullPage: true })) as string;
    }

    return {
      content: [
        { type: "text", text: `Screenshot acquisito${selector ? ` dell'elemento "${selector}"` : ""}` },
        { type: "image", data: screenshot, mimeType: "image/png" },
      ],
    };
  }
);

// ─── TOOL 2: Leggi il DOM ────────────────────────────────────────────────────
server.tool(
  "read_dom",
  "Legge e restituisce il DOM HTML della pagina o di un elemento specifico",
  {
    selector: z.string().optional().describe("CSS selector (opzionale, default: body completo)"),
  },
  async ({ selector }) => {
    const html = await page.evaluate((sel) => {
      const el = sel ? document.querySelector(sel) : document.body;
      return el ? el.outerHTML : "Elemento non trovato";
    }, selector ?? null);

    return {
      content: [{ type: "text", text: html }],
    };
  }
);

// ─── TOOL 3: Analizza stili CSS di un elemento ──────────────────────────────
server.tool(
  "get_computed_styles",
  "Recupera gli stili CSS computati di un elemento Dom Analyzer",
  {
    selector: z.string().describe("CSS selector dell'elemento"),
    properties: z.array(z.string()).optional().describe("Lista proprietà CSS da leggere (opzionale, default: tutte)"),
  },
  async ({ selector, properties }) => {
    const styles = await page.evaluate(
      (sel, props) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const computed = window.getComputedStyle(el);
        if (props && props.length > 0) {
          return props.reduce((acc, prop) => ({ ...acc, [prop]: computed.getPropertyValue(prop) }), {});
        }
        const result: Record<string, string> = {};
        for (let i = 0; i < computed.length; i++) {
          const prop = computed[i];
          result[prop] = computed.getPropertyValue(prop);
        }
        return result;
      },
      selector,
      properties ?? []
    );

    if (!styles) return { content: [{ type: "text", text: `Elemento "${selector}" non trovato` }] };
    return { content: [{ type: "text", text: JSON.stringify(styles, null, 2) }] };
  }
);

// ─── TOOL 4: Leggi le chiamate HTTP intercettate ─────────────────────────────
server.tool(
  "get_network_requests",
  "Restituisce le chiamate HTTP fatte dall'app Dom Analyzer (XHR, fetch, API calls)",
  {
    filterUrl: z.string().optional().describe("Filtra per URL contenente questa stringa"),
    filterMethod: z.enum(["GET", "POST", "PUT", "DELETE", "PATCH"]).optional().describe("Filtra per metodo HTTP"),
    limit: z.number().optional().describe("Numero massimo di richieste da restituire (default: 50)"),
  },
  async ({ filterUrl, filterMethod, limit = 50 }) => {
    let requests = [...networkRequests];
    if (filterUrl) requests = requests.filter((r) => r.url.includes(filterUrl));
    if (filterMethod) requests = requests.filter((r) => r.method === filterMethod);
    requests = requests.slice(-limit);

    return {
      content: [{ type: "text", text: JSON.stringify(requests, null, 2) }],
    };
  }
);

// ─── TOOL 5: Esegui JavaScript nella pagina ──────────────────────────────────
server.tool(
  "execute_js",
  "Esegue JavaScript nella pagina Dom Analyzer e restituisce il risultato (utile per Dom Analyzer state, debug)",
  {
    script: z.string().describe("Codice JavaScript da eseguire nella pagina"),
  },
  async ({ script }) => {
    try {
      const result = await page.evaluate(script);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err: any) {
      return { content: [{ type: "text", text: `Errore: ${err.message}` }] };
    }
  }
);

// ─── TOOL 6: Naviga a una route Dom Analyzer ──────────────────────────────────────
server.tool(
  "navigate_to",
  "Naviga a una route specifica dell'app Dom Analyzer",
  {
    url: z.string().describe("URL o path da navigare (es: http://localhost:4200/dashboard o /dashboard)"),
  },
  async ({ url }) => {
    const fullUrl = url.startsWith("http") ? url : `${config.targetUrl}${url.startsWith('/') ? '' : '/'}${url}`;
    await page.goto(fullUrl, { waitUntil: "domcontentloaded" });
    currentUrl = page.url(); // Aggiorna URL corrente
    networkRequests.length = 0; // Reset network log dopo navigazione
    return { content: [{ type: "text", text: `Navigato a ${currentUrl}` }] };
  }
);

// ─── TOOL 7: Errori dalla console del browser ────────────────────────────────
const consoleErrors: string[] = [];

server.tool(
  "get_console_errors",
  "Recupera gli errori e warning dalla console del browser Dom Analyzer",
  {},
  async () => {
    return { content: [{ type: "text", text: consoleErrors.length > 0 ? consoleErrors.join("\n") : "Nessun errore in console" }] };
  }
);

server.tool(
  "click",
  "Esegue un click su un elemento CSS selector",
  {
    selector: z.string().describe("CSS selector dell'elemento da cliccare"),
  },
  async ({ selector }) => {
    await page.waitForSelector(selector, { timeout: 10000 });
    await page.click(selector);
    return { content: [{ type: "text", text: `Click su '${selector}' eseguito` }] };
  }
);

server.tool(
  "type",
  "Inserisce del testo in un campo input",
  {
    selector: z.string().describe("CSS selector dell'input"),
    text: z.string().describe("Testo da inserire"),
  },
  async ({ selector, text }) => {
    await page.waitForSelector(selector, { timeout: 10000 });
    await page.type(selector, text);
    return { content: [{ type: "text", text: `Digitato '${text}' in '${selector}'` }] };
  }
);

server.tool(
  "wait_for_selector",
  "Attende che un elemento sia presente nel DOM",
  {
    selector: z.string().describe("CSS selector dell'elemento"),
    timeout: z.number().optional().describe("Timeout in ms"),
  },
  async ({ selector, timeout = 10000 }) => {
    await page.waitForSelector(selector, { timeout });
    return { content: [{ type: "text", text: `Elemento '${selector}' trovato` }] };
  }
);

server.tool(
  "reset_app",
  "Ripulisce stato e naviga alla root dell'app",
  {},
  async () => {
    await page.evaluate(() => {
      localStorage.clear();
      sessionStorage.clear();
      document.cookie.split(';').forEach(c => {
        const eqPos = c.indexOf('=');
        const name = eqPos > -1 ? c.substr(0, eqPos) : c;
        document.cookie = `${name}=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/`;
      });
    });
    await page.goto('http://localhost:4200', { waitUntil: 'networkidle2' });
    networkRequests.length = 0;
    return { content: [{ type: 'text', text: 'App ripristinata e ricaricata' }] };
  }
);

server.tool(
  "get_storage",
  "Legge localStorage/sessionStorage",
  {
    type: z.enum(['localStorage', 'sessionStorage']).optional().default('localStorage'),
    key: z.string().optional(),
  },
  async ({ type, key }) => {
    const storage = await page.evaluate((t, k) => {
      const area = t === 'sessionStorage' ? sessionStorage : localStorage;
      if (k) return area.getItem(k);
      const result: Record<string, string> = {};
      for (let i = 0; i < area.length; i++) {
        const k2 = area.key(i);
        if (k2) result[k2] = area.getItem(k2)!;
      }
      return result;
    }, type, key);
    return { content: [{ type: 'text', text: JSON.stringify(storage, null, 2) }] };
  }
);

server.tool(
  "set_storage",
  "Imposta localStorage/sessionStorage",
  {
    type: z.enum(['localStorage', 'sessionStorage']).optional().default('localStorage'),
    key: z.string().describe('Chiave'),
    value: z.string().describe('Valore'),
  },
  async ({ type, key, value }) => {
    await page.evaluate((t, k, v) => {
      const area = t === 'sessionStorage' ? sessionStorage : localStorage;
      area.setItem(k, v);
    }, type, key, value);
    return { content: [{ type: 'text', text: `Impostato ${type}.${key}=${value}` }] };
  }
);

server.tool(
  "get_current_url",
  "Restituisce l'URL corrente della pagina Dom Analyzer",
  {},
  async () => {
    return { content: [{ type: "text", text: currentUrl || "URL non disponibile" }] };
  }
);

// ─── Avvio ───────────────────────────────────────────────────────────────────
async function main() {
  // Inizializza browser in background senza bloccare il server
  initBrowser().catch(err => console.error(`Errore init browser: ${err.message}`));
 
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Dom Analyzer MCP Server avviato ✅");
 
  // Registra errori console dopo connessione
  if (page) {
    page.on("console", (msg) => {
      if (msg.type() === "error" || msg.type() === "warn") {
        consoleErrors.push(`[${msg.type().toUpperCase()}] ${msg.text()}`);
      }
    });
  }
}

main().catch(console.error);
