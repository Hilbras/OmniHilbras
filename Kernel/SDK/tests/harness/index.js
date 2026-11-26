/**
 * The one harness seam.
 *
 * Three interfaces are genuinely different — a transport double, a fetch double built from real
 * `Response` objects, and a driver double — so there is no single double that can stand in for all
 * of them. What can be single is the import: a contract test names the seam once and gets the
 * doubles for the style it drives.
 */
export { framesFor, scriptedTransport } from './scripted-transport.js';
export { scriptedFetch } from './scripted-fetch.js';
export { scriptedTokenHarborFetch } from './scripted-tokenharbor-fetch.js';
export {
  CHATGPT_WEB_CONTRACT_MODEL,
  DUCKDUCKGO_WEB_CONTRACT_MODEL,
  GEMINI_WEB_CONTRACT_MODEL,
  chatGptWebFixtureCredential,
  geminiWebFixtureCredential,
  scriptedDriver,
  scriptedDuckDuckGoDriver,
  scriptedGeminiDriver,
} from './scripted-driver.js';
